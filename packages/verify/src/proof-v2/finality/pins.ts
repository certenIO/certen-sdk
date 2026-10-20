/**
 * The pinned trust inputs of S7 (V2_SPEC_S7 section 4; the twin of pkg/finality/pins.go). The pins file is configuration, never
 * evidence: a pin proves nothing about any block by itself. It is UTF-8, LF, sorted keys, hashed as raw bytes; the embedded copy is
 * byte-identical to the validator's `pkg/finality/pins/finality-pins.json` and to certen-contracts' `evm/deployments/finality-pins.json`,
 * and a verifier refuses to start (`finality_pins_corrupt`) if its embedded bytes hash otherwise than PINS_SHA256.
 *
 * Go reads the file with encoding/json into typed structs after a structural walk. Both steps are reproduced rather than approximated:
 * the walk (keys sorted, none repeated, none outside the struct's exact names, in document order, over the whole document) comes
 * first, then the typed decode with Go's rules (null is a no-op, a wrongly typed value an error, an integer is a JSON integer literal
 * that fits its Go type), then the invariants of `validate`, each with its own reason.
 */
import { sha256 } from '@noble/hashes/sha2';
import { JsonError } from '../../s3/gojson.js';
import { JNum, JObj, parseGoJson, type JVal } from '../../s3/jsonx.js';
import { EMBEDDED_PINS_TEXT } from './pins-embedded.js';
import { ChainSepolia } from './table.js';
import { MAX_U64 } from './addendum.js';
import { Code, PinsReason, cmpUtf8, hexLower, newState, pinsCorrupt } from './state.js';

/** The format string of the pins file (V2_SPEC_S7 section 4.1). */
export const PINS_FORMAT = 'certen-finality-pins/1';

/**
 * The SHA-256 of the embedded pins file. A verifier refuses to start (finality_pins_corrupt) if the embedded bytes hash otherwise; the
 * CI job finality-pins-sync compares this constant and the file across the three repositories.
 */
export const PINS_SHA256 = '507d72b3499fd094f3e14e0ed585edba90c7a7a4c6235c7ccd98d04db7329cca';

/** The report's pins_source for the embedded file. */
export const PINS_SOURCE_EMBEDDED = 'embedded';

/** The smallest valid wsp_epochs of a ledger anchor (V2_SPEC_S7 5.2 step 3, r2:F10). */
export const MIN_WSP_EPOCHS = 256n;

/** A row of the Sepolia fork table; layout is null for the forks no evidence object can belong to. */
export interface ForkPin {
  name: string;
  epoch: bigint;
  version: string;
  layout: string | null;
}

/** An entry of the Sepolia ledger (4.3): a configured weak-subjectivity pin, not evidence about any block. */
export interface AnchorPin {
  period: bigint;
  committeeRoot: string;
  blockRoot: string;
  wspEpochs: bigint;
  linkSha256: string;
  derivedBy: string[];
}

/** The Sepolia network section of 4.2. */
export interface EthSepoliaPins {
  chainId: bigint;
  genesisValidatorsRoot: string;
  genesisTime: bigint;
  /**
   * The LEGACY location of the KZG setup pin (pins files published with finality_arb_posted1). Read it through kzgSetupPin, never directly;
   * '' when the file does not carry it.
   */
  kzgSetupSha256: string;
  forks: ForkPin[];
  spec: string;
  syncCommitteeSize: bigint;
  minParticipants: bigint;
  epochsPerPeriod: bigint;
  maxLinks: bigint;
  maxSpineHeaders: bigint;
  anchors: AnchorPin[];
}

/**
 * The top-level `shared` section: values more than one chain kind reads, held once so the kinds cannot diverge (the twin of pins.go
 * SharedPins). Unknown keys inside it are refused like everywhere else.
 */
export interface SharedPins {
  /** SHA-256 (64 lower-case hex, no prefix) of the EIP-4844 trusted setup file the blob kinds load */
  kzgSetupSha256: string;
}

/** The pins key a missing, malformed or conflicting KZG setup pin is reported under. */
export const KZG_SETUP_SHARED_KEY = 'shared.kzg_setup_sha256';

/** The optional on-chain commitment of the file hash (D3). */
export interface OnchainCommitment {
  chain: bigint;
  tx: string;
  block: bigint;
}

