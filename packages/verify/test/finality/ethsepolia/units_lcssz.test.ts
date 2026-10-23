/**
 * The lcssz locators (twin of pkg/finality/lcssz): fixed sizes pinned to the real objects, the conversions checked against independent
 * readers, hostile inputs (every shape around the fixed parts, hostile lengths, wrap boundaries) and exact boundaries (N passes, N-1 fails).
 * No function may throw anything but an LcsszError, and the fixed `slice bounds [2292:2056]` shape of V-C2-A1 D3 is a named error.
 */
import { describe, expect, it, vi } from 'vitest';
import * as L from '../../../src/proof-v2/finality/ethsepolia/lcssz.js';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { hashTreeRootSyncCommitteeChecked } from '../../../src/proof-v2/finality/ethl1/index.js';
import { readHeader } from '../../../src/proof-v2/finality/rlpheader.js';
import { read } from './vectorset.js';
import { recorded } from './recorded.js';

// real verifications of 3 MB objects: a loaded machine must not read a slow decode as a failure
vi.setConfig({ testTimeout: 300_000 });

const u64 = (b: Uint8Array, at: number): bigint => new DataView(b.buffer, b.byteOffset).getBigUint64(at, true);

/** An Electra-layout finality update of n bytes whose two offsets are attOff and finOff; the rest is zero. */
function electraFU(n: number, attOff: number, finOff: number): Uint8Array {
  const fu = new Uint8Array(n);
  if (n >= 8) {
    const dv = new DataView(fu.buffer);
    dv.setUint32(0, attOff, true);
    dv.setUint32(4, finOff, true);
  }
  return fu;
}

const throwsLcssz = (f: () => unknown, what: string): L.LcsszError => {
  try {
    f();
  } catch (e) {
    expect(e instanceof RangeError, `${what}: a RangeError escaped`).toBe(false);
    expect(e, what).toBeInstanceOf(L.LcsszError);
    return e as L.LcsszError;
  }
  throw new Error(`${what}: accepted`);
};

describe('sizes', () => {
  it('the fixed sizes are those of the real objects', () => {
    expect(L.CommitteeBytes).toBe(24624);
    expect([L.GloasUpdateSize, L.GloasFinalityUpdateSize, L.GloasBootstrapSize]).toEqual([26424, 1448, 25472]);
    expect(L.SIZES.electraUpdateFixed).toBe(25216);
    expect(L.SIZES.electraFinalityUpdateFixed).toBe(400);
    expect(L.SIZES.electraBootstrapFixed).toBe(24820);
    expect(L.SIZES.electraHeaderFixed).toBe(244);
    // the real root-pin bootstrap (electra layout, 25,679 B) is its fixed part plus the header's execution payload header
    const boot = Uint8Array.from(read('eth_sepolia1', 'raw/links/1378.ssz'));
    expect(boot.length).toBeGreaterThanOrEqual(L.SIZES.electraBootstrapFixed);
    expect(L.layoutOfBootstrap(boot)).toBe(L.Electra);
  });
});

