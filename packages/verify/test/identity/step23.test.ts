// Step 23 without a vector. No vector tells a step 23 that is inert (its output kept, its verdicts dropped) from the real one, because step 23 has no
// verdict; the kill gate (killgate.test.ts) kills it only by `disabled`. Here the step is pinned directly: what it writes into the facts
// (Facts.C.rulesNotJudged, content and order), that it contributes nothing else, that it is the registered step 23, and that the runner's report
// build refuses a run in which step 23 wrote nothing (runner.ts buildReport, twin of runner.go buildReport / rulesNotJudgedOf).
import { describe, expect, it } from 'vitest';
import {
  embeddedManifestBytes, embeddedPin, fingerprint, fixedRulesNotJudged, loadManifest, loadMaterialised, newEnv, newFacts, reportObject, resolveManifest, steps2c,
  type Env, type LegContext, type StepFn,
} from '../../src/proof-v2/identity/index.js';
import { step23 } from '../../src/proof-v2/identity/steps2c.js';
import { setFiles, vectorIds } from './fixtures.js';
import { verifierWith } from './stepmap.js';

// The four rows, byte for byte as the specification and the validator's FixedRulesNotJudged print them.
const WANT = [
  { row: 'A21', reason: 'minimumGovernanceLevelForValueOps is read only by executeWithGovernance (CertenAnchorV8_2.sol:1398), not on the attestation path; reported in registry' },
  { row: 'A09:3', reason: 'registeredAt is informational; no acceptance decision reads it' },
  { row: 'slot19:usedNonces', reason: 'restrict-only: its single reader is nonceValid = !usedNonces[...] (CertenAnchorV8_2.sol:2002) and its single writer assigns the literal true (:1352)' },
  { row: 'slot28:operators', reason: 'not read by the attestation path' },
];

const minimalEnv = (): Env => newEnv({} as LegContext, undefined, loadManifest(embeddedManifestBytes(), embeddedPin()));

describe('step 23 (report assembly inputs: rules_not_judged), vector-free', () => {
  it('starts from facts in which nothing has judged any rule, so step 23 is the only writer, and is the function registered for step 23', () => {
    expect(newFacts().C.rulesNotJudged).toEqual([]);
    expect(steps2c()['23']).toBe(step23);
  });

  it('writes exactly the four fixed rows, in order, into Facts.C.rulesNotJudged and returns an empty output (no part, open entry, finding, rule, refusal, halt or supersede)', () => {
    const env = minimalEnv();
    const before = Object.fromEntries((['A', 'B1', 'B2'] as const).map((g) => [g, fingerprint(env.facts[g])]));
    const cBefore = { registry: env.facts.C.registry, registryLink: env.facts.C.registryLink, level: fingerprint(env.facts.C.level) };
    const out = step23(env);
    expect(out).toEqual({});
    expect(Object.keys(out)).toEqual([]);
    expect(env.facts.C.rulesNotJudged).toEqual(WANT);
    expect(env.facts.C.rulesNotJudged.map((r) => r.row)).toEqual(['A21', 'A09:3', 'slot19:usedNonces', 'slot28:operators']);
    // nothing else in any fact group moved
    for (const g of ['A', 'B1', 'B2'] as const) expect(fingerprint(env.facts[g]), `facts ${g}`).toBe(before[g]);
    expect(env.facts.C.registry).toBe(cBefore.registry);
    expect(env.facts.C.registryLink).toBe(cBefore.registryLink);
    expect(fingerprint(env.facts.C.level)).toBe(cBefore.level);
    // the constant list of the outcomes in which step 23 does not run is the same list
    expect(fixedRulesNotJudged()).toEqual(WANT);
  });

  it('writes a fresh list each time: one run cannot leak a mutation into another', () => {
    const a = minimalEnv();
    const b = minimalEnv();
    step23(a);
    step23(b);
    a.facts.C.rulesNotJudged[0]!.reason = 'mutated';
    a.facts.C.rulesNotJudged.pop();
    expect(b.facts.C.rulesNotJudged).toEqual(WANT);
    step23(a);
    expect(a.facts.C.rulesNotJudged).toEqual(WANT);
    expect(fixedRulesNotJudged()).toEqual(WANT);
  });

  // ---- the runner refuses a run in which step 23 ran and wrote nothing ----

  // The inputs of one vector that reaches step 23 (a container with no framework halt) serve only to drive the runner; no expectation is read.
  const driver = (() => {
    const set = 's8_int_1';
    const files = setFiles(set);
    const td = new TextDecoder();
    const id = vectorIds(files).find((v) => (JSON.parse(td.decode(files.get(`${v}.expected.json`))) as { headline: string }).headline === 'verified');
    if (!id) throw new Error(`no verified vector in ${set} to drive the runner`);
    const inputs = loadMaterialised(td.decode(files.get(`${id}.inputs.json`)), files);
    const r = resolveManifest(inputs);
    if (!r.manifest) throw new Error(`${id}: the manifest does not load`);
    return { id, inputs, manifest: r.manifest };
  })();

  it('the production verifier prints the four rows on a run in which step 23 ran', () => {
    const rep = verifierWith({})(driver.inputs.ctx, driver.inputs.container, driver.manifest);
    expect(rep.rulesNotJudged, driver.id).toEqual(WANT);
    expect((reportObject(rep)['rules_not_judged'] as unknown[]).length).toBe(4);
  });

  it('the report build refuses a run in which step 23 ran and wrote nothing: an error, never a quietly filled constant', () => {
    const wroteNothing: StepFn = (env) => { void env; return {}; };
    const verify = verifierWith({ '23': () => wroteNothing });
    expect(() => verify(driver.inputs.ctx, driver.inputs.container, driver.manifest)).toThrow(/report: step 23 ran and wrote no rules_not_judged/);
  });

  it('a step 23 that writes an empty list is refused the same way', () => {
    const wroteEmpty: StepFn = (env) => { env.facts.C.rulesNotJudged = []; return {}; };
    const verify = verifierWith({ '23': () => wroteEmpty });
    expect(() => verify(driver.inputs.ctx, driver.inputs.container, driver.manifest)).toThrow(/step 23 ran and wrote no rules_not_judged/);
  });

  it('a step 23 that writes other rows is printed as written: the report carries what step 23 wrote, not the constant', () => {
    const other = [{ row: 'X', reason: 'written by the step' }];
    const verify = verifierWith({ '23': () => (env) => { env.facts.C.rulesNotJudged = other; return {}; } });
    expect(verify(driver.inputs.ctx, driver.inputs.container, driver.manifest).rulesNotJudged).toEqual(other);
  });
});
