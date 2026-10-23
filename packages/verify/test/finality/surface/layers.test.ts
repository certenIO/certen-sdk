/**
 * The finality section inside verifyProofDocument and verifyPortable, through the package entry. The section is a layer (S7) like the others: its class decides
 * the overall verdict the way Go's combined proofverify decides its exit code (cmd/proofverify/main.go: worseExit, failed beats summary-only beats verified over
 * the L1-L4 result and each requested report), so it can weaken the overall and never strengthen it. A document that carries no finality member and is given no
 * option is not touched (entry.test.ts: byte-identical to the base commit).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { COVERED_STATEMENTS, NOT_COVERED_STATEMENTS, finality, verifyPortable, verifyProofDocument, type Verification } from '../../../src/index.js';
import { applyFinality } from '../../../src/layers.js';
import { judgeFinalityDocument } from '../../../src/proof-v2/finality/docreport.js';
import { legBindingOf, newAddendum, newSection, sectionToJSON, type Addendum } from '../../../src/proof-v2/finality/addendum.js';
import { deriveIncluded } from '../../../src/proof-v2/finality/evidence.js';
import { Level } from '../../../src/proof-v2/finality/level.js';
import { Registry } from '../../../src/proof-v2/finality/registry.js';
import { ChainBaseSepolia } from '../../../src/proof-v2/finality/table.js';
import { containerFor, kBaseFin, kBaseL1, testProofId } from '../helpers.js';
import { cases, docOf, fakeBaseRegistry, legSettlement, pinsNamed } from './support.js';

const dir = new URL('../../fixtures/proofv2/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
const baseText = gunzipSync(readFileSync(new URL(manifest.base, dir))).toString('utf8');

function patched(name: string): Record<string, any> {
  const doc = JSON.parse(baseText);
  const ops = manifest.cases.find((c: { name: string }) => c.name === name).patch as { path: (string | number)[]; set?: unknown; delete?: boolean; truncate?: number }[];
  for (const op of ops) {
    let cur = doc;
    op.path.forEach((k, i) => {
      if (i === op.path.length - 1) {
        if (op.delete) delete cur[k];
        else if (op.truncate !== undefined) cur[k] = cur[k].slice(0, op.truncate);
        else cur[k] = op.set;
      }
      cur = cur[k];
    });
  }
  return doc;
}

const leg = legSettlement('base_sepolia_47368146', 84532n);
const block = deriveIncluded(ChainBaseSepolia, leg.settlement);
const KINDS: Record<number, string> = { [Level.L1Posted]: kBaseL1, [Level.Finalized]: kBaseFin };
function chain(under = legBindingOf(block), ...levels: Level[]): Addendum[] {
  const out: Addendum[] = [];
  for (const l of levels) out.push(newAddendum(under, testProofId, out, block.chain, l, KINDS[l]!, containerFor(KINDS[l]!, block, l, 'body')));
  return out;
}
const wrongD0 = (): Uint8Array => {
  const d = Uint8Array.from(legBindingOf(block));
  d[0]! ^= 1;
  return d;
};
const member = (...levels: Level[]): unknown => JSON.parse(sectionToJSON(newSection(block, chain(legBindingOf(block), ...levels))));
const withMember = (doc: Record<string, any>, m: unknown): Record<string, any> => ({ ...doc, finality: m });
const ids = (v: Verification): string[] => v.layers.map((l) => l.id);
const layer = (v: Verification, id: string) => v.layers.find((l) => l.id === id)!;
const options = (extra = {}) => ({ finality: { settlement: leg, registry: fakeBaseRegistry(), subject: 'DOC', ...extra } });

describe('verifyProofDocument with a finality section', () => {
  const valid = JSON.parse(baseText);

  it('a verified section is the layer S7 after the core layers; it does not upgrade the overall (the conformance document is partial: a page chain is not bound)', () => {
    const plain = verifyProofDocument(valid);
    expect(plain.overall).toBe('partial');
    const v = verifyProofDocument(withMember(valid, member(Level.L1Posted, Level.Finalized)), options());
    expect(ids(v)).toEqual(['trust_base', 'L4', 'L1', 'L2', 'L3', 'G0', 'G1', 'G1_chains', 'L4_set', 'govRootV3', 'S7', 'G1b', 'G2', 'L5', 'outcome']);
    const s7 = layer(v, 'S7');
    expect([s7.verdict, s7.statement]).toEqual(['verified', 'S7']);
    expect(s7.evidence.headline).toBe('finalized');
    expect(s7.evidence.block).toEqual({ chain: '84532', number: '47368146', hash: '3892cf2ea71bb8bbb66b1ce5df138522ef8ce7b6137ec791a23d19d2c58de942' });
    expect(Object.keys(s7.evidence.levels as object)).toEqual(['included', 'l1_posted', 'finalized']);
    expect(v.overall).toBe(plain.overall);
    expect(v.independent).toBe(false);
    expect(v.covers).toEqual([]);
    expect([v.finality?.class, v.finality?.exit, v.finality?.headline]).toEqual(['verified', 0, 3]);
    // every core layer is what it was without the section
    expect(v.layers.filter((l) => l.id !== 'S7')).toEqual(plain.layers);
    expect(v.failure).toBeUndefined();
    expect(() => JSON.stringify(v)).not.toThrow();
  }, 300_000);

  it('one level present: the headline says that level and the other is pending', () => {
    const v = verifyProofDocument(withMember(valid, member(Level.L1Posted)), options());
    expect(layer(v, 'S7').evidence.headline).toBe('l1_posted');
    expect((layer(v, 'S7').evidence.levels as Record<string, { status: string }>).finalized!.status).toBe('pending');
    expect(v.overall).toBe(verifyProofDocument(valid).overall);
  }, 300_000);

  it('a section judged with no Settlement is summary-only: S7 not_checked by name, overall partial, nothing is covered', () => {
    const v = verifyProofDocument(withMember(valid, member(Level.Finalized)));
    const s7 = layer(v, 'S7');
    expect(s7.verdict).toBe('not_checked');
    expect(s7.reason).toContain('finality_included_unavailable{chain="84532",reason="no_settlement_to_recompute_d0"}');
    expect(s7.evidence.exit).toBe(3);
    expect(v.overall).toBe('partial');
    expect(v.independent).toBe(false);
    expect(v.covers).toEqual([]);
    expect(v.notCovered).toEqual([...COVERED_STATEMENTS, ...NOT_COVERED_STATEMENTS]);
    expect(v.failure).toBeUndefined();
    // every core layer keeps its own verdict: the weaker overall is the section's, not a change of what was checked
    expect(v.layers.filter((l) => l.id !== 'S7' && l.verdict === 'verified').length).toBe(9);
  }, 300_000);

  it('the option alone, for a document with no member, is summary-only "no finality section" and weakens the overall (Go: --finality-file on such a file exits 3)', () => {
    const v = verifyProofDocument(valid, options());
    expect(layer(v, 'S7').verdict).toBe('not_checked');
    expect(layer(v, 'S7').reason).toContain('the document carries no finality section');
    expect(v.overall).toBe('partial');
  }, 300_000);

  it('a section that does not check out is failed: S7 failed, overall failed, failure names S7, the core layers stay verified', () => {
    const forged = JSON.parse(sectionToJSON(newSection(block, chain(wrongD0(), Level.Finalized))));
    const v = verifyProofDocument(withMember(valid, forged), options());
    expect(layer(v, 'S7').verdict).toBe('failed');
    expect(layer(v, 'S7').reason).toContain('finality_chain_broken{check="own_hash",seq="1"}');
    expect(v.overall).toBe('failed');
    expect(v.failure?.layer).toBe('S7');
    expect(v.covers).toEqual([]);
    expect(v.independent).toBe(false);
    expect(layer(v, 'L1').verdict).toBe('verified');
  }, 300_000);

  it('a kind this verifier does not know is summary-only by name, not failed', () => {
    const v = verifyProofDocument(withMember(valid, member(Level.Finalized)), options({ registry: new Registry() }));
    expect(layer(v, 'S7').verdict).toBe('not_checked');
    expect(layer(v, 'S7').reason).toContain('not known to this verifier');
    expect(v.overall).toBe('partial');
  }, 300_000);

  it('the section never upgrades: a core failure stays the first failure whatever the section says', () => {
    const v = verifyProofDocument(withMember(patched('tx-swap'), member(Level.L1Posted, Level.Finalized)), options());
    expect(layer(v, 'S7').verdict).toBe('verified');
    expect(v.overall).toBe('failed');
    expect(v.failure?.layer).toBe('L1');
    expect(v.covers).toEqual([]);
    expect(v.independent).toBe(false);
  }, 300_000);

  it('the section never upgrades a partial core either, and never hides a core failure behind its own failure', () => {
    const partial = verifyProofDocument(withMember(JSON.parse(gunzipSync(readFileSync(new URL('network-update.json.gz', dir))).toString('utf8')), member(Level.Finalized)), options());
    const plain = verifyProofDocument(JSON.parse(gunzipSync(readFileSync(new URL('network-update.json.gz', dir))).toString('utf8')));
    expect(plain.overall).not.toBe('verified');
    expect(partial.overall).toBe(plain.overall);
    expect(layer(partial, 'S7').verdict).toBe('verified');
    const forged = JSON.parse(sectionToJSON(newSection(block, chain(wrongD0(), Level.Finalized))));
    const both = verifyProofDocument(withMember(patched('tx-swap'), forged), options());
    expect(both.failure?.layer).toBe('L1');
    expect(layer(both, 'S7').verdict).toBe('failed');
  }, 300_000);

  it('a null member is no section: the document is verified as before', () => {
    const v = verifyProofDocument(withMember(valid, null));
    expect(v.finality).toBeUndefined();
    expect(ids(v)).not.toContain('S7');
    expect(v.overall).toBe(verifyProofDocument(valid).overall);
  }, 300_000);
});

describe('verifyPortable with a finality section', () => {
  const valid = JSON.parse(baseText);
  it('adds report.finality only when a member is carried or the option is given, and never changes another member', () => {
    const plain = verifyPortable(valid);
    expect(plain.finality).toBeUndefined();
    const carried = verifyPortable(withMember(valid, member(Level.Finalized)));
    expect(carried.finality?.class).toBe('summary_only');
    const { finality: _f, ...rest } = carried;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
    const judged = verifyPortable(withMember(valid, member(Level.L1Posted, Level.Finalized)), undefined, options());
    expect(judged.finality?.class).toBe('verified');
    expect(judged.finality?.headline).toBe(3);
    expect(verifyPortable(valid, undefined, options()).finality?.text).toContain('no finality section');
  }, 300_000);

  it('a core failure still throws what it threw: the section cannot swallow it', () => {
    expect(() => verifyPortable(withMember(patched('tx-swap'), member(Level.Finalized)), undefined, options())).toThrow();
  }, 300_000);
});

describe('the asynchronous entries judge with every ported kind', () => {
  it('a real Base leg of the Go oracle verifies through verifyProofDocumentWithKinds with the pins the vector was judged under', async () => {
    const c = cases().find((x) => x.id === 'e2e/base_posted_a/vector_pins')!;
    const doc = withMember(JSON.parse(baseText), JSON.parse(docOf(c)).finality);
    const v = await finality.verifyProofDocumentWithKinds(doc, { finality: { settlement: legSettlement(c.settlement, BigInt(c.chain)), pins: pinsNamed(c.pins), subject: 'DOC' } });
    expect(layer(v, 'S7').verdict).toBe('verified');
    expect(layer(v, 'S7').evidence.headline).toBe('l1_posted');
    expect(v.overall).toBe(verifyProofDocument(JSON.parse(baseText)).overall);
    const r = await finality.verifyPortableWithKinds(doc, undefined, { finality: { settlement: legSettlement(c.settlement, BigInt(c.chain)), pins: pinsNamed(c.pins) } });
    expect(r.finality?.class).toBe('verified');
  }, 300_000);

  it('the same leg under the embedded pins is the named summary-only finality_ledger_behind (the embedded Sepolia ledger ends at the root pin)', async () => {
    const c = cases().find((x) => x.id === 'e2e/base_posted_a/embedded_pins')!;
    const doc = withMember(JSON.parse(baseText), JSON.parse(docOf(c)).finality);
    const v = await finality.verifyProofDocumentWithKinds(doc, { finality: { settlement: legSettlement(c.settlement, BigInt(c.chain)) } });
    expect(layer(v, 'S7').verdict).toBe('not_checked');
    expect(layer(v, 'S7').reason).toContain('not known to this verifier');
    expect(v.overall).toBe('partial');
  }, 300_000);

  it('with no Settlement nothing is wired and the section judges nothing', async () => {
    const v = await finality.verifyProofDocumentWithKinds(withMember(JSON.parse(baseText), member(Level.Finalized)));
    expect(layer(v, 'S7').verdict).toBe('not_checked');
    expect(v.finality?.noKinds).toBeUndefined();
  }, 300_000);
});

describe('applyFinality over a core whose layers are all verified (the composition, without the capture limit of the conformance document)', () => {
  const real = verifyProofDocument(JSON.parse(baseText));
  const verifiedCore = (): Verification => ({
    ...real,
    overall: 'verified',
    independent: true,
    layers: real.layers.map((l) => (l.verdict === 'not_checked' ? { ...l, verdict: 'verified' as const, evidence: {}, reason: undefined } : l)),
    covers: COVERED_STATEMENTS,
    notCovered: NOT_COVERED_STATEMENTS,
  });
  const judged = (levels: Level[], extra = {}) => judgeFinalityDocument(withMember({}, member(...levels)), options(extra).finality);

  it('verified section: overall stays verified, S7 is covered at the level reached and is no longer not covered', () => {
    const v = applyFinality(verifiedCore(), judged([Level.L1Posted, Level.Finalized]));
    expect(v.overall).toBe('verified');
    expect(v.independent).toBe(true);
    expect(v.covers).toEqual([...COVERED_STATEMENTS, 'S7(finalized)']);
    expect(v.notCovered).toEqual(NOT_COVERED_STATEMENTS.filter((x) => x !== 'S7'));
    expect(v.failure).toBeUndefined();
    expect(ids(v).indexOf('S7')).toBe(ids(v).indexOf('govRootV3') + 1);
    const one = applyFinality(verifiedCore(), judged([Level.L1Posted]));
    expect(one.covers).toEqual([...COVERED_STATEMENTS, 'S7(l1_posted)']);
  });

  it('summary-only section: overall partial, nothing claimed; failed section: overall failed with S7 as the failure; both can only weaken', () => {
    const summary = applyFinality(verifiedCore(), judged([Level.Finalized], { registry: new Registry() }));
    expect([summary.overall, summary.independent, summary.covers]).toEqual(['partial', false, []]);
    expect(summary.notCovered).toEqual([...COVERED_STATEMENTS, ...NOT_COVERED_STATEMENTS]);
    expect(summary.failure).toBeUndefined();
    const forged = judgeFinalityDocument(withMember({}, JSON.parse(sectionToJSON(newSection(block, chain(wrongD0(), Level.Finalized))))), options().finality);
    const failed = applyFinality(verifiedCore(), forged);
    expect([failed.overall, failed.independent, failed.covers]).toEqual(['failed', false, []]);
    expect(failed.failure?.layer).toBe('S7');
  });

  it('a core that already failed keeps its own failure and its own overall whatever the section says', () => {
    const coreFailed = verifyProofDocument(patched('tx-swap'));
    expect(coreFailed.overall).toBe('failed');
    const v = applyFinality(coreFailed, judged([Level.L1Posted, Level.Finalized]));
    expect(v.overall).toBe('failed');
    expect(v.failure).toEqual(coreFailed.failure);
    expect(v.covers).toEqual([]);
  }, 300_000);

  it('the S7 layer is judged by the same order as Go: failed beats summary-only beats verified, in every pairing of core and section', () => {
    const rank = { verified: 0, partial: 1, failed: 2 } as const;
    const cores: Verification[] = [verifiedCore(), real, verifyProofDocument(patched('tx-swap'))];
    const sections = [judged([Level.Finalized]), judged([Level.Finalized], { registry: new Registry() }), judgeFinalityDocument(withMember({}, JSON.parse(sectionToJSON(newSection(block, chain(wrongD0(), Level.Finalized))))), options().finality)];
    const rankOf = (c: string): number => (c === 'verified' ? 0 : c === 'summary_only' ? 1 : 2);
    for (const core of cores) {
      for (const sec of sections) {
        const want = Math.max(rank[core.overall as keyof typeof rank], rankOf(sec.class));
        expect(rank[applyFinality(core, sec).overall as keyof typeof rank], `${core.overall} + ${sec.class}`).toBe(want);
      }
    }
  }, 300_000);
});
