/**
 * The finality section's report, replayed against the Go oracle: every case below is a document + Settlement + pins + registry whose report the validator's
 * proofverify (reportFinalityFile at cbb6373) printed; TypeScript must print the same report (same text, same headline, same exit class). The set is
 * test/fixtures/finality/doc_report1 (README.md: provenance, regeneration).
 *
 * Kinds the TypeScript verifier does not have yet (the real eth-sepolia and arb-sepolia finalized legs): the case carries two Go expectations, one from a
 * registry that holds every kind and one from a registry that lacks exactly those two. A leg whose kind is registered here must equal the first, a leg whose kind
 * is not must equal the second (the named summary-only state), so porting the kind turns the stronger assertion on without touching this file.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judgeFinalityText, renderReport, type FinalityOptions } from '../../../src/proof-v2/finality/docreport.js';
import { Level } from '../../../src/proof-v2/finality/level.js';
import type { Report } from '../../../src/proof-v2/finality/report.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { Registry } from '../../../src/proof-v2/finality/registry.js';
import { allKindsRegistry, cases, comparable, docOf, fakeBaseRegistry, goText, legSettlement, pinsNamed, readSet, SET, sha256Hex, sourceOf } from './support.js';

describe('doc_report1 is the recorded Go oracle, unmodified', () => {
  it('every file hashes to MANIFEST.json and no file is missing or extra', () => {
    const manifest = JSON.parse(readSet('MANIFEST.json').toString('utf8')) as Record<string, string>;
    const files: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), rel === '' ? e.name : `${rel}/${e.name}`);
        else if (!(rel === '' && e.name === 'MANIFEST.json')) files.push(rel === '' ? e.name : `${rel}/${e.name}`);
      }
    };
    walk(SET, '');
    expect(files.sort()).toEqual(Object.keys(manifest).sort());
    for (const f of files) expect(sha256Hex(readFileSync(join(SET, f)))).toBe(manifest[f]);
  });

  it('holds the cases the Go tests build in code and the real legs of finality_e2e_pos1', () => {
    const ids = cases().map((c) => c.id);
    expect(ids.filter((i) => i.startsWith('go/')).length).toBe(20);
    expect(ids.filter((i) => i.startsWith('extra/')).length).toBe(7);
    expect(ids.filter((i) => i.startsWith('e2e/')).length).toBe(24);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a case that names no kind has the same Go report with and without the kinds this verifier lacks', () => {
    for (const c of cases()) if (c.kind === '') expect(c.expect_without, c.id).toEqual(c.expect_all);
  });
});

const CASES = cases();

describe('every Go report of a finality member is reproduced', () => {
  for (const c of CASES) {
    it(c.id, async () => {
      const registry = c.registry === 'fake_base' ? fakeBaseRegistry() : c.registry === 'empty' ? new Registry() : await allKindsRegistry();
      const opts: FinalityOptions = { registry, pins: pinsNamed(c.pins), subject: 'DOC' };
      const want = c.kind !== '' && registry.kind(c.kind) === undefined ? c.expect_without : c.expect_all;
      if (c.settlement !== '') opts.settlement = legSettlement(c.settlement, BigInt(c.chain), sourceOf(want.text));
      const got = judgeFinalityText(docOf(c), opts);
      expect(got.exit, c.id).toBe(want.exit);
      expect(comparable(got.text), c.id).toBe(comparable(goText(want.text)));
      expect(got.class).toBe(want.exit === 0 ? 'verified' : want.exit === 3 ? 'summary_only' : 'failed');
      expect(got.noKinds).toBeUndefined();
    }, 300_000);
  }

  it('the real legs that are judged here are judged by the kinds this verifier has', async () => {
    const reg = await allKindsRegistry();
    const judged = CASES.filter((c) => c.kind !== '' && reg.kind(c.kind) !== undefined).map((c) => c.id.split('/')[1]);
    expect([...new Set(judged)].sort()).toEqual([
      'arb_final_real',
      'arb_posted',
      'base_final_47604755',
      'base_final_47898494',
      'base_posted_a',
      'base_posted_b',
      'eth_gloas_latest',
      'eth_gloas_latest_root_anchored',
      'eth_gloas_period',
      'eth_gloas_period_root_anchored',
      'eth_legacy',
      'eth_legacy_root_anchored',
    ]);
    // Every kind the Go cases name is registered here: no case is judged against the without-kinds expectation any more.
    expect(CASES.filter((c) => c.kind !== '' && c.registry === 'all' && reg.kind(c.kind) === undefined).map((c) => c.id)).toEqual([]);
    const verifiedHere = CASES.filter((c) => c.kind !== '' && reg.kind(c.kind) !== undefined && c.expect_all.exit === 0).length;
    expect(verifiedHere).toBeGreaterThanOrEqual(5);
  });
});

interface SynthState {
  code: string;
  fields: Record<string, string | number>;
}
interface SynthReport {
  chain: number;
  number: number;
  hash: string;
  unsupported?: SynthState;
  levels: Record<string, { status: 'verified' | 'level_not_applicable' | 'pending' | 'refused'; state?: SynthState }>;
  headline: string;
  broken?: SynthState;
  finalizedBlockState?: SynthState;
  finalizedBlock?: { number: number; hash: string; stateRoot: string };
  pinsSha256: string;
  pinsSource: string;
}

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const state = (s: SynthState | undefined): FinalityStateError | undefined => (s === undefined ? undefined : new FinalityStateError(s.code, s.fields));
const LEVEL_BY_NAME: Record<string, Level> = { none: Level.None, included: Level.Included, l1_posted: Level.L1Posted, finalized: Level.Finalized };

function reportOf(r: SynthReport): Report {
  const levels = new Map<Level, { status: 'verified' | 'level_not_applicable' | 'pending' | 'refused'; state?: FinalityStateError }>();
  for (const [name, l] of Object.entries(r.levels)) {
    const st = state(l.state);
    levels.set(LEVEL_BY_NAME[name]!, { status: l.status, ...(st ? { state: st } : {}) });
  }
  const unsupported = state(r.unsupported);
  const broken = state(r.broken);
  const fbs = state(r.finalizedBlockState);
  return {
    block: { chain: BigInt(r.chain), number: BigInt(r.number), hash: hex(r.hash) },
    levels,
    headline: LEVEL_BY_NAME[r.headline]!,
    pinsSha256: r.pinsSha256,
    pinsSource: r.pinsSource,
    ...(unsupported ? { unsupported } : {}),
    ...(broken ? { broken } : {}),
    ...(fbs ? { finalizedBlockState: fbs } : {}),
    ...(r.finalizedBlock ? { finalizedBlock: { number: BigInt(r.finalizedBlock.number), hash: hex(r.finalizedBlock.hash), stateRoot: hex(r.finalizedBlock.stateRoot) } } : {}),
  };
}

describe("printReport and notCoveredByThePins over Go's synthetic reports", () => {
  const synth = JSON.parse(readSet('synthetic.json').toString('utf8')).reports as { id: string; report: SynthReport; expect: { exit: number; text: string } }[];
  it('has the ten classes of finality_pins_class_test.go and every other branch of printReport', () => {
    expect(synth.filter((s) => s.id.startsWith('class/')).length).toBe(10);
    expect(synth.filter((s) => s.id.startsWith('branch/')).length).toBe(9);
  });
  for (const s of synth) {
    it(s.id, () => {
      const got = renderReport(reportOf(s.report), 'leg');
      expect(got.exit).toBe(s.expect.exit);
      expect(got.text).toBe(s.expect.text);
    });
  }
});
