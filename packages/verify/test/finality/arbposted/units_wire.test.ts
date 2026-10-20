/**
 * The container body codec (wire.ts) and the hostile-input behaviour of the whole kind: a container cut at any byte, absurd counts and
 * lengths, bad enums, trailing bytes. A verifier must refuse every one of them with a NAMED state, quickly, and never throw anything else.
 */
import { describe, expect, it } from 'vitest';
import { decodeContainer, defaultLimits, encodeContainer } from '../../../src/proof-v2/finality/codec.js';
import { encodeLC } from '../../../src/proof-v2/finality/ethl1/index.js';
import { Level } from '../../../src/proof-v2/finality/level.js';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { ArbPostedKind } from '../../../src/proof-v2/finality/arbposted/verify.js';
import { DataBlobs, DataCalldata, DataNone, decodeEvidence, defaultBounds, encodeEvidence, type Evidence } from '../../../src/proof-v2/finality/arbposted/wire.js';
import { evidenceOf, loadCase, read, refOf } from './vectorset.js';
import { concat, makeSynth, u64be } from './synth.js';

const lim = defaultLimits();
const bounds = defaultBounds(lim);

/** the canonical text of what verify throws for these bytes, or `ok` for a verdict, or `UNNAMED` for any other throw */
function judge(kind: ArbPostedKind, pinsFile: string, caseId: string): (evidence: Uint8Array) => string {
  const pins = parsePinsOverride(read(pinsFile));
  const ref = refOf(loadCase(caseId).leg);
  return (evidence) => {
    try {
      kind.verify(pins, ref, evidence);
      return 'ok';
    } catch (e) {
      return e instanceof FinalityStateError ? e.canonical() : `UNNAMED ${String(e)}`;
    }
  };
}

function bodyOf(caseId: string): Uint8Array {
  return decodeContainer(evidenceOf(loadCase(caseId)), lim).body;
}

describe('encode(decode(x)) == x on the published evidence', () => {
  for (const id of ['valid_live', 'synth_valid_calldata', 'synth_valid_blob', 'synth_valid_delayed_deposit']) {
    it(id, () => {
      const body = bodyOf(id);
      const ev = decodeEvidence(body, bounds);
      expect(encodeEvidence(ev)).toEqual(Uint8Array.from(body));
    });
  }
  it('the live evidence has three blobs, three versioned hashes, a populated node set and no delayed section', () => {
    const ev = decodeEvidence(bodyOf('valid_live'), bounds);
    expect(ev.dataKind).toBe(DataBlobs);
    expect(ev.blobs.length).toBe(3);
    expect(ev.versionedHashes.length).toBe(3);
    expect(ev.delayed).toBeNull();
    expect(ev.nodes.length).toBeGreaterThan(5);
    expect(ev.header40[4]).toBeGreaterThanOrEqual(0n);
  });
  it('the delayed section round-trips field by field', () => {
    const ev = decodeEvidence(bodyOf('synth_valid_delayed_deposit'), bounds);
    expect(ev.delayed).not.toBeNull();
    expect(ev.delayed!.msgKind).toBe(12);
    expect(ev.delayed!.k).toBe(41n);
    expect(ev.delayed!.data.length).toBe(52);
  });
  it('encodeEvidence sorts and deduplicates the node set into the canonical order', () => {
    const ev = decodeEvidence(bodyOf('synth_valid_calldata'), bounds);
    const shuffled: Evidence = { ...ev, nodes: [...ev.nodes].reverse().concat(ev.nodes.slice(0, 2)) };
    expect(encodeEvidence(shuffled)).toEqual(encodeEvidence(ev));
  });
});

