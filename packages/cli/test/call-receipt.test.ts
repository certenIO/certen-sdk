import { describe, it, expect, afterEach } from 'vitest';
import { envelope } from './helpers/run-cli.js';
import { sendEnv, savedReceipts, readSavedReceipt, INTENT_ID, type SendEnv } from './helpers/send-env.js';

/**
 * `certen call --wait` ends in a receipt, at a terminal, and `--expect` makes the receipt check an event.
 *
 * What is pinned is what changing `call` could break. Its `--json` envelope is the transaction, as it always was, and its exit code is what it
 * always returned: the receipt is a second look and costs a script nothing it did not ask for. Naming an event with `--expect` IS asking for the
 * answer, so then, and only then, the envelope gains the receipt and the exit code is the receipt's.
 */

const LEDGER = '0x41bc4283624ff703a6e15b1c2aafae95a5eb335e';
const CLAIM_PAID = '0x81eb79acc6a0ef94dfb507ea35363f86d0d190b46f4d608dc4c1d7480a7c7cbc';
const CALL = ['call', '--to', LEDGER, '--fn', 'confirm(bytes32)', '--arg', `0x${'00'.repeat(32)}`, '--yes'];

let env: SendEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

describe('call --wait at a terminal ends in the receipt', () => {
  it('prints the receipt after what it always printed, saves it, and returns what it always returned', async () => {
    env = await sendEnv();
    const r = await env.run([...CALL, '--wait']);
    // The proof fixture is a PARTIAL, and `call` still exits 0: a receipt is a second look, not a change of what `call` returns.
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Intent ${INTENT_ID} is completed.`);
    expect(r.stderr).toContain(`Next: certen proof get ${INTENT_ID}`);
    expect(r.stdout).toMatch(/Called\s+confirm\(bytes32\) on 0x41bc4283624ff703a6e15b1c2aafae95a5eb335e \(base-sepolia\)/);
    expect(r.stdout).toMatch(/Proof\s+PARTIAL: /);
    expect(r.stdout).toMatch(/Saved\s+\S+7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13\.json/);
    expect(savedReceipts(env.home)).toEqual([`${INTENT_ID}.json`]);
    const saved = readSavedReceipt(env.home);
    expect(saved.kind).toBe('contract_call');
    expect(saved.request.contract_call).toEqual({ target: LEDGER, function_signature: 'confirm(bytes32)', value_wei: '0' });
    expect(saved.signed_with).toMatchObject({ key: 'dev' });
  });

  it('the card was shown first (to stderr), and the receipt is stdout: nothing human on the machine channel in --json', async () => {
    env = await sendEnv();
    const r = await env.run([...CALL, '--wait']);
    expect(r.stderr).toMatch(/Call confirm\(bytes32\) on base-sepolia/);
    expect(r.stderr).toMatch(/You are about to sign: cross-chain intent/);
  });
});

describe('call --json is exactly what it was', () => {
  it('the envelope is the transaction, there is no receipt in it, nothing is saved, and the exit code is the call\'s', async () => {
    env = await sendEnv();
    const r = await env.run(['--json', ...CALL, '--wait']);
    expect(r.code, r.stderr).toBe(0);
    const e = envelope(r);
    expect(e.ok).toBe(true);
    expect(e.data!.status).toBe('completed');
    expect(e.data!.intent_id).toBe(INTENT_ID);
    expect(Object.keys(e.data!)).not.toContain('receipt');
    expect(Object.keys(e.data!)).not.toContain('receipt_path');
    expect(savedReceipts(env.home)).toEqual([]);
  });
});

describe('call --expect: naming an event is asking for the check', () => {
  it('the event is in the proof\'s receipt: the envelope gains the receipt, the effect is confirmed, and the exit code is the receipt\'s (4: the fixture is a PARTIAL)', async () => {
    env = await sendEnv();
    const r = await env.run(['--json', ...CALL, '--wait', '--expect', `${LEDGER}:${CLAIM_PAID}`]);
    const e = envelope(r);
    expect(e.ok).toBe(true);
    // Still the transaction, with the receipt added.
    expect(e.data!.status).toBe('completed');
    expect(e.data!.receipt.kind).toBe('contract_call');
    expect(e.data!.receipt.effect).toMatchObject({ kind: 'contract_call', state: 'confirmed', expected_event: { found: true } });
    expect(e.data!.receipt_path).toMatch(/7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13\.json$/);
    expect(r.code).toBe(4);
    expect(readSavedReceipt(env.home).effect.state).toBe('confirmed');
  });

  it('the event is NOT there: the receipt FAILS (the proof\'s execution layer does not hold), and so does the exit code', async () => {
    env = await sendEnv();
    const r = await env.run(['--json', ...CALL, '--wait', '--expect', `${LEDGER}:0x${'ab'.repeat(32)}`]);
    const e = envelope(r);
    expect(e.ok).toBe(true);
    expect(e.data!.receipt.effect).toMatchObject({ state: 'not_observed', expected_event: { found: false } });
    expect(e.data!.receipt.verdict).toBe('failed');
    expect(r.code).toBe(1);
  });

  it('at a terminal the receipt says so too, and the exit code is the receipt\'s', async () => {
    env = await sendEnv();
    const r = await env.run([...CALL, '--wait', '--expect', `${LEDGER}:${CLAIM_PAID}`]);
    expect(r.stdout).toMatch(/Effect\s+The expected event is in the proof's receipt\./);
    expect(r.code).toBe(4);
  });

  it('without the wait there is nothing to check: refused before any request, naming the way out', async () => {
    env = await sendEnv();
    const r = await env.run(['--json', ...CALL, '--no-wait', '--expect', `${LEDGER}:${CLAIM_PAID}`]);
    expect(r.code).toBe(2);
    const err = envelope(r).error!;
    expect(err.code).toBe('EXPECT_NEEDS_WAIT');
    expect(err.message).toContain('certen receipt <intent> --expect');
    expect(env.gateway.take()).toEqual([]);
  });

  it('--json without --wait is the same refusal: a machine call does not wait unless told to', async () => {
    env = await sendEnv();
    const r = await env.run(['--json', ...CALL, '--expect', `${LEDGER}:${CLAIM_PAID}`]);
    expect(r.code).toBe(2);
    expect(envelope(r).error!.code).toBe('EXPECT_NEEDS_WAIT');
    expect(env.gateway.take()).toEqual([]);
  });

  it.each([
    ['too many parts', `${LEDGER}:${CLAIM_PAID}:${CLAIM_PAID}:x`],
    ['an address that is not an address', `0x1234:${CLAIM_PAID}`],
    ['a topic that is not 32 bytes', `${LEDGER}:0xabcd`],
    ['neither a contract nor an event', ':'],
  ])('a malformed --expect (%s) is a usage error before any request, not an event "missing" from a receipt', async (_why, value) => {
    env = await sendEnv();
    const r = await env.run(['--json', ...CALL, '--wait', '--expect', value]);
    expect(r.code).toBe(2);
    expect(envelope(r).error!.code).toBe('INVALID_EXPECT');
    expect(env.gateway.take()).toEqual([]);
  });
});
