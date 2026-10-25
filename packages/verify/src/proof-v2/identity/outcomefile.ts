// The exported outcome evidence file (execution.OutcomeEvidence) as the source of a leg for `--contract-identity` (twin of settlementFromOutcomeFile, registry9FromOutcome and the
// batch facts of legContextFromOutcome in cmd/proofverify). The file is read strictly: a member it must carry that is absent or of the wrong type, a hex spelling that is not
// canonical, an integer a JS number cannot hold exactly, is an OutcomeFileError and never a default. Nothing in the file is trusted: the Settlement it yields is verified by
// finality.deriveIncluded, and what the file states about the batch and the registry is judged against the chain by the verifier.
//
// Go reads the file with encoding/json (keys matched case-insensitively, hashes read leniently); this reader matches the keys exactly and reads every hash and address at its
// exact length, so it refuses a file Go would accept in those spellings and accepts nothing Go refuses (finding RB12-F3).
import { keccak_256 } from '@noble/hashes/sha3';
import { IncludedReason, includedUnavailable } from '../finality/state.js';
import type { InclusionProof, Settlement } from '../finality/evidence.js';
import { readHeader } from '../finality/rlpheader.js';
import { toHex } from './canon.js';
import type { BatchFacts, Registry9 } from './context.js';

/** The file is not an outcome evidence this verifier can read (the reason, for a message). */
export class OutcomeFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeFileError';
  }
}
const bad = (m: string): never => {
  throw new OutcomeFileError(m);
};

/** OutcomeExecuted and OutcomeEffectsNotProven: the two statuses of a member that holds a settlement. */
const SETTLED_STATUSES: readonly number[] = [1, 2];

export interface OutcomeQuorumValidator { address: string; votingPower: string; blsPublicKey: string }
export interface OutcomeInclusion { header: Uint8Array; index: bigint; transaction: Uint8Array; transactionProof: Uint8Array[]; receipt: Uint8Array; receiptProof: Uint8Array[] }
/** The members of the file the S8 phase reads. `replayGuard` is the raw JSON of the member's S6 evidence (undefined: none carried). */
export interface OutcomeEvidence {
  chainId: bigint;
  anchor: { batchRoot: string; batchOperationId: string; accumulateSetRoot: string; incarnation: string; certenSetRoot: string };
  quorum: { thresholdNumerator: bigint; thresholdDenominator: bigint; validators: OutcomeQuorumValidator[] };
  member: { leaf: { status: number; tx: string; blockNumber: bigint; blockHash: string }; adiUrl: string; transaction?: OutcomeInclusion; replayGuard?: unknown };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown, what: string): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : bad(`${what} is not an object`));
