import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient, type TransactionQuoteResponse } from '@certen.io/sdk';
import { estimateLines, estimateJson, fetchEstimate, transferIntent, assertTransferInputs, nativeAssetFor, type Estimate } from '../src/estimate.js';
import { renderSigningCard, type SigningCard } from '../src/card.js';
import { dollars } from '../src/gateway-text.js';
import { startStub, type Stub } from './helpers/stub-gateway.js';

/**
 * The estimate, in-process: what it says, what it refuses to say, and that failing to get one is never an error.
 *
 * `fetchEstimate` is the part `send` leans on, and its whole contract is that it does not throw: a gateway without the route, a slow one, one that
 * refuses the intent or answers with something else becomes "unavailable" and the send goes on. Each of those is made to happen here.
 */

const QUOTE: TransactionQuoteResponse = {
  estimate: true, evaluated_at: '2026-10-16T00:00:00Z',
  request: { chains: ['base-sepolia'], chain: 'base-sepolia', leg_count: 1, proof_class: null },
  checked: ['chain_enabled', 'price_book'], not_checked: ['the identity and its key page', 'destination-chain gas'],
  billing: {
    state: 'priced', enforcing: true,
    price: { sku: 'proof.execute', total_usd: '0.350000', platform_fee_usd: '0.150000', gas_usd: '0.200000', max_total_usd: '0.500000' },
    funds: { state: 'ok', spendable_usd: '5.000000', remaining_usd: '4.650000', shortfall_usd: '0.000000', covered: true, gate: 'passes' },
  },
};
const available = (over: Record<string, unknown> = {}): Estimate => ({ state: 'available', quote: { ...QUOTE, ...over } as TransactionQuoteResponse });
const INTENT = transferIntent({ adiUrl: 'acc://a.acme', chain: 'base-sepolia', fromAddress: '0xaa', toAddress: '0xbb', amount: '0.0001' });

describe('estimateLines: every figure comes with its caveat', () => {
  it('prices the request, says what the balance does, and lists what was and was not looked at', () => {
    const text = estimateLines(available()).join('\n');
    expect(text).toContain('about $0.35 to open this now (platform fee $0.15 + gas $0.20; capped at $0.50)');
    expect(text).toContain('your gateway balance covers it (remaining $4.65)');
    expect(text).toContain('AN ESTIMATE as of 2026-10-16T00:00:00Z: it creates, charges and signs nothing, and promises nothing');
    expect(text).toContain('checked: chain_enabled, price_book');
    expect(text).toContain('NOT checked: the identity and its key page, destination-chain gas');
  });

  it('never shows a figure without the label and both lists, whatever the billing state', () => {
    for (const billing of [{ state: 'disabled' }, { state: 'not_gated' }, { state: 'priced', price: { total_usd: '1' } }, { state: 'odd' }, undefined]) {
      const text = estimateLines(available({ billing })).join('\n');
      expect(text, JSON.stringify(billing)).toContain('AN ESTIMATE');
      expect(text, JSON.stringify(billing)).toContain('NOT checked:');
      expect(text, JSON.stringify(billing)).toContain('checked:');
    }
  });

  it('says plainly where billing is off or the operation is not priced, and invents no price', () => {
    expect(estimateLines(available({ billing: { state: 'disabled' } })).join('\n')).toContain('billing is off on this gateway: nothing is priced');
    expect(estimateLines(available({ billing: { state: 'not_gated' } })).join('\n')).toContain('this operation is not priced');
    expect(estimateLines(available({ billing: { state: 'disabled' } })).join('\n')).not.toContain('$');
  });

  it('a shortfall is a fact: NOT covered, by how much, and whether admission would refuse', () => {
    const short = (enforcing: boolean, gate: string) => estimateLines(available({
      billing: { ...QUOTE.billing, enforcing, funds: { state: 'ok', covered: false, shortfall_usd: '0.350000', gate } },
    })).join('\n');
    expect(short(true, 'PAYMENT_REQUIRED')).toContain('does NOT cover it: short by $0.35 and admission would answer PAYMENT_REQUIRED now');
    expect(short(false, 'passes')).toContain('does NOT cover it: short by $0.35 (this gateway records a shortfall without refusing it)');
  });

  it('a balance that could not be read is not a yes', () => {
    const text = estimateLines(available({ billing: { ...QUOTE.billing, funds: { state: 'unreadable' } } })).join('\n');
    expect(text).toContain('could not be read, so whether it covers this is not known');
    expect(text).not.toContain('covers it (');
  });

  it('does not round a sub-cent figure to free', () => {
    expect(dollars('0.004000')).toBe('$0.004');
    expect(dollars('0.350000')).toBe('$0.35');
    expect(dollars('5')).toBe('$5.00');
    expect(dollars('-0.50')).toBe('-$0.50');
    expect(dollars('abc')).toBe('abc');
    expect(dollars(undefined)).toBe('unknown');
  });

  it('unavailable says so and that sending is not affected', () => {
    const text = estimateLines({ state: 'unavailable', code: 'ENDPOINT_NOT_ON_GATEWAY', reason: 'this gateway does not serve the estimate route' }).join('\n');
    expect(text).toBe('unavailable: this gateway does not serve the estimate route. Sending is not affected.');
  });

  it('the machine form is the body when there is one, and the reason when there is not', () => {
    expect(estimateJson(available())).toEqual({ estimate: QUOTE });
    expect(estimateJson({ state: 'unavailable', code: 'X', reason: 'why' })).toEqual({ estimate: null, estimate_unavailable: { code: 'X', reason: 'why' } });
  });
});

