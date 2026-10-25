// The production step functions by id and a registry builder that replaces chosen steps: the material of the mutation gate (killgate.test.ts) and of
// the step 23 unit test. Twin of the registry assembly in the validator's integration_composed_test.go killGate.
import {
  StepRegistry, newVerifier, registrableSteps, steps2a, steps2b1, steps2b2, steps2c,
  type StepFn, type StepId, type Verifier,
} from '../../src/proof-v2/identity/index.js';

/** Every registrable step with its production function. Refuses a table that is not exactly the registrable steps. */
export function realSteps(): Map<StepId, StepFn> {
  const real = new Map<StepId, StepFn>();
  for (const m of [steps2a(), steps2b1(), steps2b2(), steps2c()]) for (const [id, fn] of Object.entries(m) as [StepId, StepFn][]) real.set(id, fn);
  const want = registrableSteps();
  if (want.length !== 25 || real.size !== 25 || want.some((id) => !real.has(id))) throw new Error(`${want.length} registrable steps, ${real.size} registered functions, want 25 and 25`);
  return real;
}

/** The composed verifier over the production steps with `replace` swapped in (a function per step id to replace). */
export function verifierWith(replace: Partial<Record<StepId, (real: StepFn) => StepFn>>): Verifier {
  const real = realSteps();
  const reg = new StepRegistry<StepFn>();
  for (const id of registrableSteps()) reg.register(id, replace[id] ? replace[id]!(real.get(id)!) : real.get(id)!);
  return newVerifier(reg);
}
