/**
 * The kind against the shared state registry (the Go D2 branch's states.json, copied byte-identically under base_posted1_registry) and
 * the framework: every code the kind can raise is registered with exactly its fields, and the registered kind is reached through
 * judgeAddendum the way the offline verifier reaches it.
 */
import { describe, expect, it } from 'vitest';
import { Registry } from '../../../src/proof-v2/finality/registry.js';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { Level } from '../../../src/proof-v2/finality/level.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import * as kindModule from '../../../src/proof-v2/finality/baseposted/verify.js';
import { KIND_NAME } from '../../../src/proof-v2/finality/baseposted/pins.js';
import { bytesOfHex, caseNames, loadCase, read, readPins } from './vectorset.js';
import { assertRegistered, registry } from './regcheck.js';

describe('registry conformance', () => {
  it('every Code constant of the kind is a registered state of the Base R, L1 head R or Arbitrum-independent groups', () => {
    const codes = Object.entries(kindModule)
      .filter(([k, v]) => k.startsWith('Code') && typeof v === 'string')
      .map(([, v]) => v as string);
    expect(codes.length).toBe(14);
    for (const c of codes) expect(registry.states[c], c).toBeDefined();
  });

  it('every refusal vector is registered with its exact required fields and closed enum values', () => {
    for (const id of caseNames()) {
      const c = loadCase(id);
      if (c.expect.result === 'ok') continue;
      const e = new FinalityStateError(c.expect.code!, Object.fromEntries(Object.entries(c.expect.fields as Record<string, string>)));
      assertRegistered(e);
    }
  });

  it('l1_finality_unproven{reason} is a closed set that names lc_refused', () => {
    expect(registry.states['l1_finality_unproven']!.enums).toEqual({ reason: ['lc_refused'] });
    expect(kindModule.LC_REFUSED).toBe('lc_refused');
  });
});

describe('the kind through the framework', () => {
  const pins = parsePinsOverride(readPins('pins/main.json'));
  const leg = JSON.parse(read('legs/a.json').toString('utf8')) as { chain: string; number: string; hash: string; header: string };
  const ref = { chain: BigInt(leg.chain), number: BigInt(leg.number), hash: bytesOfHex(leg.hash), headerRlp: bytesOfHex(leg.header) };
  const ev = Uint8Array.from(read('evidence/valid_a.bin'));
  const addendum = (level: Level) => ({ proofId: new Uint8Array(16), seq: 0n, level, chain: 84532n, kind: KIND_NAME, evidence: ev, prevHash: new Uint8Array(32), ownHash: new Uint8Array(32) });

  it('registers once, refuses a second verifier, and judges the live evidence at exactly l1_posted', () => {
    const reg = new Registry();
    kindModule.registerBasePosted(reg);
    expect(() => kindModule.registerBasePosted(reg)).toThrow(/already has a verifier/);
    expect(reg.kind(KIND_NAME)?.level()).toBe(Level.L1Posted);
    expect(reg.kind(KIND_NAME)?.chain()).toBe(84532n);
    const v = reg.judgeAddendum(ref, addendum(Level.L1Posted), pins);
    expect(v.level).toBe(Level.L1Posted);
    expect(v.kind).toBe(KIND_NAME);
    expect(v.fields.batch_type).toBe(0n);
  });

  it('the same evidence stored at the finalized level is refused by the framework before the kind is asked', () => {
    const reg = new Registry();
    kindModule.registerBasePosted(reg);
    try {
      reg.judgeAddendum(ref, addendum(Level.Finalized), pins);
      throw new Error('accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(FinalityStateError);
      expect((e as FinalityStateError).canonical()).toBe(
        '{"code":"finality_evidence_malformed","fields":{"got_len":"0","part":"header.level","reason":"differs_from_addendum","want_len":"0"}}',
      );
    }
  });

  it('a Kind that is not a row of the table cannot be registered under this name for another chain', () => {
    const reg = new Registry();
    const k = new kindModule.BasePostedKind();
    expect(k.name()).toBe('base-sepolia/l1_posted/v1');
    reg.registerKind(k);
    expect(reg.kind('base-sepolia/l1_posted/v1')).toBe(k);
  });
});
