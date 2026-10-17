import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startStub, WHO, type Stub, type Seen } from './helpers/stub-gateway.js';
import type { Prompter } from '../src/prompt.js';

/**
 * The question before the platform's money is spent, with a person at a terminal.
 *
 * `credits topup` and `gas --drip` spend the platform's funds. At a terminal the person is asked, and a bare Enter is NO. A test cannot sit at a
 * TTY, so these run in-process with a scripted prompter standing in for the person (the subprocess cases, where nobody is there, are in
 * credits-topup.test.ts and gas-drip.test.ts). What is pinned:
 *
 *  - a person who says no spends nothing: no request that spends reaches the gateway, and the failure says nothing was sent;
 *  - the default offered is no;
 *  - a person who says yes spends once;
 *  - `--yes` asks nothing, even where the person would have said no;
 *  - `--json` is not an answer: at a terminal the question is still asked, and a no is still a no.
 */

let scratch = '';
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => scratch }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => scratch }));

const CREDITS = `/v1/identity/${WHO.id}/credits`;
const DRIP = `/v1/identity/${WHO.id}/chain-accounts/base-sepolia/drip`;
const ACCEPTED = { topup_id: 't-1', identity_id: WHO.id, key_page_url: WHO.keyPage, credits: 500, status: 'submitted', tx_id: 'acc://abc', credits_before: 12, note: 'ok' };
const SENT = { drip_id: 'd-1', identity_id: WHO.id, chain: 'base-sepolia', chain_id: 84532, address: WHO.account, status: 'sent', tx_hash: '0xabc', amount: '0.01', symbol: 'ETH', explorer_url: null, note: 'sent' };

function scripted(answer: boolean): Prompter & { asked: Array<{ q: string; defaultYes: boolean }> } {
  const asked: Array<{ q: string; defaultYes: boolean }> = [];
  return {
    asked, interactive: true,
    async ask(_q, fallback) { return fallback; },
    async confirm(q, defaultYes) { asked.push({ q, defaultYes }); return answer; },
    async choose() { return undefined; },
  };
}

let stub: Stub | undefined;
let err: string[] = [];
let out: string[] = [];
let balance = '0';
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'certen-spend-confirm-'));
  for (const v of Object.keys(process.env)) if (v.startsWith('CERTEN_')) delete process.env[v];
  process.env.CERTEN_API_KEY = 'ck_live_test_in_process';
  process.env.CERTEN_IDENTITY = WHO.id;
  process.env.CERTEN_CHAIN = WHO.chain;
  vi.resetModules();
  err = []; out = []; balance = '0';
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await stub?.close();
  stub = undefined;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
});

async function gateway(): Promise<Stub> {
  stub = await startStub((r: Seen) => {
    if (r.method === 'POST' && r.path === CREDITS) return { status: 202, body: ACCEPTED };
    if (r.method === 'POST' && r.path === DRIP) { balance = '0.01'; return { status: 200, body: SENT }; }
    if (r.method === 'GET' && r.path === `/v1/identity/${WHO.id}`) {
      return { body: {
        id: WHO.id, adi_url: WHO.adi, status: 'active', can_sign: true, key_page_url: WHO.keyPage, credit_balance: 500,
        chain_accounts: [{ chain_id: String(WHO.chainId), address: WHO.account, status: 'deployed' }],
        balances: [{ chain_id: WHO.chain, address: WHO.account, token: 'ETH', balance }], created_at: '2026-10-15T00:00:00Z',
      } };
    }
    return undefined;
  });
  return stub;
}
const spends = (s: Stub): Seen[] => s.calls().filter((r) => r.method === 'POST' && (r.path === CREDITS || r.path === DRIP));

async function drive(url: string, person: Prompter, args: string[]): Promise<{ code: number; errorCode?: string }> {
  process.env.CERTEN_API_URL = url;
  const prompt = await import('../src/prompt.js');
  prompt.setPrompterOverride(person);
  const { run } = await import('../src/index.js');
  const argv = ['node', 'certen', ...args];
  const saved = process.argv;
  process.argv = argv;
  let code: number;
  try { code = await run(argv); } finally { process.argv = saved; }
  const json = out.map((l) => { try { return JSON.parse(l) as { error?: { code?: string } }; } catch { return undefined; } }).find((l) => l?.error);
  const text = err.map((l) => /^Error \[([A-Z_]+)\]/.exec(l)).find(Boolean);
  return { code, errorCode: json?.error?.code ?? text?.[1] };
}