describe('the real objects', () => {
  const pins = parsePinsOverride(read('eth_sepolia1', 'pins/main.json'));
  const anchors = pins.ethSepolia!.anchors;

  it('the committee of every ledger link and of the root bootstrap hashes to the committee_root the ledger pins', () => {
    for (const a of anchors) {
      const raw = Uint8Array.from(read('eth_sepolia1', `raw/links/${a.period}.ssz`));
      const body = a.blockRoot !== '' ? L.bootstrapCommittee(L.layoutOfBootstrap(raw), raw) : L.nextCommittee(L.layoutOfUpdate(raw), raw);
      expect(body.length).toBe(L.CommitteeBytes);
      expect('0x' + Buffer.from(hashTreeRootSyncCommitteeChecked(body)).toString('hex'), String(a.period)).toBe(a.committeeRoot);
    }
  });

  it('the finality projection of a Gloas update is 1,448 bytes whose slots are the update\'s own', () => {
    const up = Uint8Array.from(read('eth_sepolia1', 'raw/links/1385.ssz'));
    expect(up.length).toBe(L.GloasUpdateSize);
    const fu = L.updateToFinalityUpdate(L.Gloas, up);
    expect(fu.length).toBe(L.GloasFinalityUpdateSize);
    const finAt = 496 + L.CommitteeBytes + 11 * 32;
    const s = L.updateSlots(L.Gloas, up);
    expect([s.attested, s.finalized, s.signature]).toEqual([u64(up, 0), u64(up, finAt), u64(up, up.length - 8)]);
    expect(L.finalityUpdateSlots(L.layoutOfFinalityUpdate(fu), fu)).toEqual(s);
    // the projection holds the attested header, the finalized header, the finality branch and the aggregate verbatim
    expect(Buffer.from(fu.subarray(0, 496)).equals(Buffer.from(up.subarray(0, 496)))).toBe(true);
    expect(Buffer.from(fu.subarray(496, 992)).equals(Buffer.from(up.subarray(finAt, finAt + 496)))).toBe(true);
    expect(Buffer.from(fu.subarray(992)).equals(Buffer.from(up.subarray(finAt + 496)))).toBe(true);
    // participants: the popcount of the 64 sync bits, which the vector's participation case also pins
    const bits = fu.subarray(2 * 496 + 9 * 32, 2 * 496 + 9 * 32 + 64);
    let n = 0;
    for (const b of bits) for (let x = b; x; x &= x - 1) n++;
    expect(L.finalityUpdateParticipants(L.Gloas, fu)).toBe(n);
    expect(n).toBeGreaterThanOrEqual(342);
  });

  it('finalizedExec of the real legs: the electra hash and number are the head of the spine; a Gloas header carries the hash only', () => {
    const legacy = recorded('eth_sepolia1', 'legacy');
    const fu = legacy.body.lc.finalUpdate.ssz;
    expect(L.layoutOfFinalityUpdate(fu)).toBe(L.Electra);
    const e = L.finalizedExec(L.Electra, fu);
    const top = readHeader(legacy.body.spine[0]!);
    expect(e.hasNumber).toBe(true);
    expect(e.number).toBe(top.number);
    expect(Buffer.from(e.hash).equals(Buffer.from(keccak_256(legacy.body.spine[0]!)))).toBe(true);
    const gl = recorded('eth_sepolia1', 'gloas_latest');
    const g = L.finalizedExec(L.Gloas, gl.body.lc.finalUpdate.ssz);
    expect(g.hasNumber).toBe(false);
    expect(g.number).toBe(0n);
    expect(Buffer.from(g.hash).equals(Buffer.from(keccak_256(gl.body.spine[0]!)))).toBe(true);
    expect(L.finalityUpdateParticipants(L.Electra, fu)).toBeGreaterThanOrEqual(342);
  });

  it('a synthetic electra update converts: offsets 400 and 400+len(att), the tail and both headers carried verbatim', () => {
    const attLen = 300;
    const finLen = 500;
    const n = L.SIZES.electraUpdateFixed + attLen + finLen;
    const up = new Uint8Array(n);
    for (let i = 0; i < n; i++) up[i] = (i * 31 + 7) & 0xff;
    const dv = new DataView(up.buffer);
    const finOffAt = 4 + L.CommitteeBytes + 6 * 32;
    dv.setUint32(0, L.SIZES.electraUpdateFixed, true);
    dv.setUint32(finOffAt, L.SIZES.electraUpdateFixed + attLen, true);
    const fu = L.updateToFinalityUpdate(L.Electra, up);
    expect(fu.length).toBe(400 + attLen + finLen);
    const fdv = new DataView(fu.buffer);
    expect([fdv.getUint32(0, true), fdv.getUint32(4, true)]).toEqual([400, 400 + attLen]);
    expect(Buffer.from(fu.subarray(8, 400)).equals(Buffer.from(up.subarray(finOffAt + 4, finOffAt + 4 + 392)))).toBe(true);
    expect(Buffer.from(fu.subarray(400)).equals(Buffer.from(up.subarray(L.SIZES.electraUpdateFixed)))).toBe(true);
    expect(L.nextCommittee(L.Electra, up).length).toBe(L.CommitteeBytes);
  });
});