describe('the confirmation card', () => {
  const SUMMARY = {
    kind: 'cross-chain intent', principal: 'acc://a.acme/data', intentId: 'i', additionalAuthorities: [], signer: { publicKey: 'ab', keyPage: 'k', keyPageVersion: 1, timestampMicros: '1' },
    legs: [], operations: [], hashes: { transaction: 'a', signatureMetadata: 'b', toSign: 'c' }, text: ['You are about to sign: x'],
  } as unknown as SigningCard['summary'];
  const base = (over: Partial<SigningCard> = {}): SigningCard => ({
    headline: 'Send 0.0001 ETH on base-sepolia', rows: [['to', '0x1111111111111111111111111111111111111111']], chain: 'base-sepolia', fromContext: [], summary: SUMMARY, keyName: 'dev', ...over,
  });

  it('shows the estimate under the fee, aligned, and unchanged without one', () => {
    const lines = renderSigningCard(base({ fee: null, estimate: estimateLines(available()) }));
    const at = lines.findIndex((l) => l.includes('estimate '));
    expect(at).toBeGreaterThan(-1);
    expect(lines[at - 1]).toMatch(/^ {4}fee {6}/);
    expect(lines[at]).toMatch(/^ {4}estimate {2}about \$0\.35/);
    expect(lines[at + 1]).toMatch(/^ {14}your gateway balance covers it/);
    expect(lines.join('\n')).toContain('NOT checked:');
    // ("fee  not estimated" is the fee row; what must be absent is a row LABELLED estimate.)
    expect(renderSigningCard(base({ fee: null })).join('\n')).not.toMatch(/^ +estimate /m);
    expect(renderSigningCard(base({ fee: null, estimate: [] })).join('\n')).not.toMatch(/^ +estimate /m);
  });
});

// ── fetchEstimate never throws ──────────────────────────────────────────────────────────────────

let stub: Stub | undefined;
let raw: http.Server | undefined;
afterEach(async () => {
  await stub?.close(); stub = undefined;
  await new Promise<void>((r) => { if (!raw) return r(); raw.closeAllConnections?.(); raw.close(() => r()); });
  raw = undefined;
});
const clientFor = (url: string, timeoutMs = 5_000): CertenClient => new CertenClient({ apiKey: 'ck_live_x', baseUrl: url, maxRetries: 0, timeoutMs });

