import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { envelope } from './helpers/run-cli.js';
import { sendEnv, readSavedReceipt, RECIPIENT, INTENT_ID, type SendEnv, type SendEnvOptions } from './helpers/send-env.js';

/**
 * `certen watch`: picking a wait back up, and the receipt it ends in.
 *
 * `send --no-wait` returns the moment the signature is in; `watch` is the other half, and it is what Ctrl-C, a closed terminal and a wait that
 * ran out all point at. What is pinned:
 *
 *  - an intent that has already finished is not "waited for": one read, then the receipt, with no announcement of a wait that never happens;
 *  - one that has not finished is waited for at the budget it always had, announcing itself and each change of status;
 *  - however the wait ends (a failed intent, the budget running out) a receipt is SAVED from the last thing the gateway said, and the failure
 *    carries it and the exact command that picks the thread back up;
 *  - the intent keeps running while nobody watches. Nothing here cancels it.
 *
 * The fake reports the next status in `statuses` on each read of the intent (the last repeats), so a sequence reads as the intent's life.
 */

let env: SendEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

async function start(options: SendEnvOptions = {}): Promise<SendEnv> {
  env = await sendEnv(options);
  return env;
}

/** Open and sign the intent, return as soon as the signature is in (this reads the intent once: the first status of the sequence). */
async function opened(e: SendEnv): Promise<void> {
  const r = await e.run(['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--yes', '--no-wait']);
  expect(r.code === 0 || r.code === 4, `send --no-wait: ${r.stderr}`).toBe(true);
  e.gateway.take();
  e.gateway.takeNodeCalls();
}

const transactionReads = (e: SendEnv): number =>
  e.gateway.take().filter((c) => c.method === 'GET' && c.path === `/v1/transaction/${INTENT_ID}`).length;

describe('watch: an intent that has already finished', () => {
  it('is read once, not waited for, and ends in the receipt', async () => {
    const e = await start();
    await opened(e);
    const r = await e.run(['watch', INTENT_ID]);
    // The fixture's proof is PARTIAL, so exit 4: watch ends in the receipt's verdict, as `receipt` does.
    expect(r.code).toBe(4);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Waiting/);
    expect(r.stdout).toContain(INTENT_ID);
    expect(r.stdout).toContain('PARTIAL:');
    expect(r.stdout).toMatch(/Saved\s+.*receipts/);
    expect(readSavedReceipt(e.home).status.gateway_status).toBe('completed');
  });

  it('costs one read of the intent: the receipt is built from the reading that showed it finished', async () => {
    const e = await start();
    await opened(e);
    const r = await e.run(['--json', 'watch', INTENT_ID]);
    expect(r.code).toBe(4);
    const got = e.gateway.take().filter((c) => c.method === 'GET' && c.path === `/v1/transaction/${INTENT_ID}`);
    expect(got).toHaveLength(1);
    const body = envelope(r);
    expect(body.ok).toBe(true);
    expect(Object.keys(body.data!).sort()).toEqual(['receipt', 'saved_to']);
    expect(body.data!.receipt.verdict).toBe('partial');
  });

  it('--rpc closes the proof\'s execution layer with a header from your own node', async () => {
    const e = await start();
    await opened(e);
    const r = await e.run(['--json', 'watch', INTENT_ID, '--rpc', e.gateway.rpcUrl]);
    expect(r.code).toBe(4);
    const receipt = envelope(r).data!.receipt;
    expect(receipt.proof.node_checked).toBe(true);
    expect(receipt.proof.layers.find((l: { id: string }) => l.id === 'outcome').verdict).toBe('verified');
    expect(receipt.effect.state).toBe('confirmed');
  });
});