describe('a container cut at any byte is a named refusal', () => {
  it('every prefix of the 29,780-byte calldata container (and the empty one)', () => {
    const full = evidenceOf(loadCase('synth_valid_calldata'));
    const kind = new ArbPostedKind();
    const pins = parsePinsOverride(read('pins/synth.json'));
    const ref = refOf(loadCase('synth_valid_calldata').leg);
    const seen = new Map<string, number>();
    for (let n = 0; n < full.length; n++) {
      try {
        kind.verify(pins, ref, full.subarray(0, n));
        throw new Error(`a prefix of ${n} bytes was accepted`);
      } catch (e) {
        if (!(e instanceof FinalityStateError)) throw new Error(`prefix ${n}: unnamed ${String(e)}`);
        seen.set(e.code, (seen.get(e.code) ?? 0) + 1);
        if (n < 8) expect(e.code).toBe('finality_evidence_malformed');
      }
    }
    expect([...seen.keys()].sort()).toEqual(['finality_evidence_malformed']);
    expect(full.length).toBe(29780);
  });

  it('every prefix of the delayed-deposit container, and of the live container at every structural byte and a stride through the blobs', () => {
    const kind = new ArbPostedKind();
    const delayed = evidenceOf(loadCase('synth_valid_delayed_deposit'));
    const judgeDelayed = judge(kind, 'pins/synth.json', 'synth_valid_delayed_deposit');
    for (let n = 0; n < delayed.length; n += 1) {
      expect(judgeDelayed(delayed.subarray(0, n)), `delayed ${n}`).toMatch(/^\{"code":"finality_evidence_(malformed|too_large)"/);
    }
    const judgeLive = judge(kind, 'pins/main.json', 'valid_live');
    const live = evidenceOf(loadCase('valid_live'));
    const cuts: number[] = [];
    for (let n = 0; n < 700; n++) cuts.push(n);
    for (let n = 700; n < 31_400; n += 53) cuts.push(n);
    for (let n = 31_400; n < live.length - 12_300; n += 20_011) cuts.push(n);
    for (let n = live.length - 12_300; n < live.length; n += 97) cuts.push(n);
    cuts.push(live.length - 1);
    for (const n of cuts) {
      expect(judgeLive(live.subarray(0, n)), `live ${n}`).toMatch(/^\{"code":"finality_evidence_(malformed|too_large)"/);
    }
  });

  it('a byte after the container is trailing_bytes of the body; the cut and the extension never share a state', () => {
    const kind = new ArbPostedKind();
    const live = evidenceOf(loadCase('valid_live'));
    expect(judge(kind, 'pins/main.json', 'valid_live')(concat(live, Uint8Array.of(0)))).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"1","part":"body","reason":"trailing_bytes","want_len":"0"}}',
    );
  });
});

