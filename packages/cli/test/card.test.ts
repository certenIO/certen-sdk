import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FeeEstimate, SigningSummary } from '@certen.io/sdk';
import {
  renderSigningCard, confirmSigning, confirmBeforeSigning, assertCanConfirm, feeLine, isMainnetLike, contextValues, signingDeclined, type SigningCard,
} from '../src/card.js';
import { setPrompterOverride, type Prompter } from '../src/prompt.js';
import { resetOutput, setJsonMode } from '../src/output.js';

/**
 * The confirmation card: what a person reads before a signature, and the question that follows it.
 *
 * What is pinned is what a wrong card would cost:
 *  - the rebuilt summary ("You are about to sign: ...") is shown VERBATIM, because it is what the signature is checked against;
 *  - only a PERSON is asked, and a command that has always signed unattended keeps doing so (a script must not start blocking);
 *  - a new command with nobody to ask refuses before a passphrase is read, instead of signing on nobody's say-so;
 *  - on anything that is not a known testnet the chain is in capitals, the card says the funds are real, and a bare Enter is NO.
 */

const SUMMARY: SigningSummary = {
  kind: 'cross-chain intent',
  principal: 'acc://jason-dev.acme/data',
  intentId: '7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13',
  additionalAuthorities: [],
  signer: { publicKey: 'ab'.repeat(32), keyPage: 'acc://jason-dev.acme/book/1', keyPageVersion: 1, timestampMicros: '1' },
  legs: [],
  operations: [],
  hashes: { transaction: 'aa', signatureMetadata: 'bb', toSign: 'cc' },
  text: [
    'You are about to sign: cross-chain intent (intent 7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13)',
    '  written to        acc://jason-dev.acme/data',
    '  leg-1             84532 (chain 84532): plain transfer to 0x1111111111111111111111111111111111111111, value 100000000000000 wei',
  ],
};

const FEE: FeeEstimate = {
  state: 'estimated', sku: 'proof.execute', chain: 'base-sepolia', platform_fee_usd: '0.040000', mode: 'quoted', max_charge_usd: '0.500000',
  gas_reserve: '0.0001', gas_symbol: 'ETH', price_book_version: '2026-10-15', note: 'An estimate from the price book: the platform fee only. Gas is priced when it executes, up to a ceiling.',
};

const card = (over: Partial<SigningCard> = {}): SigningCard => ({
  headline: 'Send 0.0001 ETH on base-sepolia',
  rows: [['from', 'acc://jason-dev.acme  ->  0xAbstract (abstract account on base-sepolia)'], ['to', '0x1111111111111111111111111111111111111111']],
  chain: 'base-sepolia',
  fee: FEE,
  fromContext: [],
  summary: SUMMARY,
  keyName: 'dev',
  ...over,
});

function scripted(answer: boolean | undefined, interactive = true): Prompter & { asked: Array<{ q: string; defaultYes: boolean }> } {
  const asked: Array<{ q: string; defaultYes: boolean }> = [];
  return {
    asked, interactive,
    async ask(_q, fallback) { return fallback; },
    async confirm(q, defaultYes) { asked.push({ q, defaultYes }); return answer ?? defaultYes; },
    async choose() { return undefined; },
  };
}

let stderr: string[] = [];
beforeEach(() => {
  resetOutput();
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); setPrompterOverride(undefined); resetOutput(); });

