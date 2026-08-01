import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CertenError } from '../src/errors.js';
// The shared catalog, also used to generate the table in llms-full.txt.
import { ERROR_CODES } from '../../../tools/agentgen/lib/errors.mjs';

/**
 * The error catalog exists in three places, and this file is why they cannot disagree:
 *
 *   1. `docs/errors.md`             — what a human reads
 *   2. `tools/agentgen/lib/errors.mjs` — what generates the table in llms-full.txt
 *   3. `CertenError.isRetryable`    — what actually decides at runtime
 *
 * The retry decision is the one that costs money to get wrong. An agent that retries a
 * `CONFLICT` burns turns; one that gives up on a `BAD_GATEWAY` abandons a transaction that would
 * have gone through. Documentation drifting away from the getter is exactly how that happens, so
 * the drift is made into a test failure rather than a surprise.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ERRORS_MD = readFileSync(join(REPO_ROOT, 'docs', 'errors.md'), 'utf8');

interface DocRow {
  code: string;
  status: number | null;
  retryable: boolean;
}

/** Parse the "Error Codes" table out of docs/errors.md. */
function docRows(): DocRow[] {
  const rows: DocRow[] = [];
  const section = ERRORS_MD.split('## Error Codes')[1]?.split('\n## ')[0] ?? '';
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*`([A-Z_]+)`\s*\|\s*([0-9]+|—)\s*\|\s*(yes|no)\s*\|/);
    if (!m) continue;
    rows.push({
      code: m[1],
      status: m[2] === '—' ? null : Number(m[2]),
      retryable: m[3] === 'yes',
    });
  }
  return rows;
}

describe('error catalog', () => {
  const rows = docRows();

  it('docs/errors.md actually contains a parseable retryable column', () => {
    // Guards the parser itself: a silently-empty table would make every check below vacuous.
    expect(rows.length).toBeGreaterThanOrEqual(9);
  });

  it('documents exactly the codes the shared catalog defines', () => {
    expect(rows.map((r) => r.code).sort()).toEqual(ERROR_CODES.map((e) => e.code).sort());
  });

  it('agrees with the shared catalog on status and retryability', () => {
    for (const row of rows) {
      const entry = ERROR_CODES.find((e) => e.code === row.code)!;
      expect(row.retryable, `${row.code} retryable`).toBe(entry.retryable);
      // The catalog stores 0 for "never reached the gateway"; the doc writes that as an em dash.
      expect(row.status ?? 0, `${row.code} status`).toBe(entry.status);
    }
  });

  it('agrees with CertenError.isRetryable — the getter that actually decides', () => {
    for (const row of rows) {
      const err = new CertenError('x', row.status ?? 0, row.code);
      expect(err.isRetryable, `${row.code} (HTTP ${row.status ?? 0})`).toBe(row.retryable);
    }
  });

  it('treats a request that never reached the gateway as retryable', () => {
    // Safe only because every POST carries an Idempotency-Key. If that ever stops being true, this
    // assertion is the one that should be revisited first.
    expect(new CertenError('down', 0, 'NETWORK_ERROR').isRetryable).toBe(true);
  });

  it('never marks a client mistake retryable', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(new CertenError('x', status, 'X').isRetryable, `HTTP ${status}`).toBe(false);
    }
  });
});
