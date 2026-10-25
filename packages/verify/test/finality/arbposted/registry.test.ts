/**
 * The kind against the shared state registry (the Go rb11-int states.json, copied byte-identically under arb_posted1_registry) and the
 * framework: every code the kind can raise is registered with exactly its fields, and the registered kind is reached through judgeAddendum
 * the way the offline verifier reaches it.
 */
import { describe, expect, it } from 'vitest';
import { Registry } from '../../../src/proof-v2/finality/registry.js';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { Level } from '../../../src/proof-v2/finality/level.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import * as states from '../../../src/proof-v2/finality/arbposted/states.js';
import { ArbPostedKind, registerArbPosted } from '../../../src/proof-v2/finality/arbposted/verify.js';
import { KIND_NAME } from '../../../src/proof-v2/finality/arbposted/pins.js';
import { caseNames, evidenceOf, loadCase, read, refOf } from './vectorset.js';
import { assertRegistered, registry } from './regcheck.js';

describe('registry conformance', () => {
  it('every Code constant of the kind is a registered state', () => {
    const codes = Object.entries(states)
      .filter(([k, v]) => k.startsWith('Code') && typeof v === 'string')
      .map(([, v]) => v as string);
    expect(codes.length).toBe(10);
    for (const c of codes) expect(registry.states[c], c).toBeDefined();
  });

  it('every refusal vector is registered with its exact required fields and closed enum values', () => {
    let refusals = 0;
    for (const id of caseNames()) {
      const c = loadCase(id);
      const parsed = JSON.parse(c.expect_canonical) as { code: string; fields: Record<string, unknown> };
      if (parsed.code === 'verified') continue;
      refusals++;
      assertRegistered(new FinalityStateError(parsed.code, parsed.fields as never));
    }
    expect(refusals).toBe(59);
  });

  it('the closed reason sets of the registry are exactly the constants of the kind', () => {
    expect(registry.states['l1_posted_content_not_found']!.enums).toEqual({ reason: Object.values(states.ContentReason).sort() });
    expect(registry.states['l1_finality_unproven']!.enums).toEqual({ reason: Object.values(states.L1FinalityReason).sort() });
  });
});

describe('the kind through the framework', () => {
  const pins = parsePinsOverride(read('pins/main.json'));
  const live = loadCase('valid_live');
  const ref = refOf(live.leg);
  const ev = evidenceOf(live);
  const addendum = (level: Level, chain = 421614n, kind = KIND_NAME) => ({
    proofId: new Uint8Array(16),
    seq: 0n,
    level,
    chain,
    kind,
    evidence: ev,
    prevHash: new Uint8Array(32),
    ownHash: new Uint8Array(32),
  });

  it('registers once, refuses a second verifier, and judges the live evidence at exactly l1_posted', () => {
    const reg = new Registry();
    registerArbPosted(reg);
    expect(() => registerArbPosted(reg)).toThrow(/already has a verifier/);
    expect(reg.kind(KIND_NAME)?.level()).toBe(Level.L1Posted);
    expect(reg.kind(KIND_NAME)?.chain()).toBe(421614n);
    expect(reg.kind(KIND_NAME)?.name()).toBe('arb-sepolia/l1_posted/v1');
    const v = reg.judgeAddendum(ref, addendum(Level.L1Posted), pins);
    expect(v.level).toBe(Level.L1Posted);
    expect(v.kind).toBe(KIND_NAME);
    expect(v.fields.batch_sequence_number).toBe(883753n);
  });

  it('evidence about another block is finality_block_mismatch before the kind is asked', () => {
    const reg = new Registry();
    registerArbPosted(reg);
    const other = { ...ref, number: ref.number + 1n };
    try {
      reg.judgeAddendum(other, addendum(Level.L1Posted), pins);
      throw new Error('accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(FinalityStateError);
      expect((e as FinalityStateError).code).toBe('finality_block_mismatch');
    }
  });

  it('the same evidence stored at the finalized level is refused by the framework before the kind is asked', () => {
    const reg = new Registry();
    registerArbPosted(reg);
    try {
      reg.judgeAddendum(ref, addendum(Level.Finalized), pins);
      throw new Error('accepted');
    } catch (e) {
      expect((e as FinalityStateError).canonical()).toBe(
        '{"code":"finality_evidence_malformed","fields":{"got_len":"0","part":"header.level","reason":"differs_from_addendum","want_len":"0"}}',
      );
    }
  });

  it('a kind that is not a row of the table cannot be registered for another chain', () => {
    const k = new ArbPostedKind();
    expect(k.chain()).toBe(421614n);
    expect(k.level()).toBe(Level.L1Posted);
    const reg = new Registry();
    reg.registerKind(k);
    expect(reg.kind('arb-sepolia/l1_posted/v1')).toBe(k);
  });
});
