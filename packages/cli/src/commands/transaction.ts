import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput } from '../output.js';
import { resolveSigner } from '../signer.js';
import { assertChain } from '../chains.js';
import { CliError, UsageError, EXIT } from '../errors.js';

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

/**
 * Pull the hash to sign out of an intent response.
 *
 * The gateway returns snake_case on the wire (`signing_data.hash_to_sign`), which is what the
 * live OpenAPI spec documents and what `execute.ts` reads. The SDK's `TransactionResponse` type
 * declares camelCase `signingData.dataToSign` and `return data` performs no transformation, so
 * the declared type does not describe the value. Both spellings are accepted here rather than
 * betting on which one a given gateway build emits.
 */
function hashToSign(result: unknown): string | undefined {
  const r = result as {
    signing_data?: { hash_to_sign?: string };
    signingData?: { dataToSign?: string; hashToSign?: string };
  };
  return r.signing_data?.hash_to_sign ?? r.signingData?.hashToSign ?? r.signingData?.dataToSign;
}

function intentIdOf(result: unknown): string | undefined {
  const r = result as { intent_id?: string; intentId?: string };
  return r.intent_id ?? r.intentId;
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
    // WHOLE units, not base units. "1" is one ETH. This said "base units (wei)"
    // until 2026-08-11 — the inverse, and inverted in the dangerous direction:
    // someone passing "1" to mean one wei moves a whole ETH, which on a funded
    // account succeeds silently.
    .option('--amount <amount>', 'Amount in whole units — "1" = 1 ETH, "0.5" = half. Pass as a string')
    .option('--token <symbol>', 'Token symbol')
    .option('--contract-address <addr...>', 'Contract addresses this intent touches')
    .option('--signer-key-page <url>', 'Which key page signs, e.g. acc://org.acme/book/2')
    .option('--signer-public-key <hex>', 'Which seat on the page signs (64 hex)')
    // Validated here so a typo is caught before a request goes out, rather than surfacing from the
    // proof service later with no obvious connection to the flag that caused it.
    .addOption(
      new Option(
        '--proof-class <class>',
        'When the proof runs: on_demand starts now (~60-110s); on_cadence batches it (cheaper, slower)',
      ).choices(['on_demand', 'on_cadence']),
    )
    .option('--idempotency-key <key>', 'Idempotency key (one is generated if omitted)')
    .option('--sign-with <key>', 'Local key: sign the returned hash and submit it in one step')
    .action(async (opts) => {
      const client = await getClient();

      // Resolve (and unlock) the signer BEFORE opening the intent. Prompting for a passphrase
      // after the intent exists would leave an unsigned intent behind every time someone
      // mistypes it or hits Ctrl-C at the prompt.
      // Chains are checked before the signer is unlocked, so a typo costs a message rather than a
      // passphrase prompt followed by a gateway rejection.
      if (opts.toChain) assertChain(opts.toChain, '--to-chain');
      // `--from-chain` defaults to `accumulate`, which is not an EVM chain and is not in the
      // supported set; only validate it when the caller named an EVM chain explicitly.
      if (opts.fromChain && opts.fromChain !== 'accumulate') assertChain(opts.fromChain, '--from-chain');

      const signer = opts.signWith ? await resolveSigner(opts.signWith) : null;

      let intent: Record<string, unknown>;
      if (opts.intent) {
        const raw = opts.intent.startsWith('@')
          ? readFileSync(opts.intent.slice(1), 'utf8')
          : opts.intent;
        try {
          intent = JSON.parse(raw);
        } catch (err) {
          const where = opts.intent.startsWith('@') ? opts.intent.slice(1) : '--intent';
          throw new UsageError(
            `${where} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
            'INVALID_INTENT_JSON',
          );
        }
      } else {
        if (!opts.to || !opts.amount) {
          throw new UsageError(
            'give --intent, or all of --to and --amount (plus --to-chain) for a simple transfer',
            'INCOMPLETE_INTENT',
          );
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
        proofClass: opts.proofClass,
        signerPublicKey: opts.signerPublicKey ?? signer?.publicKey,
        idempotencyKey: opts.idempotencyKey,
      });

      if (!signer) {
        printOutput(result as unknown as Record<string, unknown>);
        return;
      }

      const hash = hashToSign(result);
      const intentId = intentIdOf(result);
      if (!hash || !intentId) {
        // Provider mode (the gateway holds a key) returns no signing data. Printing the intent and
        // stopping is honest; pretending we signed something we never saw is not.
        printOutput(result as unknown as Record<string, unknown>);
        // Not a usage error: the invocation was well-formed and the gateway accepted it. The
        // intent exists. This is an operation that could not be completed the way it was asked
        // for, which is exactly what exit 1 means.
        throw new CliError(
          'Intent opened but returned no hash to sign — this gateway is in provider mode for that '
          + 'identity, so --sign-with does not apply. The intent above was created.',
          'NO_SIGNING_DATA',
          EXIT.FAILED,
        );
      }

      const signed = await client.transaction.submitSignature(intentId, {
        signature: signer.sign(hash),
        publicKey: signer.publicKey,
      });
      printOutput(signed as unknown as Record<string, unknown>);
    });

  tx
    .command('sign <id>')
    .description('Submit a signature for a transaction')
    .option('--sign-with <key>', 'Local key to sign with (needs --hash)')
    .option('--hash <hex>', 'Hash to sign, from the intent\'s signing_data.hash_to_sign')
    .option('--signature <sig>', 'Signature (hex) — for an HSM or air-gapped signer')
    .option('--public-key <key>', 'Public key (hex), required with --signature')
    .action(async (id: string, opts) => {
      // --signature/--public-key were required options, so there was no way to sign from the CLI
      // itself. They are now optional and --sign-with is the alternative; supplying neither is
      // still an error, just a more useful one.
      let signature: string;
      let publicKey: string;

      if (opts.signWith) {
        if (opts.signature) {
          throw new UsageError('Pass either --sign-with or --signature, not both.', 'CONFLICTING_SIGNING_FLAGS');
        }
        if (!opts.hash) {
          throw new UsageError(
            '--sign-with needs --hash <hex> (the signing_data.hash_to_sign from `tx create`). '
            + 'Or use `tx create --sign-with` to do both in one step.',
            'MISSING_HASH',
          );
        }
        const signer = await resolveSigner(opts.signWith);
        signature = signer.sign(opts.hash);
        publicKey = signer.publicKey;
      } else {
        if (!opts.signature || !opts.publicKey) {
          throw new UsageError(
            'Provide --sign-with <key> --hash <hex>, or both --signature and --public-key.',
            'MISSING_SIGNATURE',
          );
        }
        signature = opts.signature;
        publicKey = opts.publicKey;
      }

      const client = await getClient();
      const result = await client.transaction.submitSignature(id, { signature, publicKey });
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
