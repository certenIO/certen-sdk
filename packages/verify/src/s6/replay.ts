/**
 * S6 - the replay guard was consumed by this transaction (PROOF_V2 section 3, RB10): the TypeScript verifier of the
 * replay-guard evidence (domain tag certen:s6-replay:v1), judging exactly as certen-validator pkg/ethproof
 * (DecodeReplayGuardEvidence, ReplayGuardEvidence.VerifyAgainst) does, by the contract in
 * test/fixtures/s6replay1/SPEC.md. Nothing is judged without a named state: what is not established is
 * s6_replay_unproven / s6_event_missing / s6_replay_refuted with its reason, never a weaker answer shaped like a proof.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { JsonError } from '../s3/gojson.js';
import { JNum, JObj, parseGoJson } from '../s3/jsonx.js';
import type { JVal } from '../s3/jsonx.js';
import { eq, MptError, verifyStorage } from './mpt.js';
import type { StorageResult } from './mpt.js';
import { bytesOf, fixedOf, Item, listItems, RlpError, split, structItems, uintOf } from './rlp.js';

// ---------------------------------------------------------------------------------------------------------------------
// Constants (pkg/ethproof replayguard.go)

export const S6_REPLAY_DOMAIN = 'certen:s6-replay:v1';
export const S6_MAX_REPLAY_HEADER_CHAIN = 512;
export const S6_REPLAY_DERIVATION = 'keccak256(abi.encode(bytes32 key, uint256 base))';
export const S6_MAX_JSON_INTEGER = 2 ** 53 - 1;

/** The pinned account generations: the base slot of the replay guard and the settlement selectors that consume it. A
 * generation absent from this table has no pinned layout and is s6_replay_unproven{account_generation}. */
export const S6_REPLAY_LAYOUTS: Readonly<Record<string, { base: number; selectors: readonly string[] }>> = Object.freeze({
  // forge inspect CertenAccountV7_3 storageLayout / methodIdentifiers at certen-contracts 57153e5 (s6replay1 SPEC §4).
  CertenAccountV7_3: Object.freeze({ base: 4, selectors: Object.freeze(['606f2c8d', '329fe012']) }),
  // forge inspect CertenAccountV7_2 storageLayout at certen-contracts 16c6d47 (factory V10): _consumedLeaf at slot 4;
  // executeGovernanceProofDirect 0x57f8567d, batchExecuteGovernanceProofDirect 0xb7daa901 (s6replay2 SPEC §2).
  CertenAccountV7_2: Object.freeze({ base: 4, selectors: Object.freeze(['57f8567d', 'b7daa901']) }),
});

export const S6_LEAF_CONSUMED_TOPIC = keccak_256(new TextEncoder().encode('LeafConsumed(bytes32,bytes32,bytes32)'));

/** The named states. */
export const S6_PROVEN = 'proven';
export const S6_REPLAY_UNPROVEN = 's6_replay_unproven';
export const S6_EVENT_MISSING = 's6_event_missing';
export const S6_REPLAY_REFUTED = 's6_replay_refuted';

/** The reasons. */
export const S6_REASONS = Object.freeze({
  stateUnavailable: 'state_unavailable',
  proofDoesNotVerify: 'proof_does_not_verify',
  parentHeaderUnproven: 'parent_header_unproven',
  headerChainBroken: 'header_chain_broken',
  headerChainTooLong: 'header_chain_too_long',
  accountGeneration: 'account_generation',
  slotMismatch: 'slot_mismatch',
  contractMismatch: 'contract_mismatch',
  settlementUnproven: 'settlement_unproven',
  settlementNotExecuted: 'settlement_not_executed',
  blockMismatch: 'settlement_block_mismatch',
  beforeUndisclosed: 'before_neither_proven_nor_disclosed',
  noEvent: 'no_leaf_consumed_event',
  receiptUnavailable: 'receipt_unavailable',
  slotSetAtParent: 'slot_set_at_parent',
  slotUnsetAtBlock: 'slot_unset_at_block',
  version: 'unknown_version',
  emptyEvidence: 'no_evidence_or_state',
  malformedJson: 'malformed_json',
  unknownField: 'unknown_field',
  missingField: 'missing_field',
  wrongType: 'wrong_type',
});
const R = S6_REASONS;

/** A refusal by named state. */
export class S6ReplayError extends Error {
  constructor(
    readonly state: string,
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`replay guard proof refused: ${state}{reason=${reason}}: ${detail}`);
  }
}

const refuse = (state: string, reason: string, detail: string): never => {
  throw new S6ReplayError(state, reason, detail);
};
const unproven = (reason: string, detail: string): never => refuse(S6_REPLAY_UNPROVEN, reason, detail);

// ---------------------------------------------------------------------------------------------------------------------
// Hex

