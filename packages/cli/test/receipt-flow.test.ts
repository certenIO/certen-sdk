import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// The measurement harness's fake gateway: plain JavaScript, imported as it is.
// @ts-ignore - no declaration file for a .mjs script
import { startFakeGateway, IDS } from '../../../scripts/lib/fake-gateway.mjs';

/**
 * `followIntent`: wait for an intent (unless told not to), build its receipt, save it, and however the wait ends leave a saved receipt and the
 * command that picks it back up.
 *
 * Driven in-process, because the parts that matter here cannot be reached from a subprocess on Windows: node ends a child on SIGINT instead of
 * delivering it, and an injected clock and sleep are the only way to watch a 30-second retry take no time. So Ctrl-C is a stand-in emitter, the
 * sleep is a spy, and the gateway is the real in-process fake on loopback. What is pinned:
 *
 *  - Ctrl-C stops the WAIT, not the intent: no request after it, a receipt from the last reading, exit 130, and the listener for it is gone;
 *  - a failed intent and a wait that ran out each leave a saved receipt and carry it in the error, with `certen watch <id>` to continue;
 *  - the first reading is saved at once, so the ids survive a crash during the wait;
 *  - a proof that could not be FETCHED is asked for again a bounded number of times and, if it is still not there, is `unavailable` (a gap),
 *    never thrown and never a pass.
 */

let scratch = '';
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => scratch }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => scratch }));

const RECIPIENT = '0x1111111111111111111111111111111111111111';
const FAST = { timeoutMs: 20_000, intervalMs: 20 };

type Gateway = Awaited<ReturnType<typeof startFakeGateway>>;
let gw: Gateway | undefined;
let logged: string[] = [];
let errored: string[] = [];
const savedPath = (): string => join(scratch, '.certen', 'receipts', `${IDS.intent}.json`);

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'certen-flow-'));
  for (const v of Object.keys(process.env)) if (v.startsWith('CERTEN_')) delete process.env[v];
  // axios honours HTTP_PROXY, and a proxy in the caller's environment would be handed requests for 127.0.0.1 it cannot serve.
  process.env.NO_PROXY = '127.0.0.1,localhost';
  process.env.no_proxy = '127.0.0.1,localhost';
  logged = [];
  errored = [];
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errored.push(a.join(' ')); });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await gw?.close();
  gw = undefined;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
});

async function load() {
  return {
    flow: await import('../src/receipt-flow.js'),
    interrupt: await import('../src/interrupt.js'),
    sdk: await import('@certen.io/sdk'),
    output: await import('../src/output.js'),
  };
}

