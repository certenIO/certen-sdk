/**
 * The strict codec of the CFE1 evidence container (V2_SPEC_S7 sections 0 and 3; the twin of pkg/finality/codec.go). Integers are
 * unsigned big-endian; lp(x) = u32be(len(x)) || x; STR = lp(ASCII) with no NUL; LIST<T> = u32be(count) || T...; NODES is a LIST of
 * lp() trie nodes, strictly ascending by keccak256 and unique. Decoding is strict: a short field, a count above its bound, an
 * unordered node set or a trailing byte is a named refusal, and encode(decode(x)) == x for every x accepted.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { isStoredLevel } from './level.js';
import {
  EvidenceReason,
  FinalityStateError,
  evidenceTooLarge,
  evidenceUnrecognised,
  hexLower,
  malformed,
  malformedAt,
} from './state.js';

/** The DoS bounds of V2_SPEC_S7 section 8.2. Exceeding one reports the number and refuses; it never truncates. */
export interface Limits {
  /** evidence container, 64 MiB */
  maxEvidenceBytes: number;
  maxLinks: number;
  /** Sepolia/Base L1 spines and Adiri max_headers */
  maxSpineHeaders: number;
  /** Arbitrum */
  maxHeaderChain: number;
  /** Base */
  maxL2Headers: number;
  maxBlobsBase: number;
  maxBlobsArbitrum: number;
  maxFrameTxs: number;
  maxDepositTxs: number;
  maxBlockTxs: number;
  /** per NODES set */
  maxNodes: number;
  /** state and storage trie nodes */
  maxNodeBytes: number;
  /** transaction and receipt trie nodes */
  maxTxLeafBytes: number;
  /** gameCode */
  maxCodeBytes: number;
  maxCFA1Tables: number;
  maxCFA1Records: number;
  maxSigners: number;
  maxSegments: number;
  maxUncompressedBatch: number;
  /** any STR */
  maxStringBytes: number;
}

/**
 * The section 8.2 values. The pins file of section 4.2 carries the per-chain ones; the generic ones (max_nodes, max_node_bytes,
 * max_tx_leaf_bytes, max_frame_txs, ...) are code constants held here, pinned by a test against the section.
 */
export function defaultLimits(): Limits {
  return {
    maxEvidenceBytes: 64 << 20,
    maxLinks: 64,
    maxSpineHeaders: 16384,
    maxHeaderChain: 32768,
    maxL2Headers: 1024,
    maxBlobsBase: 32,
    maxBlobsArbitrum: 16,
    maxFrameTxs: 256,
    maxDepositTxs: 4096,
    maxBlockTxs: 65536,
    maxNodes: 8192,
    maxNodeBytes: 4096,
    maxTxLeafBytes: 2097152,
    maxCodeBytes: 262144,
    maxCFA1Tables: 64,
    maxCFA1Records: 65536,
    maxSigners: 255,
    maxSegments: 102400,
    maxUncompressedBatch: 16777216,
    maxStringBytes: 255,
  };
}

