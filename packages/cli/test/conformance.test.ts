import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, execFileSync as _e } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Conformance suite for the `--json` machine contract.
 *
 * This is the spec in executable form — docs/CLI-CONTRACT.md is the prose version. Changing any
 * assertion here is a contract change for every automated caller, not a test tweak.
 *
 * These cases run the built binary as a SUBPROCESS on purpose. The two properties that matter most
 * — "stdout carries exactly one JSON object and nothing else" and "the process exits with this
 * code" — are properties of a process. An in-process test that stubs console.log cannot observe
 * either one, which is exactly how a CLI ends up emitting a stray banner line that breaks every
 * consumer while its unit tests stay green.
 *
 * Nothing here reaches the network. The unreachable-gateway case points at 127.0.0.1:9 (discard),
 * which refuses immediately and locally.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

/** An isolated HOME so the suite never reads or writes the developer's real ~/.certen. */
const HOME = mkdtempSync(join(tmpdir(), 'certen-conformance-'));

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

function certen(args: string[], env: Record<string, string> = {}): Run {
  const base = {
    ...process.env,
    HOME,
    USERPROFILE: HOME,
    // Never inherit the developer's real credentials or gateway.
    CERTEN_API_KEY: '',
    CERTEN_API_URL: '',
    ...env,
  };
  // Empty string still counts as "set" for some lookups; delete instead.
  for (const k of ['CERTEN_API_KEY', 'CERTEN_API_URL']) {
    if (base[k] === '') delete base[k];
  }

  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: base,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? -1 };
  }
}

/** Parses only if stdout is exactly one JSON value — two concatenated objects throw. */
function soleJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`built CLI not found at ${CLI} — run \`npm run build\` before the CLI suite`);
  }
});

describe('CLI contract: stdout carries exactly one JSON envelope', () => {
  it('emits a single parseable object on success', () => {
    const r = certen(['--json', 'auth', 'status']);
    const env = soleJson(r.stdout);
    expect(env.ok).toBe(true);
    expect(env).toHaveProperty('data');
    expect(r.code).toBe(0);
  });

  it('emits a single parseable object on failure', () => {
    const r = certen(['--json', 'identity', 'list']);
    const env = soleJson(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error).toMatchObject({ retryable: false });
  });

  it('puts nothing but the envelope on stdout — no banners, no progress lines', () => {
    const r = certen(['--json', 'auth', 'status']);
    // Exactly one line, and it parses. A stray line would break both assertions.
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
  });

  it('keeps human notes off stdout in JSON mode', () => {
    // `keys list` with no keys prints "(no keys in ...)" — that must not land on stdout.
    const r = certen(['--json', 'keys', 'list']);
    expect(() => soleJson(r.stdout)).not.toThrow();
  });
});

describe('CLI contract: exit codes', () => {
  it('0 — success', () => {
    expect(certen(['--json', 'auth', 'status']).code).toBe(0);
  });

  it('1 — the operation failed', () => {
    const r = certen(['--json', 'identity', 'list']);
    expect(r.code).toBe(1);
    expect(soleJson(r.stdout).ok).toBe(false);
  });

  it('2 — unknown command is a usage error, not an operation failure', () => {
    const r = certen(['--json', 'nosuchcommand']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('USAGE_ERROR');
  });

  it('2 — a missing required flag is a usage error', () => {
    const r = certen(['--json', 'identity', 'create']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('USAGE_ERROR');
  });

  it('2 — no API key configured is a usage error, not a failed request', () => {
    const r = certen(['--json', 'portfolio']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('NO_API_KEY');
  });

  it('3 — gateway unreachable, and the error says it is retryable', () => {
    const r = certen(['--json', 'portfolio'], {
      CERTEN_API_KEY: 'ck_test_notreal',
      // Discard port: refuses immediately, no network required.
      CERTEN_API_URL: 'http://127.0.0.1:9',
    });
    expect(r.code).toBe(3);
    const err = soleJson(r.stdout).error as { code: string; retryable: boolean };
    expect(err.code).toBe('NETWORK_ERROR');
    // The retry decision must match the SDK's: unreachable is worth another attempt.
    expect(err.retryable).toBe(true);
  });
});

describe('CLI contract: --help --json describes the whole tree', () => {
  it('returns commands, options and exit codes in one call', () => {
    const r = certen(['--json', '--help']);
    expect(r.code).toBe(0);
    const env = soleJson(r.stdout);
    expect(env.ok).toBe(true);

    const data = env.data as {
      name: string;
      version: string;
      exitCodes: Record<string, string>;
      commands: Array<{ name: string; path: string; commands: unknown[] }>;
    };
    expect(data.name).toBe('certen');
    expect(data.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(data.exitCodes['3']).toBe('gateway unreachable');

    const names = data.commands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['auth', 'identity', 'tx', 'portfolio', 'admin']));

    // Nested commands are present, so discovery really is one call rather than one per subcommand.
    const identity = data.commands.find((c) => c.name === 'identity')!;
    expect((identity.commands as Array<{ path: string }>).map((c) => c.path)).toContain('certen identity get');
  });

  it('marks a mandatory flag as required, distinct from one that merely takes a value', () => {
    const r = certen(['--json', '--help']);
    const data = soleJson(r.stdout).data as {
      commands: Array<{ name: string; commands: Array<{ name: string; options: Array<{ name: string; required: boolean; takesValue: boolean }> }> }>;
    };
    const create = data.commands.find((c) => c.name === 'identity')!.commands.find((c) => c.name === 'create')!;
    const nameOpt = create.options.find((o) => o.name === 'name')!;
    const chainsOpt = create.options.find((o) => o.name === 'chains')!;
    expect(nameOpt).toMatchObject({ required: true, takesValue: true });
    expect(chainsOpt).toMatchObject({ required: false, takesValue: true });
  });
});

describe('CLI contract: table mode is unchanged for humans', () => {
  it('prints a table, not JSON, when --json is absent', () => {
    const r = certen(['auth', 'status']);
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout.trim())).toThrow();
    expect(r.stdout).toContain('api_url');
  });

  it('reports failures as a human line on stderr and still exits non-zero', () => {
    const r = certen(['identity', 'list']);
    expect(r.code).toBe(1);
    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toContain('Error');
  });
});
