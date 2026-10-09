/**
 * A small Solidity ABI encoder, for one purpose: to say what calldata a caller's `functionSignature` and `args` mean, so the
 * calldata a gateway returns for signing can be compared with it. Supported: address, bool, uintN, intN, bytesN, bytes, string,
 * and arrays (T[] and T[k]) of those, nested. Anything else (tuples, function types) is refused by name, never guessed at:
 * an expectation that cannot be formed is a refusal to sign, not a skipped check.
 */
import { keccak256 } from './proof-v2/accumulate.js';
import { VerifyError, hexBytes, toHex } from './proof-v2/bytes.js';

export class AbiUnsupported extends VerifyError {
  readonly code = 'SIGNING_EXPECTATION_UNAVAILABLE';
}

type T =
  | { k: 'uint' | 'int'; bits: number }
  | { k: 'address' | 'bool' | 'bytes' | 'string' }
  | { k: 'bytesN'; n: number }
  | { k: 'array'; of: T; len?: number };

const dynamic = (t: T): boolean => t.k === 'bytes' || t.k === 'string' || (t.k === 'array' && (t.len === undefined || dynamic(t.of)));

function parseType(s: string): T {
  const arr = /^(.*)\[(\d*)\]$/.exec(s);
  if (arr) return { k: 'array', of: parseType(arr[1]), ...(arr[2] === '' ? {} : { len: Number(arr[2]) }) };
  if (s === 'address' || s === 'bool' || s === 'bytes' || s === 'string') return { k: s };
  let m = /^(u?int)(\d*)$/.exec(s);
  if (m) {
    const bits = m[2] === '' ? 256 : Number(m[2]);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) throw new AbiUnsupported(`abi: ${s} is not a valid integer type`);
    return { k: m[1] as 'uint' | 'int', bits };
  }
  m = /^bytes(\d+)$/.exec(s);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 32) return { k: 'bytesN', n: Number(m[1]) };
  throw new AbiUnsupported(`abi: type "${s}" is not supported for building an expectation`);
}

/** The top-level types of "name(t1,t2,...)"; refuses a tuple. */
export function parseSignature(sig: string): { name: string; types: string[] } {
  const m = /^\s*([A-Za-z_$][\w$]*)\s*\((.*)\)\s*$/.exec(sig);
  if (!m) throw new AbiUnsupported(`abi: "${sig}" is not a function signature like name(type,type)`);
  if (m[2].includes('(')) throw new AbiUnsupported('abi: tuple parameters are not supported for building an expectation');
  const types = m[2].trim() === '' ? [] : m[2].split(',').map((x) => x.trim());
  return { name: m[1], types };
}

const word = (n: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  let x = BigInt.asUintN(256, n);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
};
const pad = (b: Uint8Array): Uint8Array => { const out = new Uint8Array(Math.ceil(b.length / 32) * 32); out.set(b); return out; };
const cat = (...p: Uint8Array[]): Uint8Array => { const o = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

function enc(t: T, v: unknown): Uint8Array {
  switch (t.k) {
    case 'uint':
    case 'int': {
      let n: bigint;
      try { n = BigInt(v as string | number | bigint); } catch { throw new AbiUnsupported(`abi: ${String(v)} is not an integer`); }
      const lo = t.k === 'uint' ? 0n : -(1n << BigInt(t.bits - 1));
      const hi = t.k === 'uint' ? (1n << BigInt(t.bits)) - 1n : (1n << BigInt(t.bits - 1)) - 1n;
      if (n < lo || n > hi) throw new AbiUnsupported(`abi: ${n} does not fit ${t.k}${t.bits}`);
      return word(n);
    }
    case 'address': {
      const b = hexBytes(String(v), 'abi address', 20);
      return cat(new Uint8Array(12), b);
    }
    case 'bool': return word(v === true || v === 'true' ? 1n : 0n);
    case 'bytesN': { const b = hexBytes(String(v), 'abi bytesN', t.n); const o = new Uint8Array(32); o.set(b); return o; }
    case 'bytes': { const b = typeof v === 'string' && /^0x/i.test(v) ? hexBytes(v, 'abi bytes') : new TextEncoder().encode(String(v)); return cat(word(BigInt(b.length)), pad(b)); }
    case 'string': { const b = new TextEncoder().encode(String(v)); return cat(word(BigInt(b.length)), pad(b)); }
    case 'array': {
      if (!Array.isArray(v)) throw new AbiUnsupported('abi: an array argument must be an array');
      if (t.len !== undefined && v.length !== t.len) throw new AbiUnsupported(`abi: expected ${t.len} elements, got ${v.length}`);
      const body = encodeTuple(v.map(() => t.of), v);
      return t.len === undefined ? cat(word(BigInt(v.length)), body) : body;
    }
  }
}

function encodeTuple(types: T[], values: unknown[]): Uint8Array {
  const heads: (Uint8Array | null)[] = [];
  const tails: Uint8Array[] = [];
  types.forEach((t, i) => {
    if (dynamic(t)) { heads.push(null); tails.push(enc(t, values[i])); } else { heads.push(enc(t, values[i])); tails.push(new Uint8Array(0)); }
  });
  const headSize = heads.reduce((a, h) => a + (h ? h.length : 32), 0);
  let off = headSize;
  const out: Uint8Array[] = [];
  heads.forEach((h, i) => { if (h) out.push(h); else { out.push(word(BigInt(off))); off += tails[i].length; } });
  return cat(...out, ...tails);
}

/** 0x-prefixed calldata for `functionSignature` called with `args`. */
export function encodeCall(functionSignature: string, args: unknown[] = []): string {
  const { name, types } = parseSignature(functionSignature);
  if (types.length !== args.length) throw new AbiUnsupported(`abi: ${name} takes ${types.length} arguments, ${args.length} given`);
  const sel = keccak256(new TextEncoder().encode(`${name}(${types.join(',')})`)).subarray(0, 4);
  try {
    return `0x${toHex(cat(sel, encodeTuple(types.map(parseType), args)))}`;
  } catch (e) {
    if (e instanceof AbiUnsupported) throw e;
    throw new AbiUnsupported(`abi: ${e instanceof Error ? e.message : String(e)}`);
  }
}
