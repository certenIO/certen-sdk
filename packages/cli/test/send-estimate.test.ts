import { describe, it, expect, afterEach } from 'vitest';
import { envelope } from './helpers/run-cli.js';
import { sendEnv, RECIPIENT, ABSTRACT_ACCOUNT, ADI, type SendEnv } from './helpers/send-env.js';
import { frontGateway, type Stub, type Reply, type Seen } from './helpers/stub-gateway.js';

/**
 * `certen send` and the gateway's estimate on its confirmation card.
 *
 * The estimate is a convenience, and the property that matters is that it is only that: whatever the estimate route does, the send is the same
 * send. What is pinned:
 *
 * - when the gateway answers, the card carries it, labelled an estimate, with what was and was not checked;
 * - it estimates the request the send really makes (the quoted intent is compared field for field with the one the send submits);
 * - when it cannot be had (no route, a server error, an answer that is not an estimate) the card says "unavailable", and the send signs, waits and
 *   writes the same receipt with the same exit code as it does with an estimate;
 * - it is asked once, before the intent is opened and before any signature.
 */

const SEND = ['send', '0.0001', 'ETH', '--to', RECIPIENT, '--yes', '--wait'];

interface Rig { env: SendEnv; front: Stub; run: SendEnv['run']; quotes(): Seen[]; order(): string[] }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });

/** The fake gateway behind a front whose quote route is whatever `quote` says (or the fake's own answer when it says nothing). */
async function rig(quote?: (r: Seen) => Reply | undefined): Promise<Rig> {
  const env = await sendEnv();
  const front = await frontGateway(env.gateway.url, (request) => (request.method === 'POST' && request.path === '/v1/transaction/quote' ? quote?.(request) : undefined));
  cleanups.push(() => front.close(), () => env.close());
  return {
    env, front,
    run: (args, opts = {}) => env.run(args, { ...opts, env: { ...(opts.env ?? {}), CERTEN_API_URL: front.url } }),
    quotes: () => front.seen.filter((r) => r.path === '/v1/transaction/quote'),
    order: () => front.calls().map((c) => `${c.method} ${c.path}`),
  };
}

describe('when the gateway answers an estimate', () => {
  it('the card carries it, labelled, and the quoted intent is the one the send submits', async () => {
    const t = await rig();
    const r = await t.run(SEND);
    expect([0, 4], r.stderr).toContain(r.code);

    expect(r.stderr).toMatch(/estimate {2}about \$0\.15 to open this now/);
    expect(r.stderr).toContain('AN ESTIMATE as of 2026-10-15T00:00:00Z: it creates, charges and signs nothing, and promises nothing');
    expect(r.stderr).toContain('NOT checked: the identity and its key page, destination-chain gas, quota, the bridge\'s own validation');
    // The card still has the fee from the price book and the rebuilt summary the signature is checked against.
    expect(r.stderr).toContain('The signature authorises exactly this');

    // Asked once, and before anything is opened or signed.
    expect(t.quotes()).toHaveLength(1);
    const order = t.order();
    expect(order.indexOf('POST /v1/transaction/quote')).toBeGreaterThan(-1);
    expect(order.indexOf('POST /v1/transaction/quote')).toBeLessThan(order.indexOf('POST /v1/transaction'));
    expect(order.filter((o) => o === 'POST /v1/transaction')).toHaveLength(1);

    // The drift guard: the estimate is of THIS request. Everything but the per-call id and time is equal to what the send opened.
    const quoted = t.quotes()[0]!.body.intent as Record<string, unknown>;
    const opened = t.env.gateway.lastIntent().body!.intent as Record<string, unknown>;
    const { id: qi, timestamp: qt, ...quotedRest } = quoted;
    const { id: oi, timestamp: ot, ...openedRest } = opened;
    expect(typeof qi).toBe('string');
    expect(typeof qt).toBe('number');
    expect(typeof oi).toBe('string');
    expect(typeof ot).toBe('number');
    expect(quotedRest).toEqual(openedRest);
    expect(quotedRest).toMatchObject({ adiUrl: ADI, fromAddress: ABSTRACT_ACCOUNT, toAddress: RECIPIENT, amount: '0.0001', toChain: 'base-sepolia' });
  }, 90_000);

  it('--proof-class is quoted as it will be sent', async () => {
    const t = await rig();
    const r = await t.run([...SEND, '--proof-class', 'on_demand', '--dry-run']);
    expect(r.code, r.stderr).toBe(0);
    expect(t.quotes()[0]!.body.proof_class).toBe('on_demand');
  });

  it('--dry-run shows it, and --json carries it next to the fee', async () => {
    const t = await rig();
    const human = await t.run(['send', '0.0001', 'ETH', '--to', RECIPIENT, '--dry-run']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/estimate +about \$0\.15 to open this now/);
    expect(human.stdout).toContain('AN ESTIMATE');
    const json = envelope(await t.run(['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--dry-run']));
    expect(json.data!.estimate).toMatchObject({ estimate: true, evaluated_at: '2026-10-15T00:00:00Z' });
    expect(json.data!.estimate_unavailable).toBeUndefined();
    expect(json.data!.dry_run).toBe(true);
  }, 60_000);
});

