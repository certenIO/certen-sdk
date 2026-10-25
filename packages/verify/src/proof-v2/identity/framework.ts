// The step framework types (twin of env.go, facts*.go and the StepOutput of steps.go): the environment a step reads, the facts steps hand
// to later steps (one group per owning package; a step that writes another group's facts is refused), and what a step returns.
import { readHeader, type HeaderFields } from '../finality/rlpheader.js';
import type { Container, Limits, Stated } from './codec.js';
import { defaultIdentityLimits, TagStated } from './codec.js';
import type { LegContext, ReceiptLeaf, Tx } from './context.js';
import type { ChainEntry, Manifest } from './manifest.js';
import type { Finding, OpenEntry, PartResult, RuleNotJudged } from './report.js';
import type { NodeSet, AccountState } from './reads.js';
const noStation = (): AuthStation => ({ stateRoot: new Uint8Array(32), words: {}, accounts: {}, verifier: new Uint8Array(20), verifierPublished: false, groth16: new Uint8Array(20) });
import { zeroAccount } from './reads.js';
import { must, type StateError } from './states.js';
import type { CanonValue } from './canon.js';
import type { Owner, StepId } from './steps.js';
import { zeros } from './bytes.js';

export interface AnchorRecord {
  words: Uint8Array[]; bundleId: Uint8Array; merkleRoot: Uint8Array; operationId: Uint8Array; executionCommitment: Uint8Array; accSetRoot: Uint8Array;
  accIncarnation: Uint8Array; batchLeafCount: Uint8Array; accumulateBlockHeight: Uint8Array;
  valid: boolean; proofExecuted: boolean; governanceExecuted: boolean; governanceLevel: number; isBatchAnchor: boolean;
}
export interface AuthorityLeg { target: Uint8Array; selector: Uint8Array; value: bigint; required: string }
export interface AuthorityObject { level: string; loggedLevel: string; book: Uint8Array; page: bigint; source: string; legs: AuthorityLeg[] }
export interface Words { [id: string]: Uint8Array }

export interface FactsA {
  settleHeader?: HeaderFields; account: Uint8Array; anchorId: Uint8Array; leafKey: Uint8Array; selector: Uint8Array; generation: string;
  generationState?: StateError; pathFailure?: StateError; accountRefusal?: StateError; stateRootN: Uint8Array; accountState: AccountState; accountCode: Uint8Array;
  adiUrl: string; governingBook: Uint8Array; governingBookHash: Uint8Array; factoryAddress: Uint8Array; anchor: Uint8Array; anchorState: AccountState; anchorCode: Uint8Array;
  anchorRefusal?: StateError; record?: AnchorRecord; verifier: Uint8Array; verifierState: AccountState; verifierCode: Uint8Array; groth16: Uint8Array;
  groth16State: AccountState; groth16Code: Uint8Array; groth16Build: string; verifierFlags: Uint8Array; settleAuth?: Words; authority?: AuthorityObject;
}
export interface ValidatorRow { address: Uint8Array; registered: boolean; power: Uint8Array; blsKey?: Uint8Array }
export interface AuthStation { stateRoot: Uint8Array; words: Words; accounts: Record<string, AccountState>; verifier: Uint8Array; verifierPublished: boolean; groth16: Uint8Array }
export interface AuthDiff { row: string; pre: Uint8Array; post: Uint8Array }
export interface OwnerCheck { address: Uint8Array; pre: AccountState; post: AccountState }
export interface IBResult { evaluated: boolean; verified: boolean; state?: StateError; owners: OwnerCheck[]; types: number[] }
export interface AttestCall {
  anchorId: Uint8Array; operationCommitment: Uint8Array; outerSigned?: bigint; outerTotal?: bigint; validatorAddresses: Uint8Array[]; votingPowers: bigint[];
  authorityLevel: number; blobInnerSigned?: bigint; blobInnerTotal?: bigint;
}
export interface FactsB1 {
  attestCaptured: boolean; headerV?: HeaderFields; headerVParent?: HeaderFields; stateRootPre: Uint8Array; stateRootPost: Uint8Array; hopChain: { link: number; walked: number };
  headerLinked: boolean; attestTx?: Tx; attestReceipt?: ReceiptLeaf; txIndex: number; call: AttestCall; messageHash: Uint8Array; pkc: Uint8Array; messageRecomputed: Uint8Array;
}
export interface FactsB2 { pre: AuthStation; post: AuthStation; changed: AuthDiff[]; recordCreatedInBlock: boolean; governanceExecutedFlip: boolean; validators: ValidatorRow[]; codeFailure?: StateError; ib: IBResult }
export interface LevelBinding { authenticated: boolean; judgedAtLevel: string; s7FinalizedStatus: string }
export interface FactsC { registry?: { [k: string]: CanonValue }; registryLink: string; level: LevelBinding; rulesNotJudged: RuleNotJudged[] }
export interface Facts { A: FactsA; B1: FactsB1; B2: FactsB2; C: FactsC }
export const factGroups: { name: keyof Facts; owner: Owner }[] = [{ name: 'A', owner: '2a' }, { name: 'B1', owner: '2b-1' }, { name: 'B2', owner: '2b-2' }, { name: 'C', owner: '2c' }];

