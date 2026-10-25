/**
 * The append-only addendum chain (V2_SPEC_S7 sections 2.1-2.6; the twin of pkg/finality/addendum.go): the leg binding D0, the
 * ownHash preimage, the chain checks, and the STRICT readers of the addendum and of the portable document's `finality` member.
 *
 * Go's encoding/json is lenient in ways JSON.parse is not (case-insensitive keys, a repeated key silently taking the last value, null
 * leaving a zero value, hex of either case), so a document is read in four fixed steps by BOTH verifiers:
 *
 *  1. the whole text is valid JSON (trailing data is invalid)                              -> not_json
 *  2. an object whose keys are EXACTLY the schema's keys (case-sensitive), none twice      -> unknown_key{key}, duplicate_key{key},
 *     in document order, decided on the decoded key (a key spelled with a unicode escape is the key it decodes to)
 *  3. every schema key is present                                                          -> missing_key{key}, in schema order
 *  4. members are decoded in SCHEMA order and the first failure is reported                -> bad_value, level_not_stored,
 *     unknown_level, not_lowercase_hex, not_32_bytes, wrong_format
 *
 * The state is always finality_addendum_malformed{field, reason[, key][, index]}. Hex is lower case only; an integer is a JSON integer
 * that fits uint64; null is never a value. The text is read by the same strict reader the S3 verifier uses for Go's encoding/json.
 */
import { sha256 } from '@noble/hashes/sha2';
import { JsonError } from '../../s3/gojson.js';
import { JNum, JObj, parseGoJson, type JVal } from '../../s3/jsonx.js';
import { isStoredLevel, levelName, parseLevel, type Level, LevelSet } from './level.js';
import { sameBytes, triple, type BlockRef } from './evidence.js';
import { decodeContainer, defaultLimits } from './codec.js';
import { readHeader } from './rlpheader.js';
import { isRow, chainSupported } from './table.js';
import {
  AddendumReason,
  Check,
  Code,
  addendumMalformed,
  blockMismatch,
  chainBroken,
  chainUnsupported,
  goQuote,
  hexLower,
  LevelField,
  asNamed,
  newState,
} from './state.js';

/** Domain of every addendum (PROOF_V2 section 10.3: new evidence gets a new tag, never a reused one). One preimage: ownHash. */
export const DOMAIN = 'certen:finality:v1';
/** Domain of the leg binding D0 (V2_SPEC_S7 section 2.6). */
export const LEG_DOMAIN = 'certen:finality:d0/v1';

export const MAX_U64 = (1n << 64n) - 1n;

/** An unsigned 64-bit integer: a bigint, or a number that is a safe non-negative integer. */
export type U64 = bigint | number;

export function u64(v: U64): bigint {
  const b = typeof v === 'bigint' ? v : Number.isSafeInteger(v) ? BigInt(v) : -1n;
  if (b < 0n || b > MAX_U64) throw new RangeError(`${String(v)} is not an unsigned 64-bit integer`);
  return b;
}

/**
 * One record of the append-only chain by which a leg is upgraded. It is evidence ABOUT a proof, stored and served beside it: the
 * proof's own bytes never change, and nothing here is an input of any attestation, outcome root or govRoot.
 *
 *   ownHash = sha256( lp(DOMAIN) || lp(D0) || lp(prevHash) || lp(be64(seq)) || lp(u8(level)) || lp(be64(chain)) ||
 *                     lp(kind) || lp(sha256(evidence)) )
 *
 * D0 is the leg binding, which a verifier recomputes from the Settlement it verified and never reads from the file. `proofId` is the
 * storage key (16 bytes) and is not hashed.
 */
export interface Addendum {
  proofId: Uint8Array;
  seq: bigint;
  level: Level;
  chain: bigint;
  kind: string;
  /** the CFE1 container */
  evidence: Uint8Array;
  prevHash: Uint8Array;
  ownHash: Uint8Array;
}

const utf8 = new TextEncoder();

function cat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** u32be(len) || bytes */
export function lp(f: Uint8Array): Uint8Array {
  const h = new Uint8Array(4);
  new DataView(h.buffer).setUint32(0, f.length, false);
  return cat([h, f]);
}

export function be64(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, false);
  return b;
}

const hex = (b: Uint8Array): string => hexLower(b);

/** lp("certen:finality:d0/v1") || lp(be64(chain)) || lp(be64(number)) || lp(blockHash): 85 bytes. */
export function legBindingPreimage(chain: U64, number: U64, blockHash: Uint8Array): Uint8Array {
  if (blockHash.length !== 32) throw new RangeError('a block hash is 32 bytes');
  return cat([utf8.encode(LEG_DOMAIN), be64(u64(chain)), be64(u64(number)), blockHash].map(lp));
}

