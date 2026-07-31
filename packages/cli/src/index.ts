#!/usr/bin/env node

import { Command } from 'commander';
import { CertenError } from '@certen.io/sdk';
import { registerAuthCommands } from './commands/auth.js';
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
  .version('0.1.0');

registerAuthCommands(program);
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
