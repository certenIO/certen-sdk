// The step table of the composed S8 verifier (twin of steps.go): one spec per step of the specification, the package that owns it, the
// parts it judges, and the execution order. A step that is not registered is a construction error of the verifier, never a skipped step.
import * as N from './names.js';

export type StepId = '0' | '1' | '1b' | '1c' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | '11' | '12' | '13' | '14' | '15' | '16' | '17' | '18' | '18b' | '19' | '20' | '21' | '22' | '22b' | '23' | '24';
export type Owner = 'skeleton' | '2a' | '2b-1' | '2b-2' | '2c';
export interface StepSpec { id: StepId; owner: Owner; title: string; parts: string[]; needs: StepId[] }

const s = (id: StepId, owner: Owner, title: string, parts: string[], needs: StepId[]): StepSpec => ({ id, owner, title, parts, needs });
export const stepTable: readonly StepSpec[] = [
  s('0', 'skeleton', 'manifest and chain row', [], []),
  s('1', 'skeleton', 'strict decode', [], ['0']),
  s('1b', 'skeleton', 'context completeness', [], ['1']),
  s('1c', '2a', 'presence of the parts; carried Stated reasons; settle-dependent parts when settle is Stated', [], ['1b']),
  s('2', '2a', 'leg block, hash and chain', [], ['1c']),
  s('3', '2a', 'settlement facts and path; generation by code', [N.JudgedSettlementPath, N.JudgedS6Link], ['2']),
  s('4', '2a', 'roots and S6 link', [N.JudgedS6Link], ['2', '3']),
  s('5', '2a', 'account code identity (settle)', [N.JudgedCodeIdentity], ['3', '4']),
  s('6', '2a', 'account strings', [N.JudgedAccountProvenance], ['5']),
  s('7', '2a', 'account immutables', [N.JudgedAccountProvenance], ['5', '6']),
  s('8', '2a', 'account provenance: CREATE2 and factory registry', [N.JudgedAccountProvenance], ['5', '6', '7']),
  s('9', '2a', 'anchor pointer', [N.JudgedPointer], ['5']),
  s('10', '2a', 'anchor identity (settle)', [N.JudgedCodeIdentity], ['9']),
  s('11', '2a', 'anchor record and record binding', [N.JudgedRecord], ['3', '9', '10']),
  s('12', '2a', 'verifier chain identity (settle)', [N.JudgedCodeIdentity], ['10', '11']),
  s('13', '2a', 'state at settlement (Open entries)', [N.JudgedStateAtSettlement], ['9', '10', '12', '18']),
  s('14', '2a', 'authority level of the settled call', [N.JudgedAuthorityLevel], ['3', '5', '6', '7']),
  s('15', '2b-1', 'attest present?', [], ['1c']),
  s('16', '2b-1', 'attestation header link', [N.JudgedAuthorizationAttest], ['2', '15']),
  s('17', '2b-1', 'attestation transaction and receipt; strict ABI; blob layout', [N.JudgedAuthorizationAttest], ['3', '9', '11', '16']),
  s('18', '2b-2', 'authorization state at B_v, pre and post; byte rule; flips', [N.JudgedAuthorizationAttest, N.JudgedCodeIdentity], ['3', '9', '10', '12', '16', '17']),
  s('18b', '2b-2', 'attestation uniqueness (lemma U)', [N.JudgedAuthorizationAttest], ['10', '11', '18']),
  s('19', '2b-2', 'authorization rules at B_v', [N.JudgedAuthorizationAttest], ['12', '17', '18', '22']),
  s('20', '2b-1', 'message binding', [N.JudgedAuthorizationAttest], ['11', '17', '18']),
  s('21', '2c', 'registry emit, owner pin, registry link, pkc cross-check', [N.JudgedAuthorizationAttest, N.JudgedRegistryLink], ['17', '18', '22']),
  s('22', '2b-2', 'intra-block window (rule IB)', [N.JudgedIntraBlockWindow], ['16', '18']),
  s('22b', 'skeleton', 'node accounting', [], ['12', '13', '14', '19', '20', '21', '22']),
  s('23', '2c', 'report assembly inputs: rules_not_judged', [], ['13', '14', '19', '21', '24']),
  s('24', '2c', 'level binding to S7', [], ['2']),
];
export const execOrder: readonly StepId[] = ['1c', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '14', '15', '16', '17', '18', '18b', '22', '19', '20', '21', '13', '22b', '24', '23'];

export const spec = (id: StepId): StepSpec | undefined => stepTable.find((x) => x.id === id);
/** The steps a package registers: every step that is not the skeleton's. */
export const registrableSteps = (): StepId[] => stepTable.filter((x) => x.owner !== 'skeleton').map((x) => x.id);
export const ownedBy = (o: Owner): StepId[] => stepTable.filter((x) => x.owner === o).map((x) => x.id);

export class StepRegistry<F> {
  private readonly fns = new Map<StepId, F>();
  register(id: StepId, fn: F): void {
    const sp = spec(id);
    if (!sp || sp.owner === 'skeleton') throw new Error(`contractidentity: step ${id} is not registrable`);
    if (this.fns.has(id)) throw new Error(`contractidentity: step ${id} is registered twice`);
    this.fns.set(id, fn);
  }
  get(id: StepId): F | undefined { return this.fns.get(id); }
  missing(): StepId[] { return registrableSteps().filter((id) => !this.fns.has(id)); }
}
