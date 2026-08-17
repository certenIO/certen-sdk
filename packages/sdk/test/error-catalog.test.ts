import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CertenError } from '../src/errors.js';
// The shared catalog, also used to generate the table in llms-full.txt.
import { ERROR_CODES } from '../../../tools/agentgen/lib/errors.mjs';
import { VENDORED_ERROR_CODES } from '../src/error-codes.js';

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

describe('the SDK catalogue against what the gateway actually raises', () => {
  // Vendored from the gateway by `npm run spec:dump`, exactly as spec/openapi.json is. Before this,
  // the SDK's list and the gateway's were unrelated artifacts — either could gain, lose or
  // re-classify a code and nothing would notice.
  const GATEWAY = JSON.parse(
    readFileSync(join(REPO_ROOT, 'spec', 'errors.json'), 'utf8'),
  ) as { errors: Array<{ code: string; status: number; retryable: boolean; audience: string }> };

  const byCode = new Map(GATEWAY.errors.map((e) => [e.code, e]));

  /**
   * Codes the SDK raises that the gateway never does, because they happen before or instead of an
   * HTTP response. Anything else appearing here is drift.
   */
  const SDK_ONLY = new Set(['NETWORK_ERROR']);

  it('vendors a catalogue worth checking against', () => {
    expect(GATEWAY.errors.length).toBeGreaterThanOrEqual(30);
    expect(byCode.has('PAYMENT_REQUIRED')).toBe(true);
  });

  it('claims no code the gateway cannot produce', () => {
    // A documented error that cannot occur sends someone writing a handler for a dead branch.
    const phantom = ERROR_CODES
      .map((e) => e.code)
      .filter((code) => !byCode.has(code) && !SDK_ONLY.has(code));
    expect(phantom, 'codes documented here that the gateway never raises').toEqual([]);
  });

  it('agrees with the gateway on status and retryability', () => {
    // `retryable` is acted on automatically. The two lists disagreeing means one of them makes a
    // client retry something that can never succeed, or give up on something that would have.
    const disagreements: string[] = [];
    for (const entry of ERROR_CODES) {
      const gw = byCode.get(entry.code);
      if (!gw) continue;
      if (entry.status !== gw.status) {
        disagreements.push(`${entry.code}: SDK says ${entry.status}, gateway ${gw.status}`);
      }
      if (entry.retryable !== gw.retryable) {
        disagreements.push(`${entry.code}: SDK retryable=${entry.retryable}, gateway ${gw.retryable}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('reports how much of the caller-facing vocabulary is documented', () => {
    // Not a pass/fail on coverage — the platform-fault codes are not worth an agent's attention.
    // What this pins is that the CALLER-facing ones a client must handle are not silently growing
    // beyond what the docs describe.
    const callerFacing = GATEWAY.errors.filter((e) => e.audience === 'caller').map((e) => e.code);
    const documented = new Set(ERROR_CODES.map((e) => e.code));
    const missing = callerFacing.filter((c) => !documented.has(c));

    // Known gap, recorded rather than hidden: these are raised and not yet in the SDK docs.
    // Shrinking this list is the work; growing it silently is the regression.
    expect(missing.length).toBeLessThanOrEqual(12);
  });
});

describe('the two codes where status alone gets retryability wrong', () => {
  it('retries an in-flight idempotent request', async () => {
    // A 409 normally means "do not retry". This one means an identical request is already running,
    // and retrying the SAME key is the correct response — treating it as terminal fails a request
    // that would have succeeded moments later.
    const err = new CertenError('still running', 409, 'IDEMPOTENCY_KEY_IN_FLIGHT');
    expect(err.isRetryable).toBe(true);
  });

  it('does not retry an exhausted plan quota', async () => {
    // A 429 normally means "back off". This one is a quota for the billing period, not a rate —
    // no amount of backing off clears it, and retrying burns the attempts a genuinely transient
    // failure would need.
    const err = new CertenError('quota gone', 429, 'PLAN_QUOTA_EXCEEDED');
    expect(err.isRetryable).toBe(false);
  });

  it('leaves ordinary throttles and conflicts alone', async () => {
    expect(new CertenError('slow', 429, 'RATE_LIMIT_EXCEEDED').isRetryable).toBe(true);
    expect(new CertenError('dup', 409, 'CONFLICT').isRetryable).toBe(false);
  });
});

/**
 * The runtime list `doctor` compares against must match the vendored catalogue.
 *
 * `spec/errors.json` is not shipped inside the SDK package, so `doctor` carries its own copy of the
 * code NAMES to notice a gateway that has moved ahead of it. Two copies of anything drift; this is
 * the test that stops them.
 */
describe('the list doctor checks against', () => {
  it('matches the vendored catalogue exactly', () => {
    const vendored = JSON.parse(
      readFileSync(join(REPO_ROOT, 'spec', 'errors.json'), 'utf8'),
    ) as { errors: Array<{ code: string }> };

    expect([...VENDORED_ERROR_CODES].sort())
      .toEqual(vendored.errors.map((e) => e.code).sort());
  });
});