describe('when it cannot be had, the send is the same send', () => {
  const FAILURES: Array<[string, (r: Seen) => Reply, RegExp]> = [
    ['a gateway without the route', (r) => ({ status: 404, body: { message: `Route ${r.method}:${r.path} not found`, error: 'Not Found', statusCode: 404 } }), /this gateway does not serve the estimate route/],
    ['a server error', () => ({ status: 500, body: { error: 'boom', code: 'INTERNAL_ERROR' } }), /INTERNAL_ERROR: boom/],
    ['a refusal of the intent', () => ({ status: 400, body: { error: 'no chain', code: 'CHAIN_UNRESOLVED' } }), /CHAIN_UNRESOLVED: no chain/],
    ['an answer that is not an estimate', () => ({ status: 200, body: { ok: true } }), /the gateway answered, but not with an estimate/],
  ];

  it.each(FAILURES)('%s: "unavailable" on the card, and it signs, waits and writes the receipt as before', async (_label, reply, reason) => {
    const t = await rig((r) => reply(r));
    const r = await t.run(SEND);
    // The same exit code a send with an estimate earns (the fixture proof is an honest PARTIAL), and the same one envelope.
    expect([0, 4], r.stderr).toContain(r.code);
    expect(r.stderr).toMatch(reason);
    expect(r.stderr).toMatch(/estimate {2}unavailable: .*Sending is not affected\./);
    expect(r.stderr).not.toContain('AN ESTIMATE');
    expect(r.stderr).toContain('The signature authorises exactly this');
    expect(t.order().filter((o) => o === 'POST /v1/transaction')).toHaveLength(1);
    expect(t.order().filter((o) => /^POST \/v1\/transaction\/[^/]+\/signature$/.test(o))).toHaveLength(1);
    expect(r.stdout).toContain('Proof');
  }, 90_000);

  it('the same send, byte for byte, with and without an estimate: exit code and receipt verdict', async () => {
    const withEstimate = await rig();
    const without = await rig(() => ({ status: 404, body: { message: 'Route POST:/v1/transaction/quote not found', error: 'Not Found', statusCode: 404 } }));
    const a = await withEstimate.run(['--json', ...SEND]);
    const b = await without.run(['--json', ...SEND]);
    expect(b.code).toBe(a.code);
    const ea = envelope(a).data!;
    const eb = envelope(b).data!;
    expect(eb.receipt.verdict).toBe(ea.receipt.verdict);
    expect(eb.receipt.headline).toBe(ea.receipt.headline);
    expect(Object.keys(eb).sort()).toEqual(Object.keys(ea).sort());
  }, 120_000);

  it('--dry-run says so in the envelope instead of leaving the key out', async () => {
    const t = await rig(() => ({ status: 404, body: { message: 'Route POST:/v1/transaction/quote not found', error: 'Not Found', statusCode: 404 } }));
    const json = envelope(await t.run(['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--dry-run']));
    expect(json.data!.estimate).toBeNull();
    expect(json.data!.estimate_unavailable).toMatchObject({ code: 'ENDPOINT_NOT_ON_GATEWAY' });
    const human = await t.run(['send', '0.0001', 'ETH', '--to', RECIPIENT, '--dry-run']);
    expect(human.stdout).toMatch(/estimate +unavailable: this gateway does not serve the estimate route/);
  }, 60_000);
});

describe('what the estimate does not touch', () => {
  it('a send that is refused before the network never asks for one', async () => {
    const t = await rig();
    const r = await t.run(['--json', 'send', '0', 'ETH', '--to', RECIPIENT, '--yes']);
    expect(r.code).toBe(2);
    expect(t.front.seen).toHaveLength(0);
  });

  it('a send that fails its readiness checks never asks for one (nothing to estimate, and nothing is signed)', async () => {
    const env = await sendEnv({ funded: false });
    const front = await frontGateway(env.gateway.url, () => undefined);
    cleanups.push(() => front.close(), () => env.close());
    const r = await env.run(['--json', ...SEND], { env: { CERTEN_API_URL: front.url } });
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ code: 'NOT_READY' });
    expect(front.seen.some((s) => s.path === '/v1/transaction/quote')).toBe(false);
    expect(front.seen.some((s) => s.method === 'POST' && s.path === '/v1/transaction')).toBe(false);
  }, 60_000);
});
