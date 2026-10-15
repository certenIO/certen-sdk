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
    // `keys show` on a name that does not exist fails locally, with no network and no API key —
    // which makes it the one failure this suite can provoke deterministically.
    const r = certen(['--json', 'keys', 'show', 'nosuchkey']);
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

  // Phase 0 / D3. `auth login` called process.exit(1) directly on a storage failure, which skips
  // `emitFailure` entirely — the process exited non-zero with an EMPTY stdout, so a caller
  // parsing the envelope got nothing to parse. Every failure path in this command must now
  // produce an envelope like any other.
  it('emits an envelope from auth login rather than exiting silently', () => {
    // stdin is /dev/null in this harness, so `--api-key -` reads EOF: no key, and no TTY to
    // prompt on. The failure is expected; the envelope is what is being asserted.
    const r = certen(['--json', 'auth', 'login', '--api-key', '-']);
    const env = soleJson(r.stdout);
    expect(env.ok).toBe(false);
    expect((env.error as { code: string }).code).toBe('NO_API_KEY');
    expect(r.code).toBe(2);
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
    const r = certen(['--json', 'keys', 'show', 'nosuchkey']);
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

  // Phase 0 / D4. These commands raised a bare `throw new Error(...)` for a wrong invocation,
  // which `resolveExitCode` has no way to distinguish from a rejected request — so "you forgot a
  // flag" and "the gateway said no" both exited 1 and read identically to an automated caller.
  // Each of these is a wrong INVOCATION and must exit 2.
  it('2 — a wrong invocation of `identity create` is a usage error, not a failed request', () => {
    const r = certen(['--json', 'identity', 'create', '--name', 'x']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('MISSING_SIGNING_KEY');
  });

  it('2 — mutually exclusive signing flags are a usage error', () => {
    const r = certen([
      '--json', 'tx', 'sign', 'some-id',
      '--sign-with', 'dev', '--signature', 'ab', '--public-key', 'cd',
    ]);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('CONFLICTING_SIGNING_FLAGS');
  });

  it('2 — an unsupported chain is a usage error, raised before any network call', () => {
    // No API key is configured in this environment, and NO_API_KEY is also exit 2 — so the code
    // is what proves the chain check ran FIRST. That ordering is the point: `fund` must not open
    // a real payment intent against a chain it was going to reject anyway.
    const r = certen(['--json', 'fund', '25', '--chain', 'base']);
    expect(r.code).toBe(2);
    const err = soleJson(r.stdout).error as { code: string; message: string };
    expect(err.code).toBe('UNSUPPORTED_CHAIN');
    // The suggestion is the useful half of the refusal: `base` is a real mainnet, not a typo of
    // nothing, so the CLI names the testnet rather than silently substituting it.
    expect(err.message).toContain('base-sepolia');
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

describe('CLI contract: context, profiles and the identity reference (docs/CLI-CONTRACT.md section 7)', () => {
  it('certen context emits one envelope, locally, with no API key and no network', () => {
    const r = certen(['--json', 'context']);
    expect(r.code).toBe(0);
    const env = soleJson(r.stdout);
    expect(env.ok).toBe(true);
    const d = env.data as Record<string, unknown>;
    // Every field the contract names is present, and absent choices are null rather than missing.
    for (const k of ['profile', 'profiles', 'gateway', 'credential', 'identity', 'key', 'chain', 'allow_mainnet_default', 'candidates']) {
      expect(d, k).toHaveProperty(k);
    }
    expect(d.profile).toBe('default');
    expect(d.identity).toBeNull();
    expect(d.allow_mainnet_default).toBe(false);
  });

  it('the human lines of context stay off stdout in JSON mode', () => {
    const r = certen(['--json', 'context']);
    // Exactly one line: the envelope. The human summary goes to stderr.
    expect(r.stdout.trim().split(/\r?\n/)).toHaveLength(1);
  });

  it('certen use chain emits one envelope naming the profile it wrote to, and the chain', () => {
    const r = certen(['--json', 'use', 'chain', 'base-sepolia']);
    expect(r.code).toBe(0);
    expect(soleJson(r.stdout).data).toMatchObject({ profile: 'default', chain: 'base-sepolia', known_testnet: true });
  });

  it('2 — use key for a key that does not exist is a usage error naming the code, and writes nothing', () => {
    const r = certen(['--json', 'use', 'key', 'nosuchkey']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('UNKNOWN_KEY');
  });

  it('2 — use with neither a value nor --unset is a usage error', () => {
    const r = certen(['--json', 'use', 'chain']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('MISSING_VALUE');
  });

  it('2 — a bad --profile is reported in an envelope, before anything is read', () => {
    const r = certen(['--json', 'context', '--profile', '../escape']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('INVALID_PROFILE_NAME');
  });

  it('--profile may appear before or after the subcommand, and a profile that does not exist is named', () => {
    for (const args of [['--profile', 'ghost', '--json', 'context'], ['--json', 'context', '--profile', 'ghost']]) {
      const r = certen(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('PROFILE_NOT_FOUND');
    }
  });

  it('2 — an identity reference that is none of a UUID, an ADI URL or a name is refused before any request', () => {
    const r = certen(['--json', 'identity', 'get', 'not a valid reference'], { CERTEN_API_KEY: 'ck_test_notreal', CERTEN_API_URL: 'http://127.0.0.1:9' });
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('INVALID_IDENTITY_REF');
  });

  it('2 — a command that needs an identity and has none says so before any request (the gateway here is unreachable)', () => {
    const r = certen(['--json', 'call', '--to', '0x1111111111111111111111111111111111111111', '--fn', 'f()', '--chain', 'base-sepolia'], { CERTEN_API_KEY: 'ck_test_notreal', CERTEN_API_URL: 'http://127.0.0.1:9' });
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('MISSING_IDENTITY');
  });

  it('2 — a duration with a bad unit is a usage error before any request', () => {
    const r = certen(['--json', 'tx', 'status', 'abc', '--timeout', '6 minutes'], { CERTEN_API_KEY: 'ck_test_notreal', CERTEN_API_URL: 'http://127.0.0.1:9' });
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('INVALID_TIMEOUT');
  });

  it('--help --json lists the new commands and the global --profile option', () => {
    const r = certen(['--json', '--help']);
    const data = soleJson(r.stdout).data as { commands: Array<{ name: string; commands?: Array<{ name: string }> }>; options?: Array<{ name: string }> };
    const names = data.commands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['context', 'use']));
    expect((data.commands.find((c) => c.name === 'use')!.commands ?? []).map((c) => c.name)).toEqual(
      expect.arrayContaining(['identity', 'key', 'chain', 'gateway', 'profile', 'allow-mainnet-default']),
    );
    expect(JSON.stringify(data)).toContain('"profile"');
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
    const r = certen(['keys', 'show', 'nosuchkey']);
    expect(r.code).toBe(1);
    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toContain('Error');
  });
});
