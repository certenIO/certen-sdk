/**
 * The kind against the shared state registries (the Go D1 branch's states.json and the integration branch's, byte-identical copies) and the
 * framework: every code the kind can raise is registered with exactly its fields, every refusing vector of the published set is a
 * registered state, and the registered kind is reached through judgeAddendum the way the offline verifier reaches it.
 */
import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { MptError, ProofDb, verifyProof, verifyProofIn } from '../../../src/s6/mpt.js';
import { Level } from '../../../src/proof-v2/finality/level.js';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { Registry } from '../../../src/proof-v2/finality/registry.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import * as states from '../../../src/proof-v2/finality/basefinal/states.js';
import { BaseFinalKind, KIND_NAME, registerBaseFinal } from '../../../src/proof-v2/finality/basefinal/index.js';
import { assertRegistered, registry, registryInt } from './regcheck.js';
import { caseNames, expectedOf, judgeNames, legRef, loadCase, loadJudge, read, runCase, type LegFile } from './vectorset.js';

describe('registry conformance', () => {
  it('every Code constant of the kind is a registered state in both registries (15 codes)', () => {
    const codes = Object.entries(states)
      .filter(([k, v]) => k.startsWith('Code') && typeof v === 'string')
      .map(([, v]) => v as string);
    expect(codes.length).toBe(15);
    expect([...codes].sort()).toEqual([...states.AllCodes].sort());
    for (const c of codes) {
      expect(registry.states[c], c).toBeDefined();
      expect(registryInt.states[c], c).toBeDefined();
    }
  });

  it('the closed reason sets are exactly the constants of the kind', () => {
    for (const reg of [registry, registryInt]) {
      expect(reg.states['game_unrecognised']!.enums).toEqual({ reason: Object.values(states.GameReason).sort() });
      expect(reg.states['l1_finality_unproven']!.enums!.reason).toContain(states.LC_REFUSED);
    }
    expect(registry.states['l1_finality_unproven']!.enums!.reason).toEqual([states.LC_REFUSED]);
  });

  it('every refusing vector (21 live, 64 judge-level) is registered with exactly its fields in both registries', () => {
    let n = 0;
    const check = (code: string, fields: Record<string, string>): void => {
      const e = new FinalityStateError(code, fields);
      assertRegistered(e);
      assertRegistered(e, registryInt);
      n++;
    };
    for (const id of caseNames()) {
      const c = loadCase(id);
      if (c.expect.result !== 'ok') check(c.expect.code!, c.expect.fields as Record<string, string>);
    }
    for (const id of judgeNames()) {
      const c = loadJudge(id);
      if (c.expect.result !== 'ok') check(c.expect.code!, c.expect.fields as Record<string, string>);
    }
    expect(n).toBe(85);
  });

  it('every Base refusal the verifier can raise has at least one published vector (the Go set claims the same list)', () => {
    const seen = new Set<string>();
    for (const id of caseNames()) seen.add(loadCase(id).expect.code ?? 'ok');
    for (const id of judgeNames()) seen.add(loadJudge(id).expect.code ?? 'ok');
    for (const code of states.AllCodes) {
      // l1_finality_unproven is raised by the LC part only; the live signature-flipped vector covers it
      expect(seen.has(code), code).toBe(true);
    }
  });
});

describe('the kind through the framework', () => {
  const live = loadCase('valid_leg_47604755');
  const pins = parsePinsOverride(read(live.pins));
  const leg = legRef(JSON.parse(read(live.leg).toString('utf8')) as LegFile);
  const ev = Uint8Array.from(read(live.evidence));
  const addendum = (level: Level, chain = 84532n, kind = KIND_NAME) => ({
    proofId: new Uint8Array(16),
    seq: 0n,
    level,
    chain,
    kind,
    evidence: ev,
    prevHash: new Uint8Array(32),
    ownHash: new Uint8Array(32),
  });

  it('registers once, refuses a second verifier, and judges the live evidence at exactly finalized', () => {
    const reg = new Registry();
    registerBaseFinal(reg);
    expect(() => registerBaseFinal(reg)).toThrow(/already has a verifier/);
    expect(reg.kind(KIND_NAME)?.level()).toBe(Level.Finalized);
    expect(reg.kind(KIND_NAME)?.chain()).toBe(84532n);
    expect(reg.kind(KIND_NAME)?.name()).toBe('base-sepolia/finalized/v1');
    const v = reg.judgeAddendum(leg, addendum(Level.Finalized), pins);
    expect(v.level).toBe(Level.Finalized);
    expect(v.kind).toBe(KIND_NAME);
    expect(v.fields.game_version).toBe('0.2.0');
    expect(v.fields.output_root_block).toBe(47604773n);
  });

  it('evidence about another block is finality_block_mismatch before the kind is asked', () => {
    const reg = new Registry();
    registerBaseFinal(reg);
    try {
      reg.judgeAddendum({ ...leg, number: leg.number + 1n }, addendum(Level.Finalized), pins);
      throw new Error('accepted');
    } catch (e) {
      expect((e as FinalityStateError).code).toBe('finality_block_mismatch');
    }
  });

  it('the same evidence stored at the l1_posted level is refused by the framework before the kind is asked', () => {
    const reg = new Registry();
    registerBaseFinal(reg);
    try {
      reg.judgeAddendum(leg, addendum(Level.L1Posted), pins);
      throw new Error('accepted');
    } catch (e) {
      expect((e as FinalityStateError).canonical()).toBe(
        '{"code":"finality_evidence_malformed","fields":{"got_len":"0","part":"header.level","reason":"differs_from_addendum","want_len":"0"}}',
      );
    }
  });

  it('the kind is a row of the table: base-sepolia, finalized', () => {
    const k = new BaseFinalKind();
    expect([k.chain(), k.level(), k.name()]).toEqual([84532n, Level.Finalized, 'base-sepolia/finalized/v1']);
  });

  it('the oldest type-621 game and a type-0 game are refused with the published states, deterministically twice', () => {
    for (const id of ['oldest_type_621_game', 'other_type_0_2026_02']) {
      const c = loadCase(id);
      const a = runCase(c);
      expect(a).toBe(expectedOf(c));
      expect(runCase(c)).toBe(a);
    }
  });
});

describe('the proof database of s6/mpt', () => {
  it('refuses an empty node and finds a node by its own keccak256 only', () => {
    expect(() => new ProofDb([new Uint8Array(0)])).toThrow(MptError);
    const node = Uint8Array.of(0xc2, 0x80, 0x80);
    const db = new ProofDb([node]);
    expect(db.get(keccak_256(node))).toEqual(node);
    expect(db.get(new Uint8Array(32))).toBeUndefined();
    // verifyProof over a node set is verifyProofIn over the database built from it
    const root = new Uint8Array(32);
    let a: unknown;
    let b: unknown;
    try {
      verifyProof(root, new Uint8Array(32), [node]);
    } catch (e) {
      a = (e as Error).message;
    }
    try {
      verifyProofIn(db, root, new Uint8Array(32));
    } catch (e) {
      b = (e as Error).message;
    }
    expect(a).toContain('missing');
    expect(b).toBe(a);
    expect(verifyProof(keccak_256(node), new Uint8Array(32), [node])).toBe(verifyProofIn(db, keccak_256(node), new Uint8Array(32)));
  });
});
