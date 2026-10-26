// THE KILL GATE of the TypeScript composed verifier (twin of TestEveryStepOfTheComposedVerifierIsKilledByAVector in the validator's
// pkg/contractidentity/integration_composed_test.go): for each of the 25 registrable steps and both modes, the production registry is built with that
// ONE step replaced, every vector of every published set is run, and the step must be KILLED, that is some vector's expectation fails.
//
//   disabled  the step is replaced by a stand-in that reports its parts verified and runs nothing (its Facts stay empty).
//   inert     the real step runs (its reads and Facts stay) but every part it contributes becomes verified and its Open entries, findings, framework
//             refusal, halt and supersede are dropped.
//
// Steps 10 and 23 may survive `inert` only, for the reasons Go records in inertEquivalents; they must be killed by `disabled`. Nothing here edits
// src/: a survivor is a finding about the vectors or the step, never something this file papers over.
import { readdirSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { registrableSteps, spec, verified, type PartResult, type StepFn, type StepId, type StepOutput, type Verifier } from '../../src/proof-v2/identity/index.js';
import { SET_NAMES, VECTORS, setFiles, vectorIds } from './fixtures.js';
import { runSet } from './runset.js';
import { verifierWith } from './stepmap.js';

/** inert wraps a real step: it runs, but every part it contributes becomes verified and everything else it decides is dropped. */
export const inert = (id: StepId, real: StepFn): StepFn => (env) => {
  const out = real(env);
  const sp = spec(id)!;
  let parts: PartResult[] = (out.parts ?? []).map((p) => verified(p.part));
  if (parts.length === 0 && out.framework) parts = sp.parts.map((p) => verified(p));
  const res: StepOutput = { parts };
  if (out.rulesJudged) res.rulesJudged = out.rulesJudged;
  if (out.readPlanIncomplete) res.readPlanIncomplete = out.readPlanIncomplete;
  return res;
};

/** disabled is the stand-in: the step's parts verified, nothing run. */
export const disabled = (id: StepId): StepFn => (env) => {
  void env;
  return { parts: spec(id)!.parts.map((p) => verified(p)) };
};

/** The steps whose own verdicts are observably redundant in the composition (reasons as in Go's inertEquivalents); killed by `disabled`. */
const inertEquivalents: Partial<Record<StepId, string>> = {
  '23': 'step 23 contributes no part: its only output is Facts.C.rulesNotJudged, which an inert step leaves untouched; the disabled gate kills it (the report of a run in which step 23 wrote nothing is an error, runner.ts buildReport)',
  '10': 'a refusal of step 10 is kept in Facts.A.anchorRefusal and step 12 (and 11) carry it onto code_identity (steps2a_settle.ts: step12, anchorRefusal): the report is identical',
};

const sets = [...SET_NAMES].sort();
const fileCache = new Map<string, Map<string, Uint8Array>>();
const filesOf = (name: string): Map<string, Uint8Array> => {
  let f = fileCache.get(name);
  if (!f) { f = setFiles(name); fileCache.set(name, f); }
  return f;
};

/**
 * Where each kill was found when this gate was written (set/vector). A hint only decides the order in which vectors are tried: a mutation is killed
 * when SOME vector fails, so a hint that no longer kills (a changed corpus, a changed step) falls through to the rest of the corpus and the result is
 * the same. It makes a kill cost one vector instead of a scan of the corpus (about 0.5 s per vector).
 */
const HINTS: Record<string, string> = {
  'disabled:1c': 's8_2a_1/VS8-024.settle_attest_event_not_found',
  'disabled:2': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:3': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:4': 's8_2a_1/VS8-023.later_proven_at',
  'disabled:5': 's8_2a_1/VS8-041',
  'disabled:6': 's8_2a_1/VS8-041',
  'disabled:7': 's8_2a_1/VS8-041',
  'disabled:8': 's8_2a_1/VS8-041',
  'disabled:9': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:10': 's8_2a_1/VS8-041',
  'disabled:11': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:12': 's8_2a_1/VS8-075.generated_code',
  'disabled:13': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:14': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:15': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:16': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:17': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:18': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:18b': 's8_2b2_1/VS8-125.bundle_id_not_recomputed',
  'disabled:19': 's8_2b2_1/VS8-130.anchor_threshold',
  'disabled:20': 's8_2b1_1/VS8-140.message_hash',
  'disabled:21': 's8_2a_1/VS8-041',
  'disabled:22': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:23': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'disabled:24': 's8_2a_1/VS8-041',
  'inert:1c': 's8_2a_1/VS8-024.settle_attest_event_not_found',
  'inert:2': 's8_2a_1/VS8-030.chain',
  'inert:3': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'inert:4': 's8_2a_1/VS8-023.later_proven_at',
  'inert:5': 's8_2a_1/VS8-046.catalogued',
  'inert:6': 's8_2a_1/VS8-063.string_slot',
  'inert:7': 's8_2a_1/VS8-066._entryPoint',
  'inert:8': 's8_2a_1/VS8-067.deployed_flag',
  'inert:9': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'inert:11': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'inert:12': 's8_2a_1/VS8-075.generated_code',
  'inert:13': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'inert:14': 's8_2a_1/VS8-022.capture_not_attempted_in_window',
  'inert:15': 's8_2b1_1/VS8-100.attest_block_out_of_reach',
  'inert:16': 's8_2b1_1/VS8-101.hops_bv_not_below_n',
  'inert:17': 's8_2a_1/VS8-040',
  'inert:18': 's8_2a_1/VS8-075.generated_code',
  'inert:18b': 's8_2b2_1/VS8-125.bundle_id_not_recomputed',
  'inert:19': 's8_2b2_1/VS8-130.anchor_threshold',
  'inert:20': 's8_2b1_1/VS8-140.message_hash',
  'inert:21': 's8_2c_1/VS8-150.anchor_owner',
  'inert:22': 's8_2b2_1/VS8-138.binding_0_at_both_owner_toggled',
  'inert:24': 's8_int_1/VS8-184.unproven',
};

interface Killer { set: string; id: string }
/** The vectors that killed an earlier mutation. A mutation is killed when SOME vector fails, which does not depend on the order the vectors are tried in. */
const killers: Killer[] = [];

/** A vector of the corpus that the verifier fails, as `set/id: detail`; undefined when every vector of every published set passes. The hinted vector and earlier killers are tried first, then the whole corpus in published order. */
function killedBy(verify: Verifier, hint?: string): string | undefined {
  const tried = new Set<string>();
  const first: Killer[] = [];
  if (hint) { const [set, id] = hint.split('/') as [string, string]; first.push({ set, id }); }
  for (const k of [...first, ...killers]) {
    if (tried.has(k.set + '/' + k.id)) continue;
    tried.add(k.set + '/' + k.id);
    const bad = runSet(k.set, verify, undefined, { files: filesOf(k.set), ids: [k.id] }).find((r) => r.outcome !== 'pass');
    if (bad) return `${k.set}/${bad.id}: ${bad.detail.slice(0, 120)}`;
  }
  for (const name of sets) {
    const bad = runSet(name, verify, undefined, { files: filesOf(name), stopAtFirstFail: true }).find((r) => r.outcome !== 'pass');
    if (bad) { killers.push({ set: name, id: bad.id }); return `${name}/${bad.id}: ${bad.detail.slice(0, 120)}`; }
  }
  return undefined;
}

interface Row { mode: string; step: StepId; killedBy: string; ms: number }
const table: Row[] = [];
const TIMEOUT = 900_000;

describe('kill gate: every step of the composed verifier is killed by a vector', () => {
  const steps = registrableSteps();

  it('uses every published set: the sets on disk are exactly the ten of SET_NAMES, 291 vectors, and 25 steps are registrable', () => {
    const onDisk = readdirSync(VECTORS, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('s8_')).map((e) => e.name).sort();
    expect(onDisk).toEqual(sets);
    expect(sets.reduce((n, s) => n + vectorIds(filesOf(s)).length, 0)).toBe(291);
    expect(steps.length).toBe(25);
  }, TIMEOUT);

  it('control: every hinted vector passes the unmutated production registry, so a hint kills only through the mutation', () => {
    const prod = verifierWith({});
    const hinted = [...new Set(Object.values(HINTS))];
    expect(hinted.length).toBeGreaterThan(0);
    for (const h of hinted) {
      const [set, id] = h.split('/') as [string, string];
      const res = runSet(set, prod, undefined, { files: filesOf(set), ids: [id] });
      expect(res.length, h).toBe(1);
      expect(res[0]!.outcome, `${h}: ${res[0]!.detail}`).toBe('pass');
    }
    expect(Object.keys(HINTS).length).toBe(48);
  }, TIMEOUT);

  for (const mode of ['disabled', 'inert'] as const) {
    describe(mode, () => {
      for (const id of steps) {
        it(`step ${id} is killed`, () => {
          const t0 = performance.now();
          const verify = verifierWith({ [id]: (real: StepFn) => (mode === 'inert' ? inert(id, real) : disabled(id)) });
          const killer = killedBy(verify, HINTS[`${mode}:${id}`]);
          const ms = Math.round(performance.now() - t0);
          if (killer !== undefined) { table.push({ mode, step: id, killedBy: killer, ms }); return; }
          const why = inertEquivalents[id];
          if (mode === 'inert' && why !== undefined) { table.push({ mode, step: id, killedBy: `SURVIVES (allowed: ${why.slice(0, 60)}...)`, ms }); return; }
          table.push({ mode, step: id, killedBy: 'SURVIVES', ms });
          expect.fail(`step ${id} survives (${mode}): no vector of any published set fails`);
        }, TIMEOUT);
      }
    });
  }

  it('summary: 25 steps killed by disabled, and by inert except the two documented equivalents', () => {
    const dis = table.filter((r) => r.mode === 'disabled');
    const ine = table.filter((r) => r.mode === 'inert');
    expect(dis.length).toBe(25);
    expect(ine.length).toBe(25);
    expect(dis.filter((r) => !r.killedBy.startsWith('SURVIVES')).length, 'disabled kills').toBe(25);
    const survivors = ine.filter((r) => r.killedBy.startsWith('SURVIVES')).map((r) => r.step).sort();
    for (const s of survivors) expect(Object.keys(inertEquivalents), `inert survivor ${s} is not a documented equivalent`).toContain(s);
    // a survivor passed all 291 vectors through its mutated registry: the harness (cached files, ordering, early stop) raises no false kill
  });

  afterAll(() => {
    const lines = table.map((r) => `${r.mode.padEnd(8)} ${r.step.padEnd(4)} ${String(r.ms).padStart(6)}ms  ${r.killedBy}`);
    const total = table.reduce((n, r) => n + r.ms, 0);
    console.log(`KILL TABLE (${table.length} rows, ${total} ms of mutation runs)\n${lines.join('\n')}`);
  });
});
