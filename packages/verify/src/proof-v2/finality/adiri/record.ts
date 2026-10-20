/**
 * The epoch record of Telcoin Network as the verifier reconstructs it (V2_SPEC_S7 5.8 O2; the twin of pkg/finality/adiri record.go):
 * the BCS of an EpochRecord digested with BLAKE3-256, the message the committee signs, and the Adiri pins of 4.2.
 */
import { blake3 } from '@noble/hashes/blake3';
import { foldEqual } from '../../../s3/fold.js';
import { JNum, JObj, type JVal } from '../../../s3/jsonx.js';
import type { Pins } from '../pins.js';
import { Code, PinsReason, newState, pinsCorrupt, type FinalityStateError } from '../state.js';
import { ChainAdiri } from '../table.js';
import { KeyBytes, type CFA1, type EpochRec } from './cfa1.js';
import type { NumHash } from './states.js';

/** The one record encoding this verifier implements; a pin that names another is epoch_record_codec_unsupported. */
export const Codec = 'telcoin-epoch-record/bcs-blake3/1';
/** The evidence kind of this package. */
export const Name = 'adiri/finalized/v1';

/** The unsigned LEB128 of n (BCS length prefix). */
export function uleb(n: number): Uint8Array {
  const out: number[] = [];
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(b);
      return Uint8Array.from(out);
    }
    out.push(b | 0x80);
  }
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const u32le = (v: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
};
const u64le = (v: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, v), true);
  return b;
};
const TAG32 = Uint8Array.of(0x20);
const TAG96 = Uint8Array.of(0x60);

/**
 * The BCS of record `epoch`: u32le(epoch) || uleb(n) || (0x60||key)^n || uleb(n') || (0x60||key')^n' || 0x20||parent_digest ||
 * u64le(fs.number) || 0x20||fs.hash || u64le(fc.number) || 0x20||fc.hash.
 */
export function bcsRecord(epoch: number, committee: readonly Uint8Array[], next: readonly Uint8Array[], parent: Uint8Array, fs: NumHash, fc: NumHash): Uint8Array {
  const parts: Uint8Array[] = [u32le(epoch), uleb(committee.length)];
  for (const k of committee) parts.push(TAG96, k);
  parts.push(uleb(next.length));
  for (const k of next) parts.push(TAG96, k);
  parts.push(TAG32, parent, u64le(fs.number), TAG32, fs.hash, u64le(fc.number), TAG32, fc.hash);
  return concat(parts);
}

/** BLAKE3-256 of the BCS record. */
export const digestOf = (bcs: Uint8Array): Uint8Array => blake3(bcs, { dkLen: 32 });

/** The message the committee signs: 01 00 01 20 || digest (scope EpochBoundary, version V0, app id Consensus, BCS of a 32-byte digest). */
export function signedMessage(digest: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(0x01, 0x00, 0x01, 0x20), digest]);
}

/** digest(i) for every record of the chain (parent_digest(0) = 0^32). */
export function recordDigests(c: CFA1): Uint8Array[] {
  const out: Uint8Array[] = [];
  let parent: Uint8Array = new Uint8Array(32);
  c.records.forEach((r: EpochRec, i: number) => {
    const d = digestOf(bcsRecord(i, c.tables[r.committeeIdx]!, c.tables[r.nextIdx]!, parent, r.finalState, r.finalConsensus));
    out.push(d);
    parent = d;
  });
  return out;
}

/** The Adiri pins of V2_SPEC_S7 4.2. */
export interface Params {
  chainId: bigint;
  codec: string;
  genesisHash: Uint8Array;
  genesisCommittee: Uint8Array[];
  epoch0FinalState: NumHash;
  genesisLinkSha: string;
  minCommittee: bigint;
  maxHeaders: bigint;
  eip2935Address: Uint8Array;
  eip2935CodeHash: Uint8Array;
}

