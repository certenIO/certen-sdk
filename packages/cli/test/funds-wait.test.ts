import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { CertenError, type CertenClient, type ReadinessCheck } from '@certen.io/sdk';
import { waitForGas, gasGapIsFundable, sleepUnlessAborted } from '../src/wait.js';
import { terminalPrompter } from '../src/prompt.js';
import { trapSigint } from '../src/interrupt.js';

/**
 * The pieces `setup` and `gas` wait with, tested without a gateway, a terminal or a clock.
 *
 * `waitForGas` takes its sleep, clock and abort signal, so a half-hour budget is exercised in microseconds and never shortened to do it: the
 * budget a caller passes is the budget the loop honours.
 */

const ACCOUNT = '0xe293e95Ec1471155d977448B99B0922C2828cAcB';
const ID = '396f863c-879c-4046-8591-3f0405c5f6bd';

/** A client whose identity read follows a script: one balance (or error) per read. */
function clientReading(script: Array<string | { status: number }>): { client: CertenClient; reads: () => number } {
  let n = 0;
  const identity = {
    get: async () => {
      const step = script[Math.min(n, script.length - 1)]!;
      n += 1;
      // A real CertenError: the SDK tells a rejected key from a bad moment by its class and status, and so must this fake.
      if (typeof step !== 'string') throw new CertenError('gateway said no', step.status, 'GATEWAY_SAID_NO');
      return {
        id: ID, status: 'active', adi_url: 'acc://x.acme', chain_accounts: [{ chain_id: '84532', address: ACCOUNT, status: 'deployed' }],
        balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: 'ETH', balance: step }],
      };
    },
  };
  return { client: { identity } as unknown as CertenClient, reads: () => n };
}

const params = { identityId: ID, chain: 'base-sepolia' };
const budget = { timeoutMs: 30 * 60_000, intervalMs: 6_000 };

describe('waitForGas', () => {
  it('returns when the balance clears the check, having polled at the interval it was given', async () => {
    const { client, reads } = clientReading(['0', '0', '0.001']);
    const sleeps: number[] = [];
    const seen: string[] = [];
    const out = await waitForGas(client, params, budget, {
      sleep: async (ms) => { sleeps.push(ms); },
      now: () => 0,
      onCheck: (c) => seen.push(String(c.data?.balance)),
    });
    expect(out.result).toBe('arrived');
    expect(reads()).toBe(3);
    expect(sleeps).toEqual([6_000, 6_000]);
    expect(seen).toEqual(['0', '0', '0.001']);
  });

  it('gives up exactly when the budget is spent, and says the last thing it saw', async () => {
    const { client } = clientReading(['0']);
    let t = 0;
    const out = await waitForGas(client, params, { timeoutMs: 20_000, intervalMs: 6_000 }, {
      sleep: async (ms) => { t += ms; },
      now: () => t,
    });
    expect(out.result).toBe('timeout');
    if (out.result !== 'timeout') throw new Error('unreachable');
    expect(out.waitedMs).toBe(20_000);
    expect(out.check).toMatchObject({ name: 'gas', status: 'fail', code: 'ABSTRACT_ACCOUNT_UNFUNDED' });
  });

  it('never sleeps past the end of the budget', async () => {
    const { client } = clientReading(['0']);
    let t = 0;
    const sleeps: number[] = [];
    await waitForGas(client, params, { timeoutMs: 8_000, intervalMs: 6_000 }, { sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t });
    expect(sleeps).toEqual([6_000, 2_000]);
  });

  it('stops the moment it is told to, before and after a sleep', async () => {
    const { client, reads } = clientReading(['0']);
    const controller = new AbortController();
    const out = await waitForGas(client, params, budget, {
      signal: controller.signal,
      sleep: async () => { controller.abort(); },
      now: () => 0,
    });
    expect(out.result).toBe('interrupted');
    expect(reads()).toBe(1);

    const pre = new AbortController();
    pre.abort();
    const { client: c2, reads: r2 } = clientReading(['0']);
    expect((await waitForGas(c2, params, budget, { signal: pre.signal })).result).toBe('interrupted');
    expect(r2()).toBe(0);
  });

  it('keeps asking through a gateway having a bad moment, but not through a rejected key or an identity that is gone', async () => {
    const flaky = clientReading([{ status: 503 }, { status: 503 }, '0.001']);
    expect((await waitForGas(flaky.client, params, budget, { sleep: async () => undefined, now: () => 0 })).result).toBe('arrived');
    expect(flaky.reads()).toBe(3);

    await expect(waitForGas(clientReading([{ status: 401 }]).client, params, budget, { sleep: async () => undefined, now: () => 0 }))
      .rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
    await expect(waitForGas(clientReading([{ status: 404 }]).client, params, budget, { sleep: async () => undefined, now: () => 0 }))
      .rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
  });

  it('treats a chain with no gas estimate as arrived once anything positive is there', async () => {
    const identity = {
      get: async () => ({
        id: ID, status: 'active', chain_accounts: [{ chain_id: '2017', address: ACCOUNT, status: 'deployed' }],
        balances: [{ chain_id: 'telcoin-adiri', address: ACCOUNT, token: 'TEL', balance: '0.5' }],
      }),
    };
    const out = await waitForGas({ identity } as unknown as CertenClient, { identityId: ID, chain: 'telcoin-adiri' }, budget, { sleep: async () => undefined, now: () => 0 });
    expect(out.result).toBe('arrived');
    expect(out.result === 'arrived' && out.check.status).toBe('warn');
  });
});

