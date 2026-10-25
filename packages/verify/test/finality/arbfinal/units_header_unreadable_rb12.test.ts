/**
 * finality_block_header_unreadable (RB12-ARBFINAL-FIX; the twin of header_unreadable_rb12_test.go at the constructor level): K's header is on the
 * covered spine and below the finalized head, and the framework header reader refuses it. The expected texts are written out, not built by the
 * constructor under test; the verdicts of the whole kind are the finality_arb_final4 vectors.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodeBlockHeaderUnreadable, blockHeaderUnreadable } from '../../../src/proof-v2/finality/arbfinal/states.js';
import { Code, EvidenceReason, FinalityStateError, malformed, malformedAt, newState } from '../../../src/proof-v2/finality/state.js';
import { FIXTURES } from './vectorset.js';

const registry = JSON.parse(readFileSync(join(FIXTURES, 'finality', 'states.json'), 'utf8')) as {
  states: Record<string, { group: string; scope: string; required: string[]; optional: string[]; enums: { reason: string[] } }>;
};

describe('blockHeaderUnreadable', () => {
  it('names the block, the finalized head, the reader\'s reason and the index of the item', () => {
    const s = blockHeaderUnreadable(11999995n, 12000000n, malformedAt('header', 4, EvidenceReason.HeaderItemNot32Bytes, 31, 32)) as FinalityStateError;
    expect(s.canonical()).toBe(
      '{"code":"finality_block_header_unreadable","fields":{"block_number":"11999995","finalized_exec_number":"12000000","index":"4","reason":"header_item_not_32_bytes"}}',
    );
  });

  it('carries no index when the reader names none (the header is not a list, is short or has trailing bytes)', () => {
    const s = blockHeaderUnreadable(7n, 9n, malformed('header', EvidenceReason.HeaderNotRLPList, 0, 0)) as FinalityStateError;
    expect(s.canonical()).toBe('{"code":"finality_block_header_unreadable","fields":{"block_number":"7","finalized_exec_number":"9","reason":"header_not_rlp_list"}}');
    expect('index' in s.fields).toBe(false);
  });

  it('returns a cause that is not the reader\'s refusal as it is: a named state is not relabelled, a foreign error is not wrapped', () => {
    const other = newState(Code.ChainUnsupported, { chain: 1n });
    expect(blockHeaderUnreadable(1n, 2n, other)).toBe(other);
    const foreign = new Error('boom');
    expect(blockHeaderUnreadable(1n, 2n, foreign)).toBe(foreign);
  });
});

describe('the registry row of finality_block_header_unreadable', () => {
  const row = registry.states[CodeBlockHeaderUnreadable]!;
  it('is in group Arbitrum R with the three required fields and the optional index', () => {
    expect(CodeBlockHeaderUnreadable).toBe('finality_block_header_unreadable');
    expect(row.group).toBe('Arbitrum R');
    expect(row.scope).toBe('go_operational');
    expect(row.required).toEqual(['block_number', 'finalized_exec_number', 'reason']);
    expect(row.optional).toContain('index');
  });
  it('has exactly the seven header reasons of the framework reader, each a reason of finality_evidence_malformed', () => {
    expect(row.enums.reason).toEqual([
      'header_bad_item', 'header_item_is_list', 'header_item_not_32_bytes', 'header_item_not_canonical_uint', 'header_not_rlp_list',
      'header_too_few_items', 'header_trailing_bytes',
    ]);
    const malformedReasons = new Set(Object.values(EvidenceReason));
    for (const r of row.enums.reason) expect(malformedReasons.has(r), r).toBe(true);
  });
});