// ---- the section's strict decode (Go json.Decoder with DisallowUnknownFields into pinsJSON) ----

type FieldKind = 'string' | 'u64' | 'int' | 'strings' | { obj: readonly FieldDef[] };
interface FieldDef {
  json: string;
  kind: FieldKind;
}

const SECTION: readonly FieldDef[] = [
  { json: 'chain_id', kind: 'u64' },
  {
    json: 'eip2935',
    kind: {
      obj: [
        { json: 'address', kind: 'string' },
        { json: 'runtime_codehash', kind: 'string' },
      ],
    },
  },
  {
    json: 'epoch0_final_state',
    kind: {
      obj: [
        { json: 'hash', kind: 'string' },
        { json: 'number', kind: 'u64' },
      ],
    },
  },
  { json: 'epoch_record_codec', kind: 'string' },
  { json: 'genesis_committee', kind: 'strings' },
  { json: 'genesis_hash', kind: 'string' },
  { json: 'genesis_link_sha256', kind: 'string' },
  { json: 'max_headers', kind: 'int' },
  { json: 'min_committee_size', kind: 'int' },
];

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

type Decoded = { [k: string]: string | bigint | string[] | Decoded };

/** The first error of a Go decode (decodeState.saveError keeps the first): an unknown field or a value of the wrong type, in document order. */
class FirstError {
  err: FinalityStateError | undefined;
  save(e: FinalityStateError): void {
    if (this.err === undefined) this.err = e;
  }
}

function decodeStruct(v: JVal, def: readonly FieldDef[], path: string, into: Decoded, fe: FirstError): void {
  if (v === null) return; // null is a no-op for a struct
  if (!(v instanceof JObj)) {
    fe.save(pinsCorrupt(PinsReason.BadValue, { key: `adiri.${path}` }));
    return;
  }
  for (const [k, e] of v.pairs) {
    const f = def.find((x) => x.json === k) ?? def.find((x) => foldEqual(x.json, k));
    if (f === undefined) {
      fe.save(pinsCorrupt(PinsReason.UnknownKey, { key: `adiri.${k}` }));
      continue;
    }
    const p = path === '' ? f.json : `${path}.${f.json}`;
    const bad = (): void => fe.save(pinsCorrupt(PinsReason.BadValue, { key: `adiri.${p}` }));
    const kind = f.kind;
    if (typeof kind === 'object') {
      const sub: Decoded = (into[f.json] as Decoded | undefined) ?? {};
      into[f.json] = sub;
      decodeStruct(e, kind.obj, p, sub, fe);
    } else if (e === null) {
      // null leaves the field as it is (a slice is set to nil)
      if (kind === 'strings') delete into[f.json];
    } else if (kind === 'string') {
      if (typeof e !== 'string') bad();
      else into[f.json] = e;
    } else if (kind === 'u64') {
      if (!(e instanceof JNum) || !/^[0-9]+$/.test(e.lit) || BigInt(e.lit) > U64_MAX) bad();
      else into[f.json] = BigInt(e.lit);
    } else if (kind === 'int') {
      if (!(e instanceof JNum) || !/^-?[0-9]+$/.test(e.lit) || BigInt(e.lit) > I64_MAX || BigInt(e.lit) < -I64_MAX - 1n) bad();
      else into[f.json] = BigInt(e.lit);
    } else {
      // []string
      if (!Array.isArray(e)) bad();
      else {
        const out: string[] = [];
        for (const x of e) {
          if (x === null) out.push('');
          else if (typeof x !== 'string') {
            bad();
            out.push('');
          } else out.push(x);
        }
        into[f.json] = out;
      }
    }
  }
}

const nibble = (c: number): number => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1);

/**
 * Go's hex.DecodeString, strictly: an odd number of digits or a character that is not a hex digit is an error (undefined), never padded
 * with a zero and never truncated. Upper case is accepted.
 */
