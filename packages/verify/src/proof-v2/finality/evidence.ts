/**
 * The leg's Settlement block and level 1 (the twin of pkg/finality/evidence.go): `included` is derived from the original proof's
 * Settlement (R1) and has no addendum. Its result is the BlockRef every other level binds to.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { RlpError, decodeList, fixedOf, uintOf } from '../../s6/rlp.js';
import { MptError, verifyProof } from '../../s6/mpt.js';
import { decodeS6Header } from '../../s6/replay.js';
import { readHeader } from './rlpheader.js';
import { Code, IncludedReason, includedUnavailable, newState, type Fields, type FinalityStateError } from './state.js';

/**
 * The leg's Settlement block: the block that holds the settled transaction on the target chain. `headerRlp` is the raw header
 * (absent for a block known only by its triple, e.g. the carried `finality.leg`).
 */
export interface BlockRef {
  chain: bigint;
  number: bigint;
  hash: Uint8Array;
  headerRlp?: Uint8Array;
}

/** The (chain, number, hash) a leg binding and a container header commit to, as a state field. */
export function triple(b: BlockRef): Fields {
  return { chain: b.chain, blockNumber: b.number, blockHash: b.hash };
}

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export const sameBlock = (a: BlockRef, b: BlockRef): boolean => a.chain === b.chain && a.number === b.number && sameBytes(a.hash, b.hash);

/** An inclusion proof as pkg/ethproof serialises it (`tx_inclusion_proof`, `receipt_inclusion_proof`), bytes decoded. */
export interface InclusionProof {
  leafHash: Uint8Array;
  leafIndex: bigint;
  proofHashes: Uint8Array[];
  expectedRoot: Uint8Array;
  proofNodes: Uint8Array[];
  leafValue: Uint8Array;
}

/** The offline-verifiable inclusion of one transaction and its receipt in one block (ethproof.Settlement). */
export interface Settlement {
  blockHash: Uint8Array;
  headerRlp: Uint8Array;
  txHash: Uint8Array;
  tx: InclusionProof | null;
  receipt: InclusionProof | null;
}

const invalid = (chain: bigint, cause: string): FinalityStateError => newState(Code.IncludedInvalid, { chain, cause });

/** A failure of an inclusion proof or of the receipt's decoding: it becomes finality_included_invalid{cause}. */
class InclusionFail extends Error {}

/** rlp(uint64 index) as the trie key: the canonical RLP of an integer. */
function rlpIndex(i: bigint): Uint8Array {
  if (i === 0n) return Uint8Array.of(0x80);
  const bytes: number[] = [];
  for (let v = i; v > 0n; v >>= 8n) bytes.unshift(Number(v & 0xffn));
  if (bytes.length === 1 && bytes[0]! < 0x80) return Uint8Array.of(bytes[0]!);
  return Uint8Array.of(0x80 + bytes.length, ...bytes);
}

/** InclusionProof.Check + VerifyInclusion: every node keyed by its own keccak256, the path of rlp(leafIndex) resolves from root to leafValue. */
function checkInclusion(p: InclusionProof, root: Uint8Array, index: bigint): Uint8Array {
  if (!sameBytes(p.expectedRoot, root)) throw new InclusionFail("the proof resolves from another root than the header's");
  if (p.leafIndex !== index) throw new InclusionFail(`the proof is for index ${p.leafIndex}, not ${index}`);
  if (p.proofNodes.length === 0) throw new InclusionFail('no proof nodes');
  if (p.leafValue.length === 0) throw new InclusionFail('no leaf value');
  if (p.proofHashes.length !== p.proofNodes.length) throw new InclusionFail('node hash count differs from node count');
  p.proofNodes.forEach((n, i) => {
    if (n.length === 0) throw new InclusionFail(`node ${i} is empty`);
    if (!sameBytes(keccak_256(n), p.proofHashes[i]!)) throw new InclusionFail(`node ${i} does not hash to the proof's stated hash`);
  });
  let value: Uint8Array | undefined;
  try {
    value = verifyProof(p.expectedRoot, rlpIndex(p.leafIndex), p.proofNodes);
  } catch (e) {
    if (e instanceof MptError) throw new InclusionFail(`path for index ${p.leafIndex}: ${e.message}`);
    throw e;
  }
  if (value === undefined) throw new InclusionFail(`the root holds no entry at index ${p.leafIndex}`);
  if (!sameBytes(value, p.leafValue)) throw new InclusionFail("the path resolves to another value than the proof's leaf");
  if (!sameBytes(keccak_256(value), p.leafHash)) throw new InclusionFail("the leaf does not hash to the proof's leaf hash");
  return value;
}