describe('credits topup, with a person at a terminal', () => {
  const TOPUP = ['credits', 'topup', '--credits', '500'];

  it('a no spends nothing: the failure says so, and the answer on a bare Enter was no', async () => {
    const g = await gateway();
    const person = scripted(false);
    const r = await drive(g.url, person, TOPUP);
    expect(r.code).toBe(1);
    expect(r.errorCode).toBe('TOPUP_DECLINED');
    expect(person.asked).toEqual([{ q: '  Add 500 credits?', defaultYes: false }]);
    expect(spends(g)).toHaveLength(0);
    expect(err.join('\n')).toContain('Nothing was sent and nothing was charged');
    // The card was shown first: what is spent, by whom, and under which key.
    expect(err.join('\n')).toContain('paid by  the platform\'s sponsor account');
    expect(err.join('\n')).toMatch(/Idempotency-Key certen-[0-9a-f-]{36}/);
  });

  it('a yes spends once', async () => {
    const g = await gateway();
    const person = scripted(true);
    const r = await drive(g.url, person, TOPUP);
    expect(r.code, err.join('\n')).toBe(0);
    expect(person.asked).toHaveLength(1);
    expect(spends(g)).toHaveLength(1);
    expect(spends(g)[0]!.body).toEqual({ credits: 500 });
  });

  it('--yes asks nothing, even where the person would have said no', async () => {
    const g = await gateway();
    const person = scripted(false);
    const r = await drive(g.url, person, [...TOPUP, '--yes']);
    expect(r.code, err.join('\n')).toBe(0);
    expect(person.asked).toEqual([]);
    expect(spends(g)).toHaveLength(1);
  });

  it('--json is not an answer: the question is still asked, and a no is still a no', async () => {
    const g = await gateway();
    const person = scripted(false);
    const r = await drive(g.url, person, ['--json', ...TOPUP]);
    expect(r.code).toBe(1);
    expect(r.errorCode).toBe('TOPUP_DECLINED');
    expect(person.asked).toHaveLength(1);
    expect(spends(g)).toHaveLength(0);
  });
});

describe('gas --drip, with a person at a terminal', () => {
  const DRIPPING = ['gas', '--drip'];

  it('a no requests nothing, prints the manual steps, and fails DRIP_DECLINED', async () => {
    const g = await gateway();
    const person = scripted(false);
    const r = await drive(g.url, person, DRIPPING);
    expect(r.code).toBe(1);
    expect(r.errorCode).toBe('DRIP_DECLINED');
    expect(person.asked).toEqual([{ q: `  Request a drip to ${WHO.account}?`, defaultYes: false }]);
    expect(spends(g)).toHaveLength(0);
    expect(err.join('\n')).toContain('No drip requested. Nothing was sent and nothing was charged.');
    expect(out.join('\n')).toContain('Send 0.001 ETH to ');
  });

  it('a yes requests one drip', async () => {
    const g = await gateway();
    const person = scripted(true);
    const r = await drive(g.url, person, DRIPPING);
    expect(r.code, err.join('\n')).toBe(0);
    expect(person.asked).toHaveLength(1);
    expect(spends(g)).toHaveLength(1);
    expect(out.join('\n')).toContain('Drip sent');
  });

  it('--yes asks nothing', async () => {
    const g = await gateway();
    const person = scripted(false);
    const r = await drive(g.url, person, [...DRIPPING, '--yes']);
    expect(r.code, err.join('\n')).toBe(0);
    expect(person.asked).toEqual([]);
    expect(spends(g)).toHaveLength(1);
  });

  it('--json is not an answer here either', async () => {
    const g = await gateway();
    const person = scripted(false);
    const r = await drive(g.url, person, ['--json', ...DRIPPING]);
    expect(r.code).toBe(1);
    expect(r.errorCode).toBe('DRIP_DECLINED');
    expect(spends(g)).toHaveLength(0);
  });

  it('an account that is already funded is not asked about at all', async () => {
    const g = await gateway();
    balance = '0.01';
    const person = scripted(false);
    const r = await drive(g.url, person, DRIPPING);
    expect(r.code, err.join('\n')).toBe(0);
    expect(person.asked).toEqual([]);
    expect(spends(g)).toHaveLength(0);
  });
});