describe('renderSigningCard', () => {
  it('puts the whole-unit headline, the recipient in full and the fee above the rebuilt summary, which is kept verbatim', () => {
    const lines = renderSigningCard(card());
    const text = lines.join('\n');
    expect(text).toContain('  Send 0.0001 ETH on base-sepolia');
    expect(text).toContain('to    0x1111111111111111111111111111111111111111');
    for (const line of SUMMARY.text) expect(lines).toContain(`  ${line}`);
    // The rebuilt text comes after the person's own terms, and the closing statement says what was checked.
    expect(text.indexOf('Send 0.0001 ETH')).toBeLessThan(text.indexOf('You are about to sign'));
    expect(lines.at(-1)).toBe('  The signature authorises exactly this: it was rebuilt from the gateway\'s bytes and matched to your request.');
  });

  it('shows the fee as an estimate and says gas is priced when it executes', () => {
    const text = renderSigningCard(card()).join('\n');
    expect(text).toMatch(/fee\s+about \$0\.040000 CERTEN fee · gas up to about 0\.0001 ETH \(an estimate, not a quote; gas is priced when it executes\)/);
  });

  it('lists only what the person did not type, with where each came from', () => {
    const none = renderSigningCard(card({ fromContext: [] })).join('\n');
    expect(none).not.toMatch(/context/);
    const some = renderSigningCard(card({
      fromContext: [
        { field: 'identity', value: 'acc://jason-dev.acme', source: 'the only identity recorded on this machine' },
        { field: 'chain', value: 'base-sepolia', source: 'from CERTEN_CHAIN' },
      ],
    })).join('\n');
    expect(some).toMatch(/context\s+not typed by you: identity acc:\/\/jason-dev\.acme \(the only identity recorded on this machine\); chain base-sepolia \(from CERTEN_CHAIN\)/);
  });

  it('writes a mainnet in capitals and says the funds are real', () => {
    const text = renderSigningCard(card({ headline: 'Send 0.1 ETH on ethereum', chain: 'ethereum' })).join('\n');
    expect(text).toContain('Send 0.1 ETH on ETHEREUM');
    expect(text).toMatch(/network\s+NOT A KNOWN TESTNET: this moves real funds/);
  });

  it('treats a chain nobody can classify like a mainnet: unknown is not ok', () => {
    expect(isMainnetLike('somenewchain')).toBe(true);
    expect(isMainnetLike('base-sepolia')).toBe(false);
    expect(isMainnetLike(undefined)).toBe(false);
    expect(renderSigningCard(card({ headline: 'Send 1 X on somenewchain', chain: 'somenewchain' })).join('\n')).toMatch(/SOMENEWCHAIN/);
  });

  it('a card with no chain (a governance change) and no fee has neither row', () => {
    const text = renderSigningCard(card({ headline: 'Change who may sign for acc://x.acme', chain: undefined, fee: undefined, rows: [['change', '{"type":"add_key"}']] })).join('\n');
    expect(text).not.toMatch(/\bfee\b|network/);
    expect(text).toContain('change  {"type":"add_key"}');
  });
});

describe('feeLine', () => {
  it('is "not estimated" when nothing was asked, and the unavailable note when the price book could not be read', () => {
    expect(feeLine(undefined)).toBe('not estimated');
    expect(feeLine(null)).toBe('not estimated');
    const unavailable: FeeEstimate = { ...FEE, state: 'unavailable', platform_fee_usd: null, note: 'Not available: the price book could not be read.' };
    expect(feeLine(unavailable)).toBe('Not available: the price book could not be read.');
  });

  it('never prints a figure the price book did not give', () => {
    expect(feeLine({ ...FEE, platform_fee_usd: null, gas_reserve: null, gas_symbol: null, mode: 'flat' })).toBe('CERTEN fee not in the price book (an estimate, not a quote)');
  });
});

