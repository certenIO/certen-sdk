// The strict ABI decoder of the S8 verifier (twin of abi.go): no padding, offset or length slack is tolerated. Only what steps 1c-14 read is
// here: the settlement call (executeGovernanceProofDirect, batchExecuteGovernanceProofDirect) and the governance event data.
import { keccak_256 } from '@noble/hashes/sha3';
import { bigOf, isZero, utf8 } from './bytes.js';

export type ABIKind = 'selector' | 'truncated' | 'offset' | 'length' | 'cap' | 'padding' | 'word' | 'trailing' | 'shape';
export class ABIError extends Error {
  constructor(readonly kind: ABIKind, readonly field: string, readonly offset = 0, readonly got = 0n, readonly limit = 0n, readonly detail = '') {
    super(`abi ${kind} at "${field}" (byte ${offset})${detail ? ': ' + detail : ''}`);
  }
}
export const AuthorityLevelMax = 4;
export interface ABILimits { maxLegs: number; maxValidators: number }
export const defaultABILimits = (): ABILimits => ({ maxLegs: 64, maxValidators: 64 });

export type T =
  | { k: 'u'; bits: number } | { k: 'a' } | { k: 'b' } | { k: 'w' } | { k: 'e'; max: number } | { k: 'y' } | { k: 's' }
  | { k: 'd'; elem: T; cap: number } | { k: 'f'; elem: T; n: number } | { k: 't'; fields: [string, T][] };
interface V { w: Uint8Array; b: Uint8Array; items: V[] }
const noV = (): V => ({ w: new Uint8Array(32), b: new Uint8Array(0), items: [] });
export const tU = (bits: number): T => ({ k: 'u', bits });
export const tAddr: T = { k: 'a' };
export const tB32: T = { k: 'w' };
export const tBytes: T = { k: 'y' };
export const tString: T = { k: 's' };
export const tArr = (elem: T, cap = 0): T => ({ k: 'd', elem, cap });
export const tTup = (...fields: [string, T][]): T => ({ k: 't', fields });

const dynamic = (t: T): boolean => (t.k === 'y' || t.k === 's' || t.k === 'd' ? true : t.k === 'f' ? dynamic(t.elem) : t.k === 't' ? t.fields.some(([, f]) => dynamic(f)) : false);
const headSize = (t: T): number => (dynamic(t) ? 32 : t.k === 'f' ? t.n * headSize(t.elem) : t.k === 't' ? t.fields.reduce((n, [, f]) => n + headSize(f), 0) : 32);

