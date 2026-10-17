/**
 * The ASN.1 and DER readers Accumulate's signature types depend on, each reproducing the exact acceptance of the Go it stands
 * for. They are separate on purpose: Accumulate uses three different parsers and they disagree on what they accept, and a
 * verifier that used one for all three would refuse or accept forms Kermit did not.
 *
 *   strictEcdsaSignature   crypto/ecdsa.VerifyASN1 (ecdsaSha256): cryptobyte, DER lengths, minimal positive integers, nothing
 *                          after the SEQUENCE;
 *   laxSecp256k1Signature  pkg/crypto.ParseSignature (btc, btclegacy, eth before Baikonur): a hand-written reader that checks
 *                          the tags and that the lengths fit in the data, and nothing else - trailing bytes, a non-minimal
 *                          integer and a high S are all accepted, and an integer is an unsigned big-endian number;
 *   parseSpkiEcdsa / parsePkcs1Rsa   crypto/x509.ParsePKIXPublicKey / ParsePKCS1PublicKey (encoding/asn1): DER lengths, minimal
 *                          integers, extra elements at the end of a SEQUENCE tolerated, trailing data after it refused.
 */

export interface Tlv {
  tag: number;
  body: Uint8Array;
  /** Everything after this element. */
  rest: Uint8Array;
}

/** cryptobyte.String.readASN1 / encoding/asn1.parseTagAndLength for a single-byte tag: DER lengths only. */
export function readTlv(s: Uint8Array): Tlv | undefined {
  if (s.length < 2) return undefined;
  const tag = s[0]!;
  if ((tag & 0x1f) === 0x1f) return undefined; // high-tag-number form
  const lenByte = s[1]!;
  let len: number;
  let header: number;
  if ((lenByte & 0x80) === 0) {
    len = lenByte;
    header = 2;
  } else {
    const lenLen = lenByte & 0x7f;
    if (lenLen === 0 || lenLen > 4 || s.length < 2 + lenLen) return undefined;
    len = 0;
    for (let i = 0; i < lenLen; i++) len = len * 256 + s[2 + i]!;
    if (len < 128) return undefined; // should have used the short form
    if (Math.floor(len / 2 ** ((lenLen - 1) * 8)) === 0) return undefined; // a leading zero octet
    header = 2 + lenLen;
  }
  if (header + len > s.length) return undefined;
  return { tag, body: s.subarray(header, header + len), rest: s.subarray(header + len) };
}

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const OID = 0x06;
const BITSTRING = 0x03;