describe('exact boundaries (N passes, N-1 fails)', () => {
  it('an electra finality update must be at least 2,056 bytes with attested offset exactly 400 and finalized offset in (400, len-8]', () => {
    expect(() => L.finalityUpdateSlots(L.Electra, electraFU(2056, 400, 1228))).not.toThrow();
    throwsLcssz(() => L.finalityUpdateSlots(L.Electra, electraFU(2055, 400, 1228)), 'one byte short');
    throwsLcssz(() => L.finalityUpdateSlots(L.Electra, electraFU(2056, 399, 1228)), 'attested offset 399');
    throwsLcssz(() => L.finalityUpdateSlots(L.Electra, electraFU(2056, 401, 1228)), 'attested offset 401');
    throwsLcssz(() => L.finalityUpdateSlots(L.Electra, electraFU(2056, 400, 400)), 'finalized offset == attested offset');
    expect(() => L.finalityUpdateSlots(L.Electra, electraFU(2056, 400, 2048))).not.toThrow(); // finOff + 8 == len
    throwsLcssz(() => L.finalityUpdateSlots(L.Electra, electraFU(2056, 400, 2049)), 'finOff + 8 > len');
  });

  it('finalizedExec: the finalized header must hold the 828 fixed bytes (finOff <= len-828); one more is the named too-short error', () => {
    const len = 4000;
    expect(() => L.finalizedExec(L.Electra, electraFU(len, 400, len - 828))).not.toThrow();
    const e = (() => {
      try {
        L.finalizedExec(L.Electra, electraFU(len, 400, len - 827));
      } catch (x) {
        return x;
      }
      return undefined;
    })();
    expect(e).toBeInstanceOf(L.FinalizedHeaderTooShortError);
    // the reviewer's probe of V-C2-A1 D3: 2,056 bytes, finalized offset 2,048 (slice bounds [2292:2056] in Go)
    const p = electraFU(2056, 400, 2048);
    expect(() => L.finalityUpdateSlots(L.Electra, p)).not.toThrow();
    expect(() => L.finalizedExec(L.Electra, p)).toThrow(L.FinalizedHeaderTooShortError);
  });

  it('electra update and bootstrap minimum sizes, the Gloas exact sizes', () => {
    expect(() => L.nextCommittee(L.Electra, new Uint8Array(25216))).not.toThrow();
    throwsLcssz(() => L.nextCommittee(L.Electra, new Uint8Array(25215)), 'update 25,215');
    expect(() => L.bootstrapCommittee(L.Electra, new Uint8Array(24820))).not.toThrow();
    throwsLcssz(() => L.bootstrapCommittee(L.Electra, new Uint8Array(24819)), 'bootstrap 24,819');
    for (const [size, f] of [[26424, (b: Uint8Array) => L.nextCommittee(L.Gloas, b)], [25472, (b: Uint8Array) => L.bootstrapCommittee(L.Gloas, b)], [1448, (b: Uint8Array) => L.finalityUpdateSlots(L.Gloas, b)]] as const) {
      expect(() => f(new Uint8Array(size))).not.toThrow();
      throwsLcssz(() => f(new Uint8Array(size - 1)), `gloas ${size - 1}`);
      throwsLcssz(() => f(new Uint8Array(size + 1)), `gloas ${size + 1}`);
    }
    expect(L.layoutOfUpdate(new Uint8Array(26424))).toBe(L.Gloas);
    expect(L.layoutOfUpdate(new Uint8Array(26425))).toBe(L.Electra);
    expect(L.layoutOfFinalityUpdate(new Uint8Array(1448))).toBe(L.Gloas);
    expect(L.layoutOfFinalityUpdate(new Uint8Array(1449))).toBe(L.Electra);
    expect(L.layoutOfBootstrap(new Uint8Array(25472))).toBe(L.Gloas);
    expect(L.layoutOfBootstrap(new Uint8Array(25473))).toBe(L.Electra);
  });

  it('an electra update converts with the finalized offset in [attested offset, len] and refuses outside it', () => {
    const base = L.SIZES.electraUpdateFixed;
    const finOffAt = 4 + L.CommitteeBytes + 6 * 32;
    const build = (n: number, attOff: number, finOff: number): Uint8Array => {
      const up = new Uint8Array(n);
      const dv = new DataView(up.buffer);
      dv.setUint32(0, attOff, true);
      dv.setUint32(finOffAt, finOff, true);
      return up;
    };
    const n = base + 100;
    expect(() => L.updateToFinalityUpdate(L.Electra, build(n, base, base))).not.toThrow();
    expect(() => L.updateToFinalityUpdate(L.Electra, build(n, base, n))).not.toThrow();
    throwsLcssz(() => L.updateToFinalityUpdate(L.Electra, build(n, base, n + 1)), 'finOff > len');
    throwsLcssz(() => L.updateToFinalityUpdate(L.Electra, build(n, base, base - 1)), 'finOff < attOff');
    throwsLcssz(() => L.updateToFinalityUpdate(L.Electra, build(n, base + 1, base + 1)), 'attOff != fixed');
    throwsLcssz(() => L.updateToFinalityUpdate(L.Electra, build(n, base - 1, base)), 'attOff != fixed (low)');
    throwsLcssz(() => L.updateToFinalityUpdate(7, new Uint8Array(100)), 'unknown layout');
  });
});