class Dec {
  constructor(readonly buf: Uint8Array) {}
  word(off: number, field: string): Uint8Array {
    if (off < 0 || off + 32 > this.buf.length) throw new ABIError('truncated', field, off, 0n, 0n, `need 32 bytes, ${Math.max(this.buf.length - off, 0)} remain`);
    return this.buf.slice(off, off + 32);
  }
  length(off: number, field: string): bigint {
    const w = this.word(off, field);
    if (!isZero(w.slice(0, 24))) throw new ABIError('length', field, off, 0xffffffffffffffffn, BigInt(this.buf.length), 'length does not fit 64 bits');
    return bigOf(w.slice(24));
  }
  scalar(t: T, off: number, field: string): V {
    const w = this.word(off, field);
    const zeroAbove = (n: number): boolean => isZero(w.slice(0, n));
    if (t.k === 'u' && t.bits < 256 && !zeroAbove(32 - t.bits / 8)) throw new ABIError('word', field, off, 0n, 0n, `value does not fit uint${t.bits}`);
    if (t.k === 'a' && !zeroAbove(12)) throw new ABIError('word', field, off, 0n, 0n, 'address with non-zero high bytes');
    if (t.k === 'b' && (!zeroAbove(31) || w[31]! > 1)) throw new ABIError('word', field, off, 0n, 0n, 'bool is neither 0 nor 1');
    if (t.k === 'e' && (!zeroAbove(31) || w[31]! > t.max)) throw new ABIError('word', field, off, 0n, 0n, `enum value outside 0..${t.max}`);
    return { ...noV(), w };
  }
  decode(t: T, off: number, field: string): { v: V; end: number } {
    switch (t.k) {
      case 'u': case 'a': case 'b': case 'w': case 'e':
        return { v: this.scalar(t, off, field), end: off + 32 };
      case 'y': case 's': {
        const n = this.length(off, field);
        const rem = BigInt(this.buf.length - off - 32);
        const padded = ((n + 31n) / 32n) * 32n;
        if (n > rem || padded > rem) throw new ABIError('length', field, off, n, rem);
        const start = off + 32;
        if (!isZero(this.buf.slice(start + Number(n), start + Number(padded)))) throw new ABIError('padding', field, start + Number(n), 0n, 0n, `non-zero padding after ${n} bytes`);
        return { v: { ...noV(), b: this.buf.slice(start, start + Number(n)) }, end: start + Number(padded) };
      }
      case 'd': {
        const n = this.length(off, field);
        if (t.cap > 0 && n > BigInt(t.cap)) throw new ABIError('cap', field, off, n, BigInt(t.cap));
        const rem = BigInt(this.buf.length - off - 32);
        const per = BigInt(headSize(t.elem));
        if (n > rem / per) throw new ABIError('length', field, off, n, rem / per);
        const types = Array.from({ length: Number(n) }, () => t.elem);
        const names = types.map((_, i) => `${field}[${i}]`);
        const r = this.seq(types, names, off + 32);
        return { v: { ...noV(), items: r.out }, end: r.end };
      }
      case 'f': {
        const types = Array.from({ length: t.n }, () => t.elem);
        const r = this.seq(types, types.map((_, i) => `${field}[${i}]`), off);
        return { v: { ...noV(), items: r.out }, end: r.end };
      }
      default: {
        const r = this.seq(t.fields.map(([, f]) => f), t.fields.map(([n]) => (field === '' ? n : `${field}.${n}`)), off);
        return { v: { ...noV(), items: r.out }, end: r.end };
      }
    }
  }
  seq(types: T[], names: string[], base: number): { out: V[]; end: number } {
    const head = types.reduce((n, t) => n + headSize(t), 0);
    if (base + head > this.buf.length) throw new ABIError('truncated', names[0] ?? '', base, 0n, 0n, `head of ${head} bytes, ${this.buf.length - base} remain`);
    let pos = base + head;
    let hp = base;
    const out: V[] = [];
    types.forEach((t, i) => {
      if (!dynamic(t)) {
        out.push(this.decode(t, hp, names[i]!).v);
        hp += headSize(t);
        return;
      }
      let o: bigint;
      try { o = this.length(hp, names[i]!); } catch (e) {
        if (e instanceof ABIError && e.kind === 'length') throw new ABIError('offset', e.field, e.offset, e.got, e.limit, e.detail);
        throw e;
      }
      if (o > BigInt(this.buf.length) || base + Number(o) !== pos) {
        throw new ABIError('offset', names[i]!, hp, 0n, 0n, `offset ${o} points to byte ${base + Number(o > BigInt(this.buf.length) ? BigInt(this.buf.length) : o)}, the previous tail ends at ${pos}`);
      }
      const r = this.decode(t, pos, names[i]!);
      out.push(r.v);
      pos = r.end;
      hp += 32;
    });
    return { out, end: pos };
  }
}

export function decodeArgs(args: Uint8Array, fields: [string, T][]): V[] {
  const d = new Dec(args);
  const r = d.seq(fields.map(([, t]) => t), fields.map(([n]) => n), 0);
  if (r.end !== args.length) throw new ABIError('trailing', '', r.end, 0n, 0n, `${args.length - r.end} bytes after the encoding`);
  return r.out;
}

export const selector4 = (sig: string): Uint8Array => keccak_256(utf8(sig)).slice(0, 4);
const adiGovTuple = '(string,bytes32,bytes32[],bytes32,bytes,bytes,bytes,uint256,uint256,bytes,uint256,bytes32,uint64,uint64,uint64)';
export const SigExecuteGovernanceDirect = `executeGovernanceProofDirect(address,uint256,bytes,${adiGovTuple})`;
export const SigBatchGovernanceDirect = `batchExecuteGovernanceProofDirect(address[],uint256[],bytes[],${adiGovTuple})`;