/** DecodeReceiptLeaf: rlp([status, cumulativeGasUsed, bloom, logs, ...tail]) behind an optional EIP-2718 type byte. */
function checkReceiptDecodes(enc: Uint8Array): void {
  if (enc.length === 0) throw new InclusionFail('empty receipt');
  const body = enc[0]! < 0x80 ? enc.subarray(1) : enc;
  const items = decodeList(body);
  if (items.length < 4) throw new InclusionFail('the receipt has too few elements');
  if (items[0]!.kind === 'list') throw new InclusionFail('the receipt status is a list');
  uintOf(items[1]!, 8);
  const bloom = items[2]!;
  if (bloom.kind === 'list' || bloom.content.length !== 256) throw new InclusionFail('the receipt bloom is not 256 bytes');
  if (items[3]!.kind !== 'list') throw new InclusionFail('the receipt logs are not a list');
  for (const log of decodeList(items[3]!.raw)) {
    if (log.kind !== 'list') throw new InclusionFail('a log is not a list');
    const f = decodeList(log.raw);
    if (f.length !== 3) throw new InclusionFail('a log has three elements');
    if (f[0]!.kind === 'list' || f[0]!.content.length !== 20) throw new InclusionFail('a log address is not 20 bytes');
    if (f[1]!.kind !== 'list') throw new InclusionFail('log topics are not a list');
    for (const t of decodeList(f[1]!.raw)) if (t.kind === 'list' || t.content.length !== 32) throw new InclusionFail('a log topic is not 32 bytes');
    if (f[2]!.kind === 'list') throw new InclusionFail('log data is a list');
  }
}

/**
 * Level 1 (5.1): the Settlement verifies (S6: the header hashes to the block hash and decodes as a typed header; the transaction
 * proof resolves from the header's transactionsRoot and its leaf hashes to the transaction hash; the receipt sits at the same index
 * and decodes), the block number is read POSITIONALLY from the header (item 8), and the chain id is the one the caller expects.
 * Level 1 has no addendum; its result is the BlockRef every other level binds to.
 */
export function deriveIncluded(chain: bigint, s: Settlement | null | undefined): BlockRef {
  if (s === null || s === undefined) throw includedUnavailable(IncludedReason.NoSettlement, { chain });
  if (s.headerRlp.length === 0) throw invalid(chain, 'no block header');
  if (!sameBytes(keccak_256(s.headerRlp), s.blockHash)) throw invalid(chain, 'the header does not hash to the block hash');
  try {
    // VerifySettlement: the typed decode (rlp.DecodeBytes into types.Header), then the two proofs against its roots
    decodeS6Header(s.headerRlp);
    const items = decodeList(s.headerRlp);
    const txRoot = fixedOf(items[4]!, 32);
    const receiptRoot = fixedOf(items[5]!, 32);
    if (s.tx === null || s.receipt === null) throw new InclusionFail('a transaction and a receipt proof are both required');
    const txLeaf = checkInclusion(s.tx, txRoot, s.tx.leafIndex);
    if (!sameBytes(keccak_256(txLeaf), s.txHash)) throw new InclusionFail(`the proven transaction at index ${s.tx.leafIndex} is not the stated transaction`);
    checkReceiptDecodes(checkInclusion(s.receipt, receiptRoot, s.tx.leafIndex));
  } catch (e) {
    if (e instanceof InclusionFail || e instanceof RlpError) throw invalid(chain, e.message);
    throw e;
  }
  const h = readHeader(s.headerRlp);
  return { chain, number: h.number, hash: h.hash, headerRlp: Uint8Array.from(s.headerRlp) };
}
