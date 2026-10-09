import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTENT_STATUS_CLASS, classifyIntentStatus, isTerminalIntentStatus, intentOutcome, EXECUTION_PROOF_UNAVAILABLE,
} from '../src/intent-states.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The statuses the gateway can write to an intent: `chk_intent_status` as re-created by api-gateway migration 053
 * (origin/main), the same list its `migrate-preflight` pins. Copied here, with that provenance, so adding a status on the
 * gateway fails this test until the client table classifies it.
 */
const GATEWAY_STATUSES = [
  'created', 'signing_required', 'submitted', 'processing', 'anchoring', 'executed', 'completed', 'completed_unproven', 'proven',
  'failed', 'expired',
];

describe('the intent status table', () => {
  it('classifies every status the gateway can write', () => {
    for (const s of GATEWAY_STATUSES) {
      expect(classifyIntentStatus(s), s).not.toBe('unknown');
    }
  });

  it('classifies every status the vendored spec names in its description of the field', () => {
    const spec = JSON.parse(readFileSync(join(REPO_ROOT, 'spec', 'openapi.json'), 'utf8'));
    const schema = spec.paths['/v1/transaction/{id}'].get.responses['200'].content['application/json'].schema;
    const description = String(schema.properties.status.description);
    const named = [...description.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThanOrEqual(9); // the parser must not go silently vacuous
    for (const s of named) expect(classifyIntentStatus(s), `spec names \`${s}\``).not.toBe('unknown');
  });

  it('knows no status the gateway cannot write, other than the two older spellings this client has always accepted', () => {
    const extra = Object.keys(INTENT_STATUS_CLASS).filter((s) => !GATEWAY_STATUSES.includes(s));
    expect(extra.sort()).toEqual(['delivered', 'error']);
  });

  it('puts each status in the class its meaning requires', () => {
    expect(classifyIntentStatus('executed')).toBe('executed');
    expect(classifyIntentStatus('completed')).toBe('terminal_success');
    expect(classifyIntentStatus('proven')).toBe('terminal_success');
    expect(classifyIntentStatus('completed_unproven')).toBe('terminal_gas_only');
    for (const s of ['failed', 'expired', 'error']) expect(classifyIntentStatus(s), s).toBe('terminal_failure');
    for (const s of ['created', 'signing_required', 'submitted', 'processing', 'anchoring']) expect(classifyIntentStatus(s), s).toBe('in_flight');
  });

  it('treats executed as NOT terminal and completed_unproven and expired as terminal', () => {
    expect(isTerminalIntentStatus('executed')).toBe(false);
    expect(isTerminalIntentStatus('completed_unproven')).toBe(true);
    expect(isTerminalIntentStatus('expired')).toBe(true);
    expect(isTerminalIntentStatus('processing')).toBe(false);
  });

  it('never calls an unrecognised status terminal, and never lets a prototype key pass for one', () => {
    for (const s of ['brand_new_state', '', undefined, null, 7, 'constructor', '__proto__', 'toString']) {
      expect(classifyIntentStatus(s), String(s)).toBe('unknown');
      expect(isTerminalIntentStatus(s), String(s)).toBe(false);
    }
  });
});

describe('intentOutcome names the state and never invents one', () => {
  it('reads completed_unproven as its own outcome with the reason the proof can never exist', () => {
    expect(intentOutcome({ status: 'completed_unproven' })).toEqual({
      status: 'completed_unproven', class: 'terminal_gas_only', terminal: true, outcome: 'completed_unproven', reason: EXECUTION_PROOF_UNAVAILABLE,
    });
    expect(intentOutcome({ status: 'completed_unproven', reason_code: 'execution_proof_unavailable' }).reason).toBe('execution_proof_unavailable');
  });

  it('reads executed as an outcome that is not terminal', () => {
    expect(intentOutcome({ status: 'executed' })).toMatchObject({ outcome: 'executed', terminal: false, reason: null });
  });

  it('carries the gateway reason on a failure, and null when it sent none', () => {
    expect(intentOutcome({ status: 'failed', reason_code: 'target_reverted' })).toMatchObject({ outcome: 'failed', terminal: true, reason: 'target_reverted' });
    expect(intentOutcome({ status: 'expired' })).toMatchObject({ outcome: 'failed', reason: null });
  });

  it('reads completed, proven and in-flight statuses, and an unknown one as unknown', () => {
    expect(intentOutcome({ status: 'completed' })).toMatchObject({ outcome: 'completed', terminal: true });
    expect(intentOutcome({ status: 'processing' })).toMatchObject({ outcome: 'pending', terminal: false });
    expect(intentOutcome({ status: 'something_new' })).toMatchObject({ outcome: 'unknown', class: 'unknown', terminal: false, status: 'something_new' });
    expect(intentOutcome(undefined)).toMatchObject({ outcome: 'unknown', status: '' });
  });
});