const adiGovType = (): T => tTup(
  ['adiURL', tString], ['anchorId', tB32], ['merkleProof', tArr(tB32)], ['operationID', tB32], ['keyBookProof', tBytes], ['roleProof', tBytes],
  ['thresholdProof', tBytes], ['timestamp', tU(256)], ['expiresAt', tU(256)], ['validatorSignatures', tBytes], ['nonce', tU(256)],
  ['authorityBook', tB32], ['authorityPage', tU(64)], ['notBefore', tU(64)], ['notAfter', tU(64)],
);

export interface Leg { target: Uint8Array; value: bigint; data: Uint8Array; selector: Uint8Array }
export interface GovernanceProof { authorityBook: Uint8Array; authorityPage: bigint }
export interface SettlementCall { selector: Uint8Array; batch: boolean; legs: Leg[]; proof: GovernanceProof }
const legSelector = (data: Uint8Array): Uint8Array => { const s = new Uint8Array(4); s.set(data.slice(0, 4)); return s; };
const govProofOf = (v: V): GovernanceProof => ({ authorityBook: v.items[11]!.w, authorityPage: bigOf(v.items[12]!.w.slice(24)) });

/** DecodeSettlementCall: THROWS an ABIError for anything the pinned settlement selectors do not encode exactly. */
export function decodeSettlementCall(calldata: Uint8Array, lim: ABILimits = defaultABILimits()): SettlementCall {
  if (calldata.length < 4) throw new ABIError('truncated', 'selector', 0, 0n, 0n, `${calldata.length} bytes`);
  const sel = calldata.slice(0, 4);
  const is = (sig: string): boolean => sel.every((b, i) => b === selector4(sig)[i]);
  if (is(SigExecuteGovernanceDirect)) {
    const it = decodeArgs(calldata.slice(4), [['target', tAddr], ['value', tU(256)], ['data', tBytes], ['proof', adiGovType()]]);
    return { selector: sel, batch: false, legs: [{ target: it[0]!.w.slice(12), value: bigOf(it[1]!.w), data: it[2]!.b, selector: legSelector(it[2]!.b) }], proof: govProofOf(it[3]!) };
  }
  if (is(SigBatchGovernanceDirect)) {
    const legs = (name: string, e: T): [string, T] => [name, { k: 'd', elem: e, cap: lim.maxLegs }];
    const it = decodeArgs(calldata.slice(4), [legs('targets', tAddr), legs('values', tU(256)), legs('datas', tBytes), ['proof', adiGovType()]]);
    const n = it[0]!.items.length;
    if (n === 0) throw new ABIError('shape', 'targets', 0, 0n, 0n, 'empty batch');
    if (it[1]!.items.length !== n || it[2]!.items.length !== n) throw new ABIError('shape', 'values', 0, BigInt(it[1]!.items.length), BigInt(n), 'targets, values and datas differ in length');
    const out: Leg[] = [];
    for (let i = 0; i < n; i++) out.push({ target: it[0]!.items[i]!.w.slice(12), value: bigOf(it[1]!.items[i]!.w), data: it[2]!.items[i]!.b, selector: legSelector(it[2]!.items[i]!.b) });
    return { selector: sel, batch: true, legs: out, proof: govProofOf(it[3]!) };
  }
  throw new ABIError('selector', 'selector', 0, 0n, 0n, `0x${[...sel].map((b) => b.toString(16).padStart(2, '0')).join('')} is not a pinned settlement selector`);
}

const tEnum = (max: number): T => ({ k: 'e', max });
export const decodeGovernanceOperationData = (data: Uint8Array): { value: bigint; data: Uint8Array; level: number } => {
  const it = decodeArgs(data, [['value', tU(256)], ['data', tBytes], ['requiredLevel', tEnum(AuthorityLevelMax)]]);
  return { value: bigOf(it[0]!.w), data: it[1]!.b, level: it[2]!.w[31]! };
};
export const decodeGovernanceBatchData = (data: Uint8Array): { callCount: bigint; level: number } => {
  const it = decodeArgs(data, [['callCount', tU(256)], ['requiredLevel', tEnum(AuthorityLevelMax)]]);
  return { callCount: bigOf(it[0]!.w), level: it[1]!.w[31]! };
};
