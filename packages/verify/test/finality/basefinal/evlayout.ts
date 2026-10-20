/** The byte offsets of the parts of a base-sepolia/finalized/v1 container (header, LC, spines, game, nodes), walked with plain length reads. */
import { decodeContainer, type Limits } from '../../../src/proof-v2/finality/codec.js';
import type { Pins as EthL1Pins } from '../../../src/proof-v2/finality/ethl1/index.js';
import { lcExtent } from '../../../src/proof-v2/finality/basefinal/index.js';

/** The offsets of the parts of a container (header, LC, spines, game, nodes), walked with plain length reads. */
export function offsets(ev: Uint8Array, ep: EthL1Pins, lim: Limits) {
  const dv = new DataView(ev.buffer, ev.byteOffset, ev.length);
  const c = decodeContainer(ev, lim);
  const hdr = ev.length - c.body.length;
  const body = hdr;
  let p = body;
  const profLen = dv.getUint32(p, false);
  const linksCount = body + 4 + profLen + 1 + 8 + 32 + 1 + 4 + dv.getUint32(body + 4 + profLen + 1 + 8 + 32 + 1, false);
  const n = lcExtent(c.body, lim, ep.maxLinks);
  p = body + n;
  const l1Count = p;
  const cnt1 = dv.getUint32(p, false);
  p += 4;
  for (let i = 0; i < cnt1; i++) p += 4 + dv.getUint32(p, false);
  const stateBlock = p;
  p += 8;
  const gameProxy = p;
  p += 20;
  const codeLen = p;
  p += 4 + dv.getUint32(p, false);
  const outIdx = p;
  p += 4;
  const l2Count = p;
  const cnt2 = dv.getUint32(p, false);
  p += 4;
  for (let i = 0; i < cnt2; i++) p += 4 + dv.getUint32(p, false);
  const nodesCount = p;
  return { hdr, body, linksCount, lcEnd: body + n, l1Count, stateBlock, gameProxy, codeLen, outIdx, l2Count, nodesCount, cnt1, cnt2, level: 4 + 4 + 'base-sepolia/finalized/v1'.length + 8 };
}