describe('watch: an intent that is still running', () => {
  it('announces the wait, reports each change of status, and ends with the receipt', async () => {
    // send --no-wait reads 'anchoring'; watch's first read sees 'anchoring' again; then the wait polls 'executed' and then 'completed'.
    const e = await start({ gateway: { statuses: ['anchoring', 'anchoring', 'executed', 'completed'] } });
    await opened(e);
    const r = await e.run(['watch', INTENT_ID, '--poll-interval', '1s']);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain(`Intent ${INTENT_ID} is anchoring. Waiting; Ctrl-C stops the wait and leaves the intent running.`);
    expect(r.stdout).toContain('Waiting for the proof cycle. This is 60-110 seconds of real validator work.');
    expect(r.stdout).toContain('Status: executed. The action ran on its chain; its proof is still being produced.');
    expect(r.stdout).toContain(INTENT_ID);
    expect(r.stdout).toContain('PARTIAL:');
    const saved = readSavedReceipt(e.home);
    expect(saved.status.gateway_status).toBe('completed');
    // The first send knew what was asked; watch did not forget it.
    expect(saved.request).toMatchObject({ kind: 'transfer', to: RECIPIENT, amount: '0.0001' });
    expect(saved.signed_with).toMatchObject({ key: 'dev' });
  });

  it('waits even with --json (watch is the command that waits), and keeps stdout to one envelope', async () => {
    const e = await start({ gateway: { statuses: ['anchoring', 'anchoring', 'completed'] } });
    await opened(e);
    const r = await e.run(['--json', 'watch', INTENT_ID, '--poll-interval', '1s']);
    expect(r.code).toBe(4);
    const body = envelope(r);
    expect(body.data!.receipt.status.outcome).toBe('completed');
  });
});

describe('watch: however the wait ends, a receipt is saved from the last reading', () => {
  it('a failed intent is TX_FAILED (exit 1), carrying a failed receipt, the reason, and how to pick it up again', async () => {
    const e = await start({ gateway: { statuses: ['anchoring', 'anchoring', 'failed'], fault: 'intent-fails' } });
    await opened(e);
    const r = await e.run(['--json', 'watch', INTENT_ID, '--poll-interval', '1s']);
    expect(r.code).toBe(1);
    const error = envelope(r).error!;
    expect(error.code).toBe('TX_FAILED');
    expect(error.details.intent_id).toBe(INTENT_ID);
    expect(error.details.reason_code).toBe('target_reverted');
    expect(error.details.resume).toBe(`certen watch ${INTENT_ID}`);
    expect(error.details.receipt).toMatchObject({ verdict: 'failed', intent_id: INTENT_ID });
    expect(error.details.receipt_path).toBe(join(e.home, '.certen', 'receipts', `${INTENT_ID}.json`));
    // The human reading of the same failure went to stderr; stdout is the one envelope.
    expect(r.stderr).toContain('FAILED');
    const saved = readSavedReceipt(e.home);
    expect(saved.verdict).toBe('failed');
    expect(saved.status.reason_code).toBe('target_reverted');
    expect(saved.request).toMatchObject({ kind: 'transfer', to: RECIPIENT });
  });

  it('the budget running out is TX_WAIT_TIMEOUT (exit 1, "it may yet complete"), with a pending receipt and the command to continue', async () => {
    const e = await start({ gateway: { statuses: ['anchoring'] } });
    await opened(e);
    const r = await e.run(['--json', 'watch', INTENT_ID, '--timeout', '3s', '--poll-interval', '1s']);
    expect(r.code).toBe(1);
    const error = envelope(r).error!;
    expect(error.code).toBe('TX_WAIT_TIMEOUT');
    expect(error.message).toContain('It may yet complete');
    expect(error.details.resume).toBe(`certen watch ${INTENT_ID}`);
    expect(error.details.receipt.verdict).toBe('pending');
    expect(r.stderr).toContain(`Pick it back up: certen watch ${INTENT_ID}`);
    expect(readSavedReceipt(e.home).verdict).toBe('pending');
    expect(transactionReads(e)).toBeGreaterThanOrEqual(3);
  });

  it('a bad --timeout is refused before any request', async () => {
    const e = await start();
    const r = await e.run(['--json', 'watch', INTENT_ID, '--timeout', 'soon']);
    expect(r.code).toBe(2);
    expect(envelope(r).error).toMatchObject({ code: 'INVALID_TIMEOUT' });
    expect(e.gateway.take()).toEqual([]);
  });
});

describe('watch: what it refuses', () => {
  it('an id that is not an id is INVALID_INTENT_ID (exit 2), before any request', async () => {
    const e = await start();
    const r = await e.run(['--json', 'watch', 'not-an-intent']);
    expect(r.code).toBe(2);
    expect(envelope(r).error).toMatchObject({ code: 'INVALID_INTENT_ID' });
    expect(e.gateway.take()).toEqual([]);
  });

  it('an intent the gateway has never heard of is the gateway\'s own 404 (exit 1), and no receipt is written', async () => {
    const e = await start();
    const r = await e.run(['--json', 'watch', '99999999-8888-4777-8666-555555555555']);
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ status: 404 });
    expect(existsSync(join(e.home, '.certen', 'receipts'))).toBe(false);
  });
});