export function newFacts(): Facts {
  return {
    A: {
      account: zeros(20), anchorId: zeros(32), leafKey: zeros(32), selector: zeros(4), generation: '', stateRootN: zeros(32), accountState: zeroAccount(), accountCode: new Uint8Array(0),
      adiUrl: '', governingBook: new Uint8Array(0), governingBookHash: zeros(32), factoryAddress: zeros(20), anchor: zeros(20), anchorState: zeroAccount(), anchorCode: new Uint8Array(0),
      verifier: zeros(20), verifierState: zeroAccount(), verifierCode: new Uint8Array(0), groth16: zeros(20), groth16State: zeroAccount(), groth16Code: new Uint8Array(0), groth16Build: '',
      verifierFlags: zeros(2),
    },
    B1: {
      attestCaptured: false, stateRootPre: zeros(32), stateRootPost: zeros(32), hopChain: { link: 0, walked: 0 }, headerLinked: false, txIndex: 0,
      call: { anchorId: zeros(32), operationCommitment: zeros(32), validatorAddresses: [], votingPowers: [], authorityLevel: 0 }, messageHash: zeros(32), pkc: zeros(32), messageRecomputed: zeros(32),
    },
    B2: { pre: noStation(), post: noStation(), changed: [], recordCreatedInBlock: false, governanceExecutedFlip: false, validators: [], ib: { evaluated: false, verified: false, owners: [], types: [] } },
    C: { registryLink: '', level: { authenticated: false, judgedAtLevel: '', s7FinalizedStatus: '' }, rulesNotJudged: [] },
  };
}

/** A structural fingerprint of a fact group: equal groups have equal fingerprints (bytes by value, states by canonical form). */
export function fingerprint(v: unknown): string {
  if (v === undefined) return 'u';
  if (v === null) return 'n';
  if (v instanceof Uint8Array) return 'b' + Array.from(v, (x) => x.toString(16).padStart(2, '0')).join('');
  if (typeof v === 'bigint') return 'i' + v.toString();
  if (typeof v !== 'object') return typeof v + String(v);
  if (Array.isArray(v)) return '[' + v.map(fingerprint).join(',') + ']';
  const o = v as Record<string, unknown>;
  if (typeof o['code'] === 'string' && typeof (o as { canonical?: unknown }).canonical === 'function') return 's' + (o as unknown as StateError).canonical();
  return '{' + Object.keys(o).sort().map((k) => k + ':' + fingerprint(o[k])).join(',') + '}';
}

export interface Env {
  ctx: LegContext; raw: Uint8Array | undefined; container: Container | undefined; manifest: Manifest; chain: ChainEntry | undefined; limits: Limits;
  nodes: NodeSet | undefined; facts: Facts; headerCache: Map<string, HeaderFields | Error>;
}
export const newEnv = (ctx: LegContext, raw: Uint8Array | undefined, m: Manifest): Env =>
  ({ ctx, raw, container: undefined, manifest: m, chain: undefined, limits: defaultIdentityLimits(), nodes: undefined, facts: newFacts(), headerCache: new Map() });

export const settleStated = (e: Env): Stated | undefined => (e.container && e.container.settle.tag === TagStated ? e.container.settle.stated : undefined);
export const attestStated = (e: Env): Stated | undefined => (e.container && e.container.attest.tag === TagStated ? e.container.attest.stated : undefined);
/** The decoded header of raw header bytes (cached); THROWS when the bytes are not a header. */
export function header(e: Env, raw: Uint8Array): HeaderFields {
  const k = Array.from(raw, (x) => x.toString(16).padStart(2, '0')).join('');
  let h = e.headerCache.get(k);
  if (h === undefined) { try { h = readHeader(raw); } catch (err) { h = err instanceof Error ? err : new Error(String(err)); } e.headerCache.set(k, h); }
  if (h instanceof Error) throw h;
  return h;
}
export const verified = (part: string): PartResult => ({ part, status: 'verified' });
export const open = (part: string, kind: string, code: string, row: string, fields: Record<string, CanonValue>): OpenEntry => ({ part, kind, state: must(code, row, fields) });
export const notApplicableS6 = (reason: string): PartResult => ({ part: 's6_link', status: 'not_applicable', reason });

export interface StepOutput {
  parts?: PartResult[]; open?: OpenEntry[]; findings?: Finding[]; rulesJudged?: string[]; readPlanIncomplete?: string; framework?: StateError;
  halt?: boolean; haltReason?: string; supersede?: boolean;
}
export type StepFn = (env: Env) => StepOutput;
export type { StepId };
