import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { resolveSigner } from '../signer.js';
import { assertChain } from '../chains.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { resolveWait, parseWaitBudget, waitForTransaction, TX_WAIT } from '../wait.js';
import { assertFundedForValue } from '../funding-guard.js';

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

/**
 * Name the next command once an intent has settled.
 *
 * The proof is what the intent was FOR — it is the artifact handed to a counterparty — and until
 * now nothing in the CLI ever mentioned it. `certen proof` arrives in Phase 3; the hint points at
 * it either way, because the sequence is the thing worth teaching and the command is imminent.
 */
function emitTerminalHints(result: Record<string, unknown>, intentId: string): void {
  if (isJsonMode()) return;
  const status = String(result.status ?? '');
  const proofId = result.proof_id as string | undefined;

  if (['completed', 'delivered', 'proven'].includes(status)) {
    human('');
    human(`  Intent ${intentId} is ${status}.`);
    hint('');
    hint(proofId
      ? `Next: certen proof get ${proofId}`
      : `Next: certen proof get ${intentId}`);
    return;
  }

  if (status && status !== 'failed' && status !== 'error') {
    hint('');
    hint(`Still ${status}. Follow it with: certen tx status ${intentId} --wait`);
  }
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
    .option('--wait', 'Wait for the proof cycle to reach a terminal state (default off with --json)')
    .option('--no-wait', 'Return as soon as the signature is submitted')
    .option('--timeout <minutes>', `How long to wait (default ${TX_WAIT.timeoutMin})`)
    .option('--poll-interval <seconds>', `How often to check (default ${TX_WAIT.intervalSec})`)
    .option('--force', 'Submit even if the abstract account has no gas to execute with')
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

      const wait = resolveWait();
      const budget = parseWaitBudget(opts.timeout, opts.pollInterval, TX_WAIT);

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
        // `--from` belongs in this list. The gateway rejects a native transfer without
        // `fromAddress` ("Native transfer intent is missing required field(s): fromAddress"), so
        // omitting it was always a failure — just one that cost a round trip and arrived phrased
        // in the API's field names rather than the flags the user typed.
        const missing = [
          !opts.toChain && '--to-chain',
          !opts.from && '--from',
          !opts.to && '--to',
          !opts.amount && '--amount',
        ].filter(Boolean);

        if (missing.length > 0) {
          throw new UsageError(
            `A simple transfer needs ${missing.join(', ')}. `
            + 'Give all of --to-chain, --from, --to and --amount, or pass --intent for a '
            + 'multi-leg or contract-call intent. '
            + '--from is the identity\'s abstract account on the source chain (certen portfolio shows it).',
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

      // Checked after the intent is assembled and BEFORE it is opened: an intent that cannot
      // execute should never exist. See funding-guard.ts for why this only ever refuses on a
      // positively observed zero.
      const executionChain = (intent.toChain ?? intent.to_chain ?? opts.toChain) as string | undefined;
      await assertFundedForValue(client, opts.identity, executionChain, intent, Boolean(opts.force));

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

      if (!wait) {
        printOutput(signed as unknown as Record<string, unknown>);
        hint('');
        hint(`The proof cycle runs now (60-110s). Check with: certen tx status ${intentId}`);
        return;
      }

      const final = await waitForTransaction(client, intentId, budget);
      printOutput(final);
      emitTerminalHints(final, intentId);
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
    .description('Get transaction status, optionally waiting for it to settle')
    // `status` defaults to a single read in BOTH modes — unlike `create`. Asking "what is it now"
    // and asking "tell me when it is done" are different questions, and a status command that
    // silently blocked for seven minutes would be the wrong answer to the first one.
    .option('--wait', 'Poll until the intent reaches a terminal state')
    .option('--timeout <minutes>', `How long to wait with --wait (default ${TX_WAIT.timeoutMin})`)
    .option('--poll-interval <seconds>', `How often to check (default ${TX_WAIT.intervalSec})`)
    .action(async (id: string, opts: { wait?: boolean; timeout?: string; pollInterval?: string }) => {
      const budget = parseWaitBudget(opts.timeout, opts.pollInterval, TX_WAIT);
      const client = await getClient();

      if (!opts.wait) {
        const result = await client.transaction.get(id);
        printOutput(result as unknown as Record<string, unknown>);
        emitTerminalHints(result as unknown as Record<string, unknown>, id);
        return;
      }

      const final = await waitForTransaction(client, id, budget);
      printOutput(final);
      emitTerminalHints(final, id);
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
