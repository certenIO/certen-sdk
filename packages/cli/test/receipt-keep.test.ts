import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleReceipt, type Receipt, type TransactionResponse, type VerificationLike } from '@certen.io/sdk';
import { weakerThan } from '../src/receipt-flow.js';
import { envelope } from './helpers/run-cli.js';
import { sendEnv, readSavedReceipt, RECIPIENT, INTENT_ID, type SendEnv } from './helpers/send-env.js';

/**
 * A receipt is never silently made weaker.
 *
 * The natural sequence is `send --rpc` (the proof compared with the person's own node, the recipient's balance read) and, later, a bare
 * `receipt`. Without the node again the second read cannot reach the first one's conclusions, and if it replaced the saved file the person
 * would lose them. So a read that establishes LESS than the saved receipt, because less was asked, is shown and does not replace it; a
 * contradiction is news and always does. And a saved receipt that is final has nothing pending, so a bare `receipt` does not ask at all.
 */

const T0 = new Date('2026-10-15T12:00:00Z');
const tx = (status: string): TransactionResponse => ({ intent_id: INTENT_ID, identity_id: 'i', status, created_at: '2026-10-15T00:00:00Z', proof_id: status === 'completed' ? 'p' : null } as TransactionResponse);
const layer = (id: string, verdict: 'verified' | 'not_checked') => ({ id, title: id, verdict, ...(verdict === 'not_checked' ? { reason: 'x' } : {}) });
const verification = (overall: VerificationLike['overall'], layers: ReturnType<typeof layer>[], header: boolean): VerificationLike => ({
  overall, layers, evidenceFound: true, execution: { ok: true, txHash: `0x${'cd'.repeat(32)}`, blockNumber: 1, chainId: '84532' }, headerCheck: header ? { ok: true } : null,
});
const request = { kind: 'transfer' as const, chain: 'base-sepolia', chain_id: 84532, identity_id: 'i', adi_url: 'acc://a.acme', from: '0xa', to: RECIPIENT, amount: '0.0001', asset: 'ETH', contract_call: null };
const effect = (state: 'confirmed' | 'not_observed' | 'unchecked' | 'unreadable') => ({ kind: 'native_transfer' as const, state, amount: '0.0001', detail: state });

const strong = (): Receipt => assembleReceipt({
  intentId: INTENT_ID, transaction: tx('completed'), request, now: () => T0, effect: effect('confirmed'),
  proof: { verification: verification('partial', [layer('a', 'verified'), layer('outcome', 'verified'), layer('G1_chains', 'not_checked')], true), nodeConsulted: true },
});
const weak = (): Receipt => assembleReceipt({
  intentId: INTENT_ID, transaction: tx('completed'), request, now: () => T0, effect: effect('unchecked'),
  proof: { verification: verification('partial', [layer('a', 'verified'), layer('outcome', 'not_checked'), layer('G1_chains', 'not_checked')], false), nodeConsulted: false },
});

describe('weakerThan', () => {
  it('a read without the node that the saved receipt was checked against is weaker', () => {
    expect(weakerThan(strong(), weak())).toBe('it was compared with a node of yours and this read was not');
  });

  it('a read that no longer has the recipient\'s balance is weaker, even where the node was consulted', () => {
    const next = assembleReceipt({
      intentId: INTENT_ID, transaction: tx('completed'), request, now: () => T0, effect: effect('unreadable'),
      proof: { verification: verification('partial', [layer('a', 'verified'), layer('outcome', 'verified'), layer('G1_chains', 'not_checked')], true), nodeConsulted: true },
    });
    expect(weakerThan(strong(), next)).toBe('the recipient\'s balance had been read and this read did not');
  });

  it('a read that is as strong or stronger is not', () => {
    expect(weakerThan(strong(), strong())).toBeUndefined();
    expect(weakerThan(weak(), strong())).toBeUndefined();
    expect(weakerThan(weak(), weak())).toBeUndefined();
  });

  it('a CONTRADICTION is never weaker: a proof that now fails is news and is always kept', () => {
    const failed = assembleReceipt({
      intentId: INTENT_ID, transaction: tx('completed'), request, now: () => T0, effect: effect('unchecked'),
      proof: { verification: { ...verification('failed', [layer('a', 'verified')], false), failure: { layer: 'a', message: 'does not hold' } } },
    });
    expect(failed.verdict).toBe('failed');
    expect(weakerThan(strong(), failed)).toBeUndefined();
  });

  it('a recipient balance that did not rise (not_observed) is a reading, not a loss', () => {
    const next = assembleReceipt({
      intentId: INTENT_ID, transaction: tx('completed'), request, now: () => T0, effect: effect('not_observed'),
      proof: { verification: verification('partial', [layer('a', 'verified'), layer('outcome', 'verified'), layer('G1_chains', 'not_checked')], true), nodeConsulted: true },
    });
    expect(weakerThan(strong(), next)).toBeUndefined();
  });
});

let env: SendEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

const reads = (reqs: Array<{ method: string; path: string }>): number => reqs.filter((r) => r.method === 'GET' && r.path === `/v1/transaction/${INTENT_ID}`).length;

