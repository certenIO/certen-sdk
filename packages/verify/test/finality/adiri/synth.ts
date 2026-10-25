/**
 * Synthetic Adiri evidence for the unit and mutation tests: deterministic BLS keys, committee chains of any shape signed by any signer set,
 * raw execution headers, and an EIP-2935 account and storage proof. Everything here is built from the standard (BCS, BLAKE3, min-sig BLS,
 * RLP, the Merkle-Patricia trie) and the module's own encoders; the Go-written vectors are the independent oracle of the module.
 */
import { bls12_381 } from '@noble/curves/bls12-381';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';
import { buildTrie, rlpBytes, rlpListOf } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import type { BlockRef } from '../../../src/proof-v2/finality/evidence.js';
import type { Pins } from '../../../src/proof-v2/finality/pins.js';
import { JObj, parseGoJson } from '../../../src/s3/jsonx.js';
import {
  Codec,
  SignatureDST,
  buildContainer,
  encodeCFA1,
  encodeBody,
  recordDigests,
  signedMessage,
  type Body,
  type CFA1,
  type EpochRec,
} from '../../../src/proof-v2/finality/adiri/index.js';
import { embeddedAdiriPins } from './vectorset.js';

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s: string): Uint8Array => Uint8Array.from(s.replace(/^0x/, '').match(/../g) ?? [], (x) => parseInt(x, 16));
export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
export const filled = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

const ORDER = bls12_381.fields.Fr.ORDER;
const keyCache = new Map<number, { sk: bigint; pk: Uint8Array }>();
/** Deterministic key number i (0, 1, 2, ...). */
export function keyPair(i: number): { sk: bigint; pk: Uint8Array } {
  let k = keyCache.get(i);
  if (k === undefined) {
    const sk = (BigInt(`0x${hex(sha256(new TextEncoder().encode(`adiri-ts-test-key-${i}`)))}`) % (ORDER - 1n)) + 1n;
    k = { sk, pk: bls12_381.G2.Point.BASE.multiply(sk).toBytes(true) };
    keyCache.set(i, k);
  }
  return k;
}
export const pubKey = (i: number): Uint8Array => keyPair(i).pk;

/** The aggregate signature of `signers` (key numbers) over msg. */
export function aggregateSign(signers: readonly number[], msg: Uint8Array): Uint8Array {
  const sk = signers.reduce((a, i) => (a + keyPair(i).sk) % ORDER, 0n);
  if (sk === 0n) return Uint8Array.of(0xc0, ...new Uint8Array(47)); // the empty sum is the identity
  return bls12_381.shortSignatures.hash(msg, SignatureDST).multiply(sk).toBytes(true);
}

export interface RecSpec {
  /** key numbers of committee(i), in order */
  committee: number[];
  /** key numbers of next_committee(i) */
  next: number[];
  /** committee positions that sign (default: all) */
  signers?: number[];
  /** final_state number (hash is derived unless given) */
  fsNumber: bigint;
  fsHash?: Uint8Array;
  fcNumber?: bigint;
  fcHash?: Uint8Array;
  /** sign a different message (a wrong digest) */
  signWrong?: boolean;
}

const keysOf = (nums: readonly number[]): Uint8Array[] => nums.map(pubKey);

/** Builds the CFA1 for the specs (tables deduplicated by ordering), signing every record. `mutate` may alter the record list before signing. */
export function buildChain(specs: readonly RecSpec[]): { cfa1: CFA1; bytes: Uint8Array; digests: Uint8Array[] } {
  const tables: Uint8Array[][] = [];
  const tableOf = (nums: readonly number[]): number => {
    const s = nums.join(',');
    const idx = tableKeys.indexOf(s);
    if (idx >= 0) return idx;
    tableKeys.push(s);
    tables.push(keysOf(nums));
    return tables.length - 1;
  };
  const tableKeys: string[] = [];
  const records: EpochRec[] = specs.map((s, i) => ({
    committeeIdx: tableOf(s.committee),
    nextIdx: tableOf(s.next),
    finalState: { number: s.fsNumber, hash: s.fsHash ?? sha256(new TextEncoder().encode(`fs-${i}-${s.fsNumber}`)) },
    finalConsensus: { number: s.fcNumber ?? s.fsNumber, hash: s.fcHash ?? sha256(new TextEncoder().encode(`fc-${i}-${s.fsNumber}`)) },
    signature: new Uint8Array(48),
    signers: Uint8Array.from(s.signers ?? s.committee.map((_, j) => j)),
  }));
  const cfa1: CFA1 = { tables, records };
  const digests = recordDigests(cfa1);
  records.forEach((r, i) => {
    const s = specs[i]!;
    const msg = signedMessage(s.signWrong ? filled(32, 0xee) : digests[i]!);
    r.signature = aggregateSign(Array.from(r.signers, (p) => s.committee[p]!), msg);
  });
  return { cfa1, bytes: encodeCFA1(cfa1), digests };
}

