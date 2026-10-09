/**
 * The shapes of the JSON a proof v2 portable document is made of (Go: certen-validator pkg/proof/v2 portable.go and the
 * accumulate v3 API records it embeds), and the readers that take them from `unknown`.
 *
 * Everything the verifier is handed is untrusted JSON. These readers are the only place it is turned into typed values, and
 * each one names what is wrong: a missing field, a number that is not a whole non-negative number, a hash of the wrong
 * length. A missing field is a VerifyError, never an `undefined` that flows into a hash or a comparison and makes a check
 * pass or fail for the wrong reason. Nothing past this module reads a document with `any`.
 */
import { fail, hexBytes } from './bytes.js';

export type Hex = string;
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Rec = Record<string, unknown>;

export function rec(v: unknown, label: string): Rec {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${label}: not an object`);
  return v as Rec;
}

export function list(v: unknown, label: string): unknown[] {
  if (!Array.isArray(v)) fail(`${label}: not a list`);
  return v;
}

/** A list that may be absent (Go omits an empty one). */
export function optList(v: unknown, label: string): unknown[] {
  return v === undefined || v === null ? [] : list(v, label);
}

export function str(v: unknown, label: string): string {
  if (typeof v !== 'string') fail(`${label}: missing or not a string`);
  return v;
}

/** A whole number >= 0 that a double holds exactly. */
export function uint(v: unknown, label: string): number {
  if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(`${label}: missing or not a whole non-negative number`);
  return v;
}

/** A number that may be absent, as Go omits a zero. */
export function optUint(v: unknown, label: string): number {
  return v === undefined || v === null ? 0 : uint(v, label);
}

export function hex32(v: unknown, label: string): Uint8Array {
  return hexBytes(v, label, 32);
}

// ── receipts ────────────────────────────────────────────────────────────────────────────────────────

/** A merkle.Receipt (start, anchor, entries[{hash, right}]), by the readers in bytes.ts. */
export interface ReceiptJSON {
  start: Hex;
  anchor: Hex;
  entries?: { hash: Hex; right?: boolean }[];
}

// ── transactions and messages ───────────────────────────────────────────────────────────────────────

export interface SignatureJSON {
  type: string;
  publicKey: Hex;
  signature: Hex;
  signer?: string;
  signerVersion?: number;
  timestamp?: number;
  transactionHash?: Hex;
}

export interface DirectoryAnchorBody {
  type: 'directoryAnchor';
  source: string;
  minorBlockIndex: number;
  rootChainAnchor: Hex;
  stateTreeAnchor: Hex;
}

/** The fields of a sequenced anchor message the verifier reads; the whole object is also handed to the SDK to rebuild. */
export interface AnchorMessage {
  json: Rec;
  source: string;
  destination: string;
  principal: string;
  body: Rec;
  bodyType: string;
}

export function anchorMessage(v: unknown, label: string): AnchorMessage {
  const j = rec(v, label);
  if (j.type !== 'sequenced') fail(`${label}: is ${String(j.type)}, not a sequenced message`);
  const m = rec(j.message, `${label}.message`);
  if (m.type !== 'transaction') fail(`${label}: anchor is not a transaction`);
  const tx = rec(m.transaction, `${label}.message.transaction`);
  const body = rec(tx.body, `${label}.message.transaction.body`);
  const header = rec(tx.header, `${label}.message.transaction.header`);
  return {
    json: j,
    source: str(j.source, `${label}.source`),
    destination: str(j.destination, `${label}.destination`),
    principal: str(header.principal, `${label}.message.transaction.header.principal`),
    body,
    bodyType: str(body.type, `${label}.message.transaction.body.type`),
  };
}

export interface AnchorBody {
  minorBlockIndex: number;
  rootChainAnchor: Uint8Array;
  stateTreeAnchor: Uint8Array;
  /** The partition the anchor is from (blockValidatorAnchor / directoryAnchor `source`). */
  source: string;
}

export function anchorBody(body: Rec, label: string): AnchorBody {
  return {
    minorBlockIndex: uint(body.minorBlockIndex, `${label}.minorBlockIndex`),
    rootChainAnchor: hex32(body.rootChainAnchor, `${label}.rootChainAnchor`),
    stateTreeAnchor: hex32(body.stateTreeAnchor, `${label}.stateTreeAnchor`),
    source: typeof body.source === 'string' ? body.source : '',
  };
}

export function signatures(v: unknown, label: string): SignatureJSON[] {
  return optList(v, label).map((s, i) => {
    const r = rec(s, `${label}[${i}]`);
    return r as unknown as SignatureJSON;
  });
}

// ── network updates and records of the spine ───────────────────────────────────────────────────────

export interface NetworkUpdateJSON {
  transaction: Rec;
  receipt: Rec;
}

export function networkUpdates(v: unknown, label: string): NetworkUpdateJSON[] {
  return optList(v, label).map((u, i) => {
    const r = rec(u, `${label}[${i}]`);
    if (!r.transaction || !r.receipt) fail(`${label}[${i}]: incomplete network update proof`);
    return { transaction: rec(r.transaction, `${label}[${i}].transaction`), receipt: rec(r.receipt, `${label}[${i}].receipt`) };
  });
}

export interface MajorRecord {
  index: number;
  entryBlockIndex: number;
  anchor: AnchorMessage;
  signatures: SignatureJSON[];
  updates: NetworkUpdateJSON[];
}

export function majorRecord(v: unknown, label: string): MajorRecord {
  if (!v || typeof v !== 'object') fail(`${label}: incomplete major header record`);
  const r = v as Rec;
  if (!r.entry || !r.anchor) fail(`${label}: incomplete major header record`);
  return {
    index: uint(r.index, `${label}.index`),
    entryBlockIndex: uint(rec(r.entry, `${label}.entry`).blockIndex, `${label}.entry.blockIndex`),
    anchor: anchorMessage(r.anchor, `${label}.anchor`),
    signatures: signatures(r.signatures, `${label}.signatures`),
    updates: networkUpdates(r.updates, `${label}.updates`),
  };
}

export interface MinorRootRecord {
  anchor: AnchorMessage;
  rootProof: unknown;
  signatures: SignatureJSON[];
  updates: NetworkUpdateJSON[];
}

export function minorRootRecord(v: unknown, label: string): MinorRootRecord {
  if (!v || typeof v !== 'object') fail(`${label}: incomplete minor root record`);
  const r = v as Rec;
  if (!r.anchor || !r.rootProof) fail(`${label}: incomplete minor root record`);
  return {
    anchor: anchorMessage(r.anchor, `${label}.anchor`),
    rootProof: r.rootProof,
    signatures: signatures(r.signatures, `${label}.signatures`),
    updates: networkUpdates(r.updates, `${label}.updates`),
  };
}

// ── the network and globals records, as the SDK renders them ───────────────────────────────────────

export interface ValidatorJSON {
  publicKey: Hex;
  publicKeyHash: Hex;
  partitions: { id: string; active: boolean }[];
}
export interface NetworkJSON {
  networkName?: string;
  version?: number;
  validators?: ValidatorJSON[];
}
export interface GlobalsJSON {
  validatorAcceptThreshold?: { numerator?: number; denominator?: number };
}