/** Builds a container body. */
export class Writer {
  private parts: Uint8Array[] = [];
  u8(v: number): void {
    this.parts.push(Uint8Array.of(v & 0xff));
  }
  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, false);
    this.parts.push(b);
  }
  u64(v: bigint): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, v), false);
    this.parts.push(b);
  }
  fixed(b: Uint8Array): void {
    this.parts.push(Uint8Array.from(b));
  }
  b32(b: Uint8Array): void {
    if (b.length !== 32) throw new Error('b32 needs 32 bytes');
    this.fixed(b);
  }
  lp(b: Uint8Array): void {
    this.u32(b.length);
    this.fixed(b);
  }
  str(s: string): void {
    this.lp(new TextEncoder().encode(s));
  }
  count(n: number): void {
    this.u32(n);
  }
  lpList(l: readonly Uint8Array[]): void {
    this.count(l.length);
    for (const e of l) this.lp(e);
  }
  /** The caller passes nodes in strictly ascending keccak256 order; encodeNodes sorts and deduplicates for it. */
  nodes(sorted: readonly Uint8Array[]): void {
    this.lpList(sorted);
  }
  bytes(): Uint8Array {
    let n = 0;
    for (const p of this.parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

/** Compares two byte strings as Go's string(a) <= string(b) does. */
export function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Decodes a container body strictly. Every method names the part it reads so that a refusal says where. */
export class Reader {
  private off = 0;
  constructor(
    private readonly b: Uint8Array,
    readonly lim: Limits,
  ) {}

  /** The number of unread bytes. */
  left(): number {
    return this.b.length - this.off;
  }

  private short(part: string, want: number): FinalityStateError {
    return malformed(part, EvidenceReason.Truncated, this.left(), want);
  }

  u8(part: string): number {
    if (this.left() < 1) throw this.short(part, 1);
    return this.b[this.off++]!;
  }

  u32(part: string): number {
    if (this.left() < 4) throw this.short(part, 4);
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.off, 4).getUint32(0, false);
    this.off += 4;
    return v;
  }

  u64(part: string): bigint {
    if (this.left() < 8) throw this.short(part, 8);
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.off, 8).getBigUint64(0, false);
    this.off += 8;
    return v;
  }

  /** Reads exactly n bytes (B16, B20, B32, B48...). */
  fixed(part: string, n: number): Uint8Array {
    if (this.left() < n) throw this.short(part, n);
    const out = Uint8Array.from(this.b.subarray(this.off, this.off + n));
    this.off += n;
    return out;
  }

  b32(part: string): Uint8Array {
    return this.fixed(part, 32);
  }

  /**
   * Reads a length-prefixed byte string of at most max bytes (max < 0: only the remaining length bounds it). The length is checked
   * against the bound and against what remains before anything is sliced.
   */
  lp(part: string, max: number): Uint8Array {
    const n = this.u32(`${part}.len`);
    if (max >= 0 && n > max) throw evidenceTooLarge(part, n, max);
    if (n > this.left()) throw malformed(part, EvidenceReason.LengthExceedsRemaining, this.left(), n);
    const out = Uint8Array.from(this.b.subarray(this.off, this.off + n));
    this.off += n;
    return out;
  }

  /** Reads an ASCII string with no NUL, at most maxStringBytes long. */
  str(part: string): string {
    const b = this.lp(part, this.lim.maxStringBytes);
    for (let i = 0; i < b.length; i++) {
      if (b[i] === 0 || b[i]! > 0x7f) throw malformedAt(part, i, EvidenceReason.StrNotASCIIOrNUL, b.length, b.length);
    }
    return String.fromCharCode(...b);
  }

  /**
   * Reads a LIST count and refuses one above limit (finality_evidence_too_large) or one that cannot fit in the remaining bytes at
   * minElem bytes per element (finality_evidence_malformed), so a hostile count never allocates.
   */
  count(part: string, limit: number, minElem: number): number {
    const n = this.u32(`${part}.count`);
    if (n > limit) throw evidenceTooLarge(part, n, limit);
    if (minElem > 0 && n * minElem > this.left()) throw malformed(part, EvidenceReason.CountExceedsRemaining, this.left(), n * minElem);
    return n;
  }

  /** Reads LIST<LP>: at most limit elements of at most maxElem bytes each. */
  lpList(part: string, limit: number, maxElem: number): Uint8Array[] {
    const n = this.count(part, limit, 4);
    const out: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      try {
        out.push(this.lp(part, maxElem));
      } catch (e) {
        throw withIndex(e, i);
      }
    }
    return out;
  }

  /**
   * Reads a NODES set: at most maxNodes nodes, strictly ascending by keccak256 and unique, each at most maxNodeBytes (maxNodeBytes
   * for state and storage tries, maxTxLeafBytes for transaction and receipt tries).
   */
  nodes(part: string, maxNodeBytes: number): Uint8Array[] {
    const nodes = this.lpList(part, this.lim.maxNodes, maxNodeBytes);
    let prev: Uint8Array = new Uint8Array(32);
    nodes.forEach((n, i) => {
      const h = keccak_256(n);
      if (i > 0 && cmpBytes(h, prev) <= 0) throw malformedAt(part, i, EvidenceReason.NodesNotAscendingUnique, 0, 0);
      prev = h;
    });
    return nodes;
  }

  /** Refuses a trailing byte. */
  end(part: string): void {
    if (this.left() !== 0) throw malformed(part, EvidenceReason.TrailingBytes, this.left(), 0);
  }

  /** The unread remainder (the body after a header), copied. */
  rest(): Uint8Array {
    return Uint8Array.from(this.b.subarray(this.off));
  }
}