describe('absurd counts and lengths never allocate and are named', () => {
  /** the byte offset of each count / length field of a synthetic container body, from the encoder's own layout */
  function layout(ev: Evidence): Record<string, number> {
    const lc = encodeLC(ev.lc).length;
    const o: Record<string, number> = {};
    o.profileLen = 0;
    o.l1Spine = lc;
    let p = lc + 4;
    for (const h of ev.l1Spine) p += 4 + h.length;
    p += 8; // stateBlock
    o.blockTxs = p;
    p += 4;
    for (const t of ev.blockTxs) p += 4 + t.length;
    p += 8 + 40 + 32 + 32; // batchSeq, header40, beforeAcc, delayedAcc
    o.dataKind = p;
    p += 1;
    if (ev.dataKind === DataCalldata) {
      o.calldata = p;
      p += 4 + ev.calldata.length;
    }
    o.delayedFlag = p;
    p += 1;
    if (ev.delayed !== null) {
      o.delayedData = p + 1 + 20 + 8 + 8 + 32;
      p += 1 + 20 + 8 + 8 + 32 + 4 + ev.delayed.data.length + 8;
    }
    o.nodes = p;
    return o;
  }
  const decodeFrom = (body: Uint8Array): FinalityStateError => {
    const t0 = Date.now();
    try {
      decodeEvidence(body, bounds);
    } catch (e) {
      expect(Date.now() - t0).toBeLessThan(500);
      return e as FinalityStateError;
    }
    throw new Error('accepted');
  };
  const put32 = (b: Uint8Array, at: number, v: number): Uint8Array => {
    const out = Uint8Array.from(b);
    new DataView(out.buffer).setUint32(at, v, false);
    return out;
  };

  const s = makeSynth({ delayed: { msg: { msgKind: 12, sender: new Uint8Array(20), msgBlockNumber: 1n, msgTimestamp: 2n, baseFeeL1: new Uint8Array(32), data: new Uint8Array(52), k: 0n } }, afterDelayed: 1n });
  const body = encodeEvidence(s.ev);
  const at = layout(s.ev);

  it('the layout helper matches the encoder (a sanity check on the offsets used below)', () => {
    expect(new DataView(body.buffer, body.byteOffset).getUint32(at.l1Spine!, false)).toBe(0);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(at.blockTxs!, false)).toBe(s.ev.blockTxs.length);
    expect(body[at.dataKind!]).toBe(DataCalldata);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(at.calldata!, false)).toBe(s.ev.calldata.length);
    expect(body[at.delayedFlag!]).toBe(1);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(at.nodes!, false)).toBe(s.ev.nodes.length);
    expect(decodeEvidence(body, bounds).delayed!.data.length).toBe(52);
  });
  it('a list count of 2^32-1 is evidence_too_large (bound) for every list; a count within the bound but beyond the bytes is count_exceeds_remaining', () => {
    for (const [part, off] of [
      ['l1Spine', at.l1Spine!],
      ['blockTxs', at.blockTxs!],
      ['nodes', at.nodes!],
    ] as const) {
      const e = decodeFrom(put32(body, off, 0xffffffff));
      expect(e.code, part).toBe('finality_evidence_too_large');
      expect(e.fields.part).toBe(part);
      expect(e.fields.count).toBe(0xffffffffn);
    }
    const within = decodeFrom(put32(body, at.l1Spine!, 16384));
    expect(within.code).toBe('finality_evidence_malformed');
    expect(within.fields.reason).toBe('count_exceeds_remaining');
    const within2 = decodeFrom(put32(body, at.blockTxs!, 65536));
    expect(within2.fields.reason).toBe('count_exceeds_remaining');
    const one = decodeFrom(put32(body, at.nodes!, 8193));
    expect(one.code).toBe('finality_evidence_too_large');
  });
  it('a byte-string length of 2^32-1 is evidence_too_large (calldata, delayed data); one within the bound but beyond the bytes is length_exceeds_remaining', () => {
    const c = decodeFrom(put32(body, at.calldata!, 0xffffffff));
    expect(c.code).toBe('finality_evidence_too_large');
    expect(c.fields.part).toBe('calldata');
    const d = decodeFrom(put32(body, at.delayedData!, 0xffffffff));
    expect(d.fields.part).toBe('delayed.data');
    const c2 = decodeFrom(put32(body, at.calldata!, 2_097_152));
    expect(c2.fields.reason).toBe('length_exceeds_remaining');
    const c3 = decodeFrom(put32(body, at.calldata!, 2_097_153));
    expect(c3.code).toBe('finality_evidence_too_large');
  });
  it('the LC part: a string length, a link count and a part length at 2^32-1 are named without allocating', () => {
    const lcBody = (mut: (b: Uint8Array) => void): Uint8Array => {
      const b = Uint8Array.from(body);
      mut(b);
      return b;
    };
    const prof = decodeFrom(lcBody((b) => new DataView(b.buffer).setUint32(0, 0xffffffff, false)));
    expect(prof.fields.part).toBe('lc.profile');
    expect(prof.code).toBe('finality_evidence_too_large');
    // anchorBody: layout byte at 4+8+1+... = profile(4+8) kind(1) period(8) root(32) -> layout at 53, its length at 54
    const ab = decodeFrom(lcBody((b) => new DataView(b.buffer).setUint32(54, 0xffffffff, false)));
    expect(ab.fields.part).toBe('lc.anchorBody');
    expect(ab.fields.reason).toBe('length_exceeds_remaining');
    // the link count follows the anchor body (4+8 + 1 + 8 + 32 + 1 + 4 + 0 = 58)
    const lk = decodeFrom(lcBody((b) => new DataView(b.buffer).setUint32(58, 0xffffffff, false)));
    expect(lk.fields.part).toBe('lc.links');
    expect(lk.code).toBe('finality_evidence_too_large');
    expect(lk.fields.limit).toBe(64n);
    const lk2 = decodeFrom(lcBody((b) => new DataView(b.buffer).setUint32(58, 64, false)));
    expect(lk2.fields).toMatchObject({ part: 'lc.link', reason: 'length_exceeds_remaining' });
  });
  it('blob mode: versionedHashes and blobs counts at 2^32-1 and at the pin; a blob of 131,071 bytes is named truncated', () => {
    const live = bodyOf('valid_live');
    const ev = decodeEvidence(live, bounds);
    const lcLen = encodeLC(ev.lc).length;
    let p = lcLen + 4;
    for (const h of ev.l1Spine) p += 4 + h.length;
    p += 8 + 4;
    for (const t of ev.blockTxs) p += 4 + t.length;
    p += 8 + 40 + 32 + 32 + 1;
    const vh = p;
    const big = decodeFrom(put32(live, vh, 0xffffffff));
    expect(big.fields.part).toBe('versionedHashes');
    expect(big.fields.count).toBe(0xffffffffn);
    expect(big.fields.limit).toBe(16n);
    const bl = vh + 4 + 32 * 3;
    expect(new DataView(live.buffer, live.byteOffset).getUint32(bl, false)).toBe(3);
    const bb = decodeFrom(put32(live, bl, 0xffffffff));
    expect(bb.fields.part).toBe('blobs');
    expect(bb.code).toBe('finality_evidence_too_large');
    const bb2 = decodeFrom(put32(live, bl, 16));
    expect(bb2.fields.reason).toBe('count_exceeds_remaining');
    const short = decodeFrom(put32(live, bl + 4, 131_071));
    expect(short.fields).toMatchObject({ part: 'blobs.raw', reason: 'truncated', index: 0n });
    const longer = decodeFrom(put32(live, bl + 4, 131_073));
    expect(longer.code).toBe('finality_evidence_too_large');
    expect(longer.fields.limit).toBe(131_072n);
  });
  it('bad enum values: dataKind other than 1, 2, 3 and delayedFlag other than 0, 1', () => {
    for (const v of [0, 4, 255]) {
      const b = Uint8Array.from(body);
      b[at.dataKind!] = v;
      const e = decodeFrom(b);
      expect(e.fields).toMatchObject({ part: 'dataKind', reason: 'bad_enum_value', got_len: BigInt(v), want_len: 3n });
    }
    for (const v of [2, 255]) {
      const b = Uint8Array.from(body);
      b[at.delayedFlag!] = v;
      expect(decodeFrom(b).fields).toMatchObject({ part: 'delayedFlag', reason: 'bad_enum_value', got_len: BigInt(v), want_len: 1n });
    }
  });
  it('dataKind 3 carries no Data bytes: the same body with the calldata cut out decodes as none', () => {
    const none: Evidence = { ...s.ev, dataKind: DataNone, calldata: new Uint8Array(0), delayed: null };
    const ev = decodeEvidence(encodeEvidence(none), bounds);
    expect(ev.dataKind).toBe(DataNone);
    expect(ev.calldata.length).toBe(0);
  });
  it('a node set out of order, duplicated or unsorted is refused at its index; the canonical order is accepted', () => {
    const ev = decodeEvidence(bodyOf('synth_valid_calldata'), bounds);
    const w = (nodes: Uint8Array[]): Uint8Array => {
      // encodeEvidence sorts; build the unsorted body by splicing the node section by hand
      const base = encodeEvidence({ ...ev, nodes: [] });
      const parts: Uint8Array[] = [base.subarray(0, base.length - 4), u64be(0).subarray(0, 0)];
      const out: number[] = [];
      new DataView(new ArrayBuffer(4)).setUint32(0, nodes.length);
      const count = new Uint8Array(4);
      new DataView(count.buffer).setUint32(0, nodes.length, false);
      parts.push(count);
      for (const n of nodes) {
        const l = new Uint8Array(4);
        new DataView(l.buffer).setUint32(0, n.length, false);
        parts.push(l, n);
      }
      void out;
      return concat(...parts);
    };
    expect(decodeEvidence(w(ev.nodes), bounds).nodes.length).toBe(ev.nodes.length);
    expect(decodeFrom(w([...ev.nodes].reverse())).fields.reason).toBe('nodes_not_ascending_unique');
    expect(decodeFrom(w([ev.nodes[0]!, ev.nodes[0]!])).fields.reason).toBe('nodes_not_ascending_unique');
  });
});

