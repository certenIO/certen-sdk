/**
 * The LC part of an evidence container (V2_SPEC_S7 section 3.2; the twin of pkg/finality/ethl1/lccodec.go):
 * STR profile || u8 anchorKind || u64 anchorPeriod || B32 anchorRoot || LB anchorBody || LIST<LB> links || LB finalUpdate,
 * with LB = u8 layout || LP ssz, LP = u32be length || bytes, STR = LP(ASCII) and LIST = u32be count || items.
 */
import { evidenceMalformed, evidenceTooLarge } from './fault.js';
import type { LB, LC } from './types.js';

const latin1 = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return s;
};
const fromLatin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** Renders the LC part of an evidence container. */
export function encodeLC(lc: LC): Uint8Array {
  const parts: Uint8Array[] = [];
  const u32 = (n: number): void => {
    const x = new Uint8Array(4);
    new DataView(x.buffer).setUint32(0, n, false);
    parts.push(x);
  };
  const lp = (x: Uint8Array): void => {
    u32(x.length);
    parts.push(x);
  };
  const lb = (x: LB): void => {
    parts.push(Uint8Array.of(x.layout));
    lp(x.ssz);
  };
  lp(fromLatin1(lc.profile));
  parts.push(Uint8Array.of(lc.anchorKind));
  const period = new Uint8Array(8);
  new DataView(period.buffer).setBigUint64(0, lc.anchorPeriod, false);
  parts.push(period);
  parts.push(lc.anchorRoot);
  lb(lc.anchorBody);
  u32(lc.links.length);
  for (const l of lc.links) lb(l);
  lb(lc.finalUpdate);
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

/**
 * The strict inverse of encodeLC: no trailing byte, every length within the buffer, the link count bounded by maxLinks before
 * anything is allocated, and encode(decode(x)) == x. A container that is not well formed throws finality_evidence_malformed, or
 * finality_evidence_too_large for a link count over maxLinks; the pins carry the bound (Pins.maxLinks, see decodeLCUnder).
 */
export function decodeLC(b: Uint8Array, maxLinks: number): LC {
  let pos = 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const need = (part: string, n: number): void => {
    if (n < 0 || pos + n > b.length) throw evidenceMalformed(part, 0, 'truncated', b.length - pos, n);
  };
  const lp = (part: string): Uint8Array => {
    need(part, 4);
    const n = dv.getUint32(pos, false);
    pos += 4;
    need(part, n);
    const x = b.subarray(pos, pos + n);
    pos += n;
    return x;
  };
  const lb = (part: string): LB => {
    need(part, 1);
    const layout = b[pos]!;
    pos++;
    return { layout, ssz: lp(part) };
  };
  const profile = latin1(lp('profile'));
  need('anchor', 1 + 8 + 32);
  const anchorKind = b[pos]!;
  pos++;
  const anchorPeriod = dv.getBigUint64(pos, false);
  pos += 8;
  const anchorRoot = Uint8Array.from(b.subarray(pos, pos + 32));
  pos += 32;
  const anchorBody = lb('anchor_body');
  need('links', 4);
  const n = dv.getUint32(pos, false);
  pos += 4;
  if (n > maxLinks) throw evidenceTooLarge('links', n, maxLinks);
  const links: LB[] = [];
  for (let i = 0; i < n; i++) links.push(lb('link'));
  const finalUpdate = lb('final_update');
  if (pos !== b.length) throw evidenceMalformed('lc', 0, 'trailing_bytes', b.length, pos);
  return { profile, anchorKind, anchorPeriod, anchorRoot, anchorBody, links, finalUpdate };
}
