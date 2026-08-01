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

  it('no read tool reaches a write-only endpoint', () => {
    // The gateway states required scopes in prose, and inconsistently: sometimes backticked,
    // sometimes as "the `x:read` or `x:write` scope". A read endpoint therefore legitimately
    // mentions :write as an alternative — so the test is "does a :read scope grant access", not
    // "is :write mentioned anywhere". A genuinely write-only endpoint names only :write and fails.
    for (const t of READ_TOOLS) {
      const description = specOp(t.endpoint)?.description ?? '';
      const scopes = [...description.matchAll(/`?([a-z]+:(?:read|write|admin))`?/g)].map((m) => m[1]);
      if (scopes.length === 0) continue;
      expect(
        scopes.some((sc) => sc.endsWith(':read')),
        `${t.name} -> ${t.endpoint} requires only ${scopes.join(', ')}`,
      ).toBe(true);
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

  it('the long-running wait tool warns about its duration', () => {
    const wait = ALL_TOOLS.find((t) => t.name === 'certen_execute_wait')!;
    expect(wait.description).toMatch(/60-110 seconds/i);
  });
});
