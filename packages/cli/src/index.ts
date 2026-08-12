#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { CertenError } from '@certen.io/sdk';
import { EXIT, type ExitCode } from './errors.js';
import { setJsonMode, flushSuccess, emitFailure } from './output.js';
import { commandTree } from './help-json.js';

/** Read the version from package.json — dist/ sits one level below the manifest. */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')).version as string;
  } catch {
    return '0.0.0-unknown';
  }
}
import { registerAuthCommands } from './commands/auth.js';
import { registerKeysCommands } from './commands/keys.js';
import { registerIdentityCommands } from './commands/identity.js';
import { registerTransactionCommands } from './commands/transaction.js';
import { registerPendingCommands } from './commands/pending.js';
import { registerGovernanceCommands } from './commands/governance.js';
import { registerPortfolioCommands } from './commands/portfolio.js';
import { registerAdminCommands } from './commands/admin.js';
import { registerBillingCommands } from './commands/billing.js';
import { registerChainsCommands } from './commands/chains.js';
import { registerWhoamiCommands } from './commands/whoami.js';
import { registerDoctorCommands } from './commands/doctor.js';
import { registerProofCommands } from './commands/proof.js';
import { formatRootHelp } from './help-root.js';

const VERSION = readVersion();

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('certen')
    .description('CERTEN Gateway CLI')
    // Was hardcoded to 0.1.0 while package.json said 0.2.0, so `certen --version` reported a
    // release that does not exist. Read it from the manifest so the two cannot drift again.
    .version(VERSION)
    // Declared so it appears in --help. It is stripped from argv before parsing (see run()), because
    // a global flag that may appear after a subcommand is not something commander models.
    .option('--json', 'Emit one JSON envelope on stdout; human output goes to stderr');

  registerChainsCommands(program);
  registerAuthCommands(program);
  registerKeysCommands(program);
  registerDoctorCommands(program);
  registerWhoamiCommands(program);
  registerIdentityCommands(program);
  registerTransactionCommands(program);
  registerProofCommands(program);
  registerPendingCommands(program);
  registerGovernanceCommands(program);
  registerPortfolioCommands(program);
  registerBillingCommands(program);
  registerAdminCommands(program);

  // Every command, not just the root. `exitOverride()` is NOT inherited by subcommands, so without
  // this walk a missing required flag on `identity create` called process.exit(1) inside commander:
  // stdout stayed empty, no envelope was ever emitted, and a usage error was indistinguishable from
  // a failed request. Every nested command has to opt in explicitly.
  applyExitOverride(program);

  // Grouped by journey stage rather than alphabetically. Applied AFTER every command is
  // registered, so nothing can be missing from the listing it builds. Subcommand help is
  // untouched — see help-root.ts.
  program.configureHelp({ formatHelp: formatRootHelp });
  return program;
}

function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) applyExitOverride(sub as Command);
}

/**
 * Map a thrown value to an exit code, and emit the matching envelope.
 *
 * The four codes exist so an automated caller never has to parse English to decide what to do:
 * `2` means fix the invocation, `3` means the gateway was unreachable and nothing was submitted,
 * `1` means the gateway answered and said no.
 */
function handleError(err: unknown): ExitCode {
  if (err instanceof CommanderError) {
    // --help and --version are successful terminations that commander reports by throwing.
    if (err.exitCode === 0 || err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      return EXIT.OK;
    }
    return emitFailure({
      message: err.message.replace(/^error: /, ''),
      code: 'USAGE_ERROR',
      exitCode: EXIT.USAGE,
    });
  }

  if (err instanceof CertenError) {
    // Pass the ERROR, not a copy of its fields.
    //
    // This used to flatten it into an object literal. The literal carried the same
    // values but destroyed the class identity, so a 402 reached the reporter as an
    // anonymous shape and its payment target was silently dropped — the refusal
    // printed a code and a message while the fix sat unread on the error.
    //
    // Nothing is lost by passing the instance: message, code, status and requestId
    // are all readable on it, and `isRetryable` is a getter, so the SDK's own retry
    // judgement still reaches both transports.
    return emitFailure(err);
  }

  return emitFailure(err);
}

export async function run(argv: string[]): Promise<ExitCode> {
  // `--json` is resolved before parsing so it applies to every code path, including failures that
  // happen while resolving credentials — those must be reportable in the envelope too.
  const json = argv.includes('--json');
  setJsonMode(json);
  const cleanArgv = argv.filter((a) => a !== '--json');

  const program = buildProgram();

  // `certen --help --json` answers "what can this CLI do" in one call, instead of scraping help
  // text once per subcommand.
  if (json && (cleanArgv.includes('--help') || cleanArgv.includes('-h'))) {
    process.stdout.write(`${commandTree(program, VERSION)}\n`);
    return EXIT.OK;
  }

  try {
    await program.parseAsync(cleanArgv);
    flushSuccess();
    return EXIT.OK;
  } catch (err) {
    return handleError(err);
  }
}

/* c8 ignore start — entrypoint wiring, exercised by the conformance suite as a subprocess */
// Run only when executed as the binary, not when imported by a test. `pathToFileURL` is what makes
// this correct on Windows, where a naive `file://` + path concatenation produces a URL that never
// matches `import.meta.url`.
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run(process.argv).then((code) => {
    process.exitCode = code;
  });
}
/* c8 ignore stop */
