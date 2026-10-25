/** The live Adiri evidence of the Go set, taken apart: container, body, CFA1 (decoding only, no signature work). */
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { decodeBody, decodeCFA1, type Body, type CFA1 } from '../../../src/proof-v2/finality/adiri/index.js';
import { evidenceOf, vectors, legOf, type Vec } from './vectorset.js';

export const vec = (name: string): Vec => {
  const v = vectors().find((x) => x.name === name);
  if (v === undefined) throw new Error(`no vector ${name}`);
  return v;
};

const memo = new Map<string, { evidence: Uint8Array; body: Body; cfa1Bytes: Uint8Array; cfa1: CFA1 }>();
export function live(name = 'live-500749-epoch600'): { evidence: Uint8Array; body: Body; cfa1Bytes: Uint8Array; cfa1: CFA1; leg: ReturnType<typeof legOf> } {
  let m = memo.get(name);
  if (m === undefined) {
    const evidence = evidenceOf(vec(name));
    const c = decodeContainer(evidence, defaultLimits());
    const body = decodeBody(c.body, defaultLimits(), 1 << 30);
    m = { evidence, body, cfa1Bytes: body.cfa1, cfa1: decodeCFA1(body.cfa1, defaultLimits()) };
    memo.set(name, m);
  }
  return { ...m, leg: legOf(vec(name)) };
}