/**
 * D0: SHA-256 of legBindingPreimage, a pure function of the three facts a verifier has already verified in S6 (V2_SPEC_S7 2.6). It
 * makes the chain a consistency check of the stored hashes against this leg's block; it is not authenticity and not completeness.
 */
export function legBinding(chain: U64, number: U64, blockHash: Uint8Array): Uint8Array {
  return sha256(legBindingPreimage(chain, number, blockHash));
}

/** legBinding of a BlockRef. */
export const legBindingOf = (b: BlockRef): Uint8Array => legBinding(b.chain, b.number, b.hash);

/** lp(DOMAIN) || lp(d0) || lp(prevHash) || lp(be64 seq) || lp(u8 level) || lp(be64 chain) || lp(kind) || lp(sha256(evidence)). */
export function ownHashPreimage(d0: Uint8Array, a: Addendum): Uint8Array {
  return cat(
    [utf8.encode(DOMAIN), d0, a.prevHash, be64(a.seq), Uint8Array.of(a.level), be64(a.chain), utf8.encode(a.kind), sha256(a.evidence)].map(lp),
  );
}

/** The addendum's chain hash under the leg binding d0 (V2_SPEC_S7 2.2). */
export const ownHash = (d0: Uint8Array, a: Addendum): Uint8Array => sha256(ownHashPreimage(d0, a));

/**
 * Builds the addendum that follows `existing` (the leg's chain so far, possibly empty) for the leg bound by d0. It refuses what
 * verifyChain would refuse: a level that is not stored, a (chain, level, kind) that is not a table row, a container whose header
 * disagrees with the addendum's kind, chain or level, and a level the chain already holds (level_already_present).
 */
export function newAddendum(
  d0: Uint8Array,
  proofId: Uint8Array,
  existing: readonly Addendum[],
  chain: bigint,
  level: Level,
  kind: string,
  evidence: Uint8Array,
): Addendum {
  const seq = BigInt(existing.length + 1);
  const a: Addendum = {
    proofId: Uint8Array.from(proofId),
    seq,
    level,
    chain,
    kind,
    evidence: Uint8Array.from(evidence),
    prevHash: new Uint8Array(32),
    ownHash: new Uint8Array(32),
  };
  if (!isRow(chain, level, kind)) throw chainBroken(seq, Check.Kind, { chain, level: levelFieldOf(level), kind });
  for (const e of existing) if (e.level === level) throw newState(Code.LevelAlreadyPresent, { chain, level: levelFieldOf(level) });
  const c = decodeContainer(evidence, defaultLimits());
  if (c.header.kind !== kind || c.header.chain !== chain || c.header.level !== level) {
    throw blockMismatch(
      'header',
      { kind, chain, level: levelFieldOf(level) },
      { kind: c.header.kind, chain: c.header.chain, level: levelFieldOf(c.header.level) },
    );
  }
  if (existing.length > 0) a.prevHash = Uint8Array.from(existing[existing.length - 1]!.ownHash);
  a.ownHash = ownHash(d0, a);
  return a;
}

const levelFieldOf = (l: number): LevelField => new LevelField(l);

/** The highest stored level in a chain (Level.None for an empty chain). It trusts nothing: callers verify first. */
export function top(chain: readonly Addendum[]): Level {
  let t: Level = 0;
  for (const a of chain) if (a.level > t) t = a.level;
  return t;
}

/** The set of levels a chain holds. */
export function levelsOf(chain: readonly Addendum[]): LevelSet {
  let s = LevelSet.empty;
  for (const a of chain) s = s.with(a.level);
  return s;
}

/**
 * Checks one leg's whole addendum chain against the leg binding d0 (V2_SPEC_S7 2.3). For i = 1..n, in this order: seq == i
 * (seq_gap); prevHash == (i == 1 ? 0x00*32 : ownHash_{i-1}) (prev_hash); the recomputed ownHash equals the stored one (own_hash);
 * the level equals no earlier level (level_duplicate; any order, R1); (chain, level, kind) is a table row (kind). The failure is
 * finality_chain_broken{seq, check}. d0 is the CALLER's legBinding of the verified Settlement: the addenda carry none, and a chain
 * built under another d0 fails own_hash at seq 1. An empty chain is valid. It does not judge the evidence itself.
 */
