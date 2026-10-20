/**
 * Exact-boundary tests of the strict electra decoders and of the empty-header rule (the twin of the validator's size-boundary and
 * empty-header unit tests): every length and offset boundary is probed on both sides, because a vector set holds only the real
 * sizes. Each refusal is the exact finality_evidence_malformed state Go names.
 */
import { describe, expect, it } from 'vitest';
import {
  Layout,
  decodeElectraBootstrap,
  decodeElectraFinalityUpdate,
  decodeElectraHeader,
  decodeElectraUpdate,
  isEmptyHeader,
  signingDomainEpoch,
  electraBootstrapFixed,
  electraFinalityUpdateFixed,
  electraUpdateFixed,
  type LcHeader,
} from '../../../src/proof-v2/finality/ethl1/index.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';

const named = (f: () => unknown): FinalityStateError => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('did not throw');
};
const reason = (f: () => unknown): string => {
  try {
    f();
    return 'ok';
  } catch (e) {
    return `${(e as FinalityStateError).fields.reason}`;
  }
};
const u32 = (b: Uint8Array, at: number, v: number): void => new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(at, v, true);

/** A structurally valid electra header of 828 + extra bytes (every content byte zero). */
function header(extra: number): Uint8Array {
  const b = new Uint8Array(828 + extra);
  u32(b, 112, 244);
  u32(b, 244 + 436, 584);
  return b;
}
const concat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

describe('electra header: 828..860 bytes, both offsets exact', () => {
  it('accepts the minimum and the maximum and refuses one byte outside either', () => {
    expect(decodeElectraHeader(header(0), 'link', 3).shape).toBe(Layout.Electra);
    expect(decodeElectraHeader(header(32), 'link', 3).exec!.length).toBe(584 + 32);
    expect(named(() => decodeElectraHeader(new Uint8Array(827), 'link', 3)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"827","index":"3","part":"link","reason":"header_length","want_len":"828"}}',
    );
    expect(named(() => decodeElectraHeader(new Uint8Array(861), 'final_update', 0)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"861","index":"0","part":"final_update","reason":"header_length","want_len":"828"}}',
    );
    const bad1 = header(5);
    u32(bad1, 112, 245);
    expect(named(() => decodeElectraHeader(bad1, 'link', 1)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"245","index":"1","part":"link","reason":"execution_offset","want_len":"244"}}',
    );
    const bad2 = header(5);
    u32(bad2, 244 + 436, 583);
    expect(named(() => decodeElectraHeader(bad2, 'link', 1)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"583","index":"1","part":"link","reason":"extra_data_offset","want_len":"584"}}',
    );
  });
});

describe('electra bootstrap: offset 24,820, minimum 25,648', () => {
  const boot = (extra: number): Uint8Array => {
    const b = concat(new Uint8Array(electraBootstrapFixed), header(extra));
    u32(b, 0, electraBootstrapFixed);
    return b;
  };
  it('accepts the exact minimum, refuses one byte less and a lying offset', () => {
    expect(decodeElectraBootstrap(boot(0)).shape).toBe(Layout.Electra);
    expect(decodeElectraBootstrap(boot(32)).header.exec!.length).toBe(616);
    expect(named(() => decodeElectraBootstrap(boot(0).subarray(0, 25647))).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"25647","index":"0","part":"anchor_body","reason":"length","want_len":"25648"}}',
    );
    const lie = boot(0);
    u32(lie, 0, electraBootstrapFixed + 1);
    expect(reason(() => decodeElectraBootstrap(lie))).toBe('header_offset');
    expect(reason(() => decodeElectraBootstrap(boot(33)))).toBe('header_length');
  });
});

describe('electra update: attested offset, finalized offset between 828 and 860 bytes past the first header', () => {
  const upd = (attExtra: number, finExtra: number): Uint8Array => {
    const b = concat(new Uint8Array(electraUpdateFixed), header(attExtra), header(finExtra));
    u32(b, 0, electraUpdateFixed);
    u32(b, 4 + 24624 + 32 * 6, electraUpdateFixed + 828 + attExtra);
    return b;
  };
  const finAt = 4 + 24624 + 32 * 6;
  it('accepts the exact minimum and maxima; refuses one byte less than the minimum', () => {
    expect(decodeElectraUpdate(upd(0, 0), 2).shape).toBe(Layout.Electra);
    expect(decodeElectraUpdate(upd(32, 32), 2).attested.exec!.length).toBe(616);
    expect(named(() => decodeElectraUpdate(upd(0, 0).subarray(0, upd(0, 0).length - 1), 2)).canonical()).toBe(
      `{"code":"finality_evidence_malformed","fields":{"got_len":"${upd(0, 0).length - 1}","index":"2","part":"link","reason":"length","want_len":"${upd(0, 0).length}"}}`,
    );
  });
  it('probes the finalized offset on both sides of both bounds', () => {
    const lo = upd(0, 0);
    u32(lo, finAt, electraUpdateFixed + 827);
    expect(named(() => decodeElectraUpdate(lo, 2)).canonical()).toBe(
      `{"code":"finality_evidence_malformed","fields":{"got_len":"${electraUpdateFixed + 827}","index":"2","part":"link","reason":"finalized_offset","want_len":"${lo.length}"}}`,
    );
    const hi = upd(32, 0); // attested header of the maximum 860 bytes: finalized offset = fixed + 860
    expect(decodeElectraUpdate(hi, 2).finalized.exec!.length).toBe(584);
    const over = upd(33, 0);
    expect(reason(() => decodeElectraUpdate(over, 2))).toBe('finalized_offset');
    const lie = upd(0, 0);
    u32(lie, 0, electraUpdateFixed + 4);
    expect(reason(() => decodeElectraUpdate(lie, 2))).toBe('attested_offset');
  });
});

