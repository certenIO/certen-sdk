import { Command, Option } from 'commander';
import { CertenClient, type Identity } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { resolveSigner } from '../signer.js';
import { assertChain, normalizeChain, chainIdFor } from '../chains.js';
import { parseSignature, checkArgs } from '../solidity-args.js';
import { resolveWait, parseWaitBudget, waitForTransaction, TX_WAIT } from '../wait.js';
import { assertFundedForValue } from '../funding-guard.js';

/**
 * `certen call` — a proof-gated contract call, as one command.
 *
 * `execute.contractCall` is the headline flow in `llms.txt` and had no CLI equivalent: the only
 * route was hand-authoring intent JSON and passing `--intent @file`. That put the hardest artifact
 * in the product behind the least support.
 *
 * The part that earns this command its existence is not the flags — it is resolving `adiUrl` and
 * `fromAddress` from the identity. Both are REQUIRED by the upstream native path, both are
 * dereferenced without a null check, and omitting either produces a **bodyless 502** that reads as
 * "the gateway is down" rather than "you left out a field". Nobody should have to know that. The
 * CLI holds the identity id already; it can look the two up.
 */

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

/** The abstract account for a chain, from whichever spelling of `chain_id` the gateway used. */
function abstractAccountFor(identity: Identity, chain: string): string | undefined {
  const want = normalizeChain(chain);
  return (identity.chain_accounts ?? [])
    .find((account) => normalizeChain(account.chain_id) === want && account.address)?.address;
}