describe('fetchEstimate: whatever goes wrong is "unavailable", never a throw', () => {
  it('returns the gateway\'s estimate when it answers one, and asks once with the intent and no proof class unless given', async () => {
    stub = await startStub(() => ({ body: QUOTE }));
    const got = await fetchEstimate(clientFor(stub.url), INTENT);
    expect(got).toEqual({ state: 'available', quote: QUOTE });
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0]!.body).toEqual({ intent: INTENT });
    await fetchEstimate(clientFor(stub.url), INTENT, 'on_demand');
    expect(stub.seen[1]!.body).toEqual({ intent: INTENT, proof_class: 'on_demand' });
  });

  it('a gateway without the route (an older one) is unavailable, and says why', async () => {
    stub = await startStub((r) => ({ status: 404, body: { message: `Route ${r.method}:${r.path} not found`, error: 'Not Found', statusCode: 404 } }));
    const got = await fetchEstimate(clientFor(stub.url), INTENT);
    expect(got).toMatchObject({ state: 'unavailable', code: 'ENDPOINT_NOT_ON_GATEWAY' });
    expect(estimateLines(got).join('\n')).toContain('does not serve the estimate route');
  });

  it('a refusal of the intent, a server error and a rate limit are unavailable, with the gateway\'s code', async () => {
    for (const [status, code] of [[400, 'CHAIN_UNRESOLVED'], [500, 'INTERNAL_ERROR'], [429, 'RATE_LIMIT_EXCEEDED'], [403, 'FORBIDDEN']] as const) {
      stub = await startStub(() => ({ status, body: { error: `${code} happened`, code } }));
      const got = await fetchEstimate(clientFor(stub.url), INTENT);
      expect(got, code).toMatchObject({ state: 'unavailable', code });
      await stub.close(); stub = undefined;
    }
  });

  it('an answer that is not an estimate is not shown as one', async () => {
    for (const body of [{}, { ok: true }, { estimate: false, billing: {} }, 'nonsense']) {
      stub = await startStub(() => ({ body }));
      expect(await fetchEstimate(clientFor(stub.url), INTENT), JSON.stringify(body)).toMatchObject({ state: 'unavailable', code: 'ESTIMATE_UNREADABLE' });
      await stub.close(); stub = undefined;
    }
  });

  it('a gateway that never answers is given up on, in the time it was given', async () => {
    raw = http.createServer(() => { /* never answers */ });
    await new Promise<void>((r) => raw!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(raw.address() as AddressInfo).port}`;
    const started = Date.now();
    const got = await fetchEstimate(clientFor(url, 300), INTENT);
    expect(got).toMatchObject({ state: 'unavailable', code: 'NETWORK_ERROR' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a gateway that is not there at all is unavailable too', async () => {
    stub = await startStub(() => ({ body: QUOTE }));
    const url = stub.url;
    await stub.close(); stub = undefined;
    expect(await fetchEstimate(clientFor(url), INTENT)).toMatchObject({ state: 'unavailable', code: 'NETWORK_ERROR' });
  });

  it('text the gateway wrote into a refusal cannot repaint the terminal', async () => {
    const ESC = String.fromCharCode(27);
    stub = await startStub(() => ({ status: 400, body: { error: `bad${ESC}[2K${ESC}[1;32m APPROVED`, code: 'BAD_REQUEST' } }));
    const got = await fetchEstimate(clientFor(stub.url), INTENT);
    // eslint-disable-next-line no-control-regex
    expect(estimateLines(got).join('\n')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });
});

describe('the invocation checks send and quote share', () => {
  it('refuse what send has always refused, in the same words', () => {
    expect(() => assertTransferInputs('0', '0x1111111111111111111111111111111111111111')).toThrow('The amount must be greater than zero.');
    expect(() => assertTransferInputs('100000000000000', '0x1111111111111111111111111111111111111111')).toThrow();
    expect(() => assertTransferInputs('0.1', '0x123')).toThrow(/^--to: /);
    expect(() => assertTransferInputs('0.0001', '0x1111111111111111111111111111111111111111')).not.toThrow();
    expect(() => nativeAssetFor('base-sepolia', 'USDC', '1', '0x1111111111111111111111111111111111111111')).toThrow(/moves ETH, and you asked to send USDC/);
    expect(nativeAssetFor('base-sepolia', ' eth ', '1', '0x1111111111111111111111111111111111111111')).toBe('ETH');
  });

  it('the intent is the transfer the SDK opens: its fields, with a fresh id and time each call', () => {
    const a = transferIntent({ adiUrl: 'acc://a.acme', chain: 'base-sepolia', fromAddress: '0xaa', toAddress: '0xbb', amount: '0.1' });
    const b = transferIntent({ adiUrl: 'acc://a.acme', chain: 'base-sepolia', fromAddress: '0xaa', toAddress: '0xbb', amount: '0.1' });
    expect(Object.keys(a).sort()).toEqual(['adiUrl', 'amount', 'fromAddress', 'fromChain', 'id', 'initiatedBy', 'timestamp', 'toAddress', 'toChain']);
    expect(a).toMatchObject({ adiUrl: 'acc://a.acme', initiatedBy: 'acc://a.acme', fromChain: 'accumulate', toChain: 'base-sepolia', amount: '0.1' });
    expect(a.id).not.toBe(b.id);
  });
});
