/**
 * The pinned identity of the copied vector sets, and the relations between them that the Go tests state: the manifests recompute, every file is
 * byte-identical, the counts and groups are the published ones, every superseded verdict of sets 1 and 2 is carried again in set 3 with a wallet
 * proof under its recorded expectation, and the real direct-route vector is unchanged by the wallet rule.
 */
import { describe, expect, it } from 'vitest';
import {
  CARRIED_AGAIN_IN_SET3,
  FINAL1,
  FINAL2,
  FINAL3,
  FORCE1_MANIFEST_SHA256,
  SUPERSEDED_IN_SET1,
  SUPERSEDED_IN_SET2,
  loadSet,
  manifestOf,
  outcomeKind,
  readIn,
  sha256Hex,
  vectorByName,
  type SetInfo,
} from './vectorset.js';

describe.each([FINAL1, FINAL2, FINAL3] as SetInfo[])('$name identity', (s) => {
  it('MANIFEST.json hashes to the Go-written MANIFEST.json.sha256 and the pinned value', () => {
    expect(sha256Hex(readIn(s.dir, 'MANIFEST.json'))).toBe(s.manifestSha256);
    expect(readIn(s.dir, 'MANIFEST.json.sha256').toString('utf8').trim()).toBe(s.manifestSha256);
  });

  it('every file the manifest lists is byte-identical to the Go copy, and vectors.json is among them', () => {
    const m = manifestOf(s);
    expect(Object.keys(m.files).length).toBeGreaterThanOrEqual(4);
    expect(m.files['vectors.json']).toBeDefined();
    for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(readIn(s.dir, f)), f).toBe(want);
  });

  it(`holds ${s.vectors} vectors of the format ${s.format}, uniquely named, each with its evidence and pins file in the manifest`, () => {
    const f = loadSet(s);
    expect(f.format).toBe(s.format);
    expect(f.vectors.length).toBe(s.vectors);
    expect(new Set(f.vectors.map((v) => v.name)).size).toBe(s.vectors);
    const files = manifestOf(s).files;
    const names = new Set(f.vectors.map((v) => v.name));
    for (const v of f.vectors) {
      if (v.pins !== 'embedded') expect(files[`pins/${v.pins}`], `${v.name} pins`).toBeDefined();
      if (v.evidence !== undefined && v.evidence !== '') expect(files[`evidence/${v.evidence}`], `${v.name} evidence`).toBeDefined();
      else expect(names.has(v.base!), `${v.name} base`).toBe(true);
    }
  });
});

