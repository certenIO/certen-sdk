import { Command, Option } from 'commander';
import { CertenClient, estimateFee, type TransactionResponse } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { confirmBeforeSigning, contextValues } from '../card.js';
import { commandPrompter } from '../prompt.js';
import { followIntent } from '../receipt-flow.js';
import { parseExpectEvent } from '../flag-parsers.js';
import { renderReceipt } from '../receipt-render.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { resolveSigner } from '../signer.js';
import { assertChain, chainIdFor } from '../chains.js';
import { parseSignature, checkArgs } from '../solidity-args.js';
import { resolveWait, parseWaitBudget, waitForTransaction, TX_WAIT } from '../wait.js';
import { assertFundedForValue } from '../funding-guard.js';
import { resolveContext, requireIdentity, requireChain, echoFromContext, sourceLabel } from '../context.js';
import { resolveCommandIdentity, abstractAccountFor, assertContextKeyExists } from '../command-context.js';
import {
  AUTHORITY_HELP, EXPIRES_IN_HELP, HEADER_FIELDS_HELP, collect, parseAuthorityFlags, parseExpiresIn,
  withOutcomeFields, emitOutcomeHints,
} from '../header-flags.js';

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
 *
 * `--identity`, `--chain` and `--sign-with` come from the context when not given (see context.ts): flag > environment > profile >
 * the only candidate there is. Every value taken from context is said on stderr before anything is signed. The key is the one
 * place a default is safe to add here: leaving `--sign-with` out of a `call` was always an error, so no invocation that worked
 * changes meaning. (`tx create` and `governance` without `--sign-with` are a supported external-signer mode, and do NOT default one.)
 */

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