describe('gasGapIsFundable', () => {
  const c = (status: ReadinessCheck['status'], code?: string, reading?: string): ReadinessCheck =>
    ({ name: 'gas', status, detail: '', ...(code ? { code } : {}), ...(reading ? { data: { reading } } : {}) });

  it('is true for an empty or short account and for a balance not reported yet', () => {
    expect(gasGapIsFundable(c('fail', 'ABSTRACT_ACCOUNT_UNFUNDED'))).toBe(true);
    expect(gasGapIsFundable(c('fail', 'ABSTRACT_ACCOUNT_UNDERFUNDED'))).toBe(true);
    expect(gasGapIsFundable(c('unknown', 'ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE', 'no-balances'))).toBe(true);
  });

  it('is false for anything sending funds cannot fix', () => {
    expect(gasGapIsFundable(c('ok'))).toBe(false);
    expect(gasGapIsFundable(c('warn', 'GAS_NOT_ESTIMATED'))).toBe(false);
    expect(gasGapIsFundable(c('fail', 'SOMETHING_ELSE'))).toBe(false);
    for (const reading of ['native-not-reported', 'unknown-native', 'unreadable']) expect(gasGapIsFundable(c('unknown', undefined, reading))).toBe(false);
    expect(gasGapIsFundable(c('skipped'))).toBe(false);
  });
});

describe('sleepUnlessAborted', () => {
  it('sleeps its time, and wakes at once on abort without rejecting', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let done = false;
      const p = sleepUnlessAborted(10_000, controller.signal).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(done).toBe(false);
      controller.abort();
      await p;
      expect(done).toBe(true);
      // Already aborted: no timer at all.
      await expect(sleepUnlessAborted(10_000, controller.signal)).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

describe('trapSigint', () => {
  it('aborts on SIGINT and the listener is gone after dispose, so Ctrl-C means what it always did', () => {
    // A stand-in for `process`: emitting a real SIGINT in the test worker would be handled by the test runner itself.
    const fake = new EventEmitter();
    const trap = trapSigint(fake as unknown as NodeJS.Process);
    expect(fake.listenerCount('SIGINT')).toBe(1);
    expect(trap.signal.aborted).toBe(false);
    fake.emit('SIGINT');
    expect(trap.signal.aborted).toBe(true);
    trap.dispose();
    expect(fake.listenerCount('SIGINT')).toBe(0);
    trap.dispose(); // idempotent
    expect(fake.listenerCount('SIGINT')).toBe(0);
  });

  it('on the real process, adds exactly one listener and removes exactly that one', () => {
    const before = process.listenerCount('SIGINT');
    const trap = trapSigint();
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    trap.dispose();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('terminalPrompter', () => {
  function terminal(interactive = true) {
    const stdin = new PassThrough();
    const written: string[] = [];
    const out = { write: (t: string) => { written.push(t); return true; } };
    return { stdin, written, prompter: terminalPrompter(stdin, out, () => interactive) };
  }
  const tick = () => new Promise<void>((r) => setImmediate(r));

  it('takes the typed line, or the default on Enter', async () => {
    const t = terminal();
    const a = t.prompter.ask('Name', 'dev');
    await tick();
    t.stdin.write('mine\n');
    expect(await a).toBe('mine');
    const b = t.prompter.ask('Name', 'dev');
    await tick();
    t.stdin.write('\r\n');
    expect(await b).toBe('dev');
    expect(t.written[0]).toBe('Name [dev]: ');
  });

  it('keeps an answer typed ahead for the next question, instead of losing it', async () => {
    const t = terminal();
    const first = t.prompter.ask('One', 'a');
    await tick();
    t.stdin.write('x\ny\n');
    expect(await first).toBe('x');
    expect(await t.prompter.ask('Two', 'b')).toBe('y');
  });

  it('confirm: Enter takes the default, y and yes are yes, anything else is no', async () => {
    const t = terminal();
    const ask = async (typed: string, d: boolean) => { const p = t.prompter.confirm('Sure?', d); await tick(); t.stdin.write(`${typed}\n`); return p; };
    expect(await ask('', true)).toBe(true);
    expect(await ask('', false)).toBe(false);
    expect(await ask('Y', false)).toBe(true);
    expect(await ask('yes', false)).toBe(true);
    expect(await ask('no', true)).toBe(false);
    expect(await ask('maybe', true)).toBe(false);
    expect(t.written[0]).toBe('Sure? [Y/n]: ');
    expect(t.written[1]).toBe('Sure? [y/N]: ');
  });

  it('choose: has no default, accepts a name or an alias, and asks again on nonsense', async () => {
    const t = terminal();
    const options = [{ key: 'new', aliases: ['n'], label: 'make one' }, { key: 'existing', aliases: ['e'], label: 'sign in' }] as const;
    const first = t.prompter.choose('Which?', options);
    await tick();
    t.stdin.write('\n');
    await tick();
    t.stdin.write('nope\n');
    await tick();
    t.stdin.write('E\n');
    expect(await first).toBe('existing');
    expect(t.written.join('')).toContain('"nope" is not one of: new, existing.');

    const gives = t.prompter.choose('Which?', options, 2);
    await tick();
    t.stdin.write('x\ny\n');
    expect(await gives).toBeUndefined();
  });

  it('asks nothing of a machine with no terminal: defaults for the easy questions, no answer for the ones that need one', async () => {
    const t = terminal(false);
    expect(await t.prompter.ask('Name', 'dev')).toBe('dev');
    expect(await t.prompter.confirm('Sure?', true)).toBe(true);
    expect(await t.prompter.confirm('Sure?', false)).toBe(false);
    expect(await t.prompter.choose('Which?', [{ key: 'a', label: 'a' }])).toBeUndefined();
    expect(t.written).toEqual([]);
    expect(t.prompter.interactive).toBe(false);
  });
});
