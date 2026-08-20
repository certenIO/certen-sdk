import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOLS, READ_TOOLS, WRITE_TOOLS, activeTools, writesAllowed } from '../src/tools.js';

/**
 * The tier split is this package's security boundary, so it is asserted rather than assumed.
 *
 * Each of these caught a real class of mistake during development: a write tool landing in the read
 * list, a tool reaching an endpoint that does not exist, and a write tool missing its confirmation
 * gate. None of them would fail a functional test — the server would work perfectly and be wrong.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const spec = JSON.parse(readFileSync(join(REPO_ROOT, 'spec', 'openapi.json'), 'utf8')) as {
  paths: Record<string, Record<string, { description?: string }>>;
};

function specOp(endpoint: string) {
  const [method, path] = endpoint.split(' ');
  return spec.paths[path]?.[method.toLowerCase()];
}

describe('tool tiers', () => {
  it('read tools are never exposed as write tools and vice versa', () => {
    const readNames = new Set(READ_TOOLS.map((t) => t.name));
    for (const w of WRITE_TOOLS) expect(readNames.has(w.name)).toBe(false);
    expect(READ_TOOLS.length + WRITE_TOOLS.length).toBe(ALL_TOOLS.length);
  });

  it('tool names are unique', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes only read tools when writes are not enabled', () => {
    const tools = activeTools({} as NodeJS.ProcessEnv);
    expect(tools).toHaveLength(READ_TOOLS.length);
    expect(tools.every((t) => t.tier === 'read')).toBe(true);
  });

  it('requires the env var to be exactly "1" — not merely present', () => {
    // "true", "yes" and "0" are all things someone types meaning to enable this. None of them
    // should, because a near-miss silently enabling writes is the wrong direction to fail in.
    for (const v of ['0', 'true', 'yes', '', 'TRUE']) {
      expect(writesAllowed({ CERTEN_MCP_ALLOW_WRITES: v } as NodeJS.ProcessEnv)).toBe(false);
    }
    expect(writesAllowed({ CERTEN_MCP_ALLOW_WRITES: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('exposes read and write tools when enabled', () => {
    const tools = activeTools({ CERTEN_MCP_ALLOW_WRITES: '1' } as NodeJS.ProcessEnv);
    expect(tools).toHaveLength(ALL_TOOLS.length);
  });
});

describe('the README describes the server that exists', () => {
  it('quotes the real tool counts', () => {
    // These went stale twice — once before the diagnostic tools were added and again when they
    // were. A number in prose has no way of noticing it is wrong, so it is asserted instead. If
    // this fails, update the README rather than the expectation.
    const readme = readFileSync(join(REPO_ROOT, 'packages', 'mcp', 'README.md'), 'utf8');
    const read = readme.match(/# (\d+) read tools/);
    const all = readme.match(/# (\d+) tools/);
    expect(read, 'README states a read-tool count').not.toBeNull();
    expect(all, 'README states a total tool count').not.toBeNull();
    expect(Number(read![1])).toBe(READ_TOOLS.length);
    expect(Number(all![1])).toBe(ALL_TOOLS.length);
  });
});

describe('tool invariants', () => {
  it('every mutating tool requires confirm:true', () => {
    for (const t of ALL_TOOLS.filter((x) => x.mutates)) {
      expect(t.inputSchema.properties, `${t.name} declares confirm`).toHaveProperty('confirm');
      expect(t.inputSchema.required ?? [], `${t.name} requires confirm`).toContain('confirm');
    }
  });

  it('no non-mutating tool has a confirmation gate', () => {
    // Asking to confirm a read teaches a model to pass confirm:true reflexively, which is the exact
    // habit that makes the gate worthless on the calls that matter.
    for (const t of ALL_TOOLS.filter((x) => !x.mutates)) {
      expect(t.inputSchema.properties, `${t.name}`).not.toHaveProperty('confirm');
    }
  });

  it('every read-tier tool is non-mutating', () => {
    for (const t of READ_TOOLS) expect(t.mutates, t.name).toBe(false);
  });

  it('every mutating tool is in the write tier', () => {
    for (const t of ALL_TOOLS.filter((x) => x.mutates)) expect(t.tier, t.name).toBe('write');
  });

  it('every tool points at an endpoint that exists in the vendored spec', () => {
    for (const t of ALL_TOOLS) {
      expect(specOp(t.endpoint), `${t.name} -> ${t.endpoint}`).toBeDefined();
    }
  });

  it('every ADDITIONAL endpoint a composite tool reaches also exists in the spec', () => {
    // `endpoint` alone becomes a half-truth the moment a tool answers one question with several
    // calls. Checking `alsoReaches` identically is what keeps the declaration honest rather than
    // decorative — declaring more can then only ever constrain a tool further.
    for (const t of ALL_TOOLS) {
      for (const extra of t.alsoReaches ?? []) {
        expect(specOp(extra), `${t.name} -> ${extra}`).toBeDefined();
      }
    }
  });

  it('a tool that calls more than one endpoint declares every one of them', () => {
    // Enforced by name for the composites that exist, because there is no way to derive the call
    // graph from a closure. If a new composite lands, it belongs in this list.
    const composites: Record<string, number> = { certen_doctor: 4 };
    for (const [name, count] of Object.entries(composites)) {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.alsoReaches ?? [], `${name} declares its extra endpoints`).toHaveLength(count);
    }
  });

  it('no read tool reaches a write-only endpoint, including via alsoReaches', () => {
    // The gateway states required scopes in prose, and inconsistently: sometimes backticked,
    // sometimes as "the `x:read` or `x:write` scope". A read endpoint therefore legitimately
    // mentions :write as an alternative — so the test is "does a :read scope grant access", not
    // "is :write mentioned anywhere". A genuinely write-only endpoint names only :write and fails.
    for (const t of READ_TOOLS) {
      for (const endpoint of [t.endpoint, ...(t.alsoReaches ?? [])]) {
        const description = specOp(endpoint)?.description ?? '';
        const scopes = [...description.matchAll(/`?([a-z]+:(?:read|write|admin))`?/g)].map((m) => m[1]);
        if (scopes.length === 0) continue;
        expect(
          scopes.some((sc) => sc.endsWith(':read')),
          `${t.name} -> ${endpoint} requires only ${scopes.join(', ')}`,
        ).toBe(true);
      }
    }
  });

  it('no read tool reaches an admin endpoint, even one with an :admin_read scope', () => {
    // The admin surface enumerates credentials and sits in the WRITE tier for that reason. A read
    // tool that quietly reached /v1/admin/* would move that capability across the tier boundary
    // without moving the tool, which is the failure the tier split exists to prevent.
    for (const t of READ_TOOLS) {
      for (const endpoint of [t.endpoint, ...(t.alsoReaches ?? [])]) {
        expect(endpoint.includes('/v1/admin/'), `${t.name} -> ${endpoint}`).toBe(false);
      }
    }
  });

  it('no tool accepts a private key, mnemonic or passphrase', () => {
    // The SDK's central guarantee is that your key never reaches it. A server that could accept
    // one would quietly undo that, so the parameter names are checked directly.
    const forbidden = /private|secret|mnemonic|seed|passphrase|privkey/i;
    for (const t of ALL_TOOLS) {
      for (const param of Object.keys(t.inputSchema.properties)) {
        expect(forbidden.test(param), `${t.name}.${param}`).toBe(false);
      }
    }
  });

  it('every tool has a non-trivial description', () => {
    for (const t of ALL_TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
    }
  });

  it('the diagnostic and proof tools are read-tier and non-mutating', () => {
    // Every one of these answers a question. None of them changes anything, so none may drift into
    // the write tier or acquire a confirmation gate.
    for (const name of [
      'certen_doctor', 'certen_chains_list', 'certen_whoami',
      'certen_proof_get', 'certen_proof_receipt', 'certen_proof_verify',
    ]) {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.tier, name).toBe('read');
      expect(tool!.mutates, name).toBe(false);
    }
  });

  it('the verify tool refuses to imply independent verification', () => {
    // An agent that reads "proof fetched" as "proof verified" is the failure mode this tool exists
    // to prevent, so the description has to say what it cannot establish, not just what it can.
    const verify = ALL_TOOLS.find((t) => t.name === 'certen_proof_verify')!;
    expect(verify.description).toMatch(/not independent verification/i);
    expect(verify.description).toMatch(/WRONG call/);
  });

  it('the receipt tool explains that a proof-service failure is not a missing proof', () => {
    const receipt = ALL_TOOLS.find((t) => t.name === 'certen_proof_receipt')!;
    expect(receipt.description).toMatch(/does NOT mean the proof is missing/i);
  });

  it('the long-running wait tool warns about its duration', () => {
    const wait = ALL_TOOLS.find((t) => t.name === 'certen_execute_wait')!;
    expect(wait.description).toMatch(/60-110 seconds/i);
  });
});

/**
 * A tool must not advertise a call the API will reject.
 *
 * `certen_identity_create` required `name` and `publicKeyHash` and left `publicKey` optional — while
 * the gateway rejects an external identity that has no `public_key`, because the hash alone cannot
 * sign. So an agent following the tool's own schema made a call that could only ever 400.
 *
 * It came from the spec: `POST /v1/identity` declares `required: ['name']` and said nothing more,
 * since the real rule depends on the signing mode and JSON Schema was not expressing it. Anything
 * generated from that spec inherits the same gap. The MCP tool only ever creates EXTERNAL
 * identities — it exposes no `signing_mode` — so for this tool both key fields are unconditionally
 * required, and saying so is the whole fix.
 */