/**
 * The parsed trust inputs of S7. The other chains' sections (base_sepolia, arb_sepolia, adiri) are accepted when present and kept raw
 * for their own packages; the loader accepts an absent section and refuses an unknown top-level key.
 */
export interface Pins {
  format: string;
  publishedUtc: string;
  onchainCommitment: OnchainCommitment | null;
  ethSepolia: EthSepoliaPins | null;
  sections: Map<string, JVal>;
  /** the `shared` section (pins more than one chain kind reads), or null when the file has none */
  shared: SharedPins | null;
  /** the SHA-256 of the raw bytes this Pins was loaded from */
  sha256: Uint8Array;
  source: string;
}

/** (pins_sha256 hex, pins_source) for a report. A null Pins is ("", "none"). */
export function pinsIdentity(p: Pins | null | undefined): [string, string] {
  if (p === null || p === undefined) return ['', 'none'];
  return [hexLower(p.sha256), p.source];
}

// ---- the schema (the Go struct types of pins.go) ----

type Sch =
  | 'str'
  | 'strptr'
  | 'u64'
  | 'int'
  | 'raw'
  | { struct: Record<string, Sch> }
  | { list: Sch }
  | { ptr: Sch };

const forkSch: Sch = { struct: { name: 'str', epoch: 'u64', version: 'str', layout: 'strptr' } };
const anchorSch: Sch = {
  struct: { period: 'u64', committee_root: 'str', block_root: 'str', wsp_epochs: 'u64', link_sha256: 'str', derived_by: { list: 'str' } },
};
const sepoliaSch: Sch = {
  struct: {
    chain_id: 'u64',
    genesis_validators_root: 'str',
    genesis_time: 'u64',
    kzg_setup_sha256: 'str',
    forks: { list: forkSch },
    spec: 'str',
    sync_committee_size: 'int',
    min_participants: 'int',
    epochs_per_period: 'u64',
    max_links: 'int',
    max_spine_headers: 'int',
    anchors: { list: anchorSch },
  },
};
const fileSch: Sch = {
  struct: {
    format: 'str',
    published_utc: 'str',
    onchain_commitment: { ptr: { struct: { chain: 'u64', tx: 'str', block: 'u64' } } },
    eth_sepolia: { ptr: sepoliaSch },
    base_sepolia: 'raw',
    arb_sepolia: 'raw',
    adiri: 'raw',
    shared: { ptr: { struct: { kzg_setup_sha256: 'str' } } },
  },
};

// ---- step 1: the structural walk (walkKeys) ----

interface Violation {
  reason: string;
  key?: string;
}

/**
 * The FIRST structural violation in document order: inside every object a key smaller than its predecessor is keys_unsorted{key}, a key
 * equal to it duplicate_key{key} (sorted keys make a duplicate adjacent), and, where t is a struct, a key that is not EXACTLY
 * (case-sensitively) one of its names is unknown_key{key}. Where t is not a struct (or the section is raw), only the order and duplicate
 * rules apply.
 */
function walkKeys(v: JVal, t: Sch | undefined): Violation | undefined {
  while (t !== undefined && typeof t === 'object' && 'ptr' in t) t = t.ptr;
  if (v instanceof JObj) {
    let prev: string | undefined;
    for (const [k, val] of v.pairs) {
      if (prev !== undefined) {
        const c = cmpUtf8(k, prev);
        if (c < 0) return { reason: PinsReason.KeysUnsorted, key: k };
        if (c === 0) return { reason: PinsReason.DuplicateKey, key: k };
      }
      prev = k;
      let ft: Sch | undefined;
      if (t !== undefined && typeof t === 'object' && 'struct' in t) {
        if (!Object.prototype.hasOwnProperty.call(t.struct, k)) return { reason: PinsReason.UnknownKey, key: k };
        ft = t.struct[k];
      }
      const r = walkKeys(val, ft);
      if (r) return r;
    }
  } else if (Array.isArray(v)) {
    const et = t !== undefined && typeof t === 'object' && 'list' in t ? t.list : undefined;
    for (const el of v) {
      const r = walkKeys(el, et);
      if (r) return r;
    }
  }
  return undefined;
}

// ---- step 2: the typed decode (json.Decoder with DisallowUnknownFields into the structs) ----