export function verifyChain(d0: Uint8Array, adds: readonly Addendum[]): void {
  let seen = LevelSet.empty;
  let prev: Uint8Array = new Uint8Array(32);
  for (let i = 0; i < adds.length; i++) {
    const a = adds[i]!;
    const want = BigInt(i + 1);
    if (a.seq !== want) throw chainBroken(a.seq, Check.SeqGap, { want });
    if (!sameBytes(a.prevHash, prev)) throw chainBroken(a.seq, Check.PrevHash);
    if (!sameBytes(ownHash(d0, a), a.ownHash)) throw chainBroken(a.seq, Check.OwnHash);
    if (seen.has(a.level)) throw chainBroken(a.seq, Check.LevelDuplicate, { level: levelFieldOf(a.level) });
    if (!isRow(a.chain, a.level, a.kind)) throw chainBroken(a.seq, Check.Kind, { chain: a.chain, level: levelFieldOf(a.level), kind: a.kind });
    seen = seen.with(a.level);
    prev = a.ownHash;
  }
}

/**
 * The chain-level judgement of one leg without judging any evidence: the leg's chain must be a row of the table
 * (finality_chain_unsupported), the carried leg must equal the verified Settlement block b FIRST (a difference is
 * finality_chain_broken{seq:0, check:"leg_binding", want:<b>, got:<carried>} and nothing else is judged), and then verifyChain
 * runs under D0 = legBinding of b. D0 is never read from the addenda.
 */
export function checkLegChain(b: BlockRef, carried: BlockRef, adds: readonly Addendum[]): void {
  if (!chainSupported(b.chain)) throw chainUnsupported(b.chain);
  if (carried.chain !== b.chain || carried.number !== b.number || !sameBytes(carried.hash, b.hash)) {
    throw chainBroken(0, Check.LegBinding, { want: triple(b), got: triple(carried) });
  }
  verifyChain(legBindingOf(b), adds);
}

// ---- proof ids ----

/**
 * Reads a uuid in its ONE canonical text form: 8-4-4-4-12 lower-case hex digits separated by dashes (36 characters). Anything else
 * (no dashes, upper case, braces, a urn prefix, a wrong dash position) is refused as
 * finality_addendum_malformed{field:"proofId", reason:"not_canonical_uuid"}, so a Go and a TypeScript verifier accept exactly the
 * same set of proof ids.
 */
export function parseProofId(s: string): Uint8Array {
  const bad = (): never => {
    throw addendumMalformed('proofId', AddendumReason.NotUUID);
  };
  if (s.length !== 36) bad();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (c !== 0x2d) bad();
    } else if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))) bad();
  }
  return hexToBytes(s.slice(0, 8) + s.slice(9, 13) + s.slice(14, 18) + s.slice(19, 23) + s.slice(24, 36));
}

