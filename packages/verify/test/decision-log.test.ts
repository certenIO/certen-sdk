import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decisionLogVerdict } from '../src/agent-pack.js';

/**
 * The specification's decision-log vectors: transaction-controls docs/core/vectors/decision-log.json at pl/agt-7-raise 0fffc72 (dl-01..dl-34,
 * and dl-35..dl-48 of AGT-F135 / DE-109: the fifteenth kind `intervention.recorded`), pinned by sha256. The pack verifier's log check must give the
 * specification's verdict, reason and seq for every case. Two cases judge a PINNED head (input.expectedHead: log_truncated, log_head_mismatch); this check
 * takes no expected head (a pin is judged by the pack's own log checks), so for exactly those two the chain itself must verify, and that is asserted.
 */
const FILE = new URL('./fixtures/decision-log/decision-log.json', import.meta.url);
const SHA = 'e4e4fdcfec4ad7532c9715c10806d904a6bbf718d46d4b814a726413cb5e152f';
const text = readFileSync(FILE);
const v = JSON.parse(text.toString('utf8')) as { cases: Array<{ id: string; input: { logId: string; entries: unknown[]; expectedHead?: unknown }; expect: { ok: boolean; reason?: string; seq?: number } }> };

describe('decision log: the specification vectors', () => {
  it('the vector file is the pinned one, with 48 cases', () => {
    expect(createHash('sha256').update(text).digest('hex')).toBe(SHA);
    expect(v.cases.map((c) => c.id)).toEqual(Array.from({ length: 48 }, (_, i) => `dl-${String(i + 1).padStart(2, '0')}`));
  });
  const headOnly = v.cases.filter((c) => c.input.expectedHead !== undefined && !c.expect.ok).map((c) => c.id);
  it('the only refusals that need a pinned head are dl-12 and dl-14', () => expect(headOnly).toEqual(['dl-12', 'dl-14']));
  for (const c of v.cases) {
    it(`${c.id}: ${c.expect.ok ? 'verifies' : c.expect.reason}`, () => {
      const got = decisionLogVerdict({ logId: c.input.logId, entries: c.input.entries });
      if (headOnly.includes(c.id)) { expect(got).toEqual({ ok: true }); return; }
      if (c.expect.ok) { expect(got).toEqual({ ok: true }); return; }
      expect(got.ok).toBe(false);
      if (!got.ok) {
        expect(got.reason).toBe(c.expect.reason);
        if (c.expect.seq !== undefined) expect(got.seq).toBe(c.expect.seq);
      }
    });
  }
});
