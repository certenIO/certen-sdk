/**
 * The Settlement of a leg from its JSON text, read the way Go reads it (json.Unmarshal into ethproof.Settlement): the form the
 * validator's recorded Settlements and the stored bundle's L6 settlement take.
 *
 *   {"block_hash":"0x..","block_header_rlp":"0x..","tx_hash":"0x..",
 *    "tx_inclusion_proof":{"leaf_hash":[..32 numbers..],"leaf_index":N,"proof_hashes":[[..32..],..],"expected_root":[..32..],
 *                          "verified":bool,"proof_nodes":["<base64>",..],"leaf_value":"<base64>"},
 *    "receipt_inclusion_proof":{..}}
 *
 * What encoding/json does that a plain JSON.parse does not, and is reproduced here so that Go and TypeScript read the same text into the same
 * Settlement or both refuse it:
 *  - keys match by exact name, else case-insensitively (the same folding as every other Go-decoded document of this package); a repeated key is read
 *    in document order, an object member into an existing pointer MERGES into it, `null` for a pointer leaves it nil;
 *  - common.Hash and hexutil.Bytes read the RAW token: `0x` or `0X`, an even count of hex digits of either case, exactly 32 bytes for a hash, and a
 *    string written with an escape is refused; null is refused (their UnmarshalJSON is called with it); the empty string is no bytes for hexutil.Bytes
 *    (the header) and an error for a hash;
 *  - [32]byte is a JSON array of numbers (a base64 string is refused): numbers are read as uint8 (an integer literal 0..255, null leaves the byte
 *    as it was), elements past the 32nd are skipped unread (of any type) and a short array is zero-filled;
 *  - []byte is base64 (StdEncoding: padding required, CR and LF ignored) or an array of numbers; null is nil;
 *  - unknown members are ignored; `verified` must still be a bool or null.
 * Anything Go would report as an error (and so a verifier would not read) is a SettlementJsonError.
 */
import { foldEqual } from '../../s3/fold.js';
import { JsonError } from '../../s3/gojson.js';
import { JNum, JObj, parseGoJson, type JVal } from '../../s3/jsonx.js';
import type { InclusionProof, Settlement } from './evidence.js';

/** The text is not a Settlement as Go reads one (the reason, for a message). */
export class SettlementJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementJsonError';
  }
}

const fail = (m: string): never => {
  throw new SettlementJsonError(m);
};

type Escaped = WeakMap<object, Set<number>>;

const typeOf = (v: JVal): string => (v === null ? 'null' : typeof v === 'string' ? 'string' : typeof v === 'boolean' ? 'bool' : v instanceof JNum ? 'number' : Array.isArray(v) ? 'array' : 'object');

