// The package 2a step table: steps 1c-14, registered into a StepRegistry.
import type { StepFn } from './framework.js';
import { ownedBy, type StepId, type StepRegistry } from './steps.js';
import { step1c, step2, step3, step4, step5, step6, step7, step8, step9 } from './steps2a.js';
import { step10, step11, step12, step13, step14 } from './steps2a_settle.js';

export const steps2a = (): Partial<Record<StepId, StepFn>> => ({
  '1c': step1c, '2': step2, '3': step3, '4': step4, '5': step5, '6': step6, '7': step7, '8': step8, '9': step9, '10': step10, '11': step11, '12': step12, '13': step13, '14': step14,
});
export function registerSteps2a(reg: StepRegistry<StepFn>): void {
  const fns = steps2a();
  for (const id of ownedBy('2a')) reg.register(id, fns[id]!);
}