describe('hostile shapes', () => {
  it('no function throws anything but an LcsszError for any length and offset pair around the fixed parts, for every layout byte', () => {
    const lens = new Set<number>([0, 1, 7, 8, 9]);
    for (const base of [400, 400 + 2 * 828, 25216, 24820, 1448, 26424, 25472]) for (let d = -3; d <= 3; d++) lens.add(base + d);
    for (let d = 0; d <= 40; d++) lens.add(2056 + d * 8);
    const offs = new Set<number>([0, 1, 4, 8]);
    for (const base of [400, 25216, 2056, 2048, 2052, 2056 - 244, 2056 - 244 - 584, 1228, 1229, 1227, 1000000, 2 ** 31 - 1]) for (let d = -3; d <= 3; d++) offs.add(base + d);
    let shapes = 0;
    for (const ln of lens) {
      if (ln < 0) continue;
      for (const off of offs) {
        for (let layout = 0; layout <= 3; layout++) {
          const fu = new Uint8Array(ln);
          if (ln >= 8) {
            const dv = new DataView(fu.buffer);
            dv.setUint32(0, 400, true);
            dv.setUint32(4, off >>> 0, true);
          }
          if (ln >= 25216) {
            const dv = new DataView(fu.buffer);
            dv.setUint32(0, 25216, true);
            dv.setUint32(4 + L.CommitteeBytes + 6 * 32, off >>> 0, true);
          }
          shapes++;
          for (const f of [
            () => L.finalityUpdateSlots(layout, fu),
            () => L.finalizedExec(layout, fu),
            () => L.finalityUpdateParticipants(layout, fu),
            () => L.updateSlots(layout, fu),
            () => L.updateToFinalityUpdate(layout, fu),
            () => L.nextCommittee(layout, fu),
            () => L.bootstrapCommittee(layout, fu),
            () => L.splitFramedUpdates(fu),
          ]) {
            try {
              f();
            } catch (e) {
              if (!(e instanceof L.LcsszError)) throw new Error(`len ${ln} offset ${off} layout ${layout}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
            }
          }
        }
      }
    }
    expect(shapes).toBeGreaterThan(1000);
  });

  it('a layout byte that is neither electra nor gloas is an unknown-layout error in every function', () => {
    for (const l of [0, 3, 255]) {
      for (const f of [L.nextCommittee, L.bootstrapCommittee, L.updateToFinalityUpdate, L.finalityUpdateSlots, L.updateSlots, L.finalizedExec, L.finalityUpdateParticipants]) {
        expect(throwsLcssz(() => f(l, new Uint8Array(30000)), `layout ${l}`).message).toContain('unknown layout');
      }
    }
  });
});

describe('splitFramedUpdates', () => {
  const frame = (n: bigint, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setBigUint64(0, n, true);
    out.set(payload, 8);
    return out;
  };
  const cat = (...p: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(p.reduce((a, b) => a + b.length, 0));
    let o = 0;
    for (const x of p) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  };

  it('splits well-formed frames into the object and the (diagnostic) digest', () => {
    const a = Uint8Array.of(1, 2, 3, 4, 9, 9, 9);
    const b = Uint8Array.of(5, 6, 7, 8);
    const r = L.splitFramedUpdates(cat(frame(7n, a), frame(4n, b)));
    expect(r.objs.map((o) => Array.from(o))).toEqual([[9, 9, 9], []]);
    expect(r.digests.map((d) => Array.from(d))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    expect(L.splitFramedUpdates(new Uint8Array(0)).objs).toEqual([]);
  });

  it('the length bound is exact: a length of the bytes that remain passes, one more is refused; below 4 is refused', () => {
    const payload = Uint8Array.of(1, 2, 3, 4, 5);
    expect(() => L.splitFramedUpdates(frame(5n, payload))).not.toThrow();
    throwsLcssz(() => L.splitFramedUpdates(frame(6n, payload)), 'one byte too long');
    expect(() => L.splitFramedUpdates(frame(4n, payload.subarray(0, 4)))).not.toThrow();
    throwsLcssz(() => L.splitFramedUpdates(frame(3n, payload)), 'length 3');
    throwsLcssz(() => L.splitFramedUpdates(frame(0n, payload)), 'length 0');
  });

  it('a truncated frame header and hostile 64-bit lengths are refused without any allocation', () => {
    throwsLcssz(() => L.splitFramedUpdates(new Uint8Array(11)), 'eleven bytes');
    for (const n of [0xffffffffffffffffn, 0x8000000000000000n, 0x100000000n, 0xfffffffffffffff8n]) {
      throwsLcssz(() => L.splitFramedUpdates(frame(n, Uint8Array.of(1, 2, 3, 4, 5))), `length ${n}`);
    }
    // a second frame that overruns after a good first one
    throwsLcssz(() => L.splitFramedUpdates(cat(frame(5n, Uint8Array.of(1, 2, 3, 4, 5)), frame(100n, Uint8Array.of(1, 2, 3, 4)))), 'second frame overruns');
  });
});

describe('finalityUpdateParticipants', () => {
  it('counts the set sync bits of both layouts', () => {
    const g = new Uint8Array(1448);
    g.fill(0xff, 1280, 1344);
    g[1280] = 0x0f; // 4 bits instead of 8
    expect(L.finalityUpdateParticipants(L.Gloas, g)).toBe(63 * 8 + 4);
    const e = new Uint8Array(400 + 1656);
    e.fill(0x01, 232, 296);
    expect(L.finalityUpdateParticipants(L.Electra, e)).toBe(64);
    throwsLcssz(() => L.finalityUpdateParticipants(L.Electra, new Uint8Array(399)), 'electra 399');
    expect(() => L.finalityUpdateParticipants(L.Electra, new Uint8Array(400))).not.toThrow();
  });
});
