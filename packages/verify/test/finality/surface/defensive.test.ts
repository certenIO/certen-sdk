/**
 * The branch of reportFinalityFile that has no input in a document: Go's `section.Leg.Ref()` can fail only on a leg ParseSection already checked, so the carried
 * leg's own refusal is reached here by making the reader fail. A named refusal is a failed result with its state (as Go prints it); anything else is not a state this
 * section may invent and is not swallowed.
 */
import { describe, expect, it, vi } from 'vitest';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';

const ctl = vi.hoisted(() => ({ mode: 'named' as 'named' | 'plain' }));

vi.mock('../../../src/proof-v2/finality/addendum.js', async (orig) => {
  const real = await orig<typeof import('../../../src/proof-v2/finality/addendum.js')>();
  return {
    ...real,
    carriedLegRef: () => {
      if (ctl.mode === 'plain') throw new Error('boom');
      throw new FinalityStateError('finality_addendum_malformed', { field: 'leg.blockHash', reason: 'not_32_bytes' });
    },
  };
});

const { judgeFinalityText } = await import('../../../src/proof-v2/finality/docreport.js');
const { cases, docOf, fakeBaseRegistry, legSettlement } = await import('./support.js');

const c = cases().find((x) => x.id === 'go/chain_verifies_to_finalized')!;
const opts = () => ({ subject: 'DOC', registry: fakeBaseRegistry(), settlement: legSettlement(c.settlement, BigInt(c.chain)) });

describe('the carried leg that cannot be read', () => {
  it('a named refusal is FAILED with its state and judges no level', () => {
    ctl.mode = 'named';
    const r = judgeFinalityText(docOf(c), opts());
    expect([r.class, r.exit]).toEqual(['failed', 1]);
    expect(r.text).toBe('FAILED (finality)  DOC\n  finality_addendum_malformed{field="leg.blockHash",reason="not_32_bytes"}\n');
    expect(r.state?.code).toBe('finality_addendum_malformed');
    expect(r.report).toBeUndefined();
  });

  it('an error that is not a named state is not turned into one', () => {
    ctl.mode = 'plain';
    expect(() => judgeFinalityText(docOf(c), opts())).toThrow('boom');
  });
});
