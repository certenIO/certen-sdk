/**
 * Targeted tests of verifyFinalizedHead's own checks, built by editing published vectors so that each refusal happens before any
 * signature work (cheap) and names exactly the code and fields Go names. They exist to kill mutants of verify.ts that the vector
 * set alone leaves alive (the mutation gate in tools/mutation-ethl1); each one states the rule it pins.
 */
import { describe, expect, it } from 'vitest';
import { rootFromNormalizedBranch, verifyFinalizedHead, type LC, type Pins } from '../../../src/proof-v2/finality/ethl1/index.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { lcOf, loadCase, loadPins } from './helpers.js';

const named = (f: () => unknown): FinalityStateError => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('did not throw');
};
const clone = (lc: LC): LC => ({
  ...lc,
  anchorRoot: Uint8Array.from(lc.anchorRoot),
  anchorBody: { layout: lc.anchorBody.layout, ssz: Uint8Array.from(lc.anchorBody.ssz) },
  links: lc.links.map((l) => ({ layout: l.layout, ssz: Uint8Array.from(l.ssz) })),
  finalUpdate: { layout: lc.finalUpdate.layout, ssz: Uint8Array.from(lc.finalUpdate.ssz) },
});
const caseLC = (id: string): { lc: LC; pins: Pins } => {
  const c = loadCase(id);
  return { lc: clone(lcOf(c)), pins: loadPins(c.pins!) };
};
const grow = (b: Uint8Array): Uint8Array => Uint8Array.of(...b, 0);
const shrink = (b: Uint8Array): Uint8Array => b.subarray(0, b.length - 1);

describe('step 1: bounds, lengths, layout bytes', () => {
  it('the link bound is inclusive: exactly maxLinks links pass the bound, one more is too large with both numbers', () => {
    const { lc, pins } = caseLC('valid_k1_short'); // two links
    expect(lc.links.length).toBe(2);
    const over = named(() => verifyFinalizedHead({ ...pins, maxLinks: 1 }, lc));
    expect(over.canonical()).toBe('{"code":"finality_evidence_too_large","fields":{"count":"2","limit":"1","part":"links"}}');
    // at the bound the walk proceeds (it verifies: the vector is valid)
    expect(verifyFinalizedHead({ ...pins, maxLinks: 2 }, lc).participants).toBeGreaterThanOrEqual(342);
  });

  it('a kind-1 committee body must be exactly 24,624 bytes, longer or shorter', () => {
    const { lc, pins } = caseLC('valid_k1_k0');
    const long = clone(lc);
    long.anchorBody.ssz = grow(long.anchorBody.ssz);
    expect(named(() => verifyFinalizedHead(pins, long)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"24625","index":"0","part":"anchor_body","reason":"length","want_len":"24624"}}',
    );
    const short = clone(lc);
    short.anchorBody.ssz = shrink(short.anchorBody.ssz);
    expect(named(() => verifyFinalizedHead(pins, short)).fields.got_len).toBe(24623);
  });

  it('a Gloas update, final update and bootstrap must have exactly their fixed sizes, longer or shorter', () => {
    const k1 = caseLC('valid_k1_short');
    const upLong = clone(k1.lc);
    upLong.links[1]!.ssz = grow(upLong.links[1]!.ssz);
    expect(named(() => verifyFinalizedHead(k1.pins, upLong)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"26425","index":"1","part":"link","reason":"length","want_len":"26424"}}',
    );
    const finLong = clone(k1.lc);
    finLong.finalUpdate.ssz = grow(finLong.finalUpdate.ssz);
    expect(named(() => verifyFinalizedHead(k1.pins, finLong)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"1449","index":"0","part":"final_update","reason":"length","want_len":"1448"}}',
    );
    const k2 = caseLC('valid_k2_k0');
    const bootLong = clone(k2.lc);
    bootLong.anchorBody.ssz = grow(bootLong.anchorBody.ssz);
    expect(named(() => verifyFinalizedHead(k2.pins, bootLong)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"25473","index":"0","part":"anchor_body","reason":"length","want_len":"25472"}}',
    );
    const bootShort = clone(k2.lc);
    bootShort.anchorBody.ssz = shrink(bootShort.anchorBody.ssz);
    expect(named(() => verifyFinalizedHead(k2.pins, bootShort)).fields.got_len).toBe(25471);
  });

  it('a layout byte above 2 is unknown, with the byte reported and 2 as the wanted bound', () => {
    const { lc, pins } = caseLC('valid_k1_short');
    lc.links[0]!.layout = 3;
    expect(named(() => verifyFinalizedHead(pins, lc)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"3","index":"0","part":"link","reason":"layout_byte_unknown","want_len":"2"}}',
    );
    lc.links[0]!.layout = 0;
    expect(named(() => verifyFinalizedHead(pins, lc)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"0","index":"0","part":"link","reason":"layout_byte_zero","want_len":"1"}}',
    );
  });
});

