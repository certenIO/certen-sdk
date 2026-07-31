import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput } from '../output.js';

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

export function registerTransactionCommands(program: Command): void {
  const tx = program.command('tx').description('Transaction lifecycle');

  tx
    .command('create')
    .description('Open a transaction intent (returns signing_data — you sign it, then `tx sign`)')
    // The API takes an `intent` object, not flat to/amount/type fields. The flags below build the simple
    // native-transfer shape; `--intent` takes a JSON file or literal for multi-leg and contract-call
    // intents, which have no sensible flag representation.
    .requiredOption('--identity <id>', 'Identity ID (uuid)')
    .option('--intent <json>', 'Intent as JSON, or @path/to/intent.json. Overrides the flags below.')
    .option('--from-chain <chain>', 'Source chain', 'accumulate')
    .option('--to-chain <chain>', 'Destination chain, e.g. ethereum-sepolia')
    .option('--from <address>', 'Source address (the identity ADI or its abstract account)')
    .option('--to <address>', 'Destination address')
    .option('--amount <amount>', 'Amount in base units (wei) — pass as a string')
    .option('--token <symbol>', 'Token symbol')
    .option('--contract-address <addr...>', 'Contract addresses this intent touches')
    .option('--signer-key-page <url>', 'Which key page signs, e.g. acc://org.acme/book/2')
    .option('--signer-public-key <hex>', 'Which seat on the page signs (64 hex)')
    .option('--idempotency-key <key>', 'Idempotency key (one is generated if omitted)')
    .action(async (opts) => {
      const client = await getClient();

      let intent: Record<string, unknown>;
      if (opts.intent) {
        const raw = opts.intent.startsWith('@')
          ? readFileSync(opts.intent.slice(1), 'utf8')
          : opts.intent;
        intent = JSON.parse(raw);
      } else {
        if (!opts.to || !opts.amount) {
          throw new Error('give --intent, or all of --to and --amount (plus --to-chain) for a simple transfer');
        }
        intent = {
          fromChain: opts.fromChain,
          toChain: opts.toChain,
          fromAddress: opts.from,
          toAddress: opts.to,
          amount: String(opts.amount),
          tokenSymbol: opts.token,
        };
      }

      const result = await client.transaction.create({
        identityId: opts.identity,
        intent,
        contractAddresses: opts.contractAddress,
        signerKeyPage: opts.signerKeyPage,
        signerPublicKey: opts.signerPublicKey,
        idempotencyKey: opts.idempotencyKey,
      });
      printOutput(result as unknown as Record<string, unknown>);
    });

  tx
    .command('sign <id>')
    .description('Submit a signature for a transaction')
    .requiredOption('--signature <sig>', 'Signature (hex)')
    .requiredOption('--public-key <key>', 'Public key (hex)')
    .action(async (id: string, opts) => {
      const client = await getClient();
      const result = await client.transaction.submitSignature(id, {
        signature: opts.signature,
        publicKey: opts.publicKey,
      });
      printOutput(result as unknown as Record<string, unknown>);
    });

  tx
    .command('status <id>')
    .description('Get transaction status')
    .action(async (id: string) => {
      const client = await getClient();
      const result = await client.transaction.get(id);
      printOutput(result as unknown as Record<string, unknown>);
    });

  tx
    .command('list')
    .description('List transactions')
    .option('--limit <n>', 'Max results', parseInt)
    .option('--offset <n>', 'Offset', parseInt)
    .action(async (opts) => {
      const client = await getClient();
      const result = await client.transaction.list({
        limit: opts.limit,
        offset: opts.offset,
      });
      printOutput(result as unknown as Record<string, unknown>);
    });
}
