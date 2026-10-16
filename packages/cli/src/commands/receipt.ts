import { Command } from 'commander';
import { CertenClient, intentOutcome, type Receipt } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint, human } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { parseWaitBudget, TX_WAIT } from '../wait.js';
import { parseNodeRpc, parseExpectEvent } from '../flag-parsers.js';
import { listReceipts, loadReceipt, receiptPath, type LoadedReceipt } from '../receipt-store.js';
import { exitCodeFor, renderReceipt } from '../receipt-render.js';
import { followIntent } from '../receipt-flow.js';

/**
 * `certen receipt` and `certen watch`: the record of an intent, and picking a wait back up.
 *
 * `send` ends in a receipt, but a receipt is also what you want an hour later, or after Ctrl-C, or for an intent somebody else opened. So the
 * receipt can be shown again (`receipt`), with whatever was pending refreshed from the gateway and re-verified HERE, and a wait can be
 * resumed (`watch`) without losing the thread.
 *
 * Nothing here signs or moves anything. It reads, verifies and writes `~/.certen/receipts`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

function assertIntentId(id: string): void {
  if (!UUID.test(id)) {
    throw new UsageError(`"${id}" is not an intent id. It looks like 7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13 (certen receipt --list shows yours).`, 'INVALID_INTENT_ID');
  }
}

/** Say why a saved file is not being used, and keep it: a file this version cannot read is not one it may overwrite. */
function unusable(loaded: Extract<LoadedReceipt, { state: 'unusable' }>): void {
  hint(`  The saved receipt ${loaded.path} cannot be used: ${loaded.reason}. Building a fresh one from the gateway; the file is left as it is.`);
}

/** What a saved receipt knows about the sender's side of a transfer, so a refresh does not read a balance that has since moved. */
function senderOf(previous: Receipt | null): { address: string; before: string | null; after: string | null } | undefined {
  const s = previous?.effect.sender;
  return s ? { address: s.address, before: s.before, after: s.after } : undefined;
}