const setSlot = (b: Uint8Array, at: number, v: bigint): void => new DataView(b.buffer, b.byteOffset, b.byteLength).setBigUint64(at, v, true);
const getSlot = (b: Uint8Array, at: number): bigint => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, true);

describe('step 3: the store slot of a kind-2 anchor is the bootstrap slot, not the start of its period', () => {
  it('an attested slot equal to the bootstrap slot is not relevant; one more passes the relevance rule', () => {
    const { lc, pins } = caseLC('valid_k2_k0');
    const bootSlot = getSlot(lc.anchorBody.ssz, 0);
    expect(bootSlot % 8192n).not.toBe(0n); // a checkpoint inside its period, so the period start differs from the bootstrap slot
    // final update (gloas): attested header at 0, finalized header at 496; a finalized slot of 1 keeps slot_order satisfied
    setSlot(lc.finalUpdate.ssz, 0, bootSlot);
    setSlot(lc.finalUpdate.ssz, 496, 1n);
    const e = named(() => verifyFinalizedHead(pins, lc));
    expect(e.code).toBe('finality_link_invalid');
    expect(e.fields.check).toBe('not_relevant');
    expect(e.fields.attested_slot).toBe(bootSlot);
    const next = clone(lc);
    setSlot(next.finalUpdate.ssz, 0, bootSlot + 1n);
    const e2 = named(() => verifyFinalizedHead(pins, next));
    expect(e2.canonical()).toBe('{"code":"finality_fork_unsupported","fields":{"epoch":"0","layout":"gloas","slot":"1"}}');
  });
});

describe('step 3: participation floor and slot order', () => {
  it('refuses fewer than 342 set bits whatever the pins say, and refuses more than the pins allow', () => {
    const k0 = caseLC('adv_participation_341');
    const loose = { ...k0.pins, minParticipants: 0 };
    const e = named(() => verifyFinalizedHead(loose, k0.lc));
    expect(e.code).toBe('finality_participation_insufficient');
    expect(e.fields).toEqual({ index: 0, participants: 341, required: 342, committee: 512 });
    // the floor is a property of the pins too: a pins minimum above the participation refuses it, naming the constant floor
    const full = caseLC('valid_k1_k0');
    const n = verifyFinalizedHead(full.pins, full.lc).participants;
    const strict = named(() => verifyFinalizedHead({ ...full.pins, minParticipants: n + 1 }, full.lc));
    expect(strict.code).toBe('finality_participation_insufficient');
    expect(strict.fields).toEqual({ index: 0, participants: n, required: 342, committee: 512 });
    // and a pins minimum equal to the participation passes the check (the vector is valid)
    expect(verifyFinalizedHead({ ...full.pins, minParticipants: n }, full.lc).participants).toBe(n);
  });

  it('accepts an attested slot equal to the finalized slot (slot order is as >= fs) and fails later, at the finality branch', () => {
    const { lc, pins } = caseLC('valid_k1_k0');
    const as = getSlot(lc.finalUpdate.ssz, 0);
    setSlot(lc.finalUpdate.ssz, 496, as);
    const e = named(() => verifyFinalizedHead(pins, lc));
    expect(e.code).toBe('finality_link_invalid');
    expect(e.fields.check).toBe('finality_branch');
    setSlot(lc.finalUpdate.ssz, 496, as + 1n);
    expect(named(() => verifyFinalizedHead(pins, lc)).fields.check).toBe('slot_order');
  });
});