class BadValue extends Error {}

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function zero(t: Sch): unknown {
  if (t === 'str') return '';
  if (t === 'u64' || t === 'int') return 0n;
  if (t === 'strptr' || t === 'raw') return null;
  if ('struct' in t) {
    const o: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(t.struct)) o[k] = zero(s);
    return o;
  }
  return null; // list, ptr
}

/** Go's json.Unmarshal into t: null is a no-op (the zero value), anything of the wrong type an error. */
function decode(v: JVal, t: Sch): unknown {
  if (t === 'raw') return v;
  if (v === null) return zero(t);
  if (t === 'str' || t === 'strptr') {
    if (typeof v !== 'string') throw new BadValue();
    return v;
  }
  if (t === 'u64') {
    if (!(v instanceof JNum) || !/^[0-9]+$/.test(v.lit)) throw new BadValue();
    const n = BigInt(v.lit);
    if (n > MAX_U64) throw new BadValue();
    return n;
  }
  if (t === 'int') {
    if (!(v instanceof JNum) || !/^-?[0-9]+$/.test(v.lit)) throw new BadValue();
    const n = BigInt(v.lit);
    if (n < INT64_MIN || n > INT64_MAX) throw new BadValue();
    return n;
  }
  if ('ptr' in t) return decode(v, t.ptr);
  if ('list' in t) {
    if (!Array.isArray(v)) throw new BadValue();
    return v.map((e) => decode(e, t.list));
  }
  if (!(v instanceof JObj)) throw new BadValue();
  const out = zero(t) as Record<string, unknown>;
  for (const [k, val] of v.pairs) {
    if (!Object.prototype.hasOwnProperty.call(t.struct, k)) throw new BadValue();
    out[k] = decode(val, t.struct[k]!);
  }
  return out;
}

// ---- step 3: the invariants (EthSepoliaPins.validate) ----

/** hexN: lower-case hex of exactly n bytes, with the 0x prefix when `prefixed`. */
function hexN(s: string, n: number, prefixed: boolean): boolean {
  if (prefixed) {
    if (!s.startsWith('0x')) return false;
    s = s.slice(2);
  }
  return s.length === 2 * n && /^[0-9a-f]*$/.test(s);
}

const idx = (i: number): { index: bigint } => ({ index: BigInt(i) });

