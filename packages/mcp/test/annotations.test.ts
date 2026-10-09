import { describe, it, expect } from 'vitest';
import { dispatch } from '../src/protocol.js';
import { createHandlers } from '../src/server.js';
import { ALL_TOOLS, READ_TOOLS, WRITE_TOOLS, annotationsFor } from '../src/tools.js';

/**
 * Every tool carries the four MCP behaviour hints, derived from the metadata the server already enforces with (`tier`, `mutates`) plus
 * two explicit facts on each mutating tool (`destructive`, `idempotent`). Annotations are hints a client may weigh, not enforcement; the
 * `confirm:true` stop and the write-tier switch remain what actually gate a call.
 */
const WRITES = { CERTEN_API_KEY: 'k', CERTEN_MCP_ALLOW_WRITES: '1' } as NodeJS.ProcessEnv;
const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';

/** The classification of every mutating tool, written out so a change to one is a visible diff in review. */
const MUTATING: Record<string, { destructive: boolean; idempotent: boolean; why: string }> = {
  certen_webhook_redeliver: { destructive: false, idempotent: false, why: 'delivers again on every call' },
  certen_billing_register_payer: { destructive: false, idempotent: true, why: 'adds an address; a duplicate is rejected, not merged' },
  certen_identity_create: { destructive: false, idempotent: false, why: 'provisions; a repeat is a new attempt' },
  certen_identity_update: { destructive: true, idempotent: true, why: 'overwrites chains / webhook url' },
  certen_identity_retire: { destructive: true, idempotent: true, why: 'retires; retiring a retired identity changes nothing' },
  certen_transaction_open: { destructive: false, idempotent: false, why: 'opens an intent that can move value' },
  certen_transaction_submit_signature: { destructive: true, idempotent: false, why: 'the point of no return: executes on chain' },
  certen_sign_create: { destructive: false, idempotent: false, why: 'creates a signing request' },
  certen_sign_submit_signature: { destructive: true, idempotent: false, why: 'casts a vote that can execute' },
  certen_governance_submit_signature: { destructive: true, idempotent: false, why: 'signs a governance operation' },
  certen_admin_rotate_api_key: { destructive: true, idempotent: false, why: 'invalidates the old key' },
  certen_admin_revoke_api_key: { destructive: true, idempotent: true, why: 'revokes; revoking a revoked key changes nothing' },
};

describe('annotationsFor', () => {
  it('marks every tool that does not mutate read-only, with no destructive or idempotent claim, and open-world', () => {
    const readish = ALL_TOOLS.filter((t) => !t.mutates);
    expect(readish.length).toBeGreaterThan(30);
    for (const t of readish) expect(annotationsFor(t), t.name).toEqual({ readOnlyHint: true, openWorldHint: true });
  });

  it('includes the admin read tools, which sit in the write TIER but change nothing', () => {
    const adminReads = WRITE_TOOLS.filter((t) => !t.mutates);
    expect(adminReads.map((t) => t.name).sort()).toEqual(['certen_admin_audit_log', 'certen_admin_list_api_keys', 'certen_admin_usage']);
    for (const t of adminReads) expect(annotationsFor(t).readOnlyHint, t.name).toBe(true);
  });

  it('marks every write tool readOnlyHint:false with both other hints stated', () => {
    const mutating = ALL_TOOLS.filter((t) => t.mutates);
    expect(mutating.map((t) => t.name).sort()).toEqual(Object.keys(MUTATING).sort());
    for (const t of mutating) {
      const a = annotationsFor(t);
      expect(a.readOnlyHint, t.name).toBe(false);
      expect(typeof a.destructiveHint, `${t.name} destructiveHint`).toBe('boolean');
      expect(typeof a.idempotentHint, `${t.name} idempotentHint`).toBe('boolean');
      expect(a.openWorldHint, t.name).toBe(true);
    }
  });

  it('makes every revoke, retire and rotate destructive, and no tool is destructive without being a write', () => {
    for (const t of ALL_TOOLS.filter((x) => /(revoke|retire|rotate)/.test(x.name))) {
      expect(annotationsFor(t).destructiveHint, t.name).toBe(true);
    }
    for (const t of ALL_TOOLS.filter((x) => !x.mutates)) expect(annotationsFor(t).destructiveHint, t.name).toBeUndefined();
  });

  it('matches the written-out classification, tool by tool', () => {
    for (const t of ALL_TOOLS.filter((x) => x.mutates)) {
      const want = MUTATING[t.name];
      expect(want, `${t.name} is missing from the table`).toBeDefined();
      expect({ destructive: annotationsFor(t).destructiveHint, idempotent: annotationsFor(t).idempotentHint }, `${t.name}: ${want.why}`)
        .toEqual({ destructive: want.destructive, idempotent: want.idempotent });
    }
  });

  it('never claims a tool is idempotent when it opens, signs or delivers', () => {
    for (const name of ['certen_transaction_open', 'certen_transaction_submit_signature', 'certen_sign_submit_signature', 'certen_governance_submit_signature', 'certen_webhook_redeliver']) {
      expect(MUTATING[name].idempotent, name).toBe(false);
    }
  });

  it('keeps the read tier read-only and the counts consistent', () => {
    expect(READ_TOOLS.every((t) => !t.mutates)).toBe(true);
    expect(ALL_TOOLS.length).toBe(READ_TOOLS.length + WRITE_TOOLS.length);
  });
});

describe('tools/list carries them, by protocol era', () => {
  const list = async (setup: 'modern' | string | null) => {
    const h = createHandlers({ env: WRITES });
    if (setup && setup !== 'modern') await dispatch({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: setup } }, h);
    const params = setup === 'modern' ? { _meta: { [PV]: '2026-07-28', [CAPS]: {} } } : {};
    const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params }, h);
    return (r?.result as { tools: Array<{ name: string; annotations?: Record<string, boolean> }> }).tools;
  };

  it('attaches annotations to every tool on 2026-07-28, 2025-11-25, 2025-06-18 and 2025-03-26', async () => {
    for (const era of ['modern', '2025-11-25', '2025-06-18', '2025-03-26']) {
      const tools = await list(era);
      expect(tools.length, era).toBe(ALL_TOOLS.length);
      for (const t of tools) {
        expect(t.annotations, `${era} ${t.name}`).toBeDefined();
        expect(typeof t.annotations!.readOnlyHint, `${era} ${t.name}`).toBe('boolean');
        expect(t.annotations!.openWorldHint, `${era} ${t.name}`).toBe(true);
      }
    }
  });

  it('does not send annotations to a 2024-11-05 client, which predates them', async () => {
    for (const t of await list('2024-11-05')) expect(t.annotations, t.name).toBeUndefined();
  });

  it('states readOnlyHint:false for exactly the mutating tools on the wire', async () => {
    const tools = await list('modern');
    const nonReadOnly = tools.filter((t) => t.annotations!.readOnlyHint === false).map((t) => t.name).sort();
    expect(nonReadOnly).toEqual(Object.keys(MUTATING).sort());
  });
});
