/**
 * The body codec and the container header of base-sepolia/finalized/v1 against hostile input: truncation at every structural position of
 * a live container, absurd counts and lengths (2^32-1), bad header enums, a trailing byte, unordered nodes. The property: every refusal
 * is a NAMED state registered with exactly its fields; no input is ever accepted that is not the evidence itself; nothing allocates by
 * a count before it is checked against its bound and against the remaining bytes.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { ethl1PinsFrom } from '../../../src/proof-v2/finality/ethl1/index.js';
import { sepoliaPins, parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { BaseFinalKind, decodeBody, encodeBody } from '../../../src/proof-v2/finality/basefinal/index.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { offsets } from './evlayout.js';
import { assertRegistered, registryInt } from './regcheck.js';
import { legRef, read, type LegFile } from './vectorset.js';

const pins = parsePinsOverride(read('pins/main.json'));
const ep = ethl1PinsFrom(sepoliaPins(pins));
const lim = defaultLimits();
const EV = Uint8Array.from(read('evidence/valid_leg_47604755.bin'));
const LEG = legRef(JSON.parse(read('legs/leg_47604755.json').toString('utf8')) as LegFile);
const kind = new BaseFinalKind();

const O = offsets(EV, ep, lim);

const setU32 = (ev: Uint8Array, off: number, v: number): Uint8Array => {
  const out = Uint8Array.from(ev);
  new DataView(out.buffer).setUint32(off, v, false);
  return out;
};
const named = (ev: Uint8Array, leg = LEG): FinalityStateError => {
  try {
    kind.verify(pins, leg, ev);
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw new Error(`NOT A NAMED STATE: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error('accepted');
};
const registered = (e: FinalityStateError): FinalityStateError => {
  assertRegistered(e);
  assertRegistered(e, registryInt);
  return e;
};

describe('the container layout of the live evidence', () => {
  it('has the parts in the order of spec 3.3 and re-encodes byte for byte', () => {
    const c = decodeContainer(EV, lim);
    const b = decodeBody(c.body, lim, ep, 1024);
    expect(b.l1Spine.length).toBe(O.cnt1);
    expect(b.l2Spine.length).toBe(O.cnt2);
    expect(b.gameProxy.length).toBe(20);
    expect(Buffer.from(encodeBody(b)).equals(Buffer.from(c.body))).toBe(true);
  });
});

describe('absurd counts and lengths are refused before anything is sized', () => {
  const cases: [string, number, string][] = [
    ['lc.links count', O.linksCount, 'finality_evidence_too_large'],
    ['l1Spine count', O.l1Count, 'finality_evidence_too_large'],
    ['gameCode length', O.codeLen, 'finality_evidence_too_large'],
    ['l2Spine count', O.l2Count, 'finality_evidence_too_large'],
    ['nodes count', O.nodesCount, 'finality_evidence_too_large'],
  ];
  for (const [name, off, code] of cases) {
    it(`${name} = 2^32-1 is ${code}`, () => {
      const e = registered(named(setU32(EV, off, 0xffffffff)));
      expect(e.code).toBe(code);
    });
  }

  it('a count within its bound but beyond the remaining bytes is count_exceeds_remaining, a length beyond them length_exceeds_remaining', () => {
    const e1 = registered(named(setU32(EV, O.l2Count, 1024).subarray(0, O.l2Count + 40)));
    expect(e1.code).toBe('finality_evidence_malformed');
    expect(e1.fields.reason).toBe('count_exceeds_remaining');
    const e2 = registered(named(setU32(EV, O.codeLen, 262144)));
    expect(e2.code).toBe('finality_evidence_malformed');
    expect(e2.fields.reason).toBe('length_exceeds_remaining');
  });

  it('the bound itself is the limit: one above is too large', () => {
    const e = registered(named(setU32(EV, O.l2Count, 1025)));
    expect(e.code).toBe('finality_evidence_too_large');
    expect(String(e.fields.limit)).toBe('1024');
    const g = registered(named(setU32(EV, O.codeLen, 262145)));
    expect(String(g.fields.limit)).toBe('262144');
  });

  it('a zero count where the verifier needs a header is a named state, not an accepted container', () => {
    const e1 = registered(named(setU32(EV, O.l1Count, 0)));
    expect(e1.code).toBeDefined();
    const e2 = registered(named(setU32(EV, O.l2Count, 0)));
    expect(e2.code).toBeDefined();
  });
});

describe('bad enums and a bad container header', () => {
  const at = (off: number, v: number): Uint8Array => {
    const out = Uint8Array.from(EV);
    out[off] = v;
    return out;
  };

  it('a level that is not stored (0, 1, 4, 255) is level_not_stored; a stored level that is not 3 differs from the addendum', () => {
    for (const lvl of [0, 1, 4, 255]) {
      const e = registered(named(at(O.level, lvl)));
      expect(e.code, String(lvl)).toBe('finality_evidence_malformed');
      expect(e.fields.reason).toBe('level_not_stored');
    }
    const e2 = registered(named(at(O.level, 2)));
    expect(e2.fields.reason).toBe('differs_from_addendum');
  });

  it('another chain id, another kind and a bad magic are named', () => {
    const chain = Uint8Array.from(EV);
    chain[O.level - 1]! ^= 1;
    const e = registered(named(chain));
    expect(e.fields.reason).toBe('differs_from_addendum');
    const kindB = Uint8Array.from(EV);
    kindB[8]! ^= 1; // first character of the kind string
    expect(registered(named(kindB)).code).toBe('finality_evidence_unrecognised');
    const magic = Uint8Array.from(EV);
    magic[0] = 0x58;
    expect(registered(named(magic)).code).toBe('finality_evidence_unrecognised');
  });

  it('a container about another block, another hash or another chain is finality_block_mismatch', () => {
    for (const leg of [{ ...LEG, number: LEG.number + 1n }, { ...LEG, hash: Uint8Array.from(LEG.hash, (x, i) => (i === 0 ? x ^ 1 : x)) }, { ...LEG, chain: 1n }]) {
      expect(registered(named(EV, leg)).code).toBe('finality_block_mismatch');
    }
  });

  it('a trailing byte is trailing_bytes and an unordered node set nodes_not_ascending_unique', () => {
    const t = new Uint8Array(EV.length + 1);
    t.set(EV);
    const e = registered(named(t));
    expect(e.fields.reason).toBe('trailing_bytes');
    // swap the first two nodes of the set (their hashes are then not ascending)
    const dv = new DataView(EV.buffer, EV.byteOffset, EV.length);
    const n0 = dv.getUint32(O.nodesCount + 4, false);
    const n1off = O.nodesCount + 4 + 4 + n0;
    const n1 = dv.getUint32(n1off, false);
    const a = EV.subarray(O.nodesCount + 4, n1off);
    const b = EV.subarray(n1off, n1off + 4 + n1);
    const swapped = new Uint8Array(EV.length);
    swapped.set(EV.subarray(0, O.nodesCount + 4), 0);
    swapped.set(b, O.nodesCount + 4);
    swapped.set(a, O.nodesCount + 4 + b.length);
    swapped.set(EV.subarray(n1off + 4 + n1), O.nodesCount + 4 + b.length + a.length);
    const asc = Buffer.compare(Buffer.from(keccak_256(EV.subarray(O.nodesCount + 8, n1off))), Buffer.from(keccak_256(EV.subarray(n1off + 4, n1off + 4 + n1)))) < 0;
    expect(asc).toBe(true);
    const e2 = registered(named(swapped));
    expect(e2.fields.reason).toBe('nodes_not_ascending_unique');
    expect(String(e2.fields.index)).toBe('1');
  });

  it('a duplicated first node is nodes_not_ascending_unique as well', () => {
    const dv = new DataView(EV.buffer, EV.byteOffset, EV.length);
    const n0 = dv.getUint32(O.nodesCount + 4, false);
    const first = EV.subarray(O.nodesCount + 4, O.nodesCount + 8 + n0);
    const out = new Uint8Array(EV.length + first.length);
    out.set(EV.subarray(0, O.nodesCount + 4 + first.length), 0);
    out.set(first, O.nodesCount + 4 + first.length);
    out.set(EV.subarray(O.nodesCount + 4 + first.length), O.nodesCount + 4 + 2 * first.length);
    const bumped = setU32(out, O.nodesCount, dv.getUint32(O.nodesCount, false) + 1);
    expect(registered(named(bumped)).fields.reason).toBe('nodes_not_ascending_unique');
  });
});

describe('truncation', () => {
  /** every byte of the container header and the LC head, every structural boundary +-3, a stride through the rest, and the last 700 bytes */
  const cuts = (): number[] => {
    const s = new Set<number>();
    for (let i = 0; i <= 700; i++) s.add(i);
    for (let i = 700; i < EV.length; i += 53) s.add(i);
    for (let i = Math.max(0, EV.length - 700); i < EV.length; i++) s.add(i);
    for (const b of [O.hdr, O.linksCount, O.lcEnd, O.l1Count, O.stateBlock, O.gameProxy, O.codeLen, O.outIdx, O.l2Count, O.nodesCount]) {
      for (let d = -3; d <= 3; d++) s.add(b + d);
    }
    return [...s].filter((x) => x >= 0 && x < EV.length).sort((a, b) => a - b);
  };

  it('every truncation of the live container is a named, registered state (never accepted, never an unnamed error)', () => {
    const codes = new Set<string>();
    let n = 0;
    for (const cut of cuts()) {
      const e = registered(named(EV.subarray(0, cut)));
      codes.add(e.code);
      n++;
    }
    expect(n).toBeGreaterThan(1500);
    expect(codes.has('finality_evidence_malformed')).toBe(true);
  }, 300_000);

  it('the body codec alone refuses every strict prefix of the body with a named state', () => {
    const body = decodeContainer(EV, lim).body;
    for (let cut = 0; cut < body.length; cut += 37) {
      let threw: unknown;
      try {
        decodeBody(body.subarray(0, cut), lim, ep, 1024);
      } catch (e) {
        threw = e;
      }
      expect(threw instanceof FinalityStateError, `cut ${cut}`).toBe(true);
    }
  });
});