export function registerCallCommands(program: Command): void {
  program
    .command('call')
    .description('Authorize a proof-gated contract call')
    .requiredOption('--identity <uuid>', 'Identity that authorizes the call')
    .requiredOption('--chain <chain>', 'Chain the call executes on, e.g. base-sepolia')
    .requiredOption('--to <address>', 'Contract to call')
    .requiredOption('--fn <signature>', 'Solidity function signature, e.g. \'confirm(bytes32)\'')
    .option('--arg <value...>', 'Argument values, in order. Repeat or pass several after one --arg')
    .option('--value <wei>', 'Native wei to forward with the call (string)', '0')
    .option('--sign-with <key>', 'Local key to sign with (see `certen keys generate`)')
    .option('--signer-key-page <url>', 'Which key page signs, e.g. acc://org.acme/book/2')
    .addOption(new Option('--proof-class <class>', 'When the proof runs')
      .choices(['on_demand', 'on_cadence']))
    .option('--from <address>', 'Override the abstract account (derived from the identity by default)')
    .option('--adi-url <url>', 'Override the ADI URL (derived from the identity by default)')
    .option('--chain-id <n>', 'Numeric EVM chain id (derived from the registry by default)', parseInt)
    .option('--idempotency-key <key>', 'Idempotency key (one is generated if omitted)')
    .option('--dry-run', 'Print the intent that would be sent, and send nothing')
    .option('--wait', 'Wait for the proof cycle (default off with --json)')
    .option('--no-wait', 'Return as soon as the signature is submitted')
    .option('--timeout <minutes>', `How long to wait (default ${TX_WAIT.timeoutMin})`)
    .option('--poll-interval <seconds>', `How often to check (default ${TX_WAIT.intervalSec})`)
    .option('--force', 'Submit even if the abstract account has no gas to execute with')
    .action(async (opts: {
      identity: string; chain: string; to: string; fn: string; arg?: string[]; value: string;
      signWith?: string; signerKeyPage?: string; proofClass?: 'on_demand' | 'on_cadence';
      from?: string; adiUrl?: string; chainId?: number; idempotencyKey?: string;
      dryRun?: boolean; timeout?: string; pollInterval?: string; force?: boolean;
    }) => {
      // Everything checkable without the network is checked first, so a typo costs a message
      // rather than a round trip — and, with --sign-with, rather than a passphrase prompt too.
      const chain = assertChain(opts.chain);
      const signature = parseSignature(opts.fn);
      const args = checkArgs(signature, opts.arg ?? []);
      const wait = resolveWait();
      const budget = parseWaitBudget(opts.timeout, opts.pollInterval, TX_WAIT);

      if (!/^0x[0-9a-fA-F]{40}$/.test(opts.to)) {
        throw new UsageError(
          `--to "${opts.to}" is not a contract address. Expected 0x followed by 40 hex characters.`,
          'INVALID_ADDRESS',
        );
      }
      if (!/^\d+$/.test(opts.value)) {
        // Wei, as a string, always. A JS number loses precision past 2^53 and this is the field
        // where that would move real value.
        throw new UsageError(
          `--value "${opts.value}" must be a whole number of wei, as digits.`,
          'INVALID_VALUE',
        );
      }

      const client = await getClient();

      // Resolve the identity BEFORE unlocking the signer: if the identity cannot sign, prompting
      // for a passphrase first would be asking for a secret in order to fail.
      const { identity } = await client.identity.get(opts.identity);

      if (identity.can_sign === false) {
        throw new CliError(
          `Identity ${identity.adi_url} cannot sign — its key page is not held by your key. `
          + 'This call would fail at the signing step.',
          'IDENTITY_CANNOT_SIGN',
          EXIT.FAILED,
        );
      }

      const adiUrl = opts.adiUrl ?? identity.adi_url;
      // Derived, not demanded: naming the chain already said which numeric id it has, and making
      // the caller repeat it in another form is a step that can only be got wrong.
      const chainId = opts.chainId ?? chainIdFor(chain);
      const fromAddress = opts.from ?? abstractAccountFor(identity, chain);

      if (!fromAddress) {
        // Naming the fix precisely: the identity exists, it simply has no account on this chain.
        throw new CliError(
          `Identity ${identity.adi_url} has no abstract account on ${chain}, so it has no `
          + 'msg.sender there. Link the chain first:\n'
          + `  certen identity link-chain ${identity.id} --chain ${chain}`,
          'NO_ABSTRACT_ACCOUNT',
          EXIT.FAILED,
        );
      }

      const contractCall = {
        target: opts.to,
        functionSignature: signature.name + `(${signature.types.join(',')})`,
        args,
        value: opts.value,
      };

      if (opts.dryRun) {
        // Also the documented starting point for `--intent @file.json`: someone who needs a
        // multi-leg intent can take this, edit it, and pass it to `tx create`.
        printOutput({
          identity_id: opts.identity,
          adi_url: adiUrl,
          chain,
          chain_id: chainId ?? null,
          from_address: fromAddress,
          contract_call: contractCall,
          proof_class: opts.proofClass ?? null,
        });
        if (!isJsonMode()) {
          hint('');
          hint('Nothing was sent. Drop --dry-run to authorize this call.');
        }
        return;
      }

      if (!opts.signWith) {
        throw new UsageError(
          'Nothing would sign this call. Pass --sign-with <key>, or --dry-run to see the intent. '
          + 'To make a key: certen keys generate --name dev',
          'MISSING_SIGNING_KEY',
        );
      }

      // A payable call forwards value from the abstract account, so it needs gas there for the
      // same reason a transfer does.
      await assertFundedForValue(
        client, opts.identity, chain, { amount: opts.value }, Boolean(opts.force),
      );

      const signer = await resolveSigner(opts.signWith);

      const opened = await client.execute.contractCall({
        identityId: opts.identity,
        adiUrl,
        fromAddress,
        chain,
        chainId,
        contractCall,
        // `contract_addresses` is deliberately not exposed. It is an object keyed by role that
        // names the CERTEN deployment, not the call target; passing an array once broke every
        // contractCall. The gateway defaults it correctly, so the right move is to never send it.
        publicKey: signer.publicKey,
        signerKeyPage: opts.signerKeyPage,
        proofClass: opts.proofClass,
        idempotencyKey: opts.idempotencyKey,
        sign: (hashHex) => signer.sign(hashHex),
        // The SDK runs the same guard. It is skipped here because the check above already ran and
        // produces the better refusal — it names the faucet for this chain and the --force flag —
        // and letting both run would cost a second portfolio lookup for an answer already known.
        skipFundingCheck: true,
      });

      if (!wait) {
        printOutput(opened as unknown as Record<string, unknown>);
        hint('');
        hint(`The proof cycle runs now (60-110s). Follow it: certen tx status ${opened.intentId} --wait`);
        return;
      }

      const final = await waitForTransaction(client, opened.intentId, budget);
      printOutput(final);

      if (isJsonMode()) return;
      const status = String(final.status ?? '');
      human('');
      human(`  Intent ${opened.intentId} is ${status}.`);
      hint('');
      hint(`Next: certen proof get ${opened.intentId}`);
    });
}
