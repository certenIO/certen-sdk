/**
 * The kind against the shared state registry and the framework: every code the kind can raise is registered with exactly its fields and a member
 * of each closed set, every refusal of the Go sets conforms, the closed sets of the registry are exactly the constants of the kind, the registered
 * kind is reached through judgeAddendum the way the offline verifier reaches it, and the valid vectors of every set go through the registry.
 */
import { describe, expect, it } from 'vitest';
import { Registry } from '../../../src/proof-v2/finality/registry.js';
import { Level } from '../../../src/proof-v2/finality/level.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import * as states from '../../../src/proof-v2/finality/arbfinal/states.js';
import { ArbFinalKind, registerArbFinal } from '../../../src/proof-v2/finality/arbfinal/verify.js';
import { CHAIN, KIND_NAME } from '../../../src/proof-v2/finality/arbfinal/pins.js';
import { FINAL1, FINAL2, FINAL3, evidenceOf, expectedOf, legOf, loadSet, pinsOf } from './vectorset.js';
import { assertRegistered, registry } from './regcheck.js';

const refusals = (): { who: string; code: string; fields: Record<string, unknown> }[] => {
  const out: { who: string; code: string; fields: Record<string, unknown> }[] = [];
  for (const s of [FINAL1, FINAL2, FINAL3]) {
    for (const v of loadSet(s).vectors) {
      const o = JSON.parse(expectedOf(s, v)) as { code: string; fields: Record<string, unknown> };
      if (o.code !== 'finalized') out.push({ who: `${s.dir}/${v.name}`, ...o });
    }
  }
  return out;
};

describe('registry conformance', () => {
  it('every Code constant of the kind is a registered state', () => {
    const codes = Object.entries(states)
      .filter(([k, v]) => k.startsWith('Code') && typeof v === 'string')
      .map(([, v]) => v as string);
    expect(codes.length).toBe(14);
    expect(new Set(codes).size).toBe(14);
    for (const c of codes) expect(registry.states[c], c).toBeDefined();
  });

  it('every refusal of the three Go sets is registered with its exact required fields and closed enum values', () => {
    const rs = refusals();
    expect(rs.length).toBeGreaterThan(150);
    for (const r of rs) assertRegistered(new FinalityStateError(r.code, r.fields as never));
  });

  it('the closed sets of the registry are exactly the constants of the kind', () => {
    const e = (code: string, f: string): string[] => registry.states[code]!.enums![f]!;
    expect(e('confirmation_path_unproven', 'reason')).toEqual(Object.values(states.ConfirmReason).sort());
    expect(e('l1_finality_unproven', 'reason')).toEqual(Object.values(states.L1FinalityReason).sort());
    expect(e('assertion_preimage_mismatch', 'part')).toEqual(Object.values(states.PreimagePart).sort());
    for (const r of Object.values(states.HeaderChainReason)) expect(e('finality_header_chain_broken', 'reason')).toContain(r);
    expect(e('finality_header_chain_broken', 'spine')).toContain(states.SPINE_L2);
  });

  it('every state constructor of the kind builds a registered state', () => {
    const h = new Uint8Array(32);
    const a = new Uint8Array(20);
    for (const s of [
      states.pinMismatch('layout'),
      states.stateProofInvalid('slot'),
      states.txProofInvalid('tx'),
      states.contractIdentity(states.RoleRollup, a, h, 1n),
      states.l1FinalityUnproven(states.L1FinalityReason.LCRefused, 'x'),
      states.headerChainBroken(1n, h, h, states.HeaderChainReason.NumberGap),
      states.headerChainExceeds(2n, 1n),
      states.confirmedByOwnerForce(states.PathFast, h, 1n),
      states.confirmationUnproven(states.ConfirmReason.Indirect, h, 1n),
      states.preimageMismatch(states.PreimagePart.ConfirmationLog),
    ]) {
      assertRegistered(s);
    }
  });
});

describe('the kind through the framework', () => {
  const v = loadSet(FINAL3).vectors.find((x) => x.name === 'synth_valid_wallet_execute_transaction_proven')!;
  const pins = pinsOf(FINAL3, v);
  const ref = legOf(v);
  const ev = evidenceOf(FINAL3, v);
  const addendum = (level: Level, chain = CHAIN, kind = KIND_NAME) => ({
    proofId: new Uint8Array(16),
    seq: 0n,
    level,
    chain,
    kind,
    evidence: ev,
    prevHash: new Uint8Array(32),
    ownHash: new Uint8Array(32),
  });

  it('registers once, refuses a second verifier, and judges the wallet world at exactly finalized, route wallet', () => {
    const reg = new Registry();
    registerArbFinal(reg);
    expect(() => registerArbFinal(reg)).toThrow(/already has a verifier/);
    const k = reg.kind(KIND_NAME)!;
    expect(k.level()).toBe(Level.Finalized);
    expect(k.chain()).toBe(421614n);
    expect(k.name()).toBe('arb-sepolia/finalized/v1');
    const got = reg.judgeAddendum(ref, addendum(Level.Finalized), pins);
    expect(got.level).toBe(Level.Finalized);
    expect(got.kind).toBe(KIND_NAME);
    expect(got.fields.confirmation_route).toBe('wallet');
    expect(got.fields.confirmation_path).toBe('honest');
  });

  it('evidence about another block is finality_block_mismatch before the kind is asked', () => {
    const reg = new Registry();
    registerArbFinal(reg);
    try {
      reg.judgeAddendum({ ...ref, number: ref.number + 1n }, addendum(Level.Finalized), pins);
      throw new Error('accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(FinalityStateError);
      expect((e as FinalityStateError).code).toBe('finality_block_mismatch');
    }
  });

  it('the same evidence stored at the l1_posted level is refused by the framework before the kind is asked', () => {
    const reg = new Registry();
    registerArbFinal(reg);
    try {
      reg.judgeAddendum(ref, addendum(Level.L1Posted), pins);
      throw new Error('accepted');
    } catch (e) {
      expect((e as FinalityStateError).canonical()).toBe(
        '{"code":"finality_evidence_malformed","fields":{"got_len":"0","part":"header.level","reason":"differs_from_addendum","want_len":"0"}}',
      );
    }
  });

  it('every valid vector of every set goes through judgeAddendum and answers at finalized (Go TestValidVectorsThroughTheRegistry)', () => {
    const reg = new Registry();
    registerArbFinal(reg);
    let seen = 0;
    for (const [s, want] of [[FINAL1, 8], [FINAL2, 4], [FINAL3, 10]] as const) {
      let n = 0;
      for (const vec of loadSet(s).vectors) {
        if (!expectedOf(s, vec).includes('"code":"finalized"')) continue;
        n++;
        const got = reg.judgeAddendum(legOf(vec), { ...addendum(Level.Finalized), evidence: evidenceOf(s, vec) }, pinsOf(s, vec));
        expect(got.level, vec.name).toBe(Level.Finalized);
        expect(got.kind, vec.name).toBe(KIND_NAME);
      }
      expect(n, s.dir).toBe(want);
      seen += n;
    }
    expect(seen).toBe(22);
  });

  it('the kind is a row of the table: it registers under its own chain and level only', () => {
    const k = new ArbFinalKind();
    expect(k.chain()).toBe(421614n);
    expect(k.level()).toBe(Level.Finalized);
    const reg = new Registry();
    reg.registerKind(k);
    expect(reg.kind('arb-sepolia/finalized/v1')).toBe(k);
  });
});