describe('the container header', () => {
  it('a kind string, chain or level other than this kind is finality_evidence_unrecognised with the kind it carried and an empty version', () => {
    const kind = new ArbPostedKind();
    const c = loadCase('synth_valid_calldata');
    const ev = evidenceOf(c);
    const dec = decodeContainer(ev, lim);
    const pins = parsePinsOverride(read('pins/synth.json'));
    for (const h of [
      { ...dec.header, chain: 84532n },
      { ...dec.header, level: Level.Finalized },
      { ...dec.header, kind: 'arb-sepolia/l1_posted/v2' },
    ]) {
      try {
        kind.verify(pins, refOf(c.leg), encodeContainer({ header: h, body: dec.body }));
        throw new Error('accepted');
      } catch (e) {
        expect((e as FinalityStateError).canonical()).toBe(`{"code":"finality_evidence_unrecognised","fields":{"kind":${JSON.stringify(h.kind)},"version":""}}`);
      }
    }
  });
});

/** xorshift32: a fixed seed, so a failure reproduces */
function prng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

describe('seeded corruption never produces an unnamed error', () => {
  it('4,000 corrupted copies of the calldata and the delayed bodies decode to a body or a named state', () => {
    const rnd = prng(0x5eed);
    const bodies = ['synth_valid_calldata', 'synth_valid_delayed_deposit'].map((id) => bodyOf(id));
    let refused = 0;
    let decoded = 0;
    for (let i = 0; i < 4000; i++) {
      const b = Uint8Array.from(bodies[i % 2]!);
      const flips = 1 + (rnd() % 3);
      for (let f = 0; f < flips; f++) {
        // half the flips land in the first 400 bytes, where the lengths and counts are
        const at = rnd() % 2 === 0 ? rnd() % 400 : rnd() % b.length;
        b[at] = rnd() & 0xff;
      }
      try {
        decodeEvidence(b, bounds);
        decoded++;
      } catch (e) {
        if (!(e instanceof FinalityStateError)) throw new Error(`iteration ${i}: unnamed ${String(e)}`);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(50);
    expect(decoded).toBeGreaterThan(500);
  });
});