/** A copy of a named state with element index i added when it carries none (codec.go withIndex). */
function withIndex(err: unknown, i: number): unknown {
  if (err instanceof FinalityStateError) {
    const out = new FinalityStateError(err.code, err.fields);
    if (!('index' in out.fields)) out.fields.index = BigInt(i);
    return out;
  }
  return err;
}

/** Sorts nodes ascending by keccak256 and drops duplicates: the canonical NODES order. */
export function encodeNodes(nodes: readonly Uint8Array[]): Uint8Array[] {
  const seen = new Set<string>();
  const list: { h: Uint8Array; n: Uint8Array }[] = [];
  for (const n of nodes) {
    const h = keccak_256(n);
    const k = hexLower(h);
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ h, n });
  }
  list.sort((a, b) => cmpBytes(a.h, b.h));
  return list.map((e) => e.n);
}

// ---- the container header (3.1) ----

/** Opens every evidence container. */
export const CONTAINER_MAGIC = 'CFE1';

/**
 * The header of every kind: "CFE1"(4) || STR kind || u64 chain || u8 level || u64 blockNumber || B32 blockHash. kind, chain and level
 * must equal the addendum's; (chain, blockNumber, blockHash) is the leg the evidence is about.
 */
export interface ContainerHeader {
  kind: string;
  chain: bigint;
  level: number;
  blockNumber: bigint;
  blockHash: Uint8Array;
}

/** A header and the kind's own body (the bytes after the header, parsed by the chain package with a Reader). */
export interface Container {
  header: ContainerHeader;
  body: Uint8Array;
}

/** The canonical encoding. A level that is not stored (1 included is derived, 0 none) is refused. */
export function encodeContainer(c: Container): Uint8Array {
  if (!isStoredLevel(c.header.level)) throw malformed('header.level', EvidenceReason.LevelNotStored, c.header.level, 2);
  const w = new Writer();
  w.fixed(new TextEncoder().encode(CONTAINER_MAGIC));
  w.str(c.header.kind);
  w.u64(c.header.chain);
  w.u8(c.header.level);
  w.u64(c.header.blockNumber);
  w.b32(c.header.blockHash);
  w.fixed(c.body);
  return w.bytes();
}

/**
 * Parses the header strictly and returns the body bytes. The container size is bounded first (max 64 MiB); the magic, the kind STR,
 * the level (2 or 3 only) and the header's fixed fields each have a named refusal.
 */
export function decodeContainer(b: Uint8Array, lim: Limits): Container {
  if (b.length > lim.maxEvidenceBytes) throw evidenceTooLarge('evidence', b.length, lim.maxEvidenceBytes);
  const r = new Reader(b, lim);
  const magic = r.fixed('header.magic', 4);
  if (String.fromCharCode(...magic) !== CONTAINER_MAGIC) throw evidenceUnrecognised('', `magic:${hexLower(magic)}`);
  const kind = r.str('header.kind');
  const chain = r.u64('header.chain');
  const level = r.u8('header.level');
  if (!isStoredLevel(level)) throw malformed('header.level', EvidenceReason.LevelNotStored, level, 2);
  const blockNumber = r.u64('header.blockNumber');
  const blockHash = r.b32('header.blockHash');
  return { header: { kind, chain, level, blockNumber, blockHash }, body: r.rest() };
}