describe('assertCanConfirm', () => {
  const none = scripted(true, false);
  const person = scripted(true, true);

  it('a new command (strict) with no terminal, no --yes and no --json refuses, before anything is unlocked', () => {
    expect(() => assertCanConfirm({ yes: false, prompter: none, mode: 'strict', command: 'certen send' }))
      .toThrowError(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED', exitCode: 2 }));
  });

  it('says what to do about it, and that --yes never skips the check', () => {
    try {
      assertCanConfirm({ yes: false, prompter: none, mode: 'strict', command: 'certen send' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/there is no one at a terminal to confirm it/);
      expect((err as Error).message).toMatch(/--yes skips the question, never the check/);
    }
  });

  it('is satisfied by --yes, by --json, and by a person', () => {
    expect(() => assertCanConfirm({ yes: true, prompter: none, mode: 'strict', command: 'certen send' })).not.toThrow();
    setJsonMode(true);
    expect(() => assertCanConfirm({ yes: false, prompter: none, mode: 'strict', command: 'certen send' })).not.toThrow();
    setJsonMode(false);
    expect(() => assertCanConfirm({ yes: false, prompter: person, mode: 'strict', command: 'certen send' })).not.toThrow();
  });

  it('a command that has always signed unattended never refuses: scripts that work today keep working', () => {
    expect(() => assertCanConfirm({ yes: false, prompter: none, mode: 'when-interactive', command: 'certen call' })).not.toThrow();
  });
});

describe('confirmSigning', () => {
  it('shows the card on stderr in every case, and asks a person, defaulting to yes on a testnet', async () => {
    const p = scripted(undefined);
    expect(await confirmSigning(card(), { yes: false, prompter: p })).toBe(true);
    expect(p.asked).toEqual([{ q: '  Sign with "dev"?', defaultYes: true }]);
    expect(stderr.join('\n')).toContain('You are about to sign: cross-chain intent');
  });

  it('defaults to NO on a mainnet, so an absent-minded Enter moves nothing', async () => {
    const p = scripted(undefined);
    expect(await confirmSigning(card({ chain: 'ethereum', headline: 'Send 1 ETH on ethereum' }), { yes: false, prompter: p })).toBe(false);
    expect(p.asked[0]!.defaultYes).toBe(false);
  });

  it('returns false only when a person answers no', async () => {
    expect(await confirmSigning(card(), { yes: false, prompter: scripted(false) })).toBe(false);
    expect(await confirmSigning(card(), { yes: false, prompter: scripted(true) })).toBe(true);
  });

  it('--yes shows the card and asks nothing', async () => {
    const p = scripted(false);
    expect(await confirmSigning(card(), { yes: true, prompter: p })).toBe(true);
    expect(p.asked).toEqual([]);
    expect(stderr.join('\n')).toContain('You are about to sign');
  });

  it('--json shows the card (on stderr) and asks nothing', async () => {
    setJsonMode(true);
    const p = scripted(false);
    expect(await confirmSigning(card(), { yes: false, prompter: p })).toBe(true);
    expect(p.asked).toEqual([]);
  });

  it('with nobody to ask it shows the card and goes on, as these commands always have', async () => {
    const p = scripted(false, false);
    expect(await confirmSigning(card(), { yes: false, prompter: p })).toBe(true);
    expect(p.asked).toEqual([]);
  });
});

describe('confirmBeforeSigning (the existing signing commands)', () => {
  it('stops with SIGNING_DECLINED, naming the intent that will expire, when a person says no', async () => {
    setPrompterOverride(scripted(false));
    await expect(confirmBeforeSigning(card(), { intentId: 'intent-1' })).rejects.toMatchObject({
      code: 'SIGNING_DECLINED', exitCode: 1, details: { intent_id: 'intent-1' },
      message: expect.stringMatching(/Not signed\. The intent intent-1 was opened and will expire unsigned; nothing was charged and nothing moved\./),
    });
  });

  it('goes on when a person says yes, and when --yes was given', async () => {
    setPrompterOverride(scripted(true));
    await expect(confirmBeforeSigning(card(), {})).resolves.toBeUndefined();
    const no = scripted(false);
    setPrompterOverride(no);
    await expect(confirmBeforeSigning(card(), { yes: true })).resolves.toBeUndefined();
    expect(no.asked).toEqual([]);
  });

  it('asks nothing of a pipe', async () => {
    const pipe = scripted(false, false);
    setPrompterOverride(pipe);
    await expect(confirmBeforeSigning(card(), {})).resolves.toBeUndefined();
    expect(pipe.asked).toEqual([]);
  });
});

describe('signingDeclined / contextValues', () => {
  it('the failure without an intent says only that nothing was signed', () => {
    const e = signingDeclined();
    expect(e.message).toBe('Not signed. nothing was charged and nothing moved.');
    expect(e.details).toBeUndefined();
  });

  it('contextValues keeps what the person did not type and drops what they did', () => {
    const r = (source: 'flag' | 'env' | 'profile' | 'single', detail: string) => ({ value: 'x', source, detail });
    expect(contextValues([
      { field: 'identity', resolved: r('flag', 'flag'), shown: 'acc://typed.acme' },
      { field: 'chain', resolved: r('env', 'CERTEN_CHAIN'), shown: 'base-sepolia' },
      { field: 'key', resolved: r('single', 'the only signing key on this machine'), shown: 'dev' },
      { field: 'identity', resolved: undefined, shown: 'nothing' },
    ])).toEqual([
      { field: 'chain', value: 'base-sepolia', source: 'from CERTEN_CHAIN' },
      { field: 'key', value: 'dev', source: 'the only signing key on this machine' },
    ]);
  });
});
