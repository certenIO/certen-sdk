/**
 * The executor: its version in force at a (partition, block) - the pinned activation table - and the transaction types whose executor
 * decides who may sign by a rule the default authorization model does not describe (validator xexecutor.go, xexecutor_table.go,
 * xoverride.go, xauthdiff.go).
 */
import { equal, goTrimSpace } from '../proof-v2/bytes.js';
import { executorFloor, KERMIT_ACTIVATIONS, normalizePartition } from '../sigtypes/gate.js';
import { AccUrl, goEqualFold, goLower, LEDGER, partitionUrl } from './acc.js';
import { accountUrl, bigOf, nodesOf, urlOf, type KeyPage, type WireNode } from './model.js';
import { refusal21, State } from './states.js';

/** One partition's anchor as the verifier established it (xAnchor). */
export interface XAnchor {
  /** The anchor body's Source, e.g. "acc://bvn-BVN2.acme": the DERIVED partition. */
  source: string;
  /** The partition id, e.g. "BVN2". */
  id: string;
  /** B_Y. */
  block: number;
  stateRoot: Uint8Array;
}

// --------------------------------------------------------------------------------------------------------------------------------
// the pinned activation table (xexecutor_table.go: a view over govsig, not a copy)

export interface ExecutorActivation {
  version: number;
  block: number;
}

/** KermitExecutorActivations: the block in which each partition activated the executor version it runs. */
export function kermitExecutorActivations(): Record<string, ExecutorActivation> {
  const out: Record<string, ExecutorActivation> = {};
  for (const [k, v] of Object.entries(KERMIT_ACTIVATIONS)) out[k] = { version: v.version, block: v.block };
  return out;
}

/** NormalizeExecutorPartition: "acc://bvn-BVN2.acme", "BVN2" and "bvn2" are one partition; the Directory is "directory". */
export function normalizeExecutorPartition(p: string): string {
  let s = goLower(goTrimSpace(p));
  if (s.startsWith('acc://')) s = s.slice('acc://'.length);
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('.acme')) s = s.slice(0, -'.acme'.length);
  if (s.startsWith('bvn-')) s = s.slice('bvn-'.length);
  return normalizePartition(s);
}

/** ExecutorFloorAt: the lowest executor version PROVEN to govern a block of a partition; undefined when the pin does not prove one. */
export function executorFloorAt(partition: string, block: number): number | undefined {
  return executorFloor(normalizeExecutorPartition(partition), block);
}

/** V2BaikonurEnabled. */
export const baikonurEnabled = (v: number | bigint): boolean => BigInt(v) >= 6n;

// --------------------------------------------------------------------------------------------------------------------------------
// the system ledger (xexecutor.go)

/** ledgerOf: whether the account is the proven partition's OWN system ledger. */
export function isOwnLedger(acct: WireNode, xa: XAnchor | undefined): boolean {
  if (acct.cls !== 'SystemLedger' || !xa) return false;
  return goEqualFold(accountUrl(acct).toString(), partitionUrl(xa.id).joinPath(LEDGER).toString());
}

export interface ProvenForExecutor {
  acct: WireNode;
  anchor: XAnchor;
}

/** checkExecutorVersion: a system ledger the document carries must be its own partition's and prove Baikonur or later. */
export function checkExecutorVersion(byURL: Map<string, ProvenForExecutor>): void {
  for (const pa of byURL.values()) {
    if (pa.acct.cls !== 'SystemLedger') continue;
    const url = accountUrl(pa.acct);
    if (!isOwnLedger(pa.acct, pa.anchor)) {
      throw refusal21(State.RoleMismatch, pa.anchor.id, pa.anchor.block, `url ${url}: a system ledger proven through another partition's anchor`);
    }
    const v = bigOf(pa.acct, 'executorVersion');
    if (!baikonurEnabled(v)) {
      throw refusal21(
        State.ExecutorVersionUnsupported,
        pa.anchor.id,
        pa.anchor.block,
        `${url} proves executor version ${v}, before Baikonur (6): the authority set inheritance and the delegation path differ (sig_authority.go:175-178, utils.go:152-154)`,
      );
    }
  }
}

// --------------------------------------------------------------------------------------------------------------------------------
// who may sign (xoverride.go)

/** The body types of the audit in xoverride.go that are refused by name. */
const EXECUTOR_OVERRIDES: ReadonlySet<string> = new Set([
  'CreateIdentity',
  'CreateLiteTokenAccount',
  'CreateKeyBook',
  'CreateTokenAccount',
  'CreateDataAccount',
  'CreateToken',
  'ReleaseLockedOperation',
  'UpdateKey',
  'UpdateKeyPage',
  'NetworkMaintenance',
]);

/** HasExecutorOverride, by the body's class. */
export function hasExecutorOverride(bodyClass: string): boolean {
  return EXECUTOR_OVERRIDES.has(bodyClass);
}

/** ExecutorOverrideTypes: the refused body classes (a copy). */
export function executorOverrideTypes(): string[] {
  return [...EXECUTOR_OVERRIDES];
}