describe('certen receipt does not make a saved receipt weaker', () => {
  it('a bare refresh after `send --rpc` shows what it can establish, says it kept the better one, and leaves the file as it was', async () => {
    env = await sendEnv({ gateway: { statuses: ['completed'] } });
    const sent = await env.run(['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--wait', '--rpc', env.gateway.rpcUrl]);
    const strongSaved = readSavedReceipt(env.home);
    expect(strongSaved.proof.node_checked).toBe(true);
    expect(strongSaved.effect.state).toBe('confirmed');
    expect(sent.code).toBe(4); // PARTIAL only because the repo's proof fixture has unbound page chains
    const bytesBefore = readFileSync(join(env.home, '.certen', 'receipts', `${INTENT_ID}.json`), 'utf8');

    const again = await env.run(['--json', 'receipt', INTENT_ID]);
    const e = envelope(again);
    expect(e.ok).toBe(true);
    // What this read could establish, shown honestly...
    expect(e.data!.receipt.proof.node_checked).toBe(false);
    expect(e.data!.refreshed).toBe(true);
    // ...and the saved receipt untouched, with the reason.
    expect(e.data!.saved_receipt_kept).toBe('it was compared with a node of yours and this read was not');
    expect(e.data!.saved_to).toBe(join(env.home, '.certen', 'receipts', `${INTENT_ID}.json`));
    expect(again.stderr).toMatch(/The saved receipt was left as it is: it was compared with a node of yours and this read was not\. Run it again with --rpc <node>/);
    expect(readFileSync(join(env.home, '.certen', 'receipts', `${INTENT_ID}.json`), 'utf8')).toBe(bytesBefore);
  });

  it('with the node again it refreshes the saved receipt as before', async () => {
    env = await sendEnv({ gateway: { statuses: ['completed'] } });
    await env.run(['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--wait', '--rpc', env.gateway.rpcUrl]);
    const before = readSavedReceipt(env.home);
    const again = await env.run(['--json', 'receipt', INTENT_ID, '--rpc', env.gateway.rpcUrl]);
    const e = envelope(again);
    expect(e.data!.saved_receipt_kept).toBeUndefined();
    expect(e.data!.receipt.proof.node_checked).toBe(true);
    expect(readSavedReceipt(env.home).updated_at >= before.updated_at).toBe(true);
    expect(readSavedReceipt(env.home).created_at).toBe(before.created_at);
  });

  it('watch, which has no node of its own, does not replace one that was checked against yours either', async () => {
    env = await sendEnv({ gateway: { statuses: ['completed'] } });
    await env.run(['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--wait', '--rpc', env.gateway.rpcUrl]);
    const bytesBefore = readFileSync(join(env.home, '.certen', 'receipts', `${INTENT_ID}.json`), 'utf8');
    const watched = await env.run(['--json', 'watch', INTENT_ID]);
    const e = envelope(watched);
    expect(e.data!.saved_receipt_kept).toMatch(/compared with a node of yours/);
    expect(readFileSync(join(env.home, '.certen', 'receipts', `${INTENT_ID}.json`), 'utf8')).toBe(bytesBefore);
  });
});

describe('a final saved receipt is shown as saved: nothing is pending, so the gateway is not asked', () => {
  it('a failed intent: a bare `receipt` makes no request, says why, and --refresh does read the gateway', async () => {
    env = await sendEnv({ gateway: { fault: 'intent-fails', statuses: ['anchoring', 'failed'] } });
    const sent = await env.run(['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--wait', '--poll-interval', '1s']);
    expect(sent.code).toBe(1);
    expect(readSavedReceipt(env.home).verdict).toBe('failed');
    env.gateway.take();

    const shown = await env.run(['--json', 'receipt', INTENT_ID]);
    const e = envelope(shown);
    expect(shown.code).toBe(1);
    expect(e.data!.refreshed).toBe(false);
    expect(e.data!.receipt.verdict).toBe('failed');
    expect(env.gateway.take()).toEqual([]);
    expect(shown.stderr).toMatch(/The saved receipt is final \(failed\): nothing is pending, so the gateway was not asked\. --refresh reads it again/);

    const refreshed = await env.run(['--json', 'receipt', INTENT_ID, '--refresh']);
    expect(envelope(refreshed).data!.refreshed).toBe(true);
    expect(reads(env.gateway.take())).toBe(1);
  });

  it('--refresh cannot be combined with --offline', async () => {
    env = await sendEnv();
    const r = await env.run(['--json', 'receipt', INTENT_ID, '--offline', '--refresh']);
    expect(r.code).toBe(2);
    expect(envelope(r).error!.code).toBe('CONFLICTING_FLAGS');
    expect(env.gateway.take()).toEqual([]);
  });

  it('a receipt that is not final (PARTIAL) is refreshed by a bare `receipt`, as before', async () => {
    env = await sendEnv({ gateway: { statuses: ['completed'] } });
    await env.run(['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--wait']);
    env.gateway.take();
    const again = await env.run(['--json', 'receipt', INTENT_ID]);
    expect(envelope(again).data!.refreshed).toBe(true);
    expect(reads(env.gateway.take())).toBe(1);
  });
});