describe('electra finality update: attested offset 400, same finalized-offset window', () => {
  const fu = (attExtra: number, finExtra: number): Uint8Array => {
    const b = concat(new Uint8Array(electraFinalityUpdateFixed), header(attExtra), header(finExtra));
    u32(b, 0, electraFinalityUpdateFixed);
    u32(b, 4, electraFinalityUpdateFixed + 828 + attExtra);
    return b;
  };
  it('accepts the minimum (2,056) and maxima, probes the finalized offset', () => {
    expect(electraFinalityUpdateFixed).toBe(400);
    expect(fu(0, 0).length).toBe(2056);
    expect(decodeElectraFinalityUpdate(fu(0, 0)).shape).toBe(Layout.Electra);
    expect(decodeElectraFinalityUpdate(fu(32, 32)).finalized.exec!.length).toBe(616);
    expect(named(() => decodeElectraFinalityUpdate(fu(0, 0).subarray(0, 2055))).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"2055","index":"0","part":"final_update","reason":"length","want_len":"2056"}}',
    );
    const lo = fu(0, 0);
    u32(lo, 4, 400 + 827);
    expect(named(() => decodeElectraFinalityUpdate(lo)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"1227","index":"0","part":"final_update","reason":"finalized_offset","want_len":"2056"}}',
    );
    expect(reason(() => decodeElectraFinalityUpdate(fu(33, 0)))).toBe('finalized_offset');
    const lie = fu(0, 0);
    u32(lie, 0, 404);
    expect(reason(() => decodeElectraFinalityUpdate(lie))).toBe('attested_offset');
  });
});

describe('isEmptyHeader (LightClientHeader() with every field default)', () => {
  const z = (n = 32): Uint8Array => new Uint8Array(n);
  const gloas = (): LcHeader => ({
    shape: Layout.Gloas,
    beacon: { slot: 0n, proposerIndex: 0n, parentRoot: z(), stateRoot: z(), bodyRoot: z() },
    execHash: z(),
    branch: Array.from({ length: 11 }, () => z()),
    exec: null,
  });
  const electra = (): LcHeader => ({ ...gloas(), shape: Layout.Electra, branch: Array.from({ length: 4 }, () => z()), exec: z(584) });
  const one = (b: Uint8Array, i = 0): Uint8Array => {
    b[i] = 1;
    return b;
  };

  it('is true for the all-zero header of either shape', () => {
    expect(isEmptyHeader(gloas())).toBe(true);
    expect(isEmptyHeader(electra())).toBe(true);
  });
  it('is false as soon as any beacon field, the block hash or a branch node is non-zero', () => {
    for (const mutate of [
      (h: LcHeader) => (h.beacon.slot = 1n),
      (h: LcHeader) => (h.beacon.proposerIndex = 1n),
      (h: LcHeader) => one(h.beacon.parentRoot),
      (h: LcHeader) => one(h.beacon.stateRoot),
      (h: LcHeader) => one(h.beacon.bodyRoot),
      (h: LcHeader) => one(h.execHash),
      (h: LcHeader) => one(h.branch[h.branch.length - 1]!, 31),
    ]) {
      for (const make of [gloas, electra]) {
        const h = make();
        mutate(h);
        expect(isEmptyHeader(h)).toBe(false);
      }
    }
  });
  it('compares the decoded electra execution fields, not the extra_data offset bytes', () => {
    const offsetBytes = electra();
    offsetBytes.exec!.set([0x48, 0x02, 0x00, 0x00], 436); // the SSZ offset 584
    expect(isEmptyHeader(offsetBytes)).toBe(true);
    const offsetAny = electra();
    offsetAny.exec!.set([0xff, 0xff, 0xff, 0xff], 436);
    expect(isEmptyHeader(offsetAny)).toBe(true);
    const lastOffsetByte = electra();
    lastOffsetByte.exec![439] = 1;
    expect(isEmptyHeader(lastOffsetByte)).toBe(true);
    const before = electra();
    before.exec![435] = 1;
    expect(isEmptyHeader(before)).toBe(false);
    const first = electra();
    first.exec![0] = 1;
    expect(isEmptyHeader(first)).toBe(false);
    const after = electra();
    after.exec![440] = 1;
    expect(isEmptyHeader(after)).toBe(false);
    const last = electra();
    last.exec![583] = 1;
    expect(isEmptyHeader(last)).toBe(false);
    const withExtra = electra();
    withExtra.exec = z(585);
    expect(isEmptyHeader(withExtra)).toBe(false);
  });
});

describe('the signing-domain epoch is epoch(saturating_sub(signature_slot, 1))', () => {
  it('maps slots on both sides of an epoch boundary, and slot 0 to epoch 0', () => {
    const e = (s: bigint) => signingDomainEpoch(s);
    expect([e(0n), e(1n), e(2n), e(32n), e(33n), e(64n), e(65n)]).toEqual([0n, 0n, 0n, 0n, 1n, 1n, 2n]);
    expect(e(32n * 353024n)).toBe(353023n);
    expect(e(32n * 353024n + 1n)).toBe(353024n);
  });
});
