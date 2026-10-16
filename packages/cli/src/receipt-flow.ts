import {
  assembleReceipt, chainSlug, intentOutcome, readNativeBalance, type CertenClient, type Receipt, type ReceiptRequest, type ReceiptSigner,
  type RecipientSnapshot, type TransactionResponse,
} from '@certen.io/sdk';
import { buildReceipt } from '@certen.io/sdk/verify';
import { CliError, type ExitCode } from './errors.js';
import { human, hint, isJsonMode } from './output.js';
import { trapSigint, type Interrupt } from './interrupt.js';
import { sleepUnlessAborted, waitForTransaction, type WaitBudget } from './wait.js';
import { saveReceipt } from './receipt-store.js';
import { exitCodeFor, renderReceipt } from './receipt-render.js';

/**
 * Following one intent to its receipt: `send` after it signs, `watch` when picking a wait back up, and `receipt` when refreshing one.
 *
 * All three do the same thing and must not differ in what they believe, so there is one implementation: wait (unless told not to), build
 * the receipt in the SDK, save it, and, however the wait ends, leave a saved receipt and a command that picks it back up.
 *
 * **A receipt is saved however the wait ends.** A failed intent, a wait that ran out and Ctrl-C all leave the last thing the gateway said in
 * `~/.certen/receipts`, built from the last reading (no extra request), so the ids are not lost with the terminal.
 *
 * **Ctrl-C stops the WAIT, not the intent.** The handler is installed for the length of the wait and no longer, because registering any SIGINT
 * listener removes node's default and a listener left behind would make Ctrl-C do nothing in every later step.
 */

/**
 * How long to keep asking for a proof that was not available right after completion. A completed intent carries its proof, so this is for the
 * proof service having a bad moment (a 5xx is "unavailable", which is not the same as "there is none"), not for a backfill. Bounded, and said.
 */
export const PROOF_GRACE = { attempts: 3, intervalMs: 10_000 };

export interface FollowArgs {
  client: CertenClient;
  intentId: string;
  gateway: string;
  /** Wait for the intent to finish. False: read it once and report where it is. */
  wait: boolean;
  budget: WaitBudget;
  /** The intent as the caller has just read it. An intent that is already finished is not waited for. */
  transaction?: TransactionResponse;
  previous?: Receipt | null;
  request?: ReceiptRequest | null;
  signedWith?: ReceiptSigner | null;
  snapshot?: RecipientSnapshot | null;
  /** A node of the caller's, for the proof's execution layer and the recipient's balance. */
  rpc?: string;
  expect?: { address?: string; topic0?: string; topic1?: string };
  /**
   * The abstract account and its native balance before signing, to show the sender's side of a transfer. `after` is given when it is already
   * known (a refresh of a finished transfer keeps the reading it took at the time rather than reading a balance that has since moved).
   */
  sender?: { address: string; before: string | null; after?: string | null };
  /** How to pick this up again, named in what is printed when the wait stops. */
  resumeCommand: string;
  /** False: build and return, but write nothing (a saved file that cannot be read is not to be overwritten). Default true. */
  persist?: boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam: where Ctrl-C comes from. A test cannot deliver a SIGINT to itself (node would stop it), so it hands in an interrupt it controls. */
  trap?: () => Interrupt;
}

export interface Followed {
  receipt: Receipt;
  /** Where it was saved, or null when `persist` was false or a stronger saved receipt was kept (see `kept`). */
  path: string | null;
  /** Set when a saved receipt that establishes MORE than this one was left as it is: why. */
  kept?: string;
  exitCode: ExitCode;
}

/** The abstract account's native balance (whole units) on a chain, as the gateway reports it, or null when it cannot be read. */
export async function senderBalance(client: CertenClient, identityId: string, chain: string): Promise<string | null> {
  try {
    const identity = await client.identity.get(identityId, { include: ['balances'] });
    // The rows of THIS chain only: `readNativeBalance` matches by token symbol, so an identity linked to two chains whose gas is ETH would
    // otherwise show the other chain's balance as the sender's.
    const rows = (identity.balances ?? []).filter((b) => chainSlug(b.chain_id) === chainSlug(chain));
    const reading = readNativeBalance(chain, rows);
    return reading.state === 'funded' || reading.state === 'empty' ? reading.balance : null;
  } catch {
    return null;
  }
}

function decorate(err: CliError, receipt: Receipt, path: string | null, resume: string): CliError {
  return new CliError(err.message, err.code, err.exitCode, err.retryable, {
    ...(err.details ?? {}), intent_id: receipt.intent_id, receipt, receipt_path: path, resume,
  });
}

/**
 * Why `next` establishes LESS than `previous`, or undefined when it does not.
 *
 * Less because less was ASKED, never because something contradicts it. A receipt that was compared with the person's own node, or that read the
 * recipient's balance, is stronger than one made by the same command without a node, and the second must not silently replace the first: the
 * natural sequence is `send --rpc` and then, later, a bare `receipt`. A contradiction (a proof layer that now fails) is news and is always kept.
 */
