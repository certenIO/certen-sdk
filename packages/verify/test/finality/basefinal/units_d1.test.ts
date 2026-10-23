/**
 * The checks the independent review of the Go verifier found absent (V-D1; Go f888712, cd3fd5e, 25b37af at pv2/rb11-e1-raise@cbb6373) and
 * the TypeScript twin owes: the AnchorStateRegistry (and, when pinned, the DisputeGameFactory) the pinned game build is made for must be the
 * ones the contract graph proves (annex step 5), a header without a withdrawals root has no output root, the header must be the block the
 * game implies, and the pins refuse a zero code-hash key. Every case here is also a differential case against the Go judge (see the check-in).
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { CodeContractIdentity, CodeOutputRootMismatch, parseBasePins } from '../../../src/proof-v2/finality/basefinal/index.js';
import { canonValue } from '../../../src/proof-v2/finality/state.js';
import { assertRegistered, registryInt } from './regcheck.js';
import { mainJson, pinsOf } from './pinsvariants.js';
import { judgeOutcome, worldOf, cloneWorld } from './world.js';
import { loadJudge } from './vectorset.js';

const ROOT = 'synth_ok_root_claim_anchor';
const RECOVERED_ASR = '0x2ff5cc82dbf333ea30d8ee462178ab1707315355';
const PROVEN_DGF = '0xd6e6dbf4f7ea0ac412fd8b65ed297e64bb7a06e1';
const OTHER = '0x1111111111111111111111111111111111111111';

/** every game_impl row of the pins is given the mutation (the world's game implementation is one of them) */
const outcome = (mutate: (row: Record<string, any>) => void, world = ROOT) => {
  const d = mainJson();
  for (const r of Object.values(d.base_sepolia.impl_pins) as Record<string, any>[]) if (r.role === 'game_impl') mutate(r);
  return judgeOutcome(worldOf(world), pinsOf(d));
};

const expectGameImplUnproven = (o: ReturnType<typeof outcome>): void => {
  expect(o.ok).toBe(false);
  if (o.ok) return;
  expect(o.state.code).toBe(CodeContractIdentity);
  expect(o.state.fields.role).toBe('game_impl');
  assertRegistered(o.state, registryInt);
};