describe('step 3: relevance of a link whose attested slot is not past the store slot', () => {
  it('a first link in the store period that carries a next committee is relevant even at the period start', () => {
    const { lc, pins } = caseLC('valid_k1_short');
    const periodStart = lc.anchorPeriod * 8192n;
    // gloas update: attested header at 0, next committee 24,624 + branch 352, finalized header at 25,472
    setSlot(lc.links[0]!.ssz, 0, periodStart);
    setSlot(lc.links[0]!.ssz, 25472, 1n);
    const e = named(() => verifyFinalizedHead(pins, lc));
    // relevant: the walk proceeds to the finalized header, whose slot 1 lies in a fork with no layout
    expect(e.canonical()).toBe('{"code":"finality_fork_unsupported","fields":{"epoch":"0","layout":"gloas","slot":"1"}}');
  });
  it('the same link is not relevant once the next committee is known (second link at the period start)', () => {
    const { lc, pins } = caseLC('valid_k1_short');
    const periodStart = lc.anchorPeriod * 8192n;
    // make link 1 a copy of link 0 patched to the period start: link 0 is applied first, so for link 1 the next committee is known
    const l1 = Uint8Array.from(lc.links[0]!.ssz);
    setSlot(l1, 0, periodStart);
    setSlot(l1, 25472, 1n);
    lc.links[1]!.ssz = l1;
    const e = named(() => verifyFinalizedHead(pins, lc));
    expect(e.code).toBe('finality_link_invalid');
    expect(e.fields.check).toBe('not_relevant');
    expect(e.fields.index).toBe(1);
  });
  it('an empty finalized header whose zero-root branch is valid is accepted by the finality rule (the walk reaches the sync-update check)', () => {
    const { lc, pins } = caseLC('valid_k1_short');
    const u = lc.links[0]!.ssz;
    u.fill(0, 25472, 25472 + 496); // empty finalized header: slot 0
    u.fill(0, 496 + 24624, 496 + 24624 + 352); // no next-committee branch: not a sync-committee update
    // attested state root := the root the existing (non-zero) finality branch commits to for the zero leaf
    const branch: Uint8Array[] = [];
    for (let i = 0; i < 9; i++) branch.push(Uint8Array.from(u.subarray(25472 + 496 + 32 * i, 25472 + 496 + 32 * i + 32)));
    u.set(rootFromNormalizedBranch(new Uint8Array(32), branch, 735n), 48);
    const e = named(() => verifyFinalizedHead(pins, lc));
    expect(e.code).toBe('finality_link_invalid');
    expect(e.fields.check).toBe('not_sync_committee_update');
  });
});

describe('step 3: the weak-subjectivity window is inclusive and measured from the signing period', () => {
  it('passes with wsp_epochs equal to the finalized epoch minus 256*period, refuses one less', () => {
    const { lc, pins } = caseLC('valid_k1_k0');
    const head = verifyFinalizedHead(pins, lc);
    const sigPeriod = lc.anchorPeriod + head.periodsCrossed;
    const d = head.epoch - 256n * sigPeriod;
    expect(d > 0n).toBe(true);
    const withWsp = (w: bigint): Pins => ({ ...pins, anchors: pins.anchors.map((a) => ({ ...a, wspEpochs: w })) });
    expect(verifyFinalizedHead(withWsp(d), lc).epoch).toBe(head.epoch);
    const e = named(() => verifyFinalizedHead(withWsp(d - 1n), lc));
    expect(e.canonical()).toBe(
      `{"code":"finality_pin_window","fields":{"anchor_epoch":"${256n * sigPeriod}","finalized_epoch":"${head.epoch}","wsp_epochs":"${d - 1n}"}}`,
    );
  });
});
