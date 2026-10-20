/**
 * The finality_adiri3 vectors that are decided before any signature is verified (structural and pin refusals of the 652-record base chain,
 * the small synthetic chains): a quick subset the mutation gate runs next to the unit tests. The full set runs in vectors_shard0..3.
 */
import { describe, expect, it } from 'vitest';
import { judge, vectors } from './vectorset.js';

const isFast = (v: { name: string; group: string; expect: string; evidence?: string }): boolean => {
  if (v.group === 'live') return false;
  const j = JSON.parse(v.expect) as { code: string; fields: Record<string, unknown> };
  if (j.code === 'finalized') return v.name.startsWith('syn');
  if (j.code === 'committee_chain_broken') return j.fields.check !== 'signature_invalid';
  if (j.code === 'finality_block_mismatch') return j.fields.field === 'blockHash' || j.fields.field === 'blockNumber';
  if (j.code === 'finality_link_broken' || j.code === 'finality_header_chain_broken') return v.name.startsWith('syn');
  return true;
};

describe('finality_adiri3: the vectors decided before any signature work', () => {
  const fast = vectors().filter(isFast);
  it('is a substantial subset', () => {
    expect(fast.length).toBeGreaterThanOrEqual(35);
  });
  for (const v of fast) {
    it(v.name, () => {
      expect(judge(v)).toBe(v.expect);
    });
  }
});