/** The canonical lowercase uuid text (proof_artifacts.proof_id::text). */
export function proofIdString(id: Uint8Array): string {
  const h = hex(id);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// ---- JSON (the portable document's and the gateway's form, V2_SPEC_S7 2.5) ----

function parseDoc(raw: Uint8Array | string, field: string): JVal {
  try {
    return parseGoJson(raw);
  } catch (e) {
    if (e instanceof JsonError) throw addendumMalformed(field, AddendumReason.NotJSON);
    throw e;
  }
}

function strictObject(v: JVal, field: string, keys: readonly string[], optional: readonly string[] = []): Map<string, JVal> {
  if (!(v instanceof JObj)) throw addendumMalformed(field, AddendumReason.NotJSON);
  const allowed = new Set([...keys, ...optional]);
  const out = new Map<string, JVal>();
  for (const [k, val] of v.pairs) {
    if (!allowed.has(k)) throw addendumMalformed(field, AddendumReason.UnknownKey, { key: k });
    if (out.has(k)) throw addendumMalformed(field, AddendumReason.DuplicateKey, { key: k });
    out.set(k, val);
  }
  for (const k of keys) if (!out.has(k)) throw addendumMalformed(field, AddendumReason.MissingKey, { key: k });
  return out;
}

function strictString(v: JVal | undefined, field: string): string {
  if (typeof v !== 'string') throw addendumMalformed(field, AddendumReason.BadValue);
  return v;
}

/** A JSON integer literal that fits uint64 (strconv.ParseUint of the literal): no sign, fraction or exponent. */
function strictUint(v: JVal | undefined, field: string): bigint {
  if (!(v instanceof JNum) || !/^[0-9]+$/.test(v.lit)) throw addendumMalformed(field, AddendumReason.BadValue);
  const n = BigInt(v.lit);
  if (n > MAX_U64) throw addendumMalformed(field, AddendumReason.BadValue);
  return n;
}

/** Lower-case hex; want >= 0 also fixes the decoded length. */
function strictHex(s: string, field: string, want: number): Uint8Array {
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw addendumMalformed(field, AddendumReason.NotLowerHex);
  const b = hexToBytes(s);
  if (want >= 0 && b.length !== want) throw addendumMalformed(field, AddendumReason.Not32Bytes);
  return b;
}

const strictHex32 = (v: JVal | undefined, field: string): Uint8Array => strictHex(strictString(v, field), field, 32);

const addendumKeys = ['proofId', 'seq', 'level', 'chain', 'kind', 'evidence', 'prevHash', 'ownHash'] as const;

function addendumFromValue(v: JVal): Addendum {
  const m = strictObject(v, 'addendum', addendumKeys);
  const proofId = parseProofId(strictString(m.get('proofId'), 'proofId'));
  const seq = strictUint(m.get('seq'), 'seq');
  const levelStr = strictString(m.get('level'), 'level');
  const level = parseLevel(levelStr);
  if (level === undefined) throw addendumMalformed('level', AddendumReason.UnknownLevel);
  if (!isStoredLevel(level)) throw addendumMalformed('level', AddendumReason.LevelNotStored);
  const chain = strictUint(m.get('chain'), 'chain');
  const kind = strictString(m.get('kind'), 'kind');
  const evidence = strictHex(strictString(m.get('evidence'), 'evidence'), 'evidence', -1);
  const prevHash = strictHex32(m.get('prevHash'), 'prevHash');
  const hash = strictHex32(m.get('ownHash'), 'ownHash');
  return { proofId, seq, level, chain, kind, evidence, prevHash, ownHash: hash };
}

/**
 * Reads the addendum's JSON form strictly (rules above): a key that is not exactly one of the eight, a repeated or missing key, a
 * level that is not "l1_posted" or "finalized" ("included" is derived and never stored), hex that is not lower case, hashes that are
 * not 32 bytes and a proof id that is not a canonical lower-case uuid are each refused by name.
 */
export function parseAddendum(raw: Uint8Array | string): Addendum {
  return addendumFromValue(parseDoc(raw, 'addendum'));
}

/** The addendum as the portable document and the gateway write it: hex byte strings and the level by name. */
export function addendumToJSON(a: Addendum): string {
  return (
    `{"proofId":${goQuote(proofIdString(a.proofId))},"seq":${a.seq},"level":${goQuote(levelName(a.level))},"chain":${a.chain},` +
    `"kind":${goQuote(a.kind)},"evidence":"${hex(a.evidence)}","prevHash":"${hex(a.prevHash)}","ownHash":"${hex(a.ownHash)}"}`
  );
}

/** The format string of the portable document's `finality` member. */
export const SECTION_FORMAT = 'certen-finality-addenda/1';

/** Bounds the carried settlement header (a few hundred bytes today) before it is hashed (Go MaxLegHeaderBytes). */
export const MAX_LEG_HEADER_BYTES = 16 << 10;

/**
 * The `leg` member of the finality section: the block the addenda claim to be about. headerRlp is OPTIONAL (R12-OUTCOME-TX): the lower-case hex of
 * the settlement block's header RLP, bound by keccak256(header) == blockHash and by the block number read positionally from the header ==
 * blockNumber, so a holder of the section alone can recompute D0 and judge the addenda against that block. It proves the block, not the
 * settlement transaction.
 */
export interface CarriedLeg {
  chain: bigint;
  blockNumber: bigint;
  /** hex32, lower case */
  blockHash: string;
  /** hex, lower case, optional */
  headerRlp?: string;
}

/**
 * The carried leg as a BlockRef. blockHash is 32 bytes of lower-case hex. When the leg carries its header it is bound here: a hash or a number
 * that differs is finality_chain_broken{seq 0, check leg_binding, want, got} naming the differing member in both maps (the twin of Go
 * CarriedLeg.Ref), and the BlockRef then holds the header; a header that is not a readable block header is readHeader's named state.
 */
export function carriedLegRef(c: CarriedLeg): BlockRef {
  const ref: BlockRef = { chain: c.chain, number: c.blockNumber, hash: strictHex(c.blockHash, 'leg.blockHash', 32) };
  if (c.headerRlp === undefined) return ref;
  const hdr = strictHex(c.headerRlp, 'leg.headerRlp', -1);
  if (hdr.length === 0 || hdr.length > MAX_LEG_HEADER_BYTES) throw addendumMalformed('leg.headerRlp', AddendumReason.BadValue);
  const f = readHeader(hdr);
  if (!sameBytes(f.hash, ref.hash)) throw chainBroken(0, Check.LegBinding, { want: { blockHash: f.hash }, got: { blockHash: ref.hash } });
  if (f.number !== c.blockNumber) throw chainBroken(0, Check.LegBinding, { want: { blockNumber: f.number }, got: { blockNumber: c.blockNumber } });
  return { ...ref, headerRlp: hdr };
}

/** A BlockRef as the carried form, without its header (the member a composer without the header emits). */
export const carriedLegOf = (b: BlockRef): CarriedLeg => ({ chain: b.chain, blockNumber: b.number, blockHash: hex(b.hash) });

/** A BlockRef as the carried form WITH its header when it holds one. */
export const carriedLegWithHeaderOf = (b: BlockRef): CarriedLeg =>
  b.headerRlp !== undefined && b.headerRlp.length > 0 ? { ...carriedLegOf(b), headerRlp: hex(b.headerRlp) } : carriedLegOf(b);

/** The value of a portable document's `finality` member (V2_SPEC_S7 2.5). */
export interface Section {
  format: string;
  leg: CarriedLeg;
  addenda: Addendum[];
}

/** Builds the member for a leg's chain. */
export const newSection = (leg: BlockRef, chain: readonly Addendum[]): Section => ({
  format: SECTION_FORMAT,
  leg: carriedLegOf(leg),
  addenda: [...chain],
});

/** newSection with the leg carrying its header when leg holds one. */
export const newSectionWithHeader = (leg: BlockRef, chain: readonly Addendum[]): Section => ({
  format: SECTION_FORMAT,
  leg: carriedLegWithHeaderOf(leg),
  addenda: [...chain],
});

export function sectionToJSON(s: Section): string {
  const header = s.leg.headerRlp === undefined ? '' : `,"headerRlp":"${s.leg.headerRlp}"`;
  return (
    `{"format":${goQuote(s.format)},"leg":{"chain":${s.leg.chain},"blockNumber":${s.leg.blockNumber},"blockHash":"${s.leg.blockHash}"${header}},` +
    `"addenda":[${s.addenda.map(addendumToJSON).join(',')}]}`
  );
}

const sectionKeys = ['format', 'leg', 'addenda'] as const;
const legKeys = ['chain', 'blockNumber', 'blockHash'] as const;

/**
 * Reads the member strictly by the rules above: the format string must be SECTION_FORMAT (wrong_format), the leg has exactly chain,
 * blockNumber and blockHash, and every addendum is read as parseAddendum does (a refusal there carries the element's index). Members
 * are judged in schema order: format, leg, addenda.
 */
export function parseSection(raw: Uint8Array | string): Section {
  return parseSectionValue(parseDoc(raw, 'finality'));
}

/** parseSection over a value already read by the strict reader (the member of a document read as Go reads it: see docreport.ts). */
export function parseSectionValue(value: JVal): Section {
  const m = strictObject(value, 'finality', sectionKeys);
  const format = strictString(m.get('format'), 'format');
  if (format !== SECTION_FORMAT) throw addendumMalformed('format', AddendumReason.WrongFormat);
  const lm = strictObject(m.get('leg') as JVal, 'leg', legKeys, ['headerRlp']); // headerRlp is the one optional member
  const chain = strictUint(lm.get('chain'), 'leg.chain');
  const blockNumber = strictUint(lm.get('blockNumber'), 'leg.blockNumber');
  const hash = strictHex32(lm.get('blockHash'), 'leg.blockHash');
  let headerRlp: string | undefined;
  if (lm.has('headerRlp')) {
    headerRlp = strictString(lm.get('headerRlp'), 'leg.headerRlp');
    const hb = strictHex(headerRlp, 'leg.headerRlp', -1);
    if (hb.length === 0 || hb.length > MAX_LEG_HEADER_BYTES) throw addendumMalformed('leg.headerRlp', AddendumReason.BadValue);
  }
  const list = m.get('addenda');
  if (!Array.isArray(list)) throw addendumMalformed('addenda', AddendumReason.BadValue);
  const addenda: Addendum[] = [];
  list.forEach((el, i) => {
    try {
      addenda.push(addendumFromValue(el as JVal));
    } catch (e) {
      const st = asNamed(e);
      if (st) st.fields.index = BigInt(i);
      throw e;
    }
  });
  return { format, leg: { chain, blockNumber, blockHash: hex(hash), ...(headerRlp === undefined ? {} : { headerRlp }) }, addenda };
}