const field = (o: Obj, k: string, what: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : bad(`${what}.${k} is missing`));
const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : bad(`${what} is not a string`));
const uint = (v: unknown, what: string): bigint => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return bad(`${what} is not an unsigned integer a JS number holds exactly`);
  return BigInt(v);
};
const hexBytes = (s: unknown, what: string): Uint8Array => {
  const t = str(s, what);
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(t)) return bad(`${what} is not 0x-prefixed hex of whole bytes`);
  const out = new Uint8Array((t.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
};
const hexList = (v: unknown, what: string): Uint8Array[] => (Array.isArray(v) ? v.map((x, i) => hexBytes(x, `${what}[${i}]`)) : bad(`${what} is not a list`));
/** A hash spelled with or without 0x, exactly 32 bytes (hash32). */
export function hash32(s: string, what: string): Uint8Array {
  const t = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^[0-9a-fA-F]{64}$/.test(t)) return bad(`${what} is not 32 bytes of hex`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(t.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Reads the members the S8 phase needs out of an outcome evidence file's text. */
export function readOutcomeEvidence(input: string | Uint8Array): OutcomeEvidence {
  let doc: unknown;
  try {
    doc = JSON.parse(typeof input === 'string' ? input : new TextDecoder().decode(input));
  } catch (e) {
    return bad(`the outcome evidence does not decode: ${(e as Error).message}`);
  }
  const top = obj(doc, 'the outcome evidence');
  const chainId = uint(field(top, 'chainId', 'evidence'), 'chainId');
  if (chainId <= 0n) bad(`the outcome evidence names chain ${chainId}`);
  const a = obj(field(top, 'anchor', 'evidence'), 'anchor');
  const anchor = Object.fromEntries(['batchRoot', 'batchOperationId', 'accumulateSetRoot', 'incarnation', 'certenSetRoot'].map((k) => [k, str(field(a, k, 'anchor'), `anchor.${k}`)])) as OutcomeEvidence['anchor'];
  const q = obj(field(top, 'quorum', 'evidence'), 'quorum');
  const vals = field(q, 'validators', 'quorum');
  if (!Array.isArray(vals)) bad('quorum.validators is not a list');
  const validators = (vals as unknown[]).map((v, i) => {
    const o = obj(v, `quorum.validators[${i}]`);
    return { address: str(field(o, 'address', 'validator'), 'address'), votingPower: str(field(o, 'votingPower', 'validator'), 'votingPower'), blsPublicKey: str(field(o, 'blsPublicKey', 'validator'), 'blsPublicKey') };
  });
  const m = obj(field(top, 'member', 'evidence'), 'member');
  const l = obj(field(m, 'leaf', 'member'), 'member.leaf');
  const leaf = { status: Number(uint(field(l, 'status', 'leaf'), 'leaf.status')), tx: str(field(l, 'tx', 'leaf'), 'leaf.tx'), blockNumber: uint(field(l, 'blockNumber', 'leaf'), 'leaf.blockNumber'), blockHash: str(field(l, 'blockHash', 'leaf'), 'leaf.blockHash') };
  const out: OutcomeEvidence = {
    chainId,
    anchor,
    quorum: { thresholdNumerator: uint(field(q, 'thresholdNumerator', 'quorum'), 'thresholdNumerator'), thresholdDenominator: uint(field(q, 'thresholdDenominator', 'quorum'), 'thresholdDenominator'), validators },
    member: { leaf, adiUrl: str(field(m, 'adiUrl', 'member'), 'member.adiUrl') },
  };
  const t = m['transaction'];
  if (t !== undefined && t !== null) {
    const o = obj(t, 'member.transaction');
    out.member.transaction = {
      header: hexBytes(field(o, 'header', 'transaction'), 'transaction.header'),
      index: uint(field(o, 'index', 'transaction'), 'transaction.index'),
      transaction: hexBytes(field(o, 'transaction', 'transaction'), 'transaction.transaction'),
      transactionProof: hexList(field(o, 'transactionProof', 'transaction'), 'transaction.transactionProof'),
      receipt: hexBytes(field(o, 'receipt', 'transaction'), 'transaction.receipt'),
      receiptProof: hexList(field(o, 'receiptProof', 'transaction'), 'transaction.receiptProof'),
    };
  }
  if (m['replayGuard'] !== undefined && m['replayGuard'] !== null) out.member.replayGuard = m['replayGuard'];
  return out;
}

/** The Settlement of the file's MEMBER: the block and transaction that settled the leg, each proven into the header by the proofs the file carries (verified by deriveIncluded). */
export function settlementFromOutcome(ev: OutcomeEvidence): { chain: bigint; settlement: Settlement } {
  const leaf = ev.member.leaf;
  // a member that holds no settlement (status 3 not settled, 4 consumed elsewhere) is the named state finality_included_unavailable{reason: no_settlement}
  if (!SETTLED_STATUSES.includes(leaf.status)) throw includedUnavailable(IncludedReason.NoSettlement, { chain: ev.chainId });
  const inc = ev.member.transaction;
  if (inc === undefined) return bad(`the outcome evidence member (status ${leaf.status}) carries no settlement inclusion`);
  let header;
  try {
    header = readHeader(inc.header);
  } catch (e) {
    return bad(`the outcome evidence header does not decode: ${(e as Error).message}`);
  }
  const blockHash = keccak_256(inc.header);
  // the outcome LEAF (committed under the certified outcome root) STATES which block and transaction settled the member: the header and the transaction bytes must be those
  if (toHex(blockHash) !== toHex(hash32(leaf.blockHash, 'leaf.blockHash'))) bad(`the outcome evidence header hashes to 0x${toHex(blockHash)}, the leaf names block ${leaf.blockHash}`);
  if (header.number !== leaf.blockNumber) bad(`the outcome evidence header is not block ${leaf.blockNumber}`);
  const txHash = keccak_256(inc.transaction);
  if (toHex(txHash) !== toHex(hash32(leaf.tx, 'leaf.tx'))) bad(`the outcome evidence transaction hashes to 0x${toHex(txHash)}, the leaf names ${leaf.tx}`);
  const proof = (value: Uint8Array, nodes: Uint8Array[], root: Uint8Array): InclusionProof => ({
    leafHash: keccak_256(value), leafIndex: inc.index, proofHashes: nodes.map((n) => keccak_256(n)), expectedRoot: root, proofNodes: nodes, leafValue: value,
  });
  return {
    chain: ev.chainId,
    settlement: { blockHash, headerRlp: inc.header, txHash, tx: proof(inc.transaction, inc.transactionProof, header.transactionRoot), receipt: proof(inc.receipt, inc.receiptProof, header.receiptsRoot) },
  };
}

/** The batch facts the anchor states (anchor.batchRoot, batchOperationId, accumulateSetRoot, incarnation). */
export function batchFactsFromOutcome(ev: OutcomeEvidence): BatchFacts {
  return {
    batchRoot: hash32(ev.anchor.batchRoot, 'anchor.batchRoot'),
    operationId: hash32(ev.anchor.batchOperationId, 'anchor.batchOperationId'),
    accSetRoot: hash32(ev.anchor.accumulateSetRoot, 'anchor.accumulateSetRoot'),
    incarnation: hash32(ev.anchor.incarnation, 'anchor.incarnation'),
  };
}

/**
 * The S9 registry the batch-outcome quorum states: the validators with their powers and BLS keys, the threshold and the anchor's CERTEN set root. It has no signer commitment
 * (the Open entry pkc_signer_check). A quorum that names no validator supplies none. The keys are re-spelled as the registry form (lower-case hex, no 0x); whether they are the
 * keys of the contract is what the verifier judges.
 */
export function registry9FromOutcome(ev: OutcomeEvidence): Registry9 | undefined {
  if (ev.quorum.validators.length === 0) return undefined;
  const members = ev.quorum.validators.map((v, i) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(v.address)) bad(`quorum validator ${i}: address ${JSON.stringify(v.address)} is not 20 bytes of 0x hex`);
    if (!/^(?:0|[1-9][0-9]*)$/.test(v.votingPower) || BigInt(v.votingPower) >= 1n << 64n) bad(`quorum validator ${i}: voting power ${JSON.stringify(v.votingPower)} is not a uint64`);
    return { address: hexBytes(v.address, `quorum validator ${i} address`), power: BigInt(v.votingPower), blsKey: v.blsPublicKey.toLowerCase().replace(/^0x/, '') };
  });
  return { members, num: ev.quorum.thresholdNumerator, den: ev.quorum.thresholdDenominator, certenSetRoot: hash32(ev.anchor.certenSetRoot, 'anchor.certenSetRoot'), signerCommitment: new Uint8Array(32) };
}