function toBig(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

/** cryptobyte checkASN1Integer: non-empty and minimally encoded. */
function minimalInteger(b: Uint8Array): boolean {
  if (b.length === 0) return false;
  if (b.length === 1) return true;
  if (b[0] === 0 && (b[1]! & 0x80) === 0) return false;
  if (b[0] === 0xff && (b[1]! & 0x80) === 0x80) return false;
  return true;
}

/** An ASN.1 INTEGER as encoding/asn1 and cryptobyte read it into a big integer (two's complement). */
function signedInteger(b: Uint8Array): bigint {
  const n = toBig(b);
  return (b[0]! & 0x80) !== 0 ? n - (1n << BigInt(8 * b.length)) : n;
}

/**
 * crypto/ecdsa parseSignature: SEQUENCE { INTEGER r, INTEGER s } as the whole input, each integer minimal and non-negative.
 * (A value that is zero or not below the group order is refused later, by the verification itself.)
 */
export function strictEcdsaSignature(sig: Uint8Array): { r: bigint; s: bigint } | undefined {
  const seq = readTlv(sig);
  if (!seq || seq.tag !== SEQUENCE || seq.rest.length !== 0) return undefined;
  const r = readTlv(seq.body);
  if (!r || r.tag !== INTEGER || !minimalInteger(r.body) || (r.body[0]! & 0x80) !== 0) return undefined;
  const s = readTlv(r.rest);
  if (!s || s.tag !== INTEGER || !minimalInteger(s.body) || (s.body[0]! & 0x80) !== 0 || s.rest.length !== 0) return undefined;
  return { r: toBig(r.body), s: toBig(s.body) };
}

/**
 * pkg/crypto ParseSignature, byte for byte: len >= 8; 0x30; len(sig) >= sig[1]+2; 0x02, a length, the integer; 0x02, a length,
 * the integer. One leading zero byte of each integer is dropped (and the rest is an unsigned number). Nothing checks sig[1]
 * against the actual length, that the integers are minimal, or that anything is left over. Go indexes sig[idx] without a bounds
 * check at three points where the data can end; there Go panics, and this returns undefined (no signature).
 */
export function laxSecp256k1Signature(sig: Uint8Array): { r: bigint; s: bigint } | undefined {
  if (sig.length < 8) return undefined;
  if (sig[0] !== 0x30) return undefined;
  const totalLen = sig[1]!;
  if (sig.length < totalLen + 2) return undefined;
  let idx = 2;
  if (sig[idx] !== 0x02) return undefined;
  idx++;
  const rLen = sig[idx]!;
  idx++;
  if (idx + rLen > sig.length) return undefined;
  let rBytes = sig.subarray(idx, idx + rLen);
  if (rBytes.length === 0) return undefined; // Go: rBytes[0] panics on an empty slice
  if (rBytes[0] === 0 && rBytes.length > 1) rBytes = rBytes.subarray(1);
  const r = toBig(rBytes);
  idx += rLen;
  if (idx >= sig.length || sig[idx] !== 0x02) return undefined;
  idx++;
  if (idx >= sig.length) return undefined; // Go: sig[idx] panics
  const sLen = sig[idx]!;
  idx++;
  if (idx + sLen > sig.length) return undefined;
  let sBytes = sig.subarray(idx, idx + sLen);
  if (sBytes.length === 0) return undefined; // Go: sBytes[0] panics
  if (sBytes[0] === 0 && sBytes.length > 1) sBytes = sBytes.subarray(1);
  return { r, s: toBig(sBytes) };
}

/** The elements of a constructed value: encoding/asn1 reads the fields it wants and tolerates more after them. */
function elements(body: Uint8Array): Tlv[] | undefined {
  const out: Tlv[] = [];
  let rest = body;
  while (rest.length > 0) {
    const t = readTlv(rest);
    if (!t) return undefined;
    out.push(t);
    rest = t.rest;
  }
  return out;
}

const bytesEq = (a: Uint8Array, hex: string): boolean => a.length * 2 === hex.length && Buffer.from(a).toString('hex') === hex;

export type EcCurve = 'P-224' | 'P-256' | 'P-384' | 'P-521';
const CURVE_OIDS: Readonly<Record<string, EcCurve>> = {
  '2b81040021': 'P-224',
  '2a8648ce3d030107': 'P-256',
  '2b81040022': 'P-384',
  '2b81040023': 'P-521',
};
const OID_EC_PUBLIC_KEY = '2a8648ce3d0201';

/** asn1.BitString.RightAlign over the bytes after the padding-count octet. */
function bitStringBytes(b: Uint8Array): Uint8Array | undefined {
  if (b.length === 0) return undefined;
  const padding = b[0]!;
  const data = b.subarray(1);
  if (padding > 7 || (data.length === 0 && padding > 0)) return undefined;
  if (data.length > 0 && (data[data.length - 1]! & ((1 << padding) - 1)) !== 0) return undefined;
  const bitLength = data.length * 8 - padding;
  const shift = 8 - (bitLength % 8);
  if (shift === 8 || data.length === 0) return data;
  const a = new Uint8Array(data.length);
  a[0] = data[0]! >> shift;
  for (let i = 1; i < data.length; i++) {
    a[i] = (data[i - 1]! << (8 - shift)) & 0xff;
    a[i] = a[i]! | (data[i]! >> shift);
  }
  return a;
}

/**
 * x509.ParsePKIXPublicKey for an EC key: SubjectPublicKeyInfo { AlgorithmIdentifier { id-ecPublicKey, namedCurve OID }, BIT
 * STRING }, no data after it. Returns the curve and the uncompressed point octets; undefined when Go would not return an
 * *ecdsa.PublicKey (a different algorithm, a curve Go has no name for, or a malformed structure).
 */
export function parseSpkiEcdsa(der: Uint8Array): { curve: EcCurve; point: Uint8Array } | undefined {
  const outer = readTlv(der);
  if (!outer || outer.tag !== SEQUENCE || outer.rest.length !== 0) return undefined;
  const parts = elements(outer.body);
  if (!parts || parts.length < 2) return undefined;
  const alg = parts[0]!;
  if (alg.tag !== SEQUENCE) return undefined;
  const algParts = elements(alg.body);
  if (!algParts || algParts.length < 1) return undefined;
  const oid = algParts[0]!;
  if (oid.tag !== OID || !bytesEq(oid.body, OID_EC_PUBLIC_KEY)) return undefined;
  const params = algParts[1];
  if (!params || params.tag !== OID) return undefined;
  const curve = CURVE_OIDS[Buffer.from(params.body).toString('hex')];
  if (!curve) return undefined;
  const bits = parts[1]!;
  if (bits.tag !== BITSTRING) return undefined;
  const point = bitStringBytes(bits.body);
  if (!point) return undefined;
  return { curve, point };
}

/** x509.ParsePKCS1PublicKey: SEQUENCE { INTEGER n, INTEGER e }, n positive, 0 < e <= 2^31-1, no data after it. */
export function parsePkcs1Rsa(der: Uint8Array): { n: bigint; e: number } | undefined {
  const outer = readTlv(der);
  if (!outer || outer.tag !== SEQUENCE || outer.rest.length !== 0) return undefined;
  const parts = elements(outer.body);
  if (!parts || parts.length < 2) return undefined;
  const [nT, eT] = [parts[0]!, parts[1]!];
  if (nT.tag !== INTEGER || eT.tag !== INTEGER) return undefined;
  if (!minimalInteger(nT.body) || !minimalInteger(eT.body)) return undefined;
  const n = signedInteger(nT.body);
  if (n <= 0n) return undefined;
  if (eT.body.length > 8) return undefined;
  const e = signedInteger(eT.body);
  if (e <= 0n || e > 0x7fffffffn) return undefined;
  return { n, e: Number(e) };
}