const HEX = '0123456789abcdef';
export function toHex(b: Uint8Array): string {
  let s = '0x';
  for (const x of b) s += HEX[x >> 4]! + HEX[x & 15]!;
  return s;
}
function fromHexDigits(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
/** EIP-55. */
export function checksumAddress(a: Uint8Array): string {
  const lower = toHex(a).slice(2);
  const h = keccak_256(new TextEncoder().encode(lower));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nib = (h[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 15;
    out += nib >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The wire format and its strict decoding (pkg/ethproof replaydecode.go)

type Kind = 'string' | 'bool' | 'uint' | 'hash' | 'address' | 'bytes' | 'bytesList' | 'object' | 'objectList';
interface Field {
  key: string;
  kind: Kind;
  required: boolean;
  schema?: readonly Field[];
}
const f = (key: string, kind: Kind, required: boolean, schema?: readonly Field[]): Field => ({ key, kind, required, schema });

const wireBlockRef = [f('number', 'uint', true), f('hash', 'hash', true)];
const wireSlot = [f('key', 'hash', true), f('base', 'uint', true), f('derivation', 'string', true), f('slot', 'hash', true)];
const wireSlotProof = [
  f('accountAbsent', 'bool', false),
  f('accountProof', 'bytesList', true),
  f('storageHash', 'hash', true),
  f('codeHash', 'hash', true),
  f('storageProof', 'bytesList', true),
  f('value', 'hash', true),
];
const wireProviderFailure = [f('host', 'string', true), f('error', 'string', true)];
const wireBefore = [f('parentHeader', 'bytes', true), f('proof', 'object', true, wireSlotProof)];
const wireBeforeUnavailable = [f('reason', 'string', true), f('providers', 'objectList', false, wireProviderFailure)];
const wireProof = [
  f('version', 'string', true),
  f('chainId', 'uint', true),
  f('generation', 'string', true),
  f('contract', 'address', true),
  f('slot', 'object', true, wireSlot),
  f('settlementBlock', 'object', true, wireBlockRef),
  f('provenAt', 'object', true, wireBlockRef),
  f('headers', 'bytesList', true),
  f('after', 'object', true, wireSlotProof),
  f('before', 'object', false, wireBefore),
  f('beforeUnavailable', 'object', false, wireBeforeUnavailable),
];
const wireNamedState = [
  f('state', 'string', true),
  f('reason', 'string', true),
  f('chainId', 'uint', true),
  f('txHash', 'hash', true),
  f('blockNumber', 'uint', true),
  f('blockHash', 'hash', true),
  f('contract', 'address', true),
  f('providers', 'objectList', false, wireProviderFailure),
  f('detail', 'string', false),
  f('before', 'object', false, wireBefore),
];
const wireEvidence = [f('version', 'string', true), f('proof', 'object', false, wireProof), f('state', 'object', false, wireNamedState)];

const UINT_RE = /^(0|[1-9][0-9]*)$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES_RE = /^0x([0-9a-fA-F]{2})*$/;

const wrongType = (path: string, want: string): never => unproven(R.wrongType, `${path} is not ${want}`);

function checkValue(path: string, v: JVal, fd: Field): void {
  switch (fd.kind) {
    case 'string':
      if (typeof v !== 'string') wrongType(path, 'a string');
      return;
    case 'bool':
      if (typeof v !== 'boolean') wrongType(path, 'a boolean');
      return;
    case 'uint':
      if (!(v instanceof JNum) || !UINT_RE.test(v.lit)) wrongType(path, 'a non-negative integer without sign, fraction or exponent');
      if (BigInt((v as JNum).lit) > BigInt(S6_MAX_JSON_INTEGER)) wrongType(path, 'an integer at most 2^53-1');
      return;
    case 'hash':
      if (typeof v !== 'string' || !HASH_RE.test(v)) wrongType(path, '0x and 64 hex digits');
      return;
    case 'address':
      if (typeof v !== 'string' || !ADDRESS_RE.test(v)) wrongType(path, '0x and 40 hex digits');
      return;
    case 'bytes':
      if (typeof v !== 'string' || !BYTES_RE.test(v)) wrongType(path, '0x and an even number of hex digits');
      return;
    case 'bytesList':
      if (!Array.isArray(v)) return wrongType(path, 'an array');
      v.forEach((e, i) => checkValue(`${path}[${i}]`, e, f('', 'bytes', true)));
      return;
    case 'object':
      checkObject(path, v, fd.schema!);
      return;
    case 'objectList':
      if (!Array.isArray(v)) return wrongType(path, 'an array');
      v.forEach((e, i) => checkObject(`${path}[${i}]`, e, fd.schema!));
      return;
  }
}

function checkObject(path: string, v: JVal, schema: readonly Field[]): void {
  if (!(v instanceof JObj)) return wrongType(path, 'an object');
  for (const [k] of v.pairs) {
    if (!schema.some((x) => x.key === k)) unproven(R.unknownField, `${path}.${k} is no field of the format`);
  }
  for (const fd of schema) {
    const p = v.pairs.find(([k]) => k === fd.key);
    if (p === undefined) {
      if (fd.required) unproven(R.missingField, `${path}.${fd.key} is required`);
      continue;
    }
    checkValue(`${path}.${fd.key}`, p[1], fd);
  }
}

/**
 * The second stage of replaydecode.go: json.Unmarshal into the Go types. common.Hash, common.Address and hexutil.Bytes
 * unmarshal the raw JSON text between the quotes (go-ethereum v1.17.7 common/hexutil/json.go Bytes.UnmarshalJSON,
 * UnmarshalFixedJSON), not the unescaped string, so a hash, address or bytes value written with any escape is not hex there
 * and is refused wrong_type, after the whole schema check has passed. String-typed fields unescape as usual.
 */
function noEscapedHex(path: string, v: JVal, schema: readonly Field[], esc: WeakMap<object, Set<number>>): void {
  const o = v as JObj;
  for (const fd of schema) {
    const idx = o.pairs.findIndex(([k]) => k === fd.key);
    if (idx < 0) continue;
    const x = o.pairs[idx]![1];
    const at = `${path}.${fd.key}`;
    const escaped = (container: object, i: number): boolean => esc.get(container)?.has(i) === true;
    switch (fd.kind) {
      case 'hash':
      case 'address':
      case 'bytes':
        if (escaped(o.pairs, idx)) wrongType(at, 'hex: its JSON text holds an escape, which the raw-token hex decoding refuses');
        break;
      case 'bytesList':
        (x as JVal[]).forEach((_, i) => {
          if (escaped(x as JVal[], i)) wrongType(`${at}[${i}]`, 'hex: its JSON text holds an escape, which the raw-token hex decoding refuses');
        });
        break;
      case 'object':
        noEscapedHex(at, x, fd.schema!, esc);
        break;
      case 'objectList':
        (x as JVal[]).forEach((e, i) => noEscapedHex(`${at}[${i}]`, e, fd.schema!, esc));
        break;
      default:
        break;
    }
  }
}

function noDuplicateKeys(v: JVal): void {
  if (Array.isArray(v)) v.forEach(noDuplicateKeys);
  else if (v instanceof JObj) {
    const seen = new Set<string>();
    for (const [k, x] of v.pairs) {
      if (seen.has(k)) throw new JsonError(`duplicate key ${JSON.stringify(k)}`);
      seen.add(k);
      noDuplicateKeys(x);
    }
  }
}

export interface S6BlockRef {
  number: number;
  hash: Uint8Array;
}
export interface S6ReplaySlot {
  key: Uint8Array;
  base: number;
  derivation: string;
  slot: Uint8Array;
}
export interface S6SlotProof {
  accountAbsent: boolean;
  accountProof: Uint8Array[];
  storageHash: Uint8Array;
  codeHash: Uint8Array;
  storageProof: Uint8Array[];
  value: Uint8Array;
}
export interface S6ProviderFailure {
  host: string;
  error: string;
}
export interface S6ReplayBefore {
  parentHeader: Uint8Array;
  proof: S6SlotProof;
}
export interface S6ReplayBeforeUnavailable {
  reason: string;
  providers?: S6ProviderFailure[];
}
export interface S6ReplayGuardProof {
  version: string;
  chainId: number;
  generation: string;
  contract: Uint8Array;
  slot: S6ReplaySlot;
  settlementBlock: S6BlockRef;
  provenAt: S6BlockRef;
  headers: Uint8Array[];
  after: S6SlotProof;
  before?: S6ReplayBefore;
  beforeUnavailable?: S6ReplayBeforeUnavailable;
}
export interface S6ReplayNamedState {
  state: string;
  reason: string;
  chainId: number;
  txHash: Uint8Array;
  blockNumber: number;
  blockHash: Uint8Array;
  contract: Uint8Array;
  providers?: S6ProviderFailure[];
  detail?: string;
  before?: S6ReplayBefore;
}
export interface S6ReplayGuardEvidence {
  version: string;
  proof?: S6ReplayGuardProof;
  state?: S6ReplayNamedState;
}

// Readers of an already schema-checked value.
type O = Map<string, JVal>;
const obj = (v: JVal | undefined): O => new Map((v as JObj).pairs);
const hx = (v: JVal | undefined): Uint8Array => fromHexDigits((v as string).slice(2));
const num = (v: JVal | undefined): number => Number((v as JNum).lit);
const hxList = (v: JVal | undefined): Uint8Array[] => (v as JVal[]).map(hx);
const providers = (v: JVal | undefined): S6ProviderFailure[] | undefined =>
  v === undefined ? undefined : (v as JVal[]).map((e) => ({ host: obj(e).get('host') as string, error: obj(e).get('error') as string }));
function readSlotProof(v: JVal | undefined): S6SlotProof {
  const o = obj(v);
  return {
    accountAbsent: (o.get('accountAbsent') as boolean | undefined) ?? false,
    accountProof: hxList(o.get('accountProof')),
    storageHash: hx(o.get('storageHash')),
    codeHash: hx(o.get('codeHash')),
    storageProof: hxList(o.get('storageProof')),
    value: hx(o.get('value')),
  };
}
const readBlockRef = (v: JVal | undefined): S6BlockRef => ({ number: num(obj(v).get('number')), hash: hx(obj(v).get('hash')) });
function readBefore(v: JVal | undefined): S6ReplayBefore | undefined {
  if (v === undefined) return undefined;
  const o = obj(v);
  return { parentHeader: hx(o.get('parentHeader')), proof: readSlotProof(o.get('proof')) };
}

/**
 * DecodeReplayGuardEvidence: strict decoding, every refusal s6_replay_unproven{reason}:
 *  1. one JSON value, no duplicate key, nothing after it - else malformed_json;
 *  2. the schema, depth first in schema order - unknown_field, missing_field, wrong_type;
 *  3. the Go types' own decoding: a hash, address or bytes value whose JSON text holds an escape - wrong_type;
 *  4. exactly one of proof and state - else no_evidence_or_state;
 *  5. the evidence's version, then the proof's, is certen:s6-replay:v1 - else unknown_version.
 */
export function decodeReplayGuardEvidence(raw: Uint8Array): S6ReplayGuardEvidence {
  let doc: JVal;
  const esc = new WeakMap<object, Set<number>>();
  try {
    doc = parseGoJson(raw, esc);
    noDuplicateKeys(doc);
  } catch (e) {
    if (e instanceof JsonError) return unproven(R.malformedJson, e.message);
    throw e;
  }
  checkObject('$', doc, wireEvidence);
  noEscapedHex('$', doc, wireEvidence, esc);
  const top = obj(doc);
  const ev: S6ReplayGuardEvidence = { version: top.get('version') as string };
  if (top.has('proof')) {
    const p = obj(top.get('proof'));
    const s = obj(p.get('slot'));
    const bu = p.get('beforeUnavailable');
    ev.proof = {
      version: p.get('version') as string,
      chainId: num(p.get('chainId')),
      generation: p.get('generation') as string,
      contract: hx(p.get('contract')),
      slot: { key: hx(s.get('key')), base: num(s.get('base')), derivation: s.get('derivation') as string, slot: hx(s.get('slot')) },
      settlementBlock: readBlockRef(p.get('settlementBlock')),
      provenAt: readBlockRef(p.get('provenAt')),
      headers: hxList(p.get('headers')),
      after: readSlotProof(p.get('after')),
      before: readBefore(p.get('before')),
      beforeUnavailable:
        bu === undefined ? undefined : { reason: obj(bu).get('reason') as string, providers: providers(obj(bu).get('providers')) },
    };
  }
  if (top.has('state')) {
    const s = obj(top.get('state'));
    ev.state = {
      state: s.get('state') as string,
      reason: s.get('reason') as string,
      chainId: num(s.get('chainId')),
      txHash: hx(s.get('txHash')),
      blockNumber: num(s.get('blockNumber')),
      blockHash: hx(s.get('blockHash')),
      contract: hx(s.get('contract')),
      providers: providers(s.get('providers')),
      detail: s.get('detail') as string | undefined,
      before: readBefore(s.get('before')),
    };
  }
  if ((ev.proof === undefined) === (ev.state === undefined)) {
    unproven(R.emptyEvidence, 'the evidence carries exactly one of a proof and a named state');
  }
  if (ev.version !== S6_REPLAY_DOMAIN) unproven(R.version, `version ${JSON.stringify(ev.version)} is not ${S6_REPLAY_DOMAIN}`);
  if (ev.proof !== undefined && ev.proof.version !== S6_REPLAY_DOMAIN) {
    unproven(R.version, `the proof's version ${JSON.stringify(ev.proof.version)} is not ${S6_REPLAY_DOMAIN}`);
  }
  return ev;
}

// ---------------------------------------------------------------------------------------------------------------------
// Headers and transactions (go-ethereum v1.17.7 types.Header, types.Transaction.UnmarshalBinary)

export interface S6Header {
  parentHash: Uint8Array;
  root: Uint8Array;
  /** The block number as decoded (a *big.Int); `numberU64` is its low 64 bits, as Go's Number.Uint64() reads it. */
  number: bigint;
  numberU64: bigint;
  /** keccak256 of the header's RLP: the decode is canonical, so this is Go's Header.Hash(). */
  hash: Uint8Array;
}

/** rlp.DecodeBytes into types.Header: 15 fields, then up to 8 optional ones (baseFee, withdrawalsHash, blobGasUsed,
 * excessBlobGas, parentBeaconRoot, requestsHash, blockAccessListHash, slotNumber). */
export function decodeS6Header(raw: Uint8Array): S6Header {
  const it = structItems(raw, 15, 8);
  const parentHash = fixedOf(it[0]!, 32);
  fixedOf(it[1]!, 32);
  fixedOf(it[2]!, 20);
  const root = fixedOf(it[3]!, 32);
  fixedOf(it[4]!, 32);
  fixedOf(it[5]!, 32);
  fixedOf(it[6]!, 256);
  uintOf(it[7]!);
  const number = uintOf(it[8]!);
  uintOf(it[9]!, 8);
  uintOf(it[10]!, 8);
  uintOf(it[11]!, 8);
  bytesOf(it[12]!);
  fixedOf(it[13]!, 32);
  fixedOf(it[14]!, 8);
  const opt: ((x: Item) => unknown)[] = [
    (x) => uintOf(x),
    (x) => fixedOf(x, 32),
    (x) => uintOf(x, 8),
    (x) => uintOf(x, 8),
    (x) => fixedOf(x, 32),
    (x) => fixedOf(x, 32),
    (x) => fixedOf(x, 32),
    (x) => uintOf(x, 8),
  ];
  for (let i = 15; i < it.length; i++) opt[i - 15]!(it[i]!);
  return { parentHash: Uint8Array.from(parentHash), root: Uint8Array.from(root), number, numberU64: BigInt.asUintN(64, number), hash: keccak_256(raw) };
}

export interface S6Transaction {
  hash: Uint8Array;
  to?: Uint8Array;
  /** tx.ChainId(): the declared chain id (typed), derived from v (legacy). */
  chainId: bigint;
  data: Uint8Array;
}

function listOf(it: Item): Item[] {
  if (it.kind !== 'list') throw new RlpError('expected input list');
  return listItems(it.content);
}
function accessList(it: Item): void {
  for (const t of listOf(it)) {
    const tuple = listOf(t);
    if (tuple.length < 2) throw new RlpError('too few elements');
    if (tuple.length > 2) throw new RlpError('input list has too many elements');
    fixedOf(tuple[0]!, 20);
    for (const k of listOf(tuple[1]!)) fixedOf(k, 32);
  }
}
const toNil = (it: Item): Uint8Array | undefined => (it.kind === 'string' && it.content.length === 0 ? undefined : Uint8Array.from(fixedOf(it, 20)));

/** BlobTx's canonical fields (rlp.DecodeBytes into types.BlobTx, 14 fields) from the encoding of its list. */
function blobTxFields(enc: Uint8Array): { to: Uint8Array; chainId: bigint; data: Uint8Array } {
  const it = structItems(enc, 14);
  const chainId = uintOf(it[0]!, 32);
  uintOf(it[1]!, 8);
  uintOf(it[2]!, 32);
  uintOf(it[3]!, 32);
  uintOf(it[4]!, 8);
  const to = Uint8Array.from(fixedOf(it[5]!, 20));
  uintOf(it[6]!, 32);
  const data = bytesOf(it[7]!);
  accessList(it[8]!);
  uintOf(it[9]!, 32);
  for (const h of listOf(it[10]!)) fixedOf(h, 32);
  for (const i of [11, 12, 13]) uintOf(it[i]!, 32);
  return { to, chainId, data: Uint8Array.from(data) };
}

/** kzg4844 sizes: a blob, a commitment and a proof. */
const BLOB_BYTES = 131072;
const KZG_BYTES = 48;

/**
 * BlobTx.decode (go-ethereum v1.17.7 core/types/tx_blob.go:369-435): the canonical form [chainID, nonce, ...], or the
 * network form with a sidecar - v0 [tx, blobs, commitments, proofs] when the second element is a list, else v1
 * [tx, version, blobs, commitments, proofs] with the version byte 1. The transaction's hash is keccak256(0x03 || the
 * canonical encoding of the inner transaction): Transaction.Hash encodes the transaction without its sidecar, and the strict
 * decode makes that re-encoding the inner list's own bytes.
 */
function decodeBlobTx(body: Uint8Array): S6Transaction {
  const outer = split(body);
  if (outer.kind !== 'list') throw new RlpError('expected List');
  const first = split(outer.content);
  if (first.kind !== 'list') {
    return { hash: keccak_256(concat2(Uint8Array.of(3), body)), ...blobTxFields(body) };
  }
  const second = split(first.rest);
  const v1 = second.kind !== 'list';
  const it = structItems(body, v1 ? 5 : 4);
  const inner = outer.content.subarray(0, outer.content.length - first.rest.length);
  const tx = blobTxFields(inner);
  let k = 1;
  if (v1) {
    const version = uintOf(it[k++]!, 1);
    for (const x of listOf(it[k]!)) fixedOf(x, BLOB_BYTES);
    for (const x of listOf(it[k + 1]!)) fixedOf(x, KZG_BYTES);
    for (const x of listOf(it[k + 2]!)) fixedOf(x, KZG_BYTES);
    if (version !== 1n) throw new RlpError(`unsupported blob tx version ${version}`);
  } else {
    for (const x of listOf(it[k]!)) fixedOf(x, BLOB_BYTES);
    for (const x of listOf(it[k + 1]!)) fixedOf(x, KZG_BYTES);
    for (const x of listOf(it[k + 2]!)) fixedOf(x, KZG_BYTES);
  }
  return { hash: keccak_256(concat2(Uint8Array.of(3), inner)), ...tx };
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Transaction.UnmarshalBinary: legacy RLP, or an EIP-2718 envelope of type 1, 2, 3 (canonical, or in its network form with a
 * v0 or v1 blob sidecar, as BlobTx.decode reads it) or 4. */
export function decodeS6Transaction(b: Uint8Array): S6Transaction {
  const hash = keccak_256(b);
  if (b.length > 0 && b[0]! > 0x7f) {
    const it = structItems(b, 9);
    uintOf(it[0]!, 8);
    uintOf(it[1]!);
    uintOf(it[2]!, 8);
    const to = toNil(it[3]!);
    uintOf(it[4]!);
    const data = bytesOf(it[5]!);
    const v = uintOf(it[6]!);
    uintOf(it[7]!);
    uintOf(it[8]!);
    let chainId: bigint;
    if (v < 1n << 64n) chainId = v === 27n || v === 28n ? 0n : BigInt.asUintN(64, v - 35n) / 2n;
    else chainId = (v - 35n) >> 1n;
    return { hash, to, chainId, data: Uint8Array.from(data) };
  }
  if (b.length <= 1) throw new RlpError('typed transaction too short');
  const body = b.subarray(1);
  switch (b[0]) {
    case 1: {
      const it = structItems(body, 11);
      const chainId = uintOf(it[0]!);
      uintOf(it[1]!, 8);
      uintOf(it[2]!);
      uintOf(it[3]!, 8);
      const to = toNil(it[4]!);
      uintOf(it[5]!);
      const data = bytesOf(it[6]!);
      accessList(it[7]!);
      for (const i of [8, 9, 10]) uintOf(it[i]!);
      return { hash, to, chainId, data: Uint8Array.from(data) };
    }
    case 2: {
      const it = structItems(body, 12);
      const chainId = uintOf(it[0]!);
      uintOf(it[1]!, 8);
      uintOf(it[2]!);
      uintOf(it[3]!);
      uintOf(it[4]!, 8);
      const to = toNil(it[5]!);
      uintOf(it[6]!);
      const data = bytesOf(it[7]!);
      accessList(it[8]!);
      for (const i of [9, 10, 11]) uintOf(it[i]!);
      return { hash, to, chainId, data: Uint8Array.from(data) };
    }
    case 3:
      return decodeBlobTx(body);
    case 4: {
      const it = structItems(body, 13);
      const chainId = uintOf(it[0]!, 32);
      uintOf(it[1]!, 8);
      uintOf(it[2]!, 32);
      uintOf(it[3]!, 32);
      uintOf(it[4]!, 8);
      const to = Uint8Array.from(fixedOf(it[5]!, 20));
      uintOf(it[6]!, 32);
      const data = bytesOf(it[7]!);
      accessList(it[8]!);
      for (const a of listOf(it[9]!)) {
        const au = listOf(a);
        if (au.length < 6) throw new RlpError('too few elements');
        if (au.length > 6) throw new RlpError('input list has too many elements');
        uintOf(au[0]!, 32);
        fixedOf(au[1]!, 20);
        uintOf(au[2]!, 8);
        uintOf(au[3]!, 1);
        uintOf(au[4]!, 32);
        uintOf(au[5]!, 32);
      }
      for (const i of [10, 11, 12]) uintOf(it[i]!, 32);
      return { hash, to, chainId, data: Uint8Array.from(data) };
    }
    default:
      throw new RlpError('transaction type not supported');
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The settlement (what the settlement layer has already proven)

export interface S6Log {
  address: string;
  topics: string[];
  data: string;
}
export interface S6Settlement {
  headerRlp: string;
  txRlp: string;
  receiptStatus: number;
  logs: S6Log[];
}
export interface S6DecodedLog {
  address: Uint8Array;
  topics: Uint8Array[];
}
export interface S6DecodedSettlement {
  header: S6Header;
  tx: S6Transaction;
  executed: boolean;
  logs: S6DecodedLog[];
}

/** hexutil.Decode. */
function goHexDecode(s: string): Uint8Array | undefined {
  if (s.length < 2 || s[0] !== '0' || (s[1] !== 'x' && s[1] !== 'X')) return undefined;
  const d = s.slice(2);
  if (d.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(d)) return undefined;
  return fromHexDigits(d);
}

/** s6replay1.DecodeSettlement: a settlement that does not decode is s6_replay_unproven{settlement_unproven}. */
export function decodeS6Settlement(s: S6Settlement): S6DecodedSettlement {
  const bad = (m: string): never => unproven(R.settlementUnproven, m);
  const hraw = goHexDecode(s.headerRlp);
  if (hraw === undefined) return bad('header is not hex');
  let header: S6Header;
  try {
    header = decodeS6Header(hraw);
  } catch (e) {
    if (e instanceof RlpError) return bad(`header does not decode: ${e.message}`);
    throw e;
  }
  const traw = goHexDecode(s.txRlp);
  if (traw === undefined) return bad('transaction is not hex');
  let tx: S6Transaction;
  try {
    tx = decodeS6Transaction(traw);
  } catch (e) {
    if (e instanceof RlpError) return bad(`transaction does not decode: ${e.message}`);
    throw e;
  }
  const logs: S6DecodedLog[] = [];
  s.logs.forEach((l, i) => {
    const a = l.address.startsWith('0x') || l.address.startsWith('0X') ? l.address.slice(2) : l.address;
    if (!/^[0-9a-fA-F]{40}$/.test(a)) bad(`log ${i} address`);
    const topics = l.topics.map((t) => {
      const b = goHexDecode(t);
      if (b === undefined || b.length !== 32) return bad(`log ${i} topic`);
      return b;
    });
    if (goHexDecode(l.data) === undefined) bad(`log ${i} data`);
    logs.push({ address: fromHexDigits(a), topics });
  });
  return { header, tx, executed: s.receiptStatus === 1, logs };
}

// ---------------------------------------------------------------------------------------------------------------------
// Verification (ReplayGuardEvidence.VerifyAgainst)

export interface S6ReplayGuardCheck {
  state: string;
  reason: string;
  beforeVerified: boolean;
  established: string[];
  /** The named state the evidence carried, when it carried one. */
  named?: S6ReplayNamedState;
}

/** keccak256(abi.encode(bytes32 key, uint256 base)). */
export function replaySlotFor(key: Uint8Array, base: number): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(key, 0);
  let b = BigInt(base);
  for (let i = 63; i >= 56; i--) {
    buf[i] = Number(b & 0xffn);
    b >>= 8n;
  }
  return keccak_256(buf);
}

const ONE32 = (() => {
  const b = new Uint8Array(32);
  b[31] = 1;
  return b;
})();
const ZERO32 = new Uint8Array(32);

/** The canonical RLP encoding of an item tree: a single byte below 0x80 as itself, every length in its shortest form. */
function rlpEncodeItem(it: Item): Uint8Array {
  if (it.kind === 'byte') return Uint8Array.from(it.content);
  let body: Uint8Array;
  if (it.kind === 'list') {
    const parts = listItems(it.content).map(rlpEncodeItem);
    body = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of parts) {
      body.set(x, o);
      o += x.length;
    }
  } else {
    if (it.content.length === 1 && it.content[0]! < 0x80) return Uint8Array.from(it.content);
    body = it.content;
  }
  const short = it.kind === 'list' ? 0xc0 : 0x80;
  let head: number[];
  if (body.length < 56) head = [short + body.length];
  else {
    const len: number[] = [];
    for (let n = body.length; n > 0; n = Math.floor(n / 256)) len.unshift(n % 256);
    head = [short + 55 + len.length, ...len];
  }
  return concat2(Uint8Array.from(head), body);
}

/** decodeReplayHeader: the header decodes, carries a number, and its bytes are the canonical RLP of the header it decodes to
 * (s6replay3 SPEC §2), so that keccak256 of the raw bytes is the decoded header's hash. */
function decodeReplayHeader(raw: Uint8Array, what: string): S6Header {
  let h: S6Header;
  try {
    h = decodeS6Header(raw);
  } catch (e) {
    if (e instanceof RlpError) return unproven(R.proofDoesNotVerify, `${what} does not decode: ${e.message}`);
    throw e;
  }
  if (!eq(rlpEncodeItem(split(raw)), raw)) {
    unproven(R.proofDoesNotVerify, `${what} is not the canonical RLP encoding of the header it decodes to`);
  }
  return h;
}

/** SlotProof.verify: the proof at stateRoot for account and slot, and its declarations equal to what it proves. */
function verifySlotProof(sp: S6SlotProof, stateRoot: Uint8Array, account: Uint8Array, slot: Uint8Array): StorageResult {
  const res = verifyStorage(stateRoot, account, sp.accountProof, slot, sp.storageProof);
  if (res.account.exists === sp.accountAbsent) throw new MptError('the declared absence is not what the proof proves');
  if (res.account.exists && (!eq(res.account.storageRoot, sp.storageHash) || !eq(res.account.codeHash, sp.codeHash))) {
    throw new MptError('the declared storage hash / code hash are not the account\'s');
  }
  if (!res.account.exists && (!eq(sp.storageHash, ZERO32) || !eq(sp.codeHash, ZERO32))) {
    throw new MptError('the account is proven absent, yet the proof declares non-zero hashes');
  }
  if (!eq(res.value, sp.value)) throw new MptError('the declared value is not the proven value');
  return res;
}

function tryVerifySlotProof(sp: S6SlotProof, root: Uint8Array, account: Uint8Array, slot: Uint8Array, what: string): StorageResult {
  try {
    return verifySlotProof(sp, root, account, slot);
  } catch (e) {
    if (e instanceof MptError || e instanceof RlpError) return unproven(R.proofDoesNotVerify, `${what}: ${e.message}`);
    throw e;
  }
}

const hasCode = (r: StorageResult): boolean =>
  r.account.exists && !eq(r.account.codeHash, keccak_256(new Uint8Array(0))) && !eq(r.account.codeHash, ZERO32);

/** ReplayGuardProof.VerifyAgainst. */
function verifyProof(p: S6ReplayGuardProof, s: S6DecodedSettlement): S6ReplayGuardCheck {
  if (p.version !== S6_REPLAY_DOMAIN) unproven(R.version, `version ${JSON.stringify(p.version)} is not ${S6_REPLAY_DOMAIN}`);
  const { header, tx, executed, logs } = s;
  if (!executed) unproven(R.settlementNotExecuted, 'the proven receipt is not status 1: no consumption happened');
  const nNumber = header.numberU64;
  if (BigInt(p.settlementBlock.number) !== nNumber || !eq(p.settlementBlock.hash, header.hash)) {
    unproven(R.blockMismatch, `the proof is about block ${p.settlementBlock.number}, the settlement is in block ${nNumber}`);
  }

  // (1) the target and the pinned generation.
  const layout = Object.prototype.hasOwnProperty.call(S6_REPLAY_LAYOUTS, p.generation) ? S6_REPLAY_LAYOUTS[p.generation] : undefined;
  if (layout === undefined) return unproven(R.accountGeneration, `generation ${JSON.stringify(p.generation)} has no pinned replay-guard layout`);
  if (tx.to === undefined || !eq(tx.to, p.contract)) unproven(R.contractMismatch, 'the transaction\'s target is not the proof\'s contract');
  if (tx.chainId > 0n && tx.chainId !== BigInt(p.chainId)) unproven(R.contractMismatch, `the transaction is of chain ${tx.chainId}, the proof of chain ${p.chainId}`);
  if (tx.data.length < 4) unproven(R.accountGeneration, 'the transaction carries no settlement call');
  const sel = toHex(tx.data.subarray(0, 4)).slice(2);
  if (!layout.selectors.includes(sel)) unproven(R.accountGeneration, `calldata selector 0x${sel} is not a ${p.generation} settlement call`);

  // (2) the event, and the slot recomputed from it.
  const isLeafConsumed = (lg: S6DecodedLog): boolean =>
    eq(lg.address, p.contract) && lg.topics.length === 3 && eq(lg.topics[0]!, S6_LEAF_CONSUMED_TOPIC);
  const event = logs.find((lg) => isLeafConsumed(lg) && eq(lg.topics[2]!, p.slot.key));
  if (event === undefined) {
    if (logs.some(isLeafConsumed)) unproven(R.slotMismatch, 'the key is not the leaf that the contract\'s LeafConsumed in this receipt names');
    refuse(S6_EVENT_MISSING, R.noEvent, 'the status-1 receipt of a call to the contract holds no LeafConsumed it emitted');
  }
  if (p.slot.base !== layout.base || p.slot.derivation !== S6_REPLAY_DERIVATION) {
    unproven(R.slotMismatch, `base ${p.slot.base} is not ${p.generation}'s pinned base ${layout.base}`);
  }
  if (!eq(p.slot.slot, replaySlotFor(p.slot.key, layout.base))) unproven(R.slotMismatch, 'the slot is not keccak256(key || base)');

  // (3) the header chain, settlement block to ProvenAt.
  if (p.headers.length > S6_MAX_REPLAY_HEADER_CHAIN) {
    unproven(R.headerChainTooLong, `${p.headers.length} headers after the settlement block, at most ${S6_MAX_REPLAY_HEADER_CHAIN}`);
  }
  let at = header;
  p.headers.forEach((raw, i) => {
    const next = decodeReplayHeader(raw, `header ${i} of the chain`);
    if (!eq(next.parentHash, at.hash) || next.numberU64 !== BigInt.asUintN(64, at.numberU64 + 1n)) {
      unproven(R.headerChainBroken, `header ${i} does not follow block ${at.numberU64}`);
    }
    at = next;
  });
  if (BigInt(p.provenAt.number) !== at.numberU64 || !eq(p.provenAt.hash, at.hash)) {
    unproven(R.headerChainBroken, `the chain ends at block ${at.numberU64}, the proof says it is proven at block ${p.provenAt.number}`);
  }

  // (4) After: the slot is 1 at ProvenAt.
  const afterRes = tryVerifySlotProof(p.after, at.root, p.contract, p.slot.slot, `After at block ${at.numberU64}`);
  if (!hasCode(afterRes)) unproven(R.contractMismatch, `the contract holds no code at block ${at.numberU64}`);
  if (eq(afterRes.value, ONE32)) {
    // consumed
  } else if (eq(afterRes.value, ZERO32)) {
    refuse(S6_REPLAY_REFUTED, R.slotUnsetAtBlock, `the slot is 0 at block ${at.numberU64} although the status-1 receipt holds its LeafConsumed`);
  } else {
    unproven(R.proofDoesNotVerify, `After proves ${toHex(afterRes.value)}, not the bool true of a consumed leaf`);
  }

  const established = [
    `S6: ${checksumAddress(p.contract)}'s replay-guard slot ${toHex(p.slot.slot)} (${p.generation} _consumedLeaf[leaf], leaf ${toHex(p.slot.key)} from this receipt's LeafConsumed) is 1 in the state of block ${p.provenAt.number} (${toHex(p.provenAt.hash)}), ${p.headers.length} block(s) after the settlement block ${nNumber}, the chain of headers linked by parentHash`,
  ];
  let beforeVerified = false;

  // (5) Before, or its disclosure.
  if (p.before !== undefined && p.beforeUnavailable !== undefined) {
    unproven(R.beforeUndisclosed, 'both a Before proof and a disclosure that it is unavailable are carried');
  } else if (p.before !== undefined) {
    let parent: S6Header;
    try {
      parent = decodeReplayHeader(p.before.parentHeader, 'the parent header');
    } catch (e) {
      if (e instanceof S6ReplayError) return unproven(R.parentHeaderUnproven, e.message);
      throw e;
    }
    if (!eq(parent.hash, header.parentHash) || BigInt.asUintN(64, parent.numberU64 + 1n) !== nNumber) {
      unproven(R.parentHeaderUnproven, `the parent header is block ${parent.numberU64}, not the settlement block's parent`);
    }
    const beforeRes = tryVerifySlotProof(p.before.proof, parent.root, p.contract, p.slot.slot, `Before at block ${parent.numberU64}`);
    if (beforeRes.account.exists && !eq(beforeRes.account.codeHash, afterRes.account.codeHash)) {
      unproven(R.contractMismatch, `the code of the contract changed between block ${parent.numberU64} and block ${at.numberU64}`);
    }
    if (eq(beforeRes.value, ZERO32)) {
      // unconsumed at the parent
    } else if (eq(beforeRes.value, ONE32)) {
      refuse(S6_REPLAY_REFUTED, R.slotSetAtParent, `the slot is already 1 at block ${parent.numberU64}, the parent of the settlement block ${nNumber}`);
    } else {
      unproven(R.proofDoesNotVerify, `Before proves ${toHex(beforeRes.value)}, not the bool false of an unconsumed leaf`);
    }
    beforeVerified = true;
    established.push(
      `S6: the same slot is 0 in the state of block ${parent.numberU64} (${toHex(parent.hash)}), the settlement block's parent: the transition happened in block ${nNumber}`,
    );
  } else if (p.beforeUnavailable !== undefined) {
    if (p.beforeUnavailable.reason === '') unproven(R.beforeUndisclosed, 'the disclosure that Before is unavailable gives no reason');
  } else {
    unproven(R.beforeUndisclosed, 'the parent-state half is neither proven nor disclosed as unavailable');
  }
  return { state: S6_PROVEN, reason: '', beforeVerified, established };
}

/** ReplayGuardEvidence.VerifyAgainst: a proof is verified; a named state is held to this transaction and block and
 * reported as the state it names. A refusal throws S6ReplayError. */
export function verifyReplayGuardEvidence(ev: S6ReplayGuardEvidence, s: S6DecodedSettlement): S6ReplayGuardCheck {
  if ((ev.proof === undefined) === (ev.state === undefined)) unproven(R.emptyEvidence, 'the evidence carries exactly one of a proof and a named state');
  if (ev.version !== S6_REPLAY_DOMAIN) unproven(R.version, `version ${JSON.stringify(ev.version)} is not ${S6_REPLAY_DOMAIN}`);
  if (ev.proof !== undefined) return verifyProof(ev.proof, s);
  const st = ev.state!;
  if (st.state !== S6_REPLAY_UNPROVEN && st.state !== S6_EVENT_MISSING && st.state !== S6_REPLAY_REFUTED) {
    unproven(R.emptyEvidence, `${JSON.stringify(st.state)} is not a named state of the replay guard`);
  }
  if (st.reason === '') unproven(R.emptyEvidence, 'a named state carries its reason');
  if (!eq(st.txHash, s.tx.hash) || !eq(st.blockHash, s.header.hash) || BigInt(st.blockNumber) !== s.header.numberU64) {
    unproven(R.blockMismatch, 'the named state is about another transaction or block than the settlement');
  }
  // The chain and the contract the state names are the settlement's (s6replay3 SPEC §3 steps 3-4): the chain id when the
  // transaction carries one, and the transaction's target; only a state named before the capture had the transaction
  // (receipt_unavailable), or about a contract creation, names no contract.
  if (s.tx.chainId > 0n && s.tx.chainId !== BigInt(st.chainId)) {
    unproven(R.contractMismatch, `the transaction is of chain ${s.tx.chainId}, the named state of chain ${st.chainId}`);
  }
  const to = s.tx.to;
  if (!(to !== undefined && eq(st.contract, to)) && !(eq(st.contract, ZERO20) && (to === undefined || st.reason === R.receiptUnavailable))) {
    unproven(R.contractMismatch, `the named state is about contract ${checksumAddress(st.contract)}, the transaction's target is ${to === undefined ? 'none' : checksumAddress(to)}`);
  }
  if (st.state === S6_REPLAY_REFUTED && st.reason === R.slotSetAtParent) {
    return { state: st.state, reason: st.reason, beforeVerified: true, established: [verifyRefutation(st, s)], named: st };
  }
  return { state: st.state, reason: st.reason, beforeVerified: false, established: [], named: st };
}

const ZERO20 = new Uint8Array(20);

/** verifyRefutation (s6replay3 SPEC §3 step 5): a refutation slot_set_at_parent is stated only with its Before verified - the
 * parent header is the settlement block's parent, and the proof proves, at its state root, the slot of a LeafConsumed key
 * the contract emitted in this receipt to be 1. */
function verifyRefutation(st: S6ReplayNamedState, s: S6DecodedSettlement): string {
  if (st.before === undefined) return unproven(R.proofDoesNotVerify, `the refutation ${R.slotSetAtParent} carries no Before proof`);
  let parent: S6Header;
  try {
    parent = decodeReplayHeader(st.before.parentHeader, "the refutation's parent header");
  } catch (e) {
    if (e instanceof S6ReplayError) return unproven(R.parentHeaderUnproven, e.message);
    throw e;
  }
  if (!eq(parent.hash, s.header.parentHash) || BigInt.asUintN(64, parent.numberU64 + 1n) !== s.header.numberU64) {
    unproven(R.parentHeaderUnproven, `the refutation's parent header is block ${parent.numberU64}, the settlement block names another parent`);
  }
  const sel = s.tx.data.length >= 4 ? toHex(s.tx.data.subarray(0, 4)).slice(2) : undefined;
  const layout = sel === undefined ? undefined : Object.values(S6_REPLAY_LAYOUTS).find((l) => l.selectors.includes(sel));
  if (layout === undefined) return unproven(R.accountGeneration, 'the transaction is no settlement call of a pinned generation');
  for (const lg of s.logs) {
    if (!eq(lg.address, st.contract) || lg.topics.length !== 3 || !eq(lg.topics[0]!, S6_LEAF_CONSUMED_TOPIC)) continue;
    const slot = replaySlotFor(lg.topics[2]!, layout.base);
    let res: StorageResult;
    try {
      res = verifySlotProof(st.before.proof, parent.root, st.contract, slot);
    } catch (e) {
      if (e instanceof MptError || e instanceof RlpError) continue;
      throw e;
    }
    if (eq(res.value, ONE32)) {
      return `S6 refuted: ${checksumAddress(st.contract)}'s replay-guard slot ${toHex(slot)} (leaf ${toHex(lg.topics[2]!)}) is already 1 in the state of block ${parent.numberU64} (${toHex(parent.hash)}), the settlement block's parent`;
    }
  }
  return unproven(R.proofDoesNotVerify, `the refutation's Before does not prove the slot of any LeafConsumed key of ${checksumAddress(st.contract)} to be 1 at block ${parent.numberU64}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The judgement the conformance suite states (s6replay1.Judge)

export interface S6Verdict {
  result: 'proven' | 'stated' | 'refused';
  state: string;
  reason: string;
  beforeVerified: boolean;
  established: string[];
}

/** The verdict on evidence bytes against a settlement: settlement decoded, evidence decoded strictly, then verified. */
export function judgeS6Replay(settlement: S6Settlement, evidence: Uint8Array): S6Verdict {
  try {
    const s = decodeS6Settlement(settlement);
    const ev = decodeReplayGuardEvidence(evidence);
    const chk = verifyReplayGuardEvidence(ev, s);
    return {
      result: chk.named !== undefined ? 'stated' : 'proven',
      state: chk.state,
      reason: chk.reason,
      beforeVerified: chk.beforeVerified,
      established: [...chk.established],
    };
  } catch (e) {
    if (e instanceof S6ReplayError) return { result: 'refused', state: e.state, reason: e.reason, beforeVerified: false, established: [] };
    throw e;
  }
}