export function weakerThan(previous: Receipt, next: Receipt): string | undefined {
  if (next.verdict === 'failed') return undefined;
  if (previous.proof.node_checked && !next.proof.node_checked) return 'it was compared with a node of yours and this read was not';
  const read = (state: string): boolean => state === 'confirmed' || state === 'not_observed';
  if (read(previous.effect.state) && !read(next.effect.state)) return 'the recipient\'s balance had been read and this read did not';
  return undefined;
}

/** Write the receipt, unless told not to or unless it would replace a stronger one (then say why, so the caller can). */
const keep = (a: FollowArgs, receipt: Receipt): { path: string | null; kept?: string } => {
  if (a.persist === false) return { path: null };
  const why = a.previous ? weakerThan(a.previous, receipt) : undefined;
  return why ? { path: null, kept: why } : { path: saveReceipt(receipt) };
};

/** Build, with a short bounded retry when the proof service could not be asked, and save. */
async function buildAndSave(a: FollowArgs, transaction: TransactionResponse, after: string | null): Promise<{ receipt: Receipt; path: string | null; kept?: string }> {
  const nap = a.sleep ?? sleepUnlessAborted;
  const sender = a.sender && a.request?.kind === 'transfer' ? { address: a.sender.address, before: a.sender.before, after: a.sender.after ?? after } : undefined;
  const build = (previous: Receipt | null | undefined): Promise<Receipt> => buildReceipt(a.client, a.intentId, {
    gateway: a.gateway, request: a.request, signedWith: a.signedWith, previous, transaction, rpc: a.rpc, expect: a.expect, snapshot: a.snapshot, sender,
  });
  let receipt = await build(a.previous);
  for (let attempt = 1; attempt <= PROOF_GRACE.attempts && receipt.proof.verdict === 'unavailable' && a.wait; attempt += 1) {
    if (!isJsonMode()) human(`  The proof could not be fetched yet; asking again in ${PROOF_GRACE.intervalMs / 1000}s (${attempt} of ${PROOF_GRACE.attempts}).`);
    await nap(PROOF_GRACE.intervalMs);
    receipt = await build(receipt);
  }
  return { receipt, ...keep(a, receipt) };
}

/** What the gateway last said, as a receipt, with no request. Used when the wait ended before the intent did. */
function interim(a: FollowArgs, last: TransactionResponse): { receipt: Receipt; path: string | null; kept?: string } {
  const receipt = assembleReceipt({
    intentId: a.intentId, transaction: last, request: a.request, signedWith: a.signedWith, gateway: a.gateway, registry: null, previous: a.previous, snapshot: a.snapshot,
  });
  return { receipt, ...keep(a, receipt) };
}

export async function followIntent(a: FollowArgs): Promise<Followed> {
  let last: TransactionResponse | undefined = a.transaction;
  let saved = false;
  const remember = (tx: TransactionResponse): void => {
    last = tx;
    // The first reading is saved at once: from here on the ids survive a crash, a closed terminal or a power cut.
    if (!saved) { saved = true; try { interim(a, tx); } catch { /* a receipt that cannot be saved must not stop the wait; the final save reports it */ } }
  };

  let transaction: TransactionResponse;
  const finished = a.transaction !== undefined && intentOutcome(a.transaction).terminal;
  if (a.wait && !finished) {
    const trap = (a.trap ?? trapSigint)();
    try {
      transaction = (await waitForTransaction(a.client, a.intentId, a.budget, { signal: trap.signal, onPoll: remember })) as unknown as TransactionResponse;
    } catch (err) {
      trap.dispose();
      if (!(err instanceof CliError) || !last) throw err;
      // However the wait ended, the last reading becomes a receipt. The error then carries it, so the ids are in the failure envelope too.
      const { receipt, path } = interim(a, last);
      if (err.code === 'INTERRUPTED') {
        hint('');
        hint(`  Stopped waiting. The intent ${a.intentId} keeps running on the gateway; nothing was cancelled.`);
        hint(`  Pick it back up: ${a.resumeCommand}`);
      } else if (err.code === 'TX_WAIT_TIMEOUT') {
        hint('');
        hint(`  The wait ran out; the intent may still complete. Pick it back up: ${a.resumeCommand}`);
      } else {
        renderReceipt(receipt, { savedTo: path ?? undefined });
      }
      throw decorate(err, receipt, path, a.resumeCommand);
    } finally {
      trap.dispose();
    }
  } else {
    transaction = last ?? (await a.client.transaction.get(a.intentId));
  }

  // The sender's balance after, once there is something to compare: only a finished transfer has moved.
  const completed = ['completed', 'proven', 'delivered'].includes(String(transaction.status));
  const after = a.sender && a.sender.after === undefined && a.request?.kind === 'transfer' && completed
    ? await senderBalance(a.client, a.request.identity_id, a.request.chain)
    : null;
  const { receipt, path, kept } = await buildAndSave(a, transaction, after);
  return { receipt, path, ...(kept ? { kept } : {}), exitCode: exitCodeFor(receipt) };
}
