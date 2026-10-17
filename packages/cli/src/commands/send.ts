import { Command, Option } from 'commander';
import {
  CertenClient, CertenError, chainInfo, estimateFee, snapshotRecipient,
  type ReceiptRequest, type RecipientSnapshot, type Readiness,
} from '@certen.io/sdk';
import { getApiKey, getApiUrl, getPortalUrl } from '../config.js';
import { printOutput, hint, human } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { assertChain, enabledChains } from '../chains.js';
import { resolveSigner } from '../signer.js';
import { resolveWait, parseWaitBudget, TX_WAIT } from '../wait.js';
import { parseExpiresIn, EXPIRES_IN_HELP } from '../header-flags.js';
import { resolveContext, requireIdentity, requireChain, echoFromContext, sourceLabel } from '../context.js';
import { resolveCommandIdentity, assertContextKeyExists } from '../command-context.js';
import { parseGasReserve, parseRpc, parseNodeRpc } from '../flag-parsers.js';
import { finishReadiness, renderReadiness, signingKeyCheck } from '../readiness-render.js';
import { commandPrompter } from '../prompt.js';
import { assertCanConfirm, confirmSigning, contextValues, feeLine, signingDeclined } from '../card.js';
import { renderReceipt } from '../receipt-render.js';
import { followIntent } from '../receipt-flow.js';
import {
  assertTransferInputs, estimateClient, estimateJson, estimateLines, fetchEstimate, nativeAssetFor, transferIntent,
} from '../estimate.js';

/**
 * `certen send 0.0001 ETH --to 0x...`: the whole transfer, as one command.
 *
 * The task the docs actually teach first is a transfer, and it was the hardest command to type: `tx create` wanted the identity, both chains,
 * the source address, the key and a timeout in minutes, then four more commands to find out what happened. `send` takes what a person knows
 * (how much, of what, to whom) and does the rest in the order that keeps them safe:
 *
 *   1. check the invocation without the network (an address with a bad checksum, an asset the chain does not move, a wei-looking amount);
 *   2. check READINESS before anything is unlocked: the key page, credits, the gateway balance and the gas for this amount. A passphrase is
 *      never asked for in order to fail;
 *   3. show the confirmation card, with what the signature will authorise REBUILT from the gateway's bytes and matched to the request, and ask;
 *   4. sign, wait for the proof cycle (Ctrl-C safe), verify the proof here, check the value arrived, and write the receipt.
 *
 * `--yes` and `--json` skip the question and never the check. A new command can be strict from day one: with nobody to confirm it and no
 * `--yes`, it refuses before reading a passphrase.
 *
 * The card also carries the gateway's ESTIMATE of this request (what `certen quote` shows), asked for after the readiness checks and before the
 * passphrase. It is a convenience and nothing more: it is labelled an estimate with the gates it did and did not look at, and an estimate that
 * cannot be had (no route on an older gateway, a timeout, a refusal) prints "unavailable" and the send goes on exactly as it would have.
 */

const GAS_CODES = new Set(['ABSTRACT_ACCOUNT_UNFUNDED', 'ABSTRACT_ACCOUNT_UNDERFUNDED']);

