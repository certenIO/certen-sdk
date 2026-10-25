/**
 * The residuals of the wallet route that the Go review documents (V-RB12-E1RAISE W17, W18, W19 and N5; arb_final3/README.md) are restated in the
 * header of confirm.ts and in the CHANGELOG entry of this port, in the Go review's words, and each one is true of the code: the worlds below are
 * accepted although the residual holds in them (RB12-TS-FIX-ARBSEP, audit N-6). The text tests are plain source-text tests: a documented residual
 * is a sentence, and the sentence must not drift away from the code it describes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeTx } from '../../../src/proof-v2/finality/baseposted/ethtx.js';
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { ethl1PinsFrom } from '../../../src/proof-v2/finality/ethl1/index.js';
import { sepoliaPins } from '../../../src/proof-v2/finality/pins.js';
import { FINAL3, bytesOfHex, evidenceOf, load, pinsOf, runVector, vectorByName } from './vectorset.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', '..', '..');
const confirmSrc = readFileSync(join(pkg, 'src', 'proof-v2', 'finality', 'arbfinal', 'confirm.ts'), 'utf8').replace(/\r\n/g, '\n');
const changelog = readFileSync(join(pkg, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
const flat = (s: string): string => s.replace(/\n \* ?/g, ' ').replace(/\s+/g, ' ');

/** The first block comment of the file (its header), on one line. */
const header = flat(confirmSrc.slice(0, confirmSrc.indexOf('*/') + 2));
/** The CHANGELOG entry of the arbfinal port: from its heading to the next top-level entry, on one line. */
const entry = ((): string => {
  const at = changelog.indexOf('## Unreleased — RB12 TS arbfinal');
  if (at < 0) return '';
  const next = changelog.indexOf('\n## ', at + 3);
  return changelog.slice(at, next < 0 ? undefined : next).replace(/\s+/g, ' ');
})();

/** The sentences of the Go review (V-RB12-E1RAISE W17, W18, W19, N5), one per residual. */
const RESIDUALS: readonly { id: string; sentence: string }[] = [
  { id: 'W17', sentence: 'the inner confirmAssertion arguments are not bound to the assertion hash' },
  { id: 'W18', sentence: 'the other calls of the batch and the gas-refunder callback are not constrained' },
  { id: 'W19', sentence: 'a same-block swap and restore at K is invisible' },
  { id: 'N5', sentence: 'rests on anyTrustFastConfirmer == 0 at the end of K and on the Rollup owner not being able to set and unset it inside block K' },
  { id: 'N5', sentence: 'Only a Rollup-privileged party can exploit it' },
];

describe('the residuals of the wallet route are stated where the claim is made', () => {
  it('the CHANGELOG entry of the arbfinal port exists', () => {
    expect(entry.length).toBeGreaterThan(0);
  });

  for (const r of RESIDUALS) {
    it(`${r.id}: "${r.sentence.slice(0, 60)}..." is in the header of confirm.ts and in the CHANGELOG entry of the arbfinal port`, () => {
      expect(header, `${r.id} in the confirm.ts header`).toContain(r.sentence);
      expect(entry, `${r.id} in the CHANGELOG entry`).toContain(r.sentence);
    });
  }

  it('the three residual identifiers and N5 are named in both places, before the first import of confirm.ts', () => {
    for (const id of ['W17', 'W18', 'W19', 'N5']) {
      expect(header, id).toContain(id);
      expect(entry, id).toContain(id);
    }
    expect(confirmSrc.indexOf('W17')).toBeLessThan(confirmSrc.indexOf('import '));
  });

  it('the header names the review the identifiers come from, and says what the wallet route does not prove', () => {
    expect(header).toContain('V-RB12-E1RAISE');
    expect(header).toContain('arb_final3/README.md');
    expect(header).toContain('does NOT prove');
    expect(entry).toContain('V-RB12-E1RAISE');
  });
});

describe('each documented residual is true of the code (the worlds are accepted although it holds)', () => {
  const expectWallet = async (name: string): Promise<void> => {
    const v = vectorByName(FINAL3, name);
    const out = JSON.parse(await runVector(FINAL3, v));
    expect(out.code, name).toBe('finalized');
    expect(out.fields.confirmation_route, name).toBe('wallet');
  };
  const callsOf = async (name: string) => {
    const A = await load();
    const v = vectorByName(FINAL3, name);
    const pins = pinsOf(FINAL3, v);
    const arb = A.loadArbFinalPins(pins);
    const ep = ethl1PinsFrom(sepoliaPins(pins));
    const e = A.decodeEvidence(decodeContainer(evidenceOf(FINAL3, v), defaultLimits()).body, A.boundsFor(ep.maxLinks, ep.maxSpineHeaders, arb));
    const tx = decodeTx(e.confTxRaw);
    return { arb, calls: A.decodeWalletCalls(arb, A.selectorOf(tx.data).sel, tx.data)!, assertion: bytesOfHex(JSON.parse(v.expect).fields.assertion) };
  };
  const isConfirm = (data: Uint8Array, sel: Uint8Array): boolean => Buffer.from(data.subarray(0, 4)).equals(Buffer.from(sel));

  it('W17: a wallet call whose confirmAssertion data is the bare four-byte selector (so no argument equals the assertion hash) is accepted', async () => {
    const name = 'synth_valid_wallet_call_is_the_bare_selector_proven';
    await expectWallet(name);
    const { arb, calls, assertion } = await callsOf(name);
    const confirm = calls.filter((c) => isConfirm(c.data, arb.sel.confirm));
    expect(confirm.length).toBe(1);
    expect(confirm[0]!.data.length).toBe(4);
    expect(Buffer.from(confirm[0]!.data).includes(Buffer.from(assertion))).toBe(false);
  });

  it('W17: the valid wallet world carries confirm arguments that are not the assertion hash either, and is accepted', async () => {
    const name = 'synth_valid_wallet_execute_transaction_proven';
    await expectWallet(name);
    const { arb, calls, assertion } = await callsOf(name);
    const confirm = calls.find((c) => isConfirm(c.data, arb.sel.confirm))!;
    expect(confirm.data.length).toBeGreaterThan(4);
    expect(Buffer.from(confirm.data).includes(Buffer.from(assertion))).toBe(false);
  });

  it('W18: a batch whose first call goes elsewhere is accepted (the other calls are not constrained), and so are the gas-refunder variants', async () => {
    await expectWallet('synth_valid_wallet_execute_transactions_proven');
    await expectWallet('synth_valid_wallet_execute_transaction_with_gas_refunder_proven');
    await expectWallet('synth_valid_wallet_execute_transactions_with_gas_refunder_proven');
    const { arb, calls } = await callsOf('synth_valid_wallet_execute_transactions_proven');
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.some((c) => !Buffer.from(c.dest).equals(Buffer.from(arb.rollup)))).toBe(true);
  });

  it('W19: the identity of the wallet is judged under the state root of K, the end of the block that contains the transaction, and nowhere else', () => {
    expect(confirmSrc).toContain('proveWallet(arb, kb.stateRoot, tx.to,');
  });
});