// ---- raw execution headers ----

const intBytes = (n: bigint): Uint8Array => {
  const out: number[] = [];
  for (let v = n; v > 0n; v >>= 8n) out.unshift(Number(v & 0xffn));
  return Uint8Array.from(out);
};

export interface HeaderSpec {
  number: bigint;
  parentHash?: Uint8Array;
  stateRoot?: Uint8Array;
  /** item 19 (parentBeaconBlockRoot); omit for a header of 16 items */
  consensusRoot?: Uint8Array;
  salt?: number;
}

/** A raw header RLP of 20 items (or 16 when no consensusRoot is given), with the positional fields of rlpheader.ts. */
export function makeHeader(h: HeaderSpec): Uint8Array {
  const items: Uint8Array[] = [
    rlpBytes(h.parentHash ?? filled(32, 0x11)),
    rlpBytes(filled(32, 0x22)),
    rlpBytes(filled(20, 0x33)),
    rlpBytes(h.stateRoot ?? filled(32, 0x44)),
    rlpBytes(filled(32, 0x55)),
    rlpBytes(filled(32, 0x66)),
    rlpBytes(filled(256, 0)),
    rlpBytes(new Uint8Array(0)),
    rlpBytes(intBytes(h.number)),
    rlpBytes(intBytes(30_000_000n)),
    rlpBytes(intBytes(21_000n)),
    rlpBytes(intBytes(1_700_000_000n + (h.number % 1_000_000n))),
    rlpBytes(Uint8Array.of(h.salt ?? 0)),
    rlpBytes(filled(32, 0x77)),
    rlpBytes(filled(8, 0)),
    rlpBytes(intBytes(7n)),
  ];
  if (h.consensusRoot !== undefined) items.push(rlpBytes(filled(32, 0x88)), rlpBytes(intBytes(0n)), rlpBytes(intBytes(0n)), rlpBytes(h.consensusRoot));
  return rlpListOf(items);
}

export const hashOf = (raw: Uint8Array): Uint8Array => keccak_256(raw);

/** A descending spine of `length` headers ending at `top` (the seal), linked by parentHash. Index 0 is the seal. */
export function makeSpine(top: bigint, length: number, consensusRoot?: Uint8Array, stateRoot?: Uint8Array): Uint8Array[] {
  // build from the bottom (the oldest) so each header can name its parent's hash
  const out: Uint8Array[] = [];
  let parent = filled(32, 0x99);
  for (let n = top - BigInt(length - 1); n <= top; n++) {
    const raw = makeHeader({ number: n, parentHash: parent, consensusRoot, stateRoot });
    out.unshift(raw);
    parent = hashOf(raw);
  }
  return out;
}

export const blockOf = (raw: Uint8Array, withHeader = true): BlockRef => {
  // a header's number is read back by the module; the test passes it in explicitly through numberOf
  const ref: BlockRef = { chain: 2017n, number: numberOf(raw), hash: hashOf(raw) };
  if (withHeader) ref.headerRlp = raw;
  return ref;
};

/** Reads item 8 of a header built by makeHeader. */
export function numberOf(raw: Uint8Array): bigint {
  // locate item 8 by walking the list
  let off = raw[0]! >= 0xf8 ? 1 + (raw[0]! - 0xf7) : 1;
  for (let i = 0; i < 8; i++) off += itemLen(raw, off);
  const len = raw[off]! - 0x80;
  let n = 0n;
  if (raw[off]! < 0x80) return BigInt(raw[off]!);
  for (let j = 0; j < len; j++) n = (n << 8n) | BigInt(raw[off + 1 + j]!);
  return n;
}
function itemLen(b: Uint8Array, off: number): number {
  const t = b[off]!;
  if (t < 0x80) return 1;
  if (t <= 0xb7) return 1 + (t - 0x80);
  const ll = t - 0xb7;
  let n = 0;
  for (let i = 0; i < ll; i++) n = n * 256 + b[off + 1 + i]!;
  return 1 + ll + n;
}

