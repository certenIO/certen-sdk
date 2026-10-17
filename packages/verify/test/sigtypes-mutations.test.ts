import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { judge, readFixture, vectors, type Expect } from './helpers/sigtypes.js';

/**
 * Byte-level mutations of the 154 shared vectors' binary signatures, against the validator's Go verdict on each.
 *
 * The shared vectors say what a well-formed signature of each type does. This corpus asks what the two verifiers do with a
 * signature that is almost one: for every vector, fourteen mutations of its binary encoding (a flipped bit, a replaced, deleted
 * or inserted byte, a truncation, an appended unknown field, a flip in the key or signature bytes), each judged by
 * govsig.Verify through sigfixture.Judge. The decoder, the digest, every curve and every named state must agree with Go on all
 * of them - in particular on the ones Go accepts (a mutation can land in a byte nothing reads, or keep a lax encoding valid) and
 * on the ones it cannot decode. The Go program that wrote it is test/fixtures/sigtypes/mutations.gen.go.txt. A mutation that
 * makes Go panic is not in the file: Go has no verdict there.
 */
const raw = readFixture('mutations.json');
const MUTATIONS_SHA256 = '41eeb8db2f1a3125df0c3389b310c6a9c1ce620980317017300b3b2f4bc7c72a';
interface Mutation {
  id: string;
  base: string;
  op: string;
  signature: string;
  expect: Expect;
}
const file = JSON.parse(raw.toString('utf8')) as { format: string; mutations: Mutation[] };
const byId = new Map(vectors.map((v) => [v.id, v]));

describe('mutations of the shared vectors, against Go', () => {
  it('is the file the Go program wrote, over the vectors this suite holds', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(MUTATIONS_SHA256);
    expect(file.format).toBe('certen:sigtypes-mutations:v1');
    expect(file.mutations.length).toBe(2154);
    for (const m of file.mutations) expect(byId.has(m.base), m.id).toBe(true);
  });

  it('exercises every kind of outcome, including the accepted ones', () => {
    const mix: Record<string, number> = {};
    for (const m of file.mutations) mix[m.expect.verdict] = (mix[m.expect.verdict] ?? 0) + 1;
    expect(mix).toEqual({
      accepted: 106,
      'named:g1_executor_version_unproven': 17,
      'named:network_name_unproven': 3,
      'refused:delegation_depth_exceeded': 21,
      'refused:executor_gate_not_met': 3,
      'refused:key_not_on_page': 22,
      'refused:not_a_key_signature': 76,
      'refused:signature_invalid': 940,
      'refused:typed_data_chain_id_mismatch': 6,
      'refused:undecodable': 960,
    });
  });

  it('reaches Go\'s verdict, key hash, digest form, eth rule, inner type and delegators on every one', () => {
    const wrong: string[] = [];
    for (const m of file.mutations) {
      const base = byId.get(m.base)!;
      const got = judge({ ...base, signature: m.signature });
      const exp = m.expect;
      const same =
        got.verdict === exp.verdict &&
        (exp.verdict !== 'accepted' ||
          (got.keyHash === exp.keyHash!.toLowerCase() &&
            got.form === exp.form &&
            got.ethRule === (exp.ethRule ?? '') &&
            got.innerType === (exp.innerType ?? base.type) &&
            JSON.stringify(got.delegators) === JSON.stringify(exp.delegators ?? [])));
      if (!same) wrong.push(`${m.id} (${m.op}): Go ${exp.verdict}${exp.form ? `/${exp.form}` : ''}, here ${got.verdict}${got.form ? `/${got.form}` : ''}${got.error instanceof Error ? ` :: ${got.error.message}` : ''}`);
    }
    expect(wrong).toEqual([]);
  });
});