describe('the game build pins the AnchorStateRegistry and, optionally, the DisputeGameFactory it is made for (annex step 5)', () => {
  it('the published rows name the ASR the Portal proves, so the world is accepted', () => {
    const o = outcome(() => {});
    expect(o.ok).toBe(true);
    // and the pins say what the test relies on below
    const rows = Object.values(mainJson().base_sepolia.impl_pins as Record<string, any>).filter((r) => r.role === 'game_impl');
    expect(rows.map((r) => r.asr)).toEqual([RECOVERED_ASR, RECOVERED_ASR]);
  });

  it('a pinned ASR other than the one proven through Portal slot 62 leaves the game implementation unproven', () => {
    expectGameImplUnproven(outcome((r) => (r.asr = OTHER)));
  });

  it('an ASR that is the last byte off is refused, not matched by prefix', () => {
    expectGameImplUnproven(outcome((r) => (r.asr = `${RECOVERED_ASR.slice(0, -1)}4`)));
  });

  it('a row without an asr is incomplete, hence absent, hence the implementation is unproven (the ASR pin is required)', () => {
    expectGameImplUnproven(outcome((r) => delete r.asr));
  });

  it('an asr that is not lower-case 0x hex of 20 bytes is unreadable and the row is incomplete', () => {
    for (const bad of [RECOVERED_ASR.toUpperCase().replace('0X', '0x'), RECOVERED_ASR.slice(2), RECOVERED_ASR.slice(0, -2), `${RECOVERED_ASR}00`, null, '']) {
      expectGameImplUnproven(outcome((r) => (r.asr = bad)));
    }
  });

  it('an all-zero asr is the same as none', () => {
    expectGameImplUnproven(outcome((r) => (r.asr = `0x${'00'.repeat(20)}`)));
  });

  it('a pinned DGF equal to the one proven through ASR slot 1 is accepted, with the same verdict as without it', () => {
    const base = outcome(() => {});
    const pinned = outcome((r) => (r.dgf = PROVEN_DGF));
    expect(base.ok && pinned.ok).toBe(true);
    if (base.ok && pinned.ok) expect(pinned.canonical).toBe(base.canonical);
  });

  it('a pinned DGF other than the proven one leaves the game implementation unproven', () => {
    expectGameImplUnproven(outcome((r) => (r.dgf = OTHER)));
    expectGameImplUnproven(outcome((r) => (r.dgf = `${PROVEN_DGF.slice(0, -1)}2`)));
  });

  it('an unreadable or all-zero dgf is not a pin (the DGF pin is optional), so the world is accepted as without it', () => {
    const base = outcome(() => {});
    for (const v of [`0x${'00'.repeat(20)}`, 'not an address', PROVEN_DGF.toUpperCase().replace('0X', '0x'), null]) {
      const o = outcome((r) => (r.dgf = v));
      expect(o.ok, String(v)).toBe(true);
      if (o.ok && base.ok) expect(o.canonical).toBe(base.canonical);
    }
  });

  it('the refusal carries the game implementation address and code hash, judged at A', () => {
    const o = outcome((r) => (r.asr = OTHER));
    expect(o.ok).toBe(false);
    if (o.ok) return;
    const f = JSON.parse(canonValue(o.state.fields)) as Record<string, string>;
    expect(Object.keys(f).sort()).toEqual(['address', 'code_hash', 'judged_at', 'role']);
    expect(f.judged_at).toBe(loadJudge(ROOT).a.number);
    expect(f.code_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('the output root is the root of the header the game implies', () => {
  it('a world whose first spine header is the block below the one the claim names is refused with the computed root, though the claim matches no other block', () => {
    // outputRootIndex 1 names the first intermediate root (block start + interval); the root-claim anchor world proves index 0, so index 1
    // makes the claim (the first intermediate root) the wrong root for header 0
    const w = cloneWorld(worldOf(ROOT));
    w.body.outputRootIndex = 1;
    const o = judgeOutcome(w);
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.state.code).toBe(CodeOutputRootMismatch);
  });
});

describe('the pins refuse a zero code-hash key (an absent account would look pinned)', () => {
  it('impl_pins and proxy_pins', () => {
    for (const [section, role] of [
      ['impl_pins', 'asr_impl'],
      ['proxy_pins', 'op_proxy'],
    ] as const) {
      const d = mainJson();
      d.base_sepolia[section][`0x${'00'.repeat(32)}`] = { role, finality_delay_seconds: 0 };
      let err: unknown;
      try {
        parseBasePins(pinsOf(d));
      } catch (e) {
        err = e;
      }
      expect((err as { code: string }).code).toBe('finality_pins_corrupt');
      expect(canonValue((err as { fields: unknown }).fields)).toBe(`{"key":"base_sepolia.${section}","reason":"bad_value"}`);
    }
  });
});

describe('a header below the output-root header that does not decode ends the spine as header_chain_broken{rlp} (5.5 O6)', () => {
  const world = 'synth_ok_030_fast_pair_6000_300';
  it('names the spine, the reason, the number below the header before it and the hash of the bytes that were given', () => {
    const w = cloneWorld(worldOf(world));
    expect(w.body.l2Spine.length).toBeGreaterThanOrEqual(2);
    const garbage = Uint8Array.of(0x01, 0x02, 0x03);
    w.body.l2Spine[1] = garbage;
    const o = judgeOutcome(w);
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.state.code).toBe('finality_header_chain_broken');
    expect(o.state.fields.reason).toBe('rlp');
    expect(o.state.fields.spine).toBe('l2');
    expect(Buffer.from(o.state.fields.got_hash as Uint8Array).toString('hex')).toBe(Buffer.from(keccak_256(garbage)).toString('hex'));
    expect(o.state.fields.want_hash).toBeInstanceOf(Uint8Array);
    assertRegistered(o.state, registryInt);
  });
  it('the unmodified world is accepted, so the refusal above is the garbage and nothing else', () => {
    expect(judgeOutcome(cloneWorld(worldOf(world))).ok).toBe(true);
  });
});