describe('the published sets', () => {
  it('sets 2 and 3 keep their README outside the manifest; set 1 lists it', () => {
    expect(manifestOf(FINAL2).files['README.md']).toBeUndefined();
    expect(manifestOf(FINAL3).files['README.md']).toBeUndefined();
    expect(manifestOf(FINAL1).files['README.md']).toBeDefined();
  });

  it('set 1 holds 110 synthetic and 15 live vectors by pins file and the groups synthetic and adversarial; set 3 adds live', () => {
    const f1 = loadSet(FINAL1).vectors;
    expect(f1.filter((v) => v.pins === 'real.json').length).toBe(15);
    expect(f1.filter((v) => v.pins !== 'real.json').length).toBe(110);
    expect(new Set(f1.map((v) => v.group))).toContain('synthetic');
    expect(new Set(f1.map((v) => v.group))).toContain('adversarial');
    expect(new Set(loadSet(FINAL3).vectors.map((v) => v.group))).toEqual(new Set(['synthetic', 'adversarial', 'live']));
  });

  it('set 3 verdict classes: 7 wallet, 3 direct, 49 indirect, 13 pin_mismatch (3 impl-slot, 4 impl, 3 proxy role, 3 logic role)', () => {
    const exp = loadSet(FINAL3).vectors.map((v) => v.expect);
    expect(exp.filter((e) => e.includes('"confirmation_route":"wallet"')).length).toBe(7);
    expect(exp.filter((e) => e.includes('"confirmation_route":"direct"')).length).toBe(3);
    expect(exp.filter((e) => e.includes('"reason":"indirect"')).length).toBe(49);
    const pm = exp.filter((e) => e.includes('"code":"pin_mismatch"'));
    expect(pm.length).toBe(13);
    const field = (f: string): number => pm.filter((e) => e.includes(`"field":"${f}"`)).length;
    expect(field('proxy_slots.wallet_impl')).toBe(3);
    expect(field('confirm_path.validator_wallet_impl')).toBe(4);
    expect(field('logic_pins.validator_wallet_proxy')).toBe(3);
    expect(field('logic_pins.validator_wallet_logic')).toBe(3);
  });

  it('the force fixture manifest is the Go-written one and every file is byte-identical', () => {
    expect(sha256Hex(readIn('arb_force1', 'MANIFEST.json'))).toBe(FORCE1_MANIFEST_SHA256);
    expect(readIn('arb_force1', 'MANIFEST.json.sha256').toString('utf8').trim()).toBe(FORCE1_MANIFEST_SHA256);
    const m = JSON.parse(readIn('arb_force1', 'MANIFEST.json').toString('utf8')) as { files: Record<string, string> };
    expect(Object.keys(m.files).sort()).toEqual(['README.md', 'fixture.json', 'header.bin', 'nodes.bin', 'receipt.bin', 'tx.bin']);
    for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(readIn('arb_force1', f)), f).toBe(want);
  });
});

describe('the superseded verdicts (V-RB12-E1RAISE (c): 12 in set 1, 1 in set 2)', () => {
  it('every superseded name is a vector of its set whose recorded literal is not the verdict now', () => {
    expect(Object.keys(SUPERSEDED_IN_SET1).length).toBe(12);
    expect(Object.keys(SUPERSEDED_IN_SET2).length).toBe(1);
    for (const [n, now] of Object.entries(SUPERSEDED_IN_SET1)) expect(vectorByName(FINAL1, n).expect, n).not.toBe(now);
    for (const [n, now] of Object.entries(SUPERSEDED_IN_SET2)) expect(vectorByName(FINAL2, n).expect, n).not.toBe(now);
  });

  it('every superseded case is carried again in set 3 with a wallet proof, and the proven world answers what the recorded literal says', () => {
    expect(Object.keys(CARRIED_AGAIN_IN_SET3).length).toBe(Object.keys(SUPERSEDED_IN_SET1).length);
    for (const [old, again] of Object.entries(CARRIED_AGAIN_IN_SET3)) {
      expect(old in SUPERSEDED_IN_SET1, `${old} is superseded in set 1`).toBe(true);
      expect(outcomeKind(vectorByName(FINAL3, again).expect), `${old} -> ${again}`).toBe(outcomeKind(vectorByName(FINAL1, old).expect));
      expect(outcomeKind(SUPERSEDED_IN_SET1[old]!), old).toBe('confirmation_path_unproven/reason=indirect');
    }
    const o = vectorByName(FINAL2, 'synth_valid_wallet_route_callee_code_is_not_examined');
    expect(outcomeKind(SUPERSEDED_IN_SET2[o.name]!)).toBe('confirmation_path_unproven/reason=indirect');
    expect(outcomeKind(o.expect)).toBe('finalized/confirmation_route=wallet');
  });

  it('the real direct-route vector is not superseded and set 3 carries it again under the same literal', () => {
    const r1 = vectorByName(FINAL1, 'real_valid');
    const r3 = vectorByName(FINAL3, 'real_valid_direct_route_unchanged');
    expect('real_valid' in SUPERSEDED_IN_SET1).toBe(false);
    expect('real_valid' in SUPERSEDED_IN_SET2).toBe(false);
    expect(r1.expect).toContain('"confirmation_route":"direct"');
    expect(r3.expect).toBe(r1.expect);
  });
});
