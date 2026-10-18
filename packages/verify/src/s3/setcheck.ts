/**
 * The validator-set check of a proof and the accounts it proves into the certified state root (validator pkg/proof: validator_set_proof.go
 * ValidatorSetProof.Verify / DerivedSet / AccountStateProof, validator_set_decode.go, routing_proof.go; portable.go importAccount).
 *
 * A proof carries three data accounts proven into the state tree root of the certified Directory block: acc://dn.acme/network (the
 * validator set), acc://dn.acme/globals (the accept threshold) and, in evidence 2.1, acc://dn.acme/routing (the routing table). Each is a
 * JSON account whose binary state is hashed and proven; the record its single data entry holds is carried as JSON too and must re-encode to
 * exactly the entry's bytes. What the verifier derives - the validators, the threshold, the routes - it derives from the entry's BYTES.
 */
import { VerifyError, equal, fail, toHex } from '../proof-v2/bytes.js';
import type { SetVerdict } from '../proof-v2/verify.js';
import { accumulateSetRoot, type AccumulateValidator } from '../proof-v2/accset.js';
import { decodeObject, type WireNode } from '../sigtypes/wire.js';
import { AccUrl, goEqualFold } from './acc.js';
import { mustHex32, verifyAccountState, type ChainedReceipt } from './chains.js';
import type { ChainRoot } from './evidence.js';
import { bool, list, str, struct, u64, u64big } from './gojson.js';
import { accountState, recordBytes } from './jsonwire.js';
import { bigOf, bytesOf, decodeAccount, nodesOf, urlOf } from './model.js';

/** The members of a PortableAccount. */
export const ACCOUNT_FIELDS = ['accountUrl', 'account', 'record', 'stateReceipt', 'chains', 'secondaryHash', 'pendingHash'] as const;

/** A data account of the set check as the import holds it (proof.AccountStateProof, rebuilt from its portable JSON). */
export interface CheckAccount {
  accountUrl: string;
  /** The binary state (UnmarshalAccountJSON then MarshalBinary). */
  state: Uint8Array;
  /** The account and its single data entry's bytes. */
  node: WireNode;
  entry: Uint8Array;
  chains: ChainRoot[];
  receipt: ChainedReceipt;
  secondaryHash: string;
  pendingHash: string;
  /** The portable JSON, for the measure of the document (budget.ts). */
  json: Record<string, unknown>;
}

function chainRoots(v: unknown, label: string): ChainRoot[] {
  const l = list(v, label) ?? [];
  return l.map((c, i) => {
    const s = struct(c, ['name', 'pending', 'count', 'anchor'], `ChainRoot (${label}[${i}])`);
    const pl = list(s.pending, `${label}[${i}].pending`);
    return {
      name: str(s.name, `${label}[${i}].name`),
      pending: pl?.map((p, k) => (p === null ? null : str(p, `${label}[${i}].pending[${k}]`))),
      count: u64(s.count, `${label}[${i}].count`),
      countBig: u64big(s.count, `${label}[${i}].count`),
      anchor: str(s.anchor, `${label}[${i}].anchor`),
    };
  });
}

function chainedReceipt(v: unknown, label: string): ChainedReceipt {
  if (v === undefined) fail(`${label}: unexpected end of JSON input`);
  const s = struct(v, ['start', 'anchor', 'localBlock', 'entries'], `chained_proof.Receipt (${label})`);
  u64(s.localBlock, `${label}.localBlock`);
  return {
    start: str(s.start, `${label}.start`),
    anchor: str(s.anchor, `${label}.anchor`),
    entries: (list(s.entries, `${label}.entries`) ?? []).map((e, i) => {
      const es = struct(e, ['hash', 'right'], `ReceiptStep (${label}.entries[${i}])`);
      return { hash: str(es.hash, `${label}.entries[${i}].hash`), right: bool(es.right, `${label}.entries[${i}].right`) };
    }),
  };
}