export function registerReceiptCommands(program: Command): void {
  program
    .command('receipt [intent]')
    .description('Show the receipt for an intent: its ids, whether the proof holds, whether the value arrived. Refreshes what was pending')
    .option('--list', 'List the receipts saved on this machine, newest first')
    .option('--explain', 'Show the proof layer by layer')
    .option('--rpc <url>', 'A node you trust on the chain (or CERTEN_RPC_URL): the proof is compared with its block header and the recipient\'s balance is read from it')
    .option('--expect <address:topic0[:topic1]>', 'An event the execution receipt must contain (contract address and event topic, optionally the first indexed argument)')
    .option('--share', 'Make a link a counterparty can open to verify the proof with no CERTEN account')
    .option('--offline', 'Show the saved receipt as it is: ask the gateway nothing')
    .option('--refresh', 'Read the gateway again and re-verify, even when the saved receipt is final (a final one is otherwise shown as saved)')
    .action(async (intentArg: string | undefined, opts: { list?: boolean; explain?: boolean; rpc?: string; expect?: string; share?: boolean; offline?: boolean; refresh?: boolean }) => {
      if (opts.list) {
        const receipts = listReceipts();
        printOutput({ receipts } as unknown as Record<string, unknown>, { machineOnly: true });
        if (receipts.length === 0) {
          human('  No receipts are saved on this machine yet. `certen send` writes one.');
        } else {
          human('');
          for (const r of receipts) human(`  ${r.updated_at}  ${r.intent_id}  ${r.verdict.padEnd(8)}  ${r.headline}`);
          human('');
        }
        return;
      }

      const rpc = parseNodeRpc(opts.rpc);
      const expect = parseExpectEvent(opts.expect);
      if (opts.offline && (rpc || opts.share || opts.refresh)) {
        throw new UsageError('--offline asks the gateway nothing, so it cannot be combined with --rpc, --share or --refresh.', 'CONFLICTING_FLAGS');
      }

      let intentId = intentArg;
      if (intentId === undefined) {
        const latest = listReceipts()[0];
        if (!latest) throw new UsageError('There is no receipt to show: none is saved on this machine yet. `certen send` writes one; or name an intent: certen receipt <intent>.', 'NO_RECEIPTS');
        intentId = latest.intent_id;
        hint(`using the most recent receipt, ${intentId}`);
      }
      assertIntentId(intentId);
      receiptPath(intentId);

      const loaded = loadReceipt(intentId);
      const previous = loaded.state === 'ok' ? loaded.receipt : null;
      if (loaded.state === 'unusable') unusable(loaded);

      // A saved receipt that is FINAL (verified, failed, or executed with a proof that can never exist) has nothing pending, so asking the gateway
      // again could only make it weaker (a bare `receipt` consults no node of yours, and the receipt it would replace did). It is shown as saved
      // unless a node, an event, a share or --refresh says otherwise.
      const final = previous !== null && (previous.verdict === 'verified' || previous.verdict === 'failed' || previous.verdict === 'unproven');
      const showSaved = opts.offline || (final && !opts.refresh && !rpc && !expect && !opts.share);
      if (showSaved) {
        if (!previous || loaded.state !== 'ok') {
          throw new UsageError(`No usable receipt is saved for ${intentId}, and --offline asks the gateway nothing. Run: certen receipt ${intentId}`, 'NO_SAVED_RECEIPT');
        }
        if (!opts.offline) hint(`  The saved receipt is final (${previous.verdict}): nothing is pending, so the gateway was not asked. --refresh reads it again; --rpc <node> checks it against your node.`);
        renderReceipt(previous, { savedTo: loaded.path, explain: opts.explain });
        printOutput({ receipt: previous, saved_to: loaded.path, refreshed: false } as unknown as Record<string, unknown>, { machineOnly: true });
        process.exitCode = exitCodeFor(previous);
        return;
      }

      const client = await getClient();
      const transaction = await client.transaction.get(intentId);
      const followed = await followIntent({
        client, intentId, gateway: getApiUrl(), wait: false, budget: parseWaitBudget(undefined, undefined, TX_WAIT), transaction,
        previous, request: previous?.request ?? null, signedWith: previous?.signed_with ?? null, snapshot: previous?.recipient_snapshot ?? null,
        rpc, expect, sender: senderOf(previous), resumeCommand: `certen watch ${intentId}`,
        persist: loaded.state !== 'unusable',
      });
      // A read that establishes less than the saved receipt (no node this time) is shown, and does NOT replace the saved one.
      const savedTo = followed.path ?? (followed.kept && loaded.state === 'ok' ? loaded.path : null);
      if (followed.kept) hint(`  The saved receipt was left as it is: ${followed.kept}. Run it again with --rpc <node> to refresh that one.`);

      let share: { url: string | null; expires_at: string | null } | undefined;
      if (opts.share) {
        const proofId = followed.receipt.ids.proof_id;
        if (!proofId) {
          throw new CliError(
            `Nothing to share yet: intent ${intentId} has no proof id (${followed.receipt.headline}). Run certen receipt ${intentId} again once it completes.`,
            'NOTHING_TO_SHARE', EXIT.FAILED,
          );
        }
        const made = await client.proof.share(proofId, { label: `receipt ${intentId}` });
        share = { url: made.url ?? null, expires_at: made.expires_at ?? null };
      }

      renderReceipt(followed.receipt, { savedTo: savedTo ?? undefined, explain: opts.explain });
      if (share) {
        human(`  Share link: ${share.url ?? '(the gateway returned no URL)'}${share.expires_at ? `   (expires ${share.expires_at})` : ''}`);
        human('  Anyone with this link can read the proof and verify it without a CERTEN account. It shows the intent, not your keys.');
        human('');
      }
      printOutput({
        receipt: followed.receipt, saved_to: savedTo, refreshed: true, ...(followed.kept ? { saved_receipt_kept: followed.kept } : {}), ...(share ? { share } : {}),
      } as unknown as Record<string, unknown>, { machineOnly: true });
      process.exitCode = exitCodeFor(followed.receipt);
    });

  program
    .command('watch <intent>')
    .description('Wait for an intent to finish, then show its receipt. Picks up where Ctrl-C or a timeout left off; the intent keeps running meanwhile')
    .option('--timeout <duration>', `How long to wait (90s, 6m, 1h; a bare number is minutes. Default ${TX_WAIT.timeoutMin}m)`)
    .option('--poll-interval <interval>', `How often to check (2s, 1m; a bare number is seconds. Default ${TX_WAIT.intervalSec}s)`)
    .option('--rpc <url>', 'A node you trust on the chain (or CERTEN_RPC_URL): the proof is compared with its block header and the recipient\'s balance is read from it')
    .option('--expect <address:topic0[:topic1]>', 'An event the execution receipt must contain (contract address and event topic, optionally the first indexed argument)')
    .action(async (intentId: string, opts: { timeout?: string; pollInterval?: string; rpc?: string; expect?: string }) => {
      assertIntentId(intentId);
      receiptPath(intentId);
      const budget = parseWaitBudget(opts.timeout, opts.pollInterval, TX_WAIT);
      const rpc = parseNodeRpc(opts.rpc);
      const expect = parseExpectEvent(opts.expect);

      const loaded = loadReceipt(intentId);
      const previous = loaded.state === 'ok' ? loaded.receipt : null;
      if (loaded.state === 'unusable') unusable(loaded);

      const client = await getClient();
      // One read decides whether there is anything to wait for: an intent that has already finished is not announced as "waiting".
      const transaction = await client.transaction.get(intentId);
      const outcome = intentOutcome(transaction);
      if (!outcome.terminal) hint(`  Intent ${intentId} is ${outcome.status || 'in progress'}. Waiting; Ctrl-C stops the wait and leaves the intent running.`);

      const followed = await followIntent({
        client, intentId, gateway: getApiUrl(), wait: true, budget, transaction,
        previous, request: previous?.request ?? null, signedWith: previous?.signed_with ?? null, snapshot: previous?.recipient_snapshot ?? null,
        rpc, expect, sender: senderOf(previous), resumeCommand: `certen watch ${intentId}`,
        persist: loaded.state !== 'unusable',
      });
      // A watch with no node of yours does not replace a saved receipt that was checked against one.
      const savedTo = followed.path ?? (followed.kept && loaded.state === 'ok' ? loaded.path : null);
      if (followed.kept) hint(`  The saved receipt was left as it is: ${followed.kept}. Run it again with --rpc <node> to refresh that one.`);
      renderReceipt(followed.receipt, { savedTo: savedTo ?? undefined });
      printOutput({
        receipt: followed.receipt, saved_to: savedTo, ...(followed.kept ? { saved_receipt_kept: followed.kept } : {}),
      } as unknown as Record<string, unknown>, { machineOnly: true });
      process.exitCode = exitCodeFor(followed.receipt);
    });
}