export function registerSendCommands(program: Command): void {
  program
    .command('send <amount> <asset>')
    .description('Send native value to an address: preview, confirm, sign, wait, verify the proof, and keep a receipt')
    .requiredOption('--to <address>', 'Recipient: an EVM address')
    .option('--chain <chain>', 'Chain the value lands on, e.g. base-sepolia (default: your context; never a mainnet from a default)')
    .option('--identity <ref>', 'Identity that sends: UUID, ADI URL or name (default: your context, see `certen context`)')
    .option('--sign-with <key>', 'Local key to sign with (default: your context key, or your only key)')
    .option('--yes', 'Say yes to the confirmation in advance (needed when nobody is at a terminal). The check of what is signed is never skipped')
    .option('--dry-run', 'Check everything and show what would be sent. Nothing is signed or sent')
    .option('--wait', 'Wait for the proof cycle and verify the result (default off with --json)')
    .option('--no-wait', 'Return as soon as the signature is submitted; `certen watch <intent>` picks it up')
    .option('--timeout <duration>', `How long to wait (90s, 6m, 1h; a bare number is minutes. Default ${TX_WAIT.timeoutMin}m)`)
    .option('--poll-interval <interval>', `How often to check (2s, 1m; a bare number is seconds. Default ${TX_WAIT.intervalSec}s)`)
    .option('--rpc <url>', 'A node you trust on the chain (or CERTEN_RPC_URL): the proof is compared with its block header and the recipient\'s balance is read from it')
    .option('--force', 'Send even if the abstract account is short of gas (the gas checks only)')
    .option('--gas-reserve <amount>', 'Gas to hold back, in whole native units, or "none". The default is an estimate, not a quote')
    .option('--accumulate-rpc <url>', 'Accumulate API to read the key page from (default: the one the gateway advertises)')
    .addOption(new Option('--proof-class <class>', 'When the proof runs: on_demand starts now (~60-110s); on_cadence batches it (cheaper, slower)').choices(['on_demand', 'on_cadence']))
    .option('--idempotency-key <key>', 'Idempotency key (one is generated if omitted)')
    .option('--expires-in <duration>', EXPIRES_IN_HELP)
    .action(async (amount: string, asset: string, opts: {
      to: string; chain?: string; identity?: string; signWith?: string; yes?: boolean; dryRun?: boolean; timeout?: string; pollInterval?: string;
      rpc?: string; force?: boolean; gasReserve?: string; accumulateRpc?: string; proofClass?: 'on_demand' | 'on_cadence'; idempotencyKey?: string;
      expiresIn?: string;
    }) => {
      // ── 1. the invocation, without the network ────────────────────────────────────────────────────────
      assertTransferInputs(amount, opts.to);
      parseExpiresIn(opts.expiresIn);
      const wait = resolveWait();
      const budget = parseWaitBudget(opts.timeout, opts.pollInterval, TX_WAIT);
      const gasReserve = parseGasReserve(opts.gasReserve);
      const accumulateRpc = parseRpc(opts.accumulateRpc);
      const rpc = parseNodeRpc(opts.rpc);

      // Which identity, chain and key: from the context. This moves value, so a chain that is not a known testnet is refused as a default.
      const ctx = resolveContext({ identity: opts.identity, chain: opts.chain, key: opts.signWith }, { valueMoving: true });
      requireIdentity(ctx);
      const chainFrom = requireChain(ctx);
      const chain = assertChain(chainFrom.value, sourceLabel(chainFrom, '--chain'));

      // A mismatch is refused, never guessed: "ETH" on a TEL chain is not sent as TEL. A token is not sent at all (see nativeAssetFor).
      const symbol = nativeAssetFor(chain, asset, amount, opts.to);

      const keyFrom = ctx.key;
      if (!keyFrom && !opts.dryRun) {
        const local = ctx.candidates.key;
        throw new UsageError(
          local.length > 1
            ? `Which key signs this? You have ${local.join(', ')}. Pass --sign-with <key>, set CERTEN_KEY, or choose one once with: certen use key <name>. Or --dry-run to see what would be sent.`
            : 'Nothing would sign this. Pass --sign-with <key>, or --dry-run to see what would be sent. To make a key: certen keys generate --name dev',
          'MISSING_SIGNING_KEY',
          local.length > 1 ? 'certen use key <name>' : 'certen setup',
        );
      }
      if (keyFrom) assertContextKeyExists(keyFrom);

      const prompter = commandPrompter();
      if (!opts.dryRun) assertCanConfirm({ yes: Boolean(opts.yes), prompter, mode: 'strict', command: 'certen send' });

      // ── 2. readiness, BEFORE anything is unlocked ──────────────────────────────────────────────────────
      const apiKey = await getApiKey();
      const client = new CertenClient({ apiKey, baseUrl: getApiUrl() });
      const who = await resolveCommandIdentity(ctx, client, 'id');
      echoFromContext('chain', ctx.chain);
      echoFromContext('key', ctx.key);

      const keyCheck = signingKeyCheck({ name: keyFrom?.value, candidates: ctx.candidates.key });
      // The fee is asked for alongside the checks: it is one more read, it needs nothing from them, and it must be on the card.
      const [raw, fee] = await Promise.all([
        client.readiness({
          identityId: who.id!, chain, keyHash: keyCheck.keyHash, amount, gasReserve, accumulateRpc, configuredChains: enabledChains(),
        }),
        estimateFee(client, chain),
      ]);
      const readiness: Readiness = finishReadiness(raw, {
        localChecks: [keyCheck.check],
        env: { chain, identityId: who.id!, portalUrl: getPortalUrl(), keyName: keyFrom?.value },
      });

      // A failing check refuses. An unknown one is SHOWN and does not: a balance the gateway has not reported yet is not evidence of
      // zero, and a guard that blocked on a lagging view would refuse legitimate work (the funding guard has always worked this way).
      // --force has only ever meant "send although the account is short of gas", so it excuses the gas checks and nothing else.
      const failing = readiness.checks.filter((c) => c.status === 'fail');
      const blockers = failing.filter((c) => !(opts.force && GAS_CODES.has(c.code ?? '')));
      if (blockers.length > 0) {
        renderReadiness(readiness, chain);
        const first = blockers[0]!;
        const down = first.code === 'GATEWAY_UNREACHABLE';
        throw new CliError(
          `Not sending: ${first.name} is failing on ${chain}. ${first.detail} Nothing was signed or charged.`,
          down ? 'NETWORK_ERROR' : 'NOT_READY',
          down ? EXIT.UNREACHABLE : EXIT.FAILED,
          down,
          { readiness: { ...readiness, first_blocker: first } },
          // The failing check's own fix, so the line a person is told to run is the line `status` would have shown beside it.
          down ? undefined : first.fix?.command,
        );
      }
      for (const c of failing) hint(`  --force: sending although ${c.name} is failing. ${c.detail}`);
      for (const c of readiness.checks.filter((x) => x.status === 'unknown')) hint(`  not confirmed: ${c.name}: ${c.detail}`);

      const adiUrl = readiness.context.adi_url;
      const fromAddress = readiness.context.abstract_account;
      if (!adiUrl || !fromAddress) {
        throw new CliError(
          `Cannot tell where this would be sent from: ${!adiUrl ? 'the identity\'s ADI' : `its abstract account on ${chain}`} is not known. Run: certen status`,
          'NOT_READY', EXIT.FAILED, false, { readiness },
        );
      }
      const gas = readiness.checks.find((c) => c.name === 'gas');
      const senderBefore = typeof gas?.data?.balance === 'string' ? gas.data.balance : null;

      const request: ReceiptRequest = {
        kind: 'transfer', chain, chain_id: chainInfo(chain)?.chainId ?? null, identity_id: who.id!, adi_url: adiUrl,
        from: fromAddress, to: opts.to, amount, asset: symbol, contract_call: null,
      };

      // The gateway's estimate of THIS request. It cannot throw and it decides nothing: see estimate.ts.
      const estimate = await fetchEstimate(
        estimateClient(apiKey, getApiUrl()),
        transferIntent({ adiUrl, chain, fromAddress, toAddress: opts.to, amount }),
        opts.proofClass,
      );

      if (opts.dryRun) {
        human('');
        human(`  Would send ${amount} ${symbol} on ${chain}`);
        human(`    from  ${adiUrl}  ->  ${fromAddress} (abstract account)`);
        human(`    to    ${opts.to}`);
        human(`    fee   ${feeLine(fee)}`);
        estimateLines(estimate).forEach((line, i) => human(`    ${(i === 0 ? 'estimate' : '').padEnd(8)} ${line}`));
        human(`    state ${readiness.ready ? 'ready' : 'not fully confirmed'} (certen status shows every check)`);
        printOutput({ dry_run: true, request, fee, ...estimateJson(estimate), readiness } as unknown as Record<string, unknown>, { machineOnly: true });
        hint('');
        hint('Nothing was signed or sent. Drop --dry-run to send it.');
        return;
      }

      // The recipient's balance BEFORE the value moves, from the node the person named. Done now so a node that cannot be used stops the
      // send here, not after the value has moved: someone who asked for an independent check should not discover it was not made.
      let snapshot: RecipientSnapshot | undefined;
      if (rpc) {
        try {
          snapshot = await snapshotRecipient({ rpc, chain, address: opts.to });
        } catch (err) {
          throw new CliError(
            `Not sending: the node you gave (--rpc / CERTEN_RPC_URL) cannot be used for the check. ${err instanceof CertenError ? err.message.replace(/^certen: /, '') : String(err)} `
            + 'Fix it, or send without --rpc and check the recipient yourself. Nothing was signed or charged.',
            err instanceof CertenError ? err.code : 'INVALID_RPC', EXIT.FAILED,
          );
        }
      }

      // ── 3 and 4. unlock, open, check, confirm, sign ───────────────────────────────────────────────────
      const signer = await resolveSigner(keyFrom!.value);
      const fromContext = contextValues([
        { field: 'identity', resolved: ctx.identity, shown: adiUrl },
        { field: 'chain', resolved: ctx.chain, shown: chain },
        { field: 'key', resolved: ctx.key, shown: keyFrom!.value },
      ]);

      let intentSeen: string | undefined;
      let sent;
      try {
        sent = await client.execute.send({
          identityId: who.id!,
          chain,
          toAddress: opts.to,
          amount,
          asset: symbol,
          adiUrl,
          fromAddress,
          publicKey: signer.publicKey,
          sign: (hashHex) => signer.sign(hashHex),
          proofClass: opts.proofClass,
          idempotencyKey: opts.idempotencyKey,
          // After the passphrase and the checks, so none of that time comes out of the deadline.
          expiresAt: parseExpiresIn(opts.expiresIn),
          // Readiness above already judged the gas for this amount; a second portfolio read would only repeat it.
          skipFundingCheck: true,
          beforeSign: (summary) => {
            intentSeen = summary.intentId;
            return confirmSigning({
              headline: `Send ${amount} ${symbol} on ${chain}`,
              rows: [
                ['from', `${adiUrl}  ->  ${fromAddress} (abstract account on ${chain})`],
                ['to', opts.to],
              ],
              chain, fee, estimate: estimateLines(estimate), fromContext, summary, keyName: keyFrom!.value,
            }, { yes: Boolean(opts.yes), prompter });
          },
        });
      } catch (err) {
        // A person who answered no is the SDK's SIGNING_DECLINED: nothing was signed, and the intent that was opened expires unsigned.
        if (err instanceof CertenError && err.code === 'SIGNING_DECLINED') throw signingDeclined(intentSeen);
        throw err;
      }

      hint('');
      hint(`  Signed. Intent ${sent.intentId}.${wait ? '' : ' The proof cycle runs now (60-110s).'}`);

      // ── the outcome ────────────────────────────────────────────────────────────────────────────────────
      const followed = await followIntent({
        client, intentId: sent.intentId, gateway: getApiUrl(), wait, budget, request,
        signedWith: { key: keyFrom!.value, public_key_hash: signer.publicKeyHash },
        snapshot: snapshot ?? null, rpc, sender: { address: fromAddress, before: senderBefore },
        resumeCommand: `certen watch ${sent.intentId}`,
      });
      renderReceipt(followed.receipt, { savedTo: followed.path ?? undefined, destination: followed.destination });
      printOutput({ receipt: followed.receipt, saved_to: followed.path, destination: followed.destination } as unknown as Record<string, unknown>, { machineOnly: true });
      // `--no-wait` returned as soon as the signature was in, exactly as `tx create --no-wait` does: that is a success of the command, with
      // a receipt that says it is pending.
      process.exitCode = !wait && followed.receipt.verdict === 'pending' ? EXIT.OK : followed.exitCode;
    });
}