export function registerCallCommands(program: Command): void {
  program
    .command('call')
    .description('Authorize a proof-gated contract call')
    .option('--identity <ref>', 'Identity that authorizes the call: UUID, ADI URL or name (default: your context, see `certen context`)')
    .option('--chain <chain>', 'Chain the call executes on, e.g. base-sepolia (default: your context)')
    .requiredOption('--to <address>', 'Contract to call')
    .requiredOption('--fn <signature>', 'Solidity function signature, e.g. \'confirm(bytes32)\'')
    .option('--arg <value...>', 'Argument values, in order. Repeat or pass several after one --arg')
    .option('--value <wei>', 'Native wei to forward with the call (string)', '0')
    .option('--sign-with <key>', 'Local key to sign with (default: your context key, or your only key; see `certen keys generate`)')
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
    .option('--timeout <duration>', `How long to wait (90s, 6m, 1h; a bare number is minutes. Default ${TX_WAIT.timeoutMin}m)`)
    .option('--poll-interval <interval>', `How often to check (2s, 1m; a bare number is seconds. Default ${TX_WAIT.intervalSec}s)`)
    .option('--force', 'Submit even if the abstract account has no gas to execute with')
    .option('--yes', 'Say yes to the confirmation in advance (it is only asked at a terminal). The check of what is signed is never skipped')
    .option('--expect <address:topic0[:topic1]>', 'An event the execution receipt must contain, checked when the call completes (with --wait): contract address and event topic, optionally the first indexed argument. The exit code is then the receipt\'s')
    .option('--authority <acc-url>', AUTHORITY_HELP, collect)
    .option('--expires-in <duration>', EXPIRES_IN_HELP)
    .addHelpText('after', HEADER_FIELDS_HELP)
    .action(async (opts: {
      identity?: string; chain?: string; to: string; fn: string; arg?: string[]; value: string;
      signWith?: string; signerKeyPage?: string; proofClass?: 'on_demand' | 'on_cadence';
      from?: string; adiUrl?: string; chainId?: number; idempotencyKey?: string;
      dryRun?: boolean; timeout?: string; pollInterval?: string; force?: boolean; yes?: boolean; expect?: string;
      authority?: string[]; expiresIn?: string;
    }) => {
      // Everything checkable without the network is checked first, so a typo costs a message
      // rather than a round trip — and, with --sign-with, rather than a passphrase prompt too.
      //
      // The context is resolved here, locally: which identity, which chain, which key. A call authorises execution on a chain, so the
      // chain is held to the value-moving rule: a default that is not a known testnet is refused (context.ts).
      const ctx = resolveContext({ identity: opts.identity, chain: opts.chain, key: opts.signWith }, { valueMoving: true });
      requireIdentity(ctx);
      const chainFrom = requireChain(ctx);
      const chain = assertChain(chainFrom.value, sourceLabel(chainFrom, '--chain'));
      const signature = parseSignature(opts.fn);
      const args = checkArgs(signature, opts.arg ?? []);
      const additionalAuthorities = parseAuthorityFlags(opts.authority);
      // Validated here, but the deadline itself is computed again just before the intent is opened:
      // the duration is relative, and measuring it before a passphrase prompt would let the prompt
      // eat into it — or, for a short one, push it under the gateway minimum.
      parseExpiresIn(opts.expiresIn);
      const wait = resolveWait();
      const budget = parseWaitBudget(opts.timeout, opts.pollInterval, TX_WAIT);
      // Checked now, before any request: a malformed event would otherwise be reported as an event missing from the receipt.
      const expectEvent = parseExpectEvent(opts.expect);
      if (expectEvent !== undefined && !wait) {
        throw new UsageError(
          '--expect is checked when the call completes, so it needs the wait: add --wait (it is on by default at a terminal, and off with --json or --no-wait). '
          + 'Or check later: certen receipt <intent> --expect <address:topic0>',
          'EXPECT_NEEDS_WAIT',
        );
      }

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

      // The identity as a UUID, whichever way it was named (a UUID, an ADI URL or a name). Recorded or typed spellings need no
      // request. The value is echoed once it resolves, so the person sees the ADI they recognise.
      const who = await resolveCommandIdentity(ctx, client, 'id');
      echoFromContext('chain', ctx.chain);

      // Resolve the identity BEFORE unlocking the signer: if the identity cannot sign, prompting
      // for a passphrase first would be asking for a secret in order to fail.
      // The response IS the identity now — it is no longer nested under an `identity` key.
      // Only `balances` — this command reads `can_sign`, `adi_url`, `chain_accounts` and the
      // per-chain balances (for the unfunded-account guard), and never touches `governance` or
      // `pending`. Both of those are live fetches on the critical path of the flagship command:
      // governance is a network round trip, pending a database read, and neither answer was used.
      const identity = await client.identity.get(who.id!, { include: ['balances'] });

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
          identity_id: who.id!,
          adi_url: adiUrl,
          chain,
          chain_id: chainId ?? null,
          from_address: fromAddress,
          contract_call: contractCall,
          proof_class: opts.proofClass ?? null,
          additional_authorities: additionalAuthorities ?? null,
          expires_at: parseExpiresIn(opts.expiresIn) ?? null,
        });
        if (!isJsonMode()) {
          hint('');
          hint('Nothing was sent. Drop --dry-run to authorize this call.');
        }
        return;
      }

      // The key. Leaving `--sign-with` out of a `call` was always an error, so a context key can fill it without changing what any
      // working invocation does. Several local keys and none chosen is a question, never a guess.
      const keyFrom = ctx.key;
      if (!keyFrom) {
        const local = ctx.candidates.key;
        throw new UsageError(
          local.length > 1
            ? `Which key signs this call? You have ${local.join(', ')}. Pass --sign-with <key>, set CERTEN_KEY, or choose one once with: certen use key <name>. `
              + 'Or --dry-run to see the intent.'
            : 'Nothing would sign this call. Pass --sign-with <key>, or --dry-run to see the intent. '
              + 'To make a key: certen keys generate --name dev',
          'MISSING_SIGNING_KEY',
        );
      }
      assertContextKeyExists(keyFrom);
      // Before the passphrase prompt and before the summary of what the signature authorises.
      echoFromContext('key', keyFrom);

      // A payable call forwards value from the abstract account, so it needs gas there for the
      // same reason a transfer does.
      // The identity fetched above already carries per-chain balances, so this reuses them instead
      // of reading the same numbers again from /v1/portfolio.
      // `--value` is wei, so it goes under `value` (base units), not `amount` (whole units): the guard compares it with the balance.
      await assertFundedForValue(
        client, who.id!, chain, { value: opts.value }, Boolean(opts.force),
        identity.balances,
      );

      const signer = await resolveSigner(keyFrom.value);

      // The fee is on the card only where a person will read it: it is one more request, and a script that has always run unattended does not
      // pay for it. The card itself is always shown; it is the question that is only asked at a terminal.
      const prompter = commandPrompter();
      const fee = !opts.yes && !isJsonMode() && prompter.interactive ? await estimateFee(client, chain) : undefined;

      const opened = await client.execute.contractCall({
        identityId: who.id!,
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
        additionalAuthorities,
        // After the prompt and the funding check, so the deadline is now + duration at submission.
        expiresAt: parseExpiresIn(opts.expiresIn),
        // The SDK has rebuilt the transaction and matched it to this request by the time this runs; a person reads it, and says yes, before the
        // signature. Piped, or with --yes or --json, the card is shown and the call goes on, as it always has.
        beforeSign: (summary) => confirmBeforeSigning({
          headline: `Call ${contractCall.functionSignature} on ${chain}`,
          rows: [
            ['contract', opts.to],
            ['args', args.length > 0 ? args.map(String).join(', ') : '(none)'],
            ['value', `${opts.value} wei`],
            ['from', `${adiUrl}  ->  ${fromAddress} (abstract account on ${chain})`],
          ],
          chain, fee, summary, keyName: keyFrom.value,
          fromContext: contextValues([
            { field: 'identity', resolved: ctx.identity, shown: adiUrl },
            { field: 'chain', resolved: ctx.chain, shown: chain },
            { field: 'key', resolved: ctx.key, shown: keyFrom.value },
          ]),
        }, { yes: opts.yes, intentId: summary.intentId }),
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

      const final = withOutcomeFields(await waitForTransaction(client, opened.intentId, budget));

      // The receipt: the ids to keep, whether the proof holds HERE, and what is not established, saved to ~/.certen/receipts.
      //  - At a terminal it is always built, and a call that has always returned what it returned keeps doing so (a receipt is a second look).
      //  - In `--json` it is built ONLY when `--expect` names an event the receipt must contain: asking for that check is asking for its answer,
      //    so the envelope gains `receipt` and `receipt_path` (additive) and the exit code is the receipt's. Without `--expect`, `--json` is
      //    exactly what it was (its envelope is the transaction; `certen receipt <id> --json` is the receipt).
      let followed: Awaited<ReturnType<typeof followIntent>> | undefined;
      let receiptError: string | undefined;
      if (!isJsonMode() || expectEvent !== undefined) {
        try {
          followed = await followIntent({
            client, intentId: opened.intentId, gateway: getApiUrl(), wait: false, budget, transaction: final as unknown as TransactionResponse,
            request: {
              kind: 'contract_call', chain, chain_id: chainId ?? null, identity_id: who.id!, adi_url: adiUrl, from: fromAddress, to: opts.to,
              amount: null, asset: null,
              contract_call: { target: opts.to, function_signature: contractCall.functionSignature, value_wei: opts.value },
            },
            signedWith: { key: keyFrom.value, public_key_hash: signer.publicKeyHash },
            expect: expectEvent,
            resumeCommand: `certen watch ${opened.intentId}`,
          });
        } catch (err) {
          // Someone who asked for a check and did not get it must be told by the exit code; one who did not ask is told in a line.
          if (expectEvent !== undefined) throw err;
          receiptError = err instanceof Error ? err.message.replace(/^certen: /, '') : String(err);
        }
      }

      printOutput(isJsonMode() && followed ? { ...final, receipt: followed.receipt, receipt_path: followed.path } : final);
      if (isJsonMode()) {
        if (followed) process.exitCode = followed.exitCode;
        return;
      }
      const status = String(final.status ?? '');
      human('');
      human(`  Intent ${opened.intentId} is ${status}.`);
      emitOutcomeHints(final);
      hint('');
      hint(`Next: certen proof get ${opened.intentId}`);

      if (followed) {
        renderReceipt(followed.receipt, { savedTo: followed.path ?? undefined });
        if (expectEvent !== undefined) process.exitCode = followed.exitCode;
      } else if (receiptError) {
        // The call itself succeeded and was reported above. A receipt that could not be built is a second look that failed, not a failed call.
        hint(`  The receipt could not be built (${receiptError}). The call is unaffected; try: certen receipt ${opened.intentId}`);
      }
    });
}