function validateSepolia(e: Record<string, unknown>): EthSepoliaPins {
  const chainId = e.chain_id as bigint;
  if (chainId !== ChainSepolia) throw pinsCorrupt(PinsReason.ChainIDMismatch);
  const gvr = e.genesis_validators_root as string;
  if (!hexN(gvr, 32, true)) throw pinsCorrupt(PinsReason.GenesisRootMalformed);
  const kzgLegacy = e.kzg_setup_sha256 as string;
  if (kzgLegacy !== '' && !hexN(kzgLegacy, 32, false)) throw pinsCorrupt(PinsReason.BadValue, { key: 'kzg_setup_sha256' });
  const size = e.sync_committee_size as bigint;
  const minP = e.min_participants as bigint;
  const epp = e.epochs_per_period as bigint;
  const maxLinks = e.max_links as bigint;
  const maxSpine = e.max_spine_headers as bigint;
  for (const [key, ok] of [
    ['sync_committee_size', size > 0n],
    ['min_participants', minP > 0n],
    ['epochs_per_period', epp > 0n],
    ['max_links', maxLinks > 0n],
    ['max_spine_headers', maxSpine > 0n],
  ] as const) {
    if (!ok) throw pinsCorrupt(PinsReason.BoundMissing, { key });
  }
  // Go's int arithmetic wraps at 64 bits
  if (BigInt.asIntN(64, minP * 3n) < BigInt.asIntN(64, size * 2n) || minP > size) throw pinsCorrupt(PinsReason.ParticipationFloor);
  const rawForks = e.forks as Record<string, unknown>[] | null;
  if (rawForks === null || rawForks.length === 0) throw pinsCorrupt(PinsReason.ForksEmpty);
  if (rawForks[0]!.epoch !== 0n) throw pinsCorrupt(PinsReason.FirstForkNotEpochZero);
  const forks: ForkPin[] = [];
  rawForks.forEach((f, i) => {
    if (f.name === '' || !hexN(f.version as string, 4, true)) throw pinsCorrupt(PinsReason.ForkMalformed, idx(i));
    if (i > 0 && (f.epoch as bigint) <= (rawForks[i - 1]!.epoch as bigint)) throw pinsCorrupt(PinsReason.ForkEpochNotAscending, idx(i));
    const layout = f.layout as string | null;
    if (layout !== null && layout !== 'electra' && layout !== 'gloas') throw pinsCorrupt(PinsReason.ForkLayoutUnknown, idx(i));
    forks.push({ name: f.name as string, epoch: f.epoch as bigint, version: f.version as string, layout });
  });
  const rawAnchors = (e.anchors as Record<string, unknown>[] | null) ?? [];
  const anchors: AnchorPin[] = [];
  rawAnchors.forEach((a, i) => {
    const blockRoot = a.block_root as string;
    if (!hexN(a.committee_root as string, 32, true) || (blockRoot !== '' && !hexN(blockRoot, 32, true)) || !hexN(a.link_sha256 as string, 32, false)) {
      throw pinsCorrupt(PinsReason.AnchorMalformed, idx(i));
    }
    const period = a.period as bigint;
    if (i > 0 && period === (rawAnchors[i - 1]!.period as bigint)) throw pinsCorrupt(PinsReason.AnchorPeriodDuplicate, idx(i));
    if (i > 0 && period < (rawAnchors[i - 1]!.period as bigint)) throw pinsCorrupt(PinsReason.AnchorPeriodNotAscending, idx(i));
    if ((a.wsp_epochs as bigint) < MIN_WSP_EPOCHS) throw pinsCorrupt(PinsReason.AnchorWspBelow256, idx(i));
    const derivedBy = (a.derived_by as string[] | null) ?? [];
    if (derivedBy.length === 0) throw pinsCorrupt(PinsReason.AnchorDerivedByEmpty, idx(i));
    anchors.push({
      period,
      committeeRoot: a.committee_root as string,
      blockRoot,
      wspEpochs: a.wsp_epochs as bigint,
      linkSha256: a.link_sha256 as string,
      derivedBy,
    });
  });
  return {
    chainId,
    genesisValidatorsRoot: gvr,
    genesisTime: e.genesis_time as bigint,
    kzgSetupSha256: kzgLegacy,
    forks,
    spec: e.spec as string,
    syncCommitteeSize: size,
    minParticipants: minP,
    epochsPerPeriod: epp,
    maxLinks,
    maxSpineHeaders: maxSpine,
    anchors,
  };
}

function parsePins(raw: Uint8Array, sum: Uint8Array, source: string): Pins {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw pinsCorrupt(PinsReason.NotUTF8);
  }
  if (raw.includes(0x0d)) throw pinsCorrupt(PinsReason.ContainsCR);
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) throw pinsCorrupt(PinsReason.ByteOrderMark);
  let doc: JVal;
  try {
    doc = parseGoJson(raw);
  } catch (e) {
    if (e instanceof JsonError) throw pinsCorrupt(PinsReason.NotJSON);
    throw e;
  }
  const bad = walkKeys(doc, fileSch);
  if (bad) throw pinsCorrupt(bad.reason, bad.key !== undefined ? { key: bad.key } : {});
  let f: Record<string, unknown>;
  try {
    f = decode(doc, fileSch) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof BadValue) throw pinsCorrupt(PinsReason.BadValue);
    throw e;
  }
  if (f.format !== PINS_FORMAT) throw pinsCorrupt(PinsReason.WrongFormat);
  if (f.published_utc === '') throw pinsCorrupt(PinsReason.PublishedUTCEmpty);
  const sections = new Map<string, JVal>();
  for (const name of ['base_sepolia', 'arb_sepolia', 'adiri']) {
    const r = f[name] as JVal;
    if (r !== null && r !== undefined) sections.set(name, r);
  }
  const oc = f.onchain_commitment as Record<string, unknown> | null;
  const eth = f.eth_sepolia as Record<string, unknown> | null;
  const ethSepolia = eth === null ? null : validateSepolia(eth);
  const sh = f.shared as Record<string, unknown> | null;
  if (sh !== null && !hexN(sh.kzg_setup_sha256 as string, 32, false)) throw pinsCorrupt(PinsReason.BadValue, { key: KZG_SETUP_SHARED_KEY });
  return {
    format: f.format as string,
    publishedUtc: f.published_utc as string,
    onchainCommitment: oc === null ? null : { chain: oc.chain as bigint, tx: oc.tx as string, block: oc.block as bigint },
    ethSepolia,
    sections,
    shared: sh === null ? null : { kzgSetupSha256: sh.kzg_setup_sha256 as string },
    sha256: sum,
    source,
  };
}