/** Start the fake, open the intent the way `send` does (without signing), and give back a client on the same SDK the CLI modules use. */
async function opened(options: Record<string, unknown> = {}) {
  gw = await startFakeGateway(options);
  const m = await load();
  const res = await fetch(`${gw.url}/v1/transaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identity_id: IDS.identity, signer_public_key: '11'.repeat(32),
      intent: { adiUrl: IDS.adi, fromChain: 'accumulate', toChain: 'base-sepolia', fromAddress: IDS.abstractAccount, toAddress: RECIPIENT, amount: '0.0001' },
    }),
  });
  expect(res.status).toBe(201);
  gw.take();
  const client = new m.sdk.CertenClient({ apiKey: 'ck_test_not_a_real_key', baseUrl: gw.url });
  const request = {
    kind: 'transfer' as const, chain: 'base-sepolia', chain_id: 84532, identity_id: IDS.identity, adi_url: IDS.adi, from: IDS.abstractAccount, to: RECIPIENT,
    amount: '0.0001', asset: 'ETH', contract_call: null,
  };
  const args = (over: Record<string, unknown> = {}) => ({
    client, intentId: IDS.intent as string, gateway: gw!.url as string, wait: true, budget: FAST, request, resumeCommand: `certen watch ${IDS.intent}`, ...over,
  });
  return { ...m, client, request, args };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((r) => { setTimeout(r, 10); });
  }
}

/** A stand-in for `process`, so Ctrl-C can be sent without node ending the test run. Records how many listeners there are as the wait begins. */
function fakeProcess(m: Awaited<ReturnType<typeof load>>) {
  const proc = new EventEmitter();
  const during: number[] = [];
  const trap = () => {
    const t = m.interrupt.trapSigint(proc as unknown as Pick<NodeJS.Process, 'on' | 'off'>);
    during.push(proc.listenerCount('SIGINT'));
    return t;
  };
  return { proc, trap, during };
}

describe('Ctrl-C while waiting', () => {
  it('stops the wait, not the intent: INTERRUPTED (130), a receipt from the last reading, the command to continue, and no request after it', async () => {
    const o = await opened({ statuses: ['anchoring'] });
    const fp = fakeProcess(o);
    // A long poll interval: the wait must wake the moment Ctrl-C arrives, not at the end of the nap.
    const pending = o.flow.followIntent(o.args({ trap: fp.trap, budget: { timeoutMs: 60_000, intervalMs: 30_000 } }));
    const settled = pending.then(() => undefined, (e: unknown) => e);
    await until(() => gw!.intentReads() >= 1 && existsSync(savedPath()));
    const started = Date.now();
    fp.proc.emit('SIGINT');
    const err = (await settled) as { code: string; exitCode: number; message: string; details: Record<string, any> };

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toMatchObject({ code: 'INTERRUPTED', exitCode: 130 });
    expect(err.details).toMatchObject({
      intent_id: IDS.intent, resume: `certen watch ${IDS.intent}`, receipt_path: savedPath(), last_status: 'anchoring',
    });
    expect(err.details.receipt).toMatchObject({ intent_id: IDS.intent, verdict: 'pending', kind: 'transfer' });
    // Saved from the reading it had: pending, with the request it was given.
    const saved = JSON.parse(readFileSync(savedPath(), 'utf8'));
    expect(saved.status.gateway_status).toBe('anchoring');
    expect(saved.request.to).toBe(RECIPIENT);

    // Said, in words, on stderr.
    expect(errored.join('\n')).toContain(`Stopped waiting. The intent ${IDS.intent} keeps running on the gateway; nothing was cancelled.`);
    expect(errored.join('\n')).toContain(`Pick it back up: certen watch ${IDS.intent}`);

    // The intent is left alone: after the reading that was saved, nothing was asked of the gateway, and nothing was cancelled.
    const after = gw!.take();
    expect(after.every((r: { method: string; path: string }) => r.method === 'GET' && r.path === `/v1/transaction/${IDS.intent}`)).toBe(true);
    expect(after).toHaveLength(1);
  });

  it('removes its listener however the wait ends: one while waiting, none after, on the error path and on the success path', async () => {
    const stopped = await opened({ statuses: ['anchoring'] });
    const a = fakeProcess(stopped);
    const p = stopped.flow.followIntent(stopped.args({ trap: a.trap, budget: { timeoutMs: 60_000, intervalMs: 30_000 } }));
    const settled = p.then(() => undefined, (e: unknown) => e);
    await until(() => gw!.intentReads() >= 1);
    expect(a.proc.listenerCount('SIGINT')).toBe(1);
    a.proc.emit('SIGINT');
    expect(await settled).toMatchObject({ code: 'INTERRUPTED' });
    expect(a.during).toEqual([1]);
    // A listener left behind would stop Ctrl-C working in every later step: node's default goes the moment any listener is registered.
    expect(a.proc.listenerCount('SIGINT')).toBe(0);

    await gw!.close();
    const done = await opened();
    const b = fakeProcess(done);
    const followed = await done.flow.followIntent(done.args({ trap: b.trap }));
    expect(followed.receipt.status.outcome).toBe('completed');
    expect(b.during).toEqual([1]);
    expect(b.proc.listenerCount('SIGINT')).toBe(0);
  });

  it('disposes the trap on the error path (the real one is idempotent, so twice is harmless)', async () => {
    const o = await opened({ statuses: ['anchoring'] });
    const dispose = vi.fn();
    const controller = new AbortController();
    const trap = () => ({ signal: controller.signal, dispose });
    const p = o.flow.followIntent(o.args({ trap, budget: { timeoutMs: 60_000, intervalMs: 30_000 } }));
    const settled = p.then(() => undefined, (e: unknown) => e);
    await until(() => gw!.intentReads() >= 1);
    controller.abort();
    expect(await settled).toMatchObject({ code: 'INTERRUPTED' });
    expect(dispose).toHaveBeenCalled();
  });
});

describe('however else the wait ends, a receipt is saved and carried in the error', () => {
  it('a failed intent: TX_FAILED with the failed receipt, the reason code, the saved path and how to continue', async () => {
    const o = await opened({ statuses: ['anchoring', 'failed'], fault: 'intent-fails' });
    const fp = fakeProcess(o);
    const err = await o.flow.followIntent(o.args({ trap: fp.trap })).then(() => undefined, (e: unknown) => e) as { code: string; exitCode: number; details: Record<string, any> };
    expect(err).toMatchObject({ code: 'TX_FAILED', exitCode: 1 });
    expect(err.details).toMatchObject({ intent_id: IDS.intent, reason_code: 'target_reverted', resume: `certen watch ${IDS.intent}`, receipt_path: savedPath() });
    expect(err.details.receipt).toMatchObject({ verdict: 'failed', intent_id: IDS.intent });
    expect(JSON.parse(readFileSync(savedPath(), 'utf8')).verdict).toBe('failed');
    // The receipt is shown where a person is reading: the failure is not only a code.
    expect(logged.join('\n')).toContain('FAILED');
    expect(fp.proc.listenerCount('SIGINT')).toBe(0);
  });

  it('a wait that ran out: TX_WAIT_TIMEOUT ("it may yet complete") with a pending receipt, and the budget is not shortened for it', async () => {
    const o = await opened({ statuses: ['anchoring'] });
    const err = await o.flow.followIntent(o.args({ budget: { timeoutMs: 250, intervalMs: 20 } })).then(() => undefined, (e: unknown) => e) as { code: string; message: string; details: Record<string, any> };
    expect(err).toMatchObject({ code: 'TX_WAIT_TIMEOUT' });
    expect(err.message).toContain('It may yet complete');
    expect(err.details).toMatchObject({ intent_id: IDS.intent, resume: `certen watch ${IDS.intent}`, timeout_ms: 250 });
    expect(err.details.receipt.verdict).toBe('pending');
    expect(errored.join('\n')).toContain(`The wait ran out; the intent may still complete. Pick it back up: certen watch ${IDS.intent}`);
    expect(JSON.parse(readFileSync(savedPath(), 'utf8')).verdict).toBe('pending');
  });

  it('saves the first reading AT ONCE, while the wait is still going, so the ids survive a crash', async () => {
    const o = await opened({ statuses: ['anchoring', 'completed'] });
    let done = false;
    const p = o.flow.followIntent(o.args({ budget: { timeoutMs: 20_000, intervalMs: 400 } })).then((x: unknown) => { done = true; return x; });
    await until(() => existsSync(savedPath()));
    expect(done).toBe(false);
    expect(JSON.parse(readFileSync(savedPath(), 'utf8')).status.gateway_status).toBe('anchoring');
    const finished = await p as { receipt: { status: { gateway_status: string } } };
    expect(finished.receipt.status.gateway_status).toBe('completed');
    expect(JSON.parse(readFileSync(savedPath(), 'utf8')).status.gateway_status).toBe('completed');
  });
});

describe('a proof that could not be fetched', () => {
  it('is asked for again a bounded number of times, then reported as unavailable: a gap, never thrown and never a pass', async () => {
    const o = await opened({ portableStatus: 403 });
    const sleep = vi.fn(async () => undefined);
    const followed = await o.flow.followIntent(o.args({ sleep }));

    expect(followed.receipt.proof.verdict).toBe('unavailable');
    expect(followed.receipt.verdict).toBe('partial');
    expect(followed.receipt.gaps.map((g: { code: string }) => g.code)).toContain('PROOF_NOT_FETCHED');
    expect(followed.exitCode).toBe(4);

    // 1 + PROOF_GRACE.attempts, each after a nap of the stated length; the napping is the injected sleep, so this takes no time.
    expect(sleep).toHaveBeenCalledTimes(o.flow.PROOF_GRACE.attempts);
    for (const call of sleep.mock.calls) expect(call[0]).toBe(o.flow.PROOF_GRACE.intervalMs);
    const reqs = gw!.take().map((r: { method: string; path: string }) => `${r.method} ${r.path}`);
    expect(reqs.filter((r: string) => r === `GET /v1/proof/${IDS.proof}/v2`)).toHaveLength(1 + o.flow.PROOF_GRACE.attempts);
    // The intent itself is read once (the wait's poll); every rebuild reuses that reading.
    expect(reqs.filter((r: string) => r === `GET /v1/transaction/${IDS.intent}`)).toHaveLength(1);
    expect(logged.join('\n')).toContain(`The proof could not be fetched yet; asking again in ${o.flow.PROOF_GRACE.intervalMs / 1000}s (1 of ${o.flow.PROOF_GRACE.attempts}).`);
  });

  it('is not asked for again when nobody is waiting (wait: false)', async () => {
    const o = await opened({ portableStatus: 403 });
    const sleep = vi.fn(async () => undefined);
    const followed = await o.flow.followIntent(o.args({ wait: false, sleep }));
    expect(followed.receipt.proof.verdict).toBe('unavailable');
    expect(sleep).not.toHaveBeenCalled();
    const reqs = gw!.take().map((r: { method: string; path: string }) => `${r.method} ${r.path}`);
    expect(reqs.filter((r: string) => r === `GET /v1/proof/${IDS.proof}/v2`)).toHaveLength(1);
  });

  it('a proof service that is DOWN (503) is retried like any other fetch failure: a bad moment is not the absence of a proof', async () => {
    const o = await opened({ fault: 'proof-service-down' });
    const sleep = vi.fn(async () => undefined);
    const followed = await o.flow.followIntent(o.args({ sleep }));
    expect(followed.receipt.proof.verdict).toBe('unavailable');
    expect(followed.exitCode).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(o.flow.PROOF_GRACE.attempts);
    // The grace sleeps are injected (so the test does not wait out 3 x 10s), but the SDK client still retries each 503 with its own backoff, on
    // each of the four attempts: that real waiting is the cost of a service that is down, and it is why this one has a longer timeout.
  }, 180_000);
});

describe('what it does and does not do', () => {
  it('an intent the caller has just read and found finished is not waited for, installs no trap, and costs no further read', async () => {
    const o = await opened();
    const transaction = await o.client.transaction.get(IDS.intent);
    gw!.take();
    const trap = vi.fn();
    const followed = await o.flow.followIntent(o.args({ transaction, trap }));
    expect(trap).not.toHaveBeenCalled();
    expect(gw!.take().filter((r: { method: string; path: string }) => r.path === `/v1/transaction/${IDS.intent}`)).toHaveLength(0);
    expect(followed.receipt.status.outcome).toBe('completed');
    expect(followed.path).toBe(savedPath());
  });

  it('persist: false builds the receipt and writes nothing, on the success path and on the failure path', async () => {
    const o = await opened();
    const followed = await o.flow.followIntent(o.args({ persist: false }));
    expect(followed.path).toBeNull();
    expect(followed.receipt.intent_id).toBe(IDS.intent);
    expect(existsSync(join(scratch, '.certen'))).toBe(false);

    await gw!.close();
    const stuck = await opened({ statuses: ['anchoring'] });
    const err = await stuck.flow.followIntent(stuck.args({ persist: false, budget: { timeoutMs: 150, intervalMs: 20 } })).then(() => undefined, (e: unknown) => e) as { code: string; details: Record<string, any> };
    expect(err.code).toBe('TX_WAIT_TIMEOUT');
    expect(err.details.receipt_path).toBeNull();
    expect(err.details.receipt.verdict).toBe('pending');
    expect(existsSync(join(scratch, '.certen'))).toBe(false);
  });

  it('writes one file, atomically: no temporary file is left in the receipts directory', async () => {
    const o = await opened({ statuses: ['anchoring', 'completed'] });
    await o.flow.followIntent(o.args({ budget: { timeoutMs: 20_000, intervalMs: 50 } }));
    expect(readdirSync(join(scratch, '.certen', 'receipts'))).toEqual([`${IDS.intent}.json`]);
  });

  it('keeps the request it was given when it is run again from the saved receipt', async () => {
    const o = await opened();
    const first = await o.flow.followIntent(o.args());
    const again = await o.flow.followIntent(o.args({ wait: false, previous: first.receipt, request: undefined }));
    expect(again.receipt.request).toEqual(o.request);
    expect(again.receipt.created_at).toBe(first.receipt.created_at);
  });

  it('on a transfer that finished, the sender\'s balance is read once more, from the gateway, and shown as supporting evidence only', async () => {
    const o = await opened({ debitSender: true });
    gw!.adoptIdentity('ab'.repeat(32));
    gw!.fundAbstractAccount();
    gw!.take();
    const followed = await o.flow.followIntent(o.args({ sender: { address: IDS.abstractAccount, before: '0.001' } }));
    expect(followed.receipt.effect.sender).toMatchObject({ source: 'gateway', before: '0.001', after: '0.0009', delta: '-0.0001' });
    // Supporting evidence never decides: the recipient was not checked (no node), so the effect is unchecked.
    expect(followed.receipt.effect.state).toBe('unchecked');
    expect(gw!.take().filter((r: { path: string }) => r.path === `/v1/identity/${IDS.identity}`)).toHaveLength(1);
  });
});

describe('senderBalance', () => {
  it('is null when the gateway cannot say (the identity is unknown to it: a 404)', async () => {
    const o = await opened();
    expect(await o.flow.senderBalance(o.client, IDS.identity, 'base-sepolia')).toBeNull();
  });

  it('is the whole-unit string the gateway reports, "0" included, once the identity exists', async () => {
    const o = await opened();
    gw!.adoptIdentity('ab'.repeat(32));
    expect(await o.flow.senderBalance(o.client, IDS.identity, 'base-sepolia')).toBe('0');
    gw!.fundAbstractAccount();
    expect(await o.flow.senderBalance(o.client, IDS.identity, 'base-sepolia')).toBe('0.001');
  });

  it('is null for a chain the account is not on, rather than a balance of another chain', async () => {
    const o = await opened();
    gw!.adoptIdentity('ab'.repeat(32));
    gw!.fundAbstractAccount();
    expect(await o.flow.senderBalance(o.client, IDS.identity, 'arbitrum-sepolia')).toBeNull();
  });
});
