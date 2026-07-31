#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { CertenError } from '@certen.io/sdk';

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

const program = new Command();

program
  .name('certen')
  .description('CERTEN Gateway CLI')
  // Was hardcoded to 0.1.0 while package.json said 0.2.0, so `certen --version` reported a
  // release that does not exist. Read it from the manifest so the two cannot drift again.
  .version(readVersion());

registerAuthCommands(program);
registerKeysCommands(program);
registerIdentityCommands(program);
registerTransactionCommands(program);
registerPendingCommands(program);
registerGovernanceCommands(program);
registerPortfolioCommands(program);
registerAdminCommands(program);

// Global error handler
program.hook('preAction', () => {});
program.exitOverride();

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    if (err instanceof CertenError) {
      console.error(`Error [${err.code}]: ${err.message}`);
      process.exit(1);
    }
    if (err instanceof Error) {
      // Commander exit override throws for --help etc
      if ((err as any).exitCode === 0) return;
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.error('Unknown error:', err);
    process.exit(1);
  }
}

main();