/**
 * Hash-checks raw against `want` and parses it. A mismatch, or a file that does not parse, is finality_pins_corrupt: a verifier given
 * such a file refuses to start.
 */
export function loadPins(raw: Uint8Array, want: Uint8Array): Pins {
  const got = sha256(raw);
  if (got.length !== want.length || !got.every((x, i) => x === want[i])) {
    throw pinsCorrupt(PinsReason.SHA256Mismatch, { want_sha256: want, got_sha256: got });
  }
  return parsePins(raw, got, PINS_SOURCE_EMBEDDED);
}

/** Parses a pins file handed to the verifier (`--pins`) with no expected hash; the report states pins_source = override:<sha256>. */
export function parsePinsOverride(raw: Uint8Array): Pins {
  const sum = sha256(raw);
  return parsePins(raw, sum, `override:${hexLower(sum)}`);
}

/** The embedded pins file's bytes (a copy). */
export const embeddedPinsBytes = (): Uint8Array => new TextEncoder().encode(EMBEDDED_PINS_TEXT);

/** Loads the embedded pins file against the PINS_SHA256 constant. */
export function embeddedPins(): Pins {
  if (!/^[0-9a-f]{64}$/.test(PINS_SHA256)) throw pinsCorrupt(PinsReason.SHA256ConstantMalformed);
  const want = Uint8Array.from(PINS_SHA256.match(/../g)!, (h) => parseInt(h, 16));
  return loadPins(embeddedPinsBytes(), want);
}

/** The Sepolia network section, or finality_pin_unknown when the file has none. */
export function sepoliaPins(p: Pins | null | undefined): EthSepoliaPins {
  if (p === null || p === undefined || p.ethSepolia === null) throw newState(Code.PinUnknown, { chain: ChainSepolia, kind: 'eth_sepolia' });
  return p.ethSepolia;
}

/**
 * The pinned SHA-256 of the KZG ceremony setup and the pins key it was read from (the twin of Pins.KZGSetupPin).
 *
 * The pin lives in the `shared` section (the embedded file carries it nowhere else). Pins files published before that section existed
 * carry a copy in the chain section of the kind that used it (finality_base_posted1: base_sepolia.kzg_setup_sha256; finality_arb_posted1:
 * eth_sepolia.kzg_setup_sha256) and a published vector set is never edited, so legacyKey/legacyValue name that copy. It is read when the
 * file has no `shared` section; when the file has both and they differ the file is finality_pins_corrupt (never "the shared one wins");
 * when it has neither the pin is missing: finality_pins_corrupt{bad_value} under KZG_SETUP_SHARED_KEY.
 */
export function kzgSetupPin(p: Pins | null | undefined, legacyKey: string, legacyValue: string): { value: string; key: string } {
  if (p === null || p === undefined) throw newState(Code.PinUnknown, { kind: 'kzg_setup_sha256' });
  if (p.shared !== null) {
    if (legacyValue !== '' && legacyValue !== p.shared.kzgSetupSha256) throw pinsCorrupt(PinsReason.BadValue, { key: legacyKey });
    return { value: p.shared.kzgSetupSha256, key: KZG_SETUP_SHARED_KEY };
  }
  if (legacyValue !== '') return { value: legacyValue, key: legacyKey };
  throw pinsCorrupt(PinsReason.BadValue, { key: KZG_SETUP_SHARED_KEY });
}

/**
 * The ledger entry chosen for a proof: the latest entry with period <= sigPeriod. An empty ledger, or no entry at or below sigPeriod, is
 * finality_pin_unknown{period} (correct until the ledger is filled by RB11-C).
 */
export function anchorFor(e: EthSepoliaPins, sigPeriod: bigint): AnchorPin {
  let best: AnchorPin | undefined;
  for (const a of e.anchors) if (a.period <= sigPeriod) best = a;
  if (best === undefined) throw newState(Code.PinUnknown, { chain: ChainSepolia, kind: 'eth_sepolia', period: sigPeriod });
  return best;
}