describe('tool schemas describe calls that can actually succeed', () => {
  it('every required parameter is a parameter the tool declares', () => {
    // A `required` entry with no matching property makes a tool uncallable: the client cannot
    // satisfy it, and nothing else would notice.
    for (const t of ALL_TOOLS) {
      const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const declared = Object.keys(schema.properties ?? {});
      for (const req of schema.required ?? []) {
        expect(declared, `${t.name} requires "${req}" but does not declare it`).toContain(req);
      }
    }
  });

  it('creating an identity requires the public key, not only its hash', () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'certen_identity_create')!;
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('publicKey');
    expect(schema.required).toContain('publicKeyHash');
  });

  it('signing requires only the target and the confirmation', () => {
    // The three signer fields apply to the transaction-hash path only. Marking them required made
    // the inbox-id path — the one an agent reaches straight from certen_pending_list — impossible
    // to call. `run` enforces them where the requirement actually is.
    const tool = ALL_TOOLS.find((t) => t.name === 'certen_sign_create')!;
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toEqual(['targetId', 'confirm']);
    // The inference rule is in the description because that is what the model reads to decide what
    // to pass.
    expect(tool.description).toMatch(/UUID/);
    expect(tool.description).toMatch(/certen_pending_list/);
    expect(tool.description).toMatch(/TxID/);
  });

  it('the identity tool says that it waits, and what can_sign: null means', () => {
    // Waiting by default replaces "poll certen_identity_get until terminal and can_sign is true" —
    // several more tool calls, and a contract an agent can get wrong invisibly, since reading a null
    // `can_sign` as either false or ready produces an identity that fails at the last step of every
    // later flow.
    const tool = ALL_TOOLS.find((t) => t.name === 'certen_identity_create')!;
    expect(tool.description).toMatch(/WAITS/);
    expect(tool.description).toMatch(/can_sign/);
    expect(tool.description).toMatch(/null/);
  });
});
