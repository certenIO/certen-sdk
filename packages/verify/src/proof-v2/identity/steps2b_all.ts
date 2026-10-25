// The package 2b-1 (steps 15, 16, 17, 20) and 2b-2 (steps 18, 18b, 19, 22) step tables, registered into a StepRegistry.
import type { StepFn } from './framework.js';
import { ownedBy, type StepId, type StepRegistry } from './steps.js';
import { step15, step16, step17, step20 } from './steps2b1.js';
import { step18, step18b, step19, step22 } from './steps2b2.js';

export const steps2b1 = (): Partial<Record<StepId, StepFn>> => ({ '15': step15, '16': step16, '17': step17, '20': step20 });
export const steps2b2 = (): Partial<Record<StepId, StepFn>> => ({ '18': step18, '18b': step18b, '19': step19, '22': step22 });
export function registerSteps2b1(reg: StepRegistry<StepFn>): void {
  const fns = steps2b1();
  for (const id of ownedBy('2b-1')) reg.register(id, fns[id]!);
}
export function registerSteps2b2(reg: StepRegistry<StepFn>): void {
  const fns = steps2b2();
  for (const id of ownedBy('2b-2')) reg.register(id, fns[id]!);
}