/** hexutil's fixed or variable length hex: the raw token is 0x then an even count of hex digits. */
function hexToken(v: JVal, wasEscaped: boolean, want: number, what: string): Uint8Array {
  if (typeof v !== 'string') return fail(`${what}: ${typeOf(v)} is not a hex string`);
  if (wasEscaped) return fail(`${what}: the string is written with an escape and hexutil reads its raw text`);
  // hexutil.Bytes reads the empty string as no bytes (checkText: "empty strings are allowed"); a fixed length (common.Hash) still refuses it below
  if (v === '' && want < 0) return new Uint8Array(0);
  if (v.length < 2 || v[0] !== '0' || (v[1] !== 'x' && v[1] !== 'X')) return fail(`${what}: missing 0x prefix`);
  const digits = v.slice(2);
  if (digits.length % 2 !== 0) return fail(`${what}: odd length hex string`);
  if (!/^[0-9a-fA-F]*$/.test(digits)) return fail(`${what}: invalid hex digit`);
  if (want >= 0 && digits.length / 2 !== want) return fail(`${what}: hex string has length ${digits.length}, want ${want * 2}`);
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** One element of a byte array: an integer literal 0..255 (uint8), or null (the byte is left as it was). */
function byteOf(v: JVal, what: string): number | undefined {
  if (v === null) return undefined;
  if (!(v instanceof JNum) || !/^[0-9]+$/.test(v.lit)) return fail(`${what}: ${typeOf(v)} is not a uint8`);
  const n = BigInt(v.lit);
  if (n > 255n) return fail(`${what}: ${v.lit} overflows uint8`);
  return Number(n);
}

/** [32]byte (or any [N]byte): an array of numbers decoded into the existing array; long input is dropped, short input zero-fills the rest. */
function fixedBytes(v: JVal, prev: Uint8Array, what: string): Uint8Array {
  if (v === null) return prev;
  if (!Array.isArray(v)) return fail(`${what}: ${typeOf(v)} is not an array of bytes`);
  const out = Uint8Array.from(prev);
  for (let i = 0; i < out.length; i++) {
    if (i >= v.length) {
      out[i] = 0;
      continue;
    }
    const b = byteOf(v[i]!, `${what}[${i}]`);
    if (b !== undefined) out[i] = b;
  }
  // elements past the array's end are SKIPPED, not decoded: encoding/json's array() reads them with d.value(reflect.Value{}), which checks nothing about their type
  return out;
}

/** base64.StdEncoding.Decode: CR and LF are ignored, padding is required, nothing follows it, unused trailing bits are not checked. */
export function base64Std(s: string): Uint8Array {
  const clean = s.replace(/[\r\n]/g, '');
  const m = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(clean);
  if (m === null || clean.length % 4 !== 0) return fail('base64: illegal data');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of m[1]!) {
    acc = (acc << 6) | alphabet.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

/** []byte: a base64 string, an array of numbers, or null (nil). */
function sliceBytes(v: JVal, what: string): Uint8Array {
  if (v === null) return new Uint8Array(0);
  if (typeof v === 'string') return base64Std(v);
  if (Array.isArray(v)) return Uint8Array.from(v.map((e, i) => byteOf(e, `${what}[${i}]`) ?? 0));
  return fail(`${what}: ${typeOf(v)} is not bytes`);
}

const field = (names: readonly string[], key: string): string | undefined => names.find((n) => n === key) ?? names.find((n) => foldEqual(n, key));

const PROOF_KEYS = ['leaf_hash', 'leaf_index', 'proof_hashes', 'expected_root', 'verified', 'proof_nodes', 'leaf_value'] as const;

function emptyProof(): InclusionProof {
  return { leafHash: new Uint8Array(32), leafIndex: 0n, proofHashes: [], expectedRoot: new Uint8Array(32), proofNodes: [], leafValue: new Uint8Array(0) };
}

function proofInto(p: InclusionProof, v: JObj, what: string): InclusionProof {
  const out: InclusionProof = { ...p };
  for (const [k, e] of v.pairs) {
    const f = field(PROOF_KEYS, k);
    if (f === undefined) continue;
    const w = `${what}.${f}`;
    switch (f) {
      case 'leaf_hash':
        out.leafHash = fixedBytes(e, out.leafHash, w);
        break;
      case 'expected_root':
        out.expectedRoot = fixedBytes(e, out.expectedRoot, w);
        break;
      case 'leaf_index': {
        if (e === null) break;
        if (!(e instanceof JNum) || !/^[0-9]+$/.test(e.lit)) return fail(`${w}: ${typeOf(e)} is not a uint64`);
        const n = BigInt(e.lit);
        if (n >= 1n << 64n) return fail(`${w}: ${e.lit} overflows uint64`);
        out.leafIndex = n;
        break;
      }
      case 'verified':
        if (e !== null && typeof e !== 'boolean') return fail(`${w}: ${typeOf(e)} is not a bool`);
        break;
      case 'proof_hashes': {
        if (e === null) {
          out.proofHashes = [];
          break;
        }
        if (!Array.isArray(e)) return fail(`${w}: ${typeOf(e)} is not an array`);
        out.proofHashes = e.map((el, i) => fixedBytes(el, new Uint8Array(32), `${w}[${i}]`));
        break;
      }
      case 'proof_nodes': {
        if (e === null) {
          out.proofNodes = [];
          break;
        }
        if (!Array.isArray(e)) return fail(`${w}: ${typeOf(e)} is not an array`);
        out.proofNodes = e.map((el, i) => sliceBytes(el, `${w}[${i}]`));
        break;
      }
      case 'leaf_value':
        out.leafValue = sliceBytes(e, w);
        break;
    }
  }
  return out;
}

const SETTLEMENT_KEYS = ['block_hash', 'block_header_rlp', 'tx_hash', 'tx_inclusion_proof', 'receipt_inclusion_proof'] as const;

/**
 * Reads a Settlement from JSON text as Go reads `*ethproof.Settlement`: JSON null is `null` (no Settlement), an object is read member by member in
 * document order. Throws SettlementJsonError for text Go refuses (or JsonError for text that is not JSON at all).
 */
export function parseSettlementJSON(input: string | Uint8Array): Settlement | null {
  const escaped: Escaped = new WeakMap();
  let tree: JVal;
  try {
    tree = parseGoJson(input, escaped);
  } catch (e) {
    if (e instanceof JsonError) throw new SettlementJsonError(e.message);
    throw e;
  }
  if (tree === null) return null;
  if (!(tree instanceof JObj)) return fail(`a ${typeOf(tree)} is not a Settlement`);
  let blockHash: Uint8Array = new Uint8Array(32);
  let headerRlp: Uint8Array = new Uint8Array(0);
  let txHash: Uint8Array = new Uint8Array(32);
  let tx: InclusionProof | null = null;
  let receipt: InclusionProof | null = null;
  const esc = escaped.get(tree.pairs) ?? new Set<number>();
  tree.pairs.forEach(([k, e], i) => {
    const f = field(SETTLEMENT_KEYS, k);
    if (f === undefined) return;
    switch (f) {
      case 'block_hash':
        blockHash = hexToken(e, esc.has(i), 32, f);
        break;
      case 'block_header_rlp':
        headerRlp = hexToken(e, esc.has(i), -1, f);
        break;
      case 'tx_hash':
        txHash = hexToken(e, esc.has(i), 32, f);
        break;
      case 'tx_inclusion_proof':
      case 'receipt_inclusion_proof': {
        let next: InclusionProof | null;
        if (e === null) next = null;
        else if (!(e instanceof JObj)) return fail(`${f}: ${typeOf(e)} is not an object`);
        else next = proofInto((f === 'tx_inclusion_proof' ? tx : receipt) ?? emptyProof(), e, f);
        if (f === 'tx_inclusion_proof') tx = next;
        else receipt = next;
        break;
      }
    }
  });
  return { blockHash, headerRlp, txHash, tx, receipt };
}