/** importAccount (portable.go): a one-entry data account whose record re-encodes to the entry, with its state receipt and chains. */
export function importCheckAccount(pa: Record<string, unknown>, recordCls: string, label: string): CheckAccount {
  const s = struct(pa, [...ACCOUNT_FIELDS], `PortableAccount (${label})`);
  const accountUrl = str(s.accountUrl, `${label}.accountUrl`);
  const chains = chainRoots(s.chains, `${label}.chains`);
  const secondaryHash = str(s.secondaryHash, `${label}.secondaryHash`);
  const pendingHash = str(s.pendingHash, `${label}.pendingHash`);
  const state = accountState(s.account, `${label} account`);
  const node = decodeAccount(state);
  const entry = node.cls === 'DataAccount' ? node.fields.get('entry') : undefined;
  const data = entry && typeof entry === 'object' && !(entry instanceof Uint8Array) && !Array.isArray(entry) ? (entry as WireNode).fields.get('data') : undefined;
  if (node.cls !== 'DataAccount' || !Array.isArray(data) || data.length !== 1) fail(`${label}: ${accountUrl} is ${node.cls}, not a one-entry data account`);
  const bytes = (data as Uint8Array[])[0]!;
  let enc: Uint8Array;
  try {
    enc = recordBytes(recordCls, s.record, `${label} record`);
  } catch (e) {
    throw new VerifyError(`${label}: ${accountUrl}: record: ${(e as Error).message}`);
  }
  if (!equal(enc, bytes)) fail(`${label}: ${accountUrl}: record: the JSON does not re-encode to the record's bytes`);
  return { accountUrl, state, node, entry: bytes, chains, receipt: chainedReceipt(s.stateReceipt, `${label} stateReceipt`), secondaryHash, pendingHash, json: s };
}

/** AccountStateProof.verify of an imported account: the proven root and the main chain's height. */
export function proveAccount(a: CheckAccount): { root: Uint8Array; mainHeight: number | undefined } {
  return verifyAccountState(a.state, a.receipt, a.chains, a.secondaryHash, a.pendingHash);
}

/** decodeValidators: the set the network account's NetworkDefinition entry carries, each validator with the partitions it is active on. */
export function decodeValidators(a: CheckAccount): AccumulateValidator[] {
  let nd: WireNode;
  try {
    nd = decodeObject('NetworkDefinition', a.entry);
  } catch (e) {
    return fail(`network account: entry is not a NetworkDefinition: ${(e as Error).message}`);
  }
  const vs = nodesOf(nd, 'validators');
  if (vs.length === 0) fail('network account: NetworkDefinition carries no validators');
  return vs.map((v, i) => {
    const pk = bytesOf(v, 'publicKey');
    if (pk.length !== 32) fail(`network account: validator ${i} has a ${pk.length}-byte public key, expected 32`);
    return { publicKey: toHex(pk), activeOn: nodesOf(v, 'partitions').filter((p) => p.fields.get('active') === true).map((p) => Buffer.from((p.fields.get('id') as string | undefined) ?? '', 'latin1').toString('utf8')) };
  });
}

/** decodeAcceptThreshold: validatorAcceptThreshold of the globals account's NetworkGlobals entry. */
export function decodeAcceptThreshold(a: CheckAccount): { num: bigint; den: bigint } {
  let ng: WireNode;
  try {
    ng = decodeObject('NetworkGlobals', a.entry);
  } catch (e) {
    return fail(`globals account: entry is not NetworkGlobals: ${(e as Error).message}`);
  }
  const t = ng.fields.get('validatorAcceptThreshold');
  const tn = t && typeof t === 'object' && !(t instanceof Uint8Array) && !Array.isArray(t) ? (t as WireNode) : undefined;
  const num = tn ? bigOf(tn, 'numerator') : 0n;
  const den = tn ? bigOf(tn, 'denominator') : 0n;
  if (den === 0n) fail('globals account: zero validatorAcceptThreshold denominator');
  if (num === 0n) fail('globals account: zero validatorAcceptThreshold numerator would admit an unsigned anchor');
  if (num > den) fail(`globals account: validatorAcceptThreshold numerator ${num} exceeds denominator ${den}`);
  return { num, den };
}

export interface SetCheckResult {
  verdict: SetVerdict;
  accumulateSetRoot: string;
}

/**
 * ValidatorSetProof.Verify (steps 10-17) over the network and globals accounts bound to the certified block's state tree root, and the
 * checks verifyFrom makes after it: the proven records are exactly what the spine's walk derived and the network account's main chain has
 * exactly the entries the walk applied.
 */