export function decodeHex(s: string): Uint8Array | undefined {
  if (s.length % 2 !== 0) return undefined;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    const hi = nibble(s.charCodeAt(i));
    const lo = nibble(s.charCodeAt(i + 1));
    if (hi < 0 || lo < 0) return undefined;
    out[i / 2] = (hi << 4) | lo;
  }
  return out;
}

/** decode0x: the prefix must be a lower-case 0x, then exact hex. */
function decode0x(s: string): Uint8Array | undefined {
  if (s.length < 2 || s.slice(0, 2) !== '0x') return undefined;
  return decodeHex(s.slice(2));
}

function hex32(s: string): Uint8Array | undefined {
  const b = decode0x(s);
  return b !== undefined && b.length === 32 ? b : undefined;
}

const str = (d: Decoded, k: string): string => (d[k] as string | undefined) ?? '';
const big = (d: Decoded, k: string): bigint => (d[k] as bigint | undefined) ?? 0n;

/**
 * Reads the adiri section of the pins file. A missing section is finality_pin_unknown; a malformed one is finality_pins_corrupt
 * (unknown_key and bad_value name the key; the first error of the decode in document order is the one reported).
 */
export function parsePins(p: Pins | null | undefined): Params {
  const sec = p?.sections.get('adiri');
  if (sec === undefined) throw newState(Code.PinUnknown, { chain: ChainAdiri, kind: 'adiri' });
  const j: Decoded = {};
  const fe = new FirstError();
  decodeStruct(sec, SECTION, '', j, fe);
  if (fe.err !== undefined) throw fe.err;
  const bad = (key: string, extra: { index?: bigint } = {}): FinalityStateError => pinsCorrupt(PinsReason.BadValue, { key, ...extra });
  const eip = (j.eip2935 as Decoded | undefined) ?? {};
  const e0 = (j.epoch0_final_state as Decoded | undefined) ?? {};
  const genesisHash = hex32(str(j, 'genesis_hash'));
  if (genesisHash === undefined) throw bad('adiri.genesis_hash');
  const e0Hash = hex32(str(e0, 'hash'));
  if (e0Hash === undefined) throw bad('adiri.epoch0_final_state.hash');
  const codeHash = hex32(str(eip, 'runtime_codehash'));
  if (codeHash === undefined) throw bad('adiri.eip2935.runtime_codehash');
  const addr = decode0x(str(eip, 'address'));
  if (addr === undefined || addr.length !== 20) throw bad('adiri.eip2935.address');
  const committee = (j.genesis_committee as string[] | undefined) ?? [];
  if (committee.length === 0 || committee.length > 255) throw bad('adiri.genesis_committee');
  const genesisCommittee: Uint8Array[] = [];
  committee.forEach((h, i) => {
    const k = decodeHex(h);
    if (k === undefined || k.length !== KeyBytes) throw bad('adiri.genesis_committee', { index: BigInt(i) });
    genesisCommittee.push(k);
  });
  const chainId = big(j, 'chain_id');
  const minCommittee = big(j, 'min_committee_size');
  const maxHeaders = big(j, 'max_headers');
  for (const [isBad, key] of [
    [chainId === 0n, 'adiri.chain_id'],
    [minCommittee < 1n, 'adiri.min_committee_size'],
    [maxHeaders < 1n, 'adiri.max_headers'],
  ] as const) {
    if (isBad) throw bad(key);
  }
  const linkSha = str(j, 'genesis_link_sha256');
  if (new TextEncoder().encode(linkSha).length !== 64) throw bad('adiri.genesis_link_sha256');
  return {
    chainId,
    codec: str(j, 'epoch_record_codec'),
    genesisHash,
    genesisCommittee,
    epoch0FinalState: { number: big(e0, 'number'), hash: e0Hash },
    genesisLinkSha: linkSha,
    minCommittee,
    maxHeaders,
    eip2935Address: addr,
    eip2935CodeHash: codeHash,
  };
}