// ---- the EIP-2935 history contract ----

export const EIP2935_ADDRESS = unhex('0000F90827F1C53a10cb7A02335B175320002935'.toLowerCase());
export const EIP2935_CODEHASH = unhex('6e49e66782037c0555897870e29fa5e552daf4719552131a0abce779daec0a5d');

const slotKey = (n: bigint): Uint8Array => {
  const s = new Uint8Array(32);
  let v = n % 8191n;
  for (let i = 31; i >= 0 && v > 0n; i--, v >>= 8n) s[i] = Number(v & 0xffn);
  return s;
};

/** The state root and the proof nodes of an EIP-2935 contract (code hash `codeHash`) whose slot N mod 8191 holds `value`. */
export function eip2935State(n: bigint, value: Uint8Array, codeHash: Uint8Array = EIP2935_CODEHASH): { stateRoot: Uint8Array; nodes: Uint8Array[] } {
  let trimmed = value;
  while (trimmed.length > 0 && trimmed[0] === 0) trimmed = trimmed.subarray(1);
  const st = buildTrie([{ key: keccak_256(slotKey(n)), value: rlpBytes(trimmed) }]);
  const account = rlpListOf([rlpBytes(new Uint8Array(0)), rlpBytes(new Uint8Array(0)), rlpBytes(st.root), rlpBytes(codeHash)]);
  // a second, unrelated account so the state trie has a branch
  const other = rlpListOf([rlpBytes(Uint8Array.of(1)), rlpBytes(Uint8Array.of(2)), rlpBytes(filled(32, 5)), rlpBytes(filled(32, 6))]);
  const state = buildTrie([
    { key: keccak_256(EIP2935_ADDRESS), value: account },
    { key: keccak_256(filled(20, 0xab)), value: other },
  ]);
  return { stateRoot: state.root, nodes: [...state.nodes, ...st.nodes] };
}

// ---- pins ----

export interface PinSpec {
  chainId?: number;
  codec?: string;
  genesisCommittee: number[];
  epoch0Number: bigint;
  epoch0Hash: Uint8Array;
  minCommittee?: number;
  maxHeaders?: number;
  address?: string;
  codeHash?: string;
}

/** The adiri pins section object (Go key names). */
export function pinsSection(s: PinSpec): Record<string, unknown> {
  return {
    chain_id: s.chainId ?? 2017,
    eip2935: { address: s.address ?? '0x0000F90827F1C53a10cb7A02335B175320002935', runtime_codehash: s.codeHash ?? `0x${hex(EIP2935_CODEHASH)}` },
    epoch0_final_state: { hash: `0x${hex(s.epoch0Hash)}`, number: Number(s.epoch0Number) },
    epoch_record_codec: s.codec ?? Codec,
    genesis_committee: s.genesisCommittee.map((i) => hex(pubKey(i))),
    genesis_hash: `0x${hex(filled(32, 0x01))}`,
    genesis_link_sha256: hex(filled(32, 0x02)),
    max_headers: s.maxHeaders ?? 64,
    min_committee_size: s.minCommittee ?? 4,
  };
}

/** A Pins holding the given adiri section object. */
export function pinsOfSection(section: unknown): Pins {
  const base = embeddedAdiriPins();
  const doc = parseGoJson(JSON.stringify(section));
  if (!(doc instanceof JObj)) throw new Error('section is not an object');
  return { ...base, sections: new Map([['adiri', doc]]), source: 'synth' };
}

/** A Pins holding an adiri section given as raw JSON text (key order and case preserved). */
export function pinsOfText(text: string): Pins {
  return { ...embeddedAdiriPins(), sections: new Map([['adiri', parseGoJson(text)]]), source: 'synth' };
}

export function container(leg: BlockRef, body: Body): Uint8Array {
  return buildContainer(leg, body);
}
export { encodeBody, defaultLimits };