export function verifySetCheck(
  net: CheckAccount,
  glob: CheckAccount,
  incarnation: string,
  bound: Uint8Array,
  pinned: Uint8Array,
  walk: { networkRecord: Uint8Array; globalsRecord: Uint8Array; networkUpdates: number },
): SetCheckResult {
  // DerivedSet: both are decoded from the accounts' own bytes, neither is asserted.
  const derived = decodeValidators(net);
  const thr = decodeAcceptThreshold(glob);
  let verdict: SetVerdict;
  if (net.receipt.entries.length === 0 || glob.receipt.entries.length === 0) {
    // An absent proof is a named state, not an error.
    verdict = 'validator_set_asserted';
  } else {
    let n: ReturnType<typeof proveAccount>;
    let g: ReturnType<typeof proveAccount>;
    try {
      n = proveAccount(net);
    } catch (e) {
      throw new VerifyError(`set check: validatorSetProof.network: ${(e as Error).message}`);
    }
    try {
      g = proveAccount(glob);
    } catch (e) {
      throw new VerifyError(`set check: validatorSetProof.globals: ${(e as Error).message}`);
    }
    if (!equal(n.root, g.root)) fail(`set check: validatorSetProof: the two accounts are proven into different BPT roots (network=${toHex(n.root).slice(0, 16)} globals=${toHex(g.root).slice(0, 16)})`);
    if (!equal(n.root, bound)) {
      fail(`set check: validatorSetProof: the BPT root the set was proven into is not the one the quorum signed: proven=${toHex(n.root).slice(0, 16)} signed=${toHex(bound).slice(0, 16)}`);
    }
    if (n.mainHeight === undefined) fail("set check: validatorSetProof: no main chain in the network account's chain set");
    if (n.mainHeight !== 1) verdict = 'validator_set_asserted';
    else if (incarnation === '') verdict = 'incarnation_unknown';
    else {
      const inc = mustHex32(incarnation, 'incarnation');
      verdict = equal(inc, pinned) ? 'verified' : 'foreign_incarnation';
    }
  }
  // The proven accounts must hold exactly what the walk derived.
  if (!equal(net.entry, walk.networkRecord)) fail('set check: network: the proven record differs from the one the walk derived');
  if (!equal(glob.entry, walk.globalsRecord)) fail('set check: globals: the proven record differs from the one the walk derived');
  const height = mainHeightOf(net);
  if (height === undefined) fail('set check: no main chain on the network account');
  if (height !== 1 + walk.networkUpdates) fail(`set check: the network account's main chain has ${height} entries but the walk applied ${walk.networkUpdates} updates after genesis`);
  let root: string;
  try {
    root = accumulateSetRoot(derived, { numerator: thr.num, denominator: thr.den }, toHex(pinned));
  } catch (e) {
    throw new VerifyError(`set check: the accumulate set root: ${(e as Error).message}`);
  }
  return { verdict, accumulateSetRoot: root };
}

import { mainChainHeight } from './chains.js';
const mainHeightOf = (a: CheckAccount): number | undefined => mainChainHeight(a.chains);

/** The routing table of a proven routing account. */
export interface RoutingTable {
  routes: { length: number; value: bigint; partition: string }[];
  overrides: { account?: AccUrl; partition: string }[];
}

export const ROUTING_ACCOUNT_URL = 'acc://dn.acme/routing';

const text = (n: WireNode, name: string): string => {
  const v = n.fields.get(name);
  return typeof v === 'string' ? Buffer.from(v, 'latin1').toString('utf8') : '';
};

/**
 * VerifyRoutingProof: the account must be the routing account, proven into exactly the bound state root, holding one data entry that decodes as
 * a routing table with routes. Returns the table and the height of the account's main chain (1 is the genesis write: the table has never
 * changed).
 */
export function verifyRoutingProof(a: CheckAccount, bound: Uint8Array): { table: RoutingTable; height: number } {
  if (!goEqualFold(a.accountUrl, ROUTING_ACCOUNT_URL)) fail(`routing proof is for ${a.accountUrl}, not ${ROUTING_ACCOUNT_URL}`);
  let proven: ReturnType<typeof proveAccount>;
  try {
    proven = proveAccount(a);
  } catch (e) {
    throw new VerifyError(`routing proof: ${(e as Error).message}`);
  }
  if (!equal(proven.root, bound)) fail(`routing proof: the account is proven into ${toHex(proven.root).slice(0, 16)}, not the certified state root ${toHex(bound).slice(0, 16)}`);
  const url = urlOf(a.node, 'url');
  if (!url || !goEqualFold(url.toString(), ROUTING_ACCOUNT_URL)) fail(`routing proof: the proven state is ${String(url)}, not ${ROUTING_ACCOUNT_URL}`);
  let table: WireNode;
  try {
    table = decodeObject('RoutingTable', a.entry);
  } catch (e) {
    return fail(`routing proof: the entry is not a routing table: ${(e as Error).message}`);
  }
  const routes = nodesOf(table, 'routes').map((x) => ({ length: Number(bigOf(x, 'length')), value: bigOf(x, 'value'), partition: text(x, 'partition') }));
  if (routes.length === 0) fail('routing proof: the table has no routes');
  if (proven.mainHeight === undefined) fail('routing proof: no main chain on the routing account');
  const overrides = nodesOf(table, 'overrides').map((x) => ({ account: urlOf(x, 'account'), partition: text(x, 'partition') }));
  return { table: { routes, overrides }, height: proven.mainHeight };
}