/** refuseExecutorOverride: a carried transaction of an override type is refused before the vote is re-evaluated. */
export function refuseExecutorOverride(txn: WireNode, x: XAnchor): void {
  const body = txn.fields.get('body');
  if (!body || typeof body !== 'object' || body instanceof Uint8Array || Array.isArray(body)) return;
  const b = body as WireNode;
  if (EXECUTOR_OVERRIDES.has(b.cls)) {
    throw refusal21(State.ExecutorOverrideUnsupported, x.id, x.block, `${b.cls} has an executor override of who may sign; the default rule is not what judged it (see xoverride.go)`);
  }
  // UpdateAccountAuth rewrites the authority set the verifier reads: only the operations that can be inverted from the body are modelled.
  if (b.cls === 'UpdateAccountAuth') {
    for (const op of nodesOf(b, 'operations')) {
      if (op.cls !== 'AddAccountAuthorityOperation' && op.cls !== 'EnableAccountAuthOperation' && op.cls !== 'DisableAccountAuthOperation') {
        throw refusal21(
          State.ExecutorOverrideUnsupported,
          x.id,
          x.block,
          `UpdateAccountAuth operation ${op.cls} rewrites the principal's authority set in the transaction, and the set the executor required (before it) cannot be derived from the set proven at the anchor block (see xoverride.go)`,
        );
      }
    }
  }
}

/**
 * refuseUpdateAccountAuthInherited: the one case of a modelled UpdateAccountAuth the proven principal cannot give the requirement of -
 * its own authority list, as proven after the transaction, holds only authorities the transaction added.
 */
export function refuseUpdateAccountAuthInherited(txn: WireNode | undefined, own: { url: AccUrl; disabled: boolean }[], x: XAnchor): void {
  if (!txn) return;
  const body = txn.fields.get('body');
  if (!body || typeof body !== 'object' || body instanceof Uint8Array || Array.isArray(body) || (body as WireNode).cls !== 'UpdateAccountAuth') return;
  const added = new Set<string>();
  for (const op of nodesOf(body as WireNode, 'operations')) {
    if (op.cls === 'AddAccountAuthorityOperation') {
      const a = urlOf(op, 'authority');
      if (a) added.add(a.key);
    }
  }
  if (added.size === 0 || own.length === 0) return;
  for (const e of own) if (!added.has(e.url.key)) return;
  throw refusal21(
    State.ExecutorOverrideUnsupported,
    x.id,
    x.block,
    'UpdateAccountAuth adds the first authorities of an account that listed none: the executor required the authorities it inherited from its parent, which the document does not carry (see xoverride.go)',
  );
}

// --------------------------------------------------------------------------------------------------------------------------------
// the authority of a key page (xauthdiff.go)

export interface AuthorityFieldDiff {
  field: string;
  a: string;
  b: string;
  text: string;
}

/** AuthorityFieldDiffs: how the authority of two states of a key page differs (version, thresholds, blacklist, entries). */
export function authorityFieldDiffs(a: KeyPage, b: KeyPage): AuthorityFieldDiff[] {
  const out: AuthorityFieldDiff[] = [];
  const add = (field: string, av: string, bv: string, text: string): void => {
    if (av !== bv) out.push({ field, a: av, b: bv, text });
  };
  const num = (field: string, av: bigint, bv: bigint): void => add(field, av.toString(), bv.toString(), `${field} ${av} vs ${bv}`);
  num('version', a.version, b.version);
  num('acceptThreshold', a.acceptThreshold, b.acceptThreshold);
  num('rejectThreshold', a.rejectThreshold, b.rejectThreshold);
  num('responseThreshold', a.responseThreshold, b.responseThreshold);
  num('blockThreshold', a.blockThreshold, b.blockThreshold);
  add('entries', String(a.keys.length), String(b.keys.length), `${a.keys.length} entries vs ${b.keys.length}`);
  add('transactionBlacklist', String(a.blacklist ?? 0n), String(b.blacklist ?? 0n), 'transaction blacklist');
  const n = Math.min(a.keys.length, b.keys.length);
  for (let i = 0; i < n; i++) {
    if (!equal(a.keys[i]!.publicKeyHash, b.keys[i]!.publicKeyHash)) {
      const f = `keys[${i}].publicKeyHash`;
      add(f, Buffer.from(a.keys[i]!.publicKeyHash).toString('hex'), Buffer.from(b.keys[i]!.publicKeyHash).toString('hex'), f);
    }
    const f = `keys[${i}].delegate`;
    add(f, a.keys[i]!.delegate ? goLower(a.keys[i]!.delegate!.toString()) : '', b.keys[i]!.delegate ? goLower(b.keys[i]!.delegate!.toString()) : '', f);
  }
  return out;
}

/** AuthorityDiff: the first difference, or "" when the authority is the same. */
export function authorityDiff(a: KeyPage, b: KeyPage): string {
  return authorityFieldDiffs(a, b)[0]?.text ?? '';
}
