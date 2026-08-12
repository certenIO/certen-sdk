import type { CertenClient, Identity } from '@certen.io/sdk';
import { CliError, UsageError, EXIT } from './errors.js';
import { human, isJsonMode } from './output.js';

/**
 * Waiting for asynchronous work to finish.
 *
 * Two of this product's central operations return before they are usable — `POST /v1/identity`
 * answers 202 while provisioning continues, and a transaction intent takes a 60–110 second proof
 * cycle to reach a terminal state. Every document in the repo warns about both. The CLI
 * nonetheless printed the interim response and exited, leaving each user to write the same poll
 * loop, and leaving anyone who did not write one holding an identity that fails at the last step
 * of every flow with an error that never mentions provisioning.
 *
 * The polling shape here is lifted from `certen fund`, which got it right first: speak only when
 * something changes, treat a timeout as neither success nor failure, and never exit 0 on an
 * outcome a script would misread as done.
 */

/** `certen fund`'s defaults are 60 min / 5 s; these are per-operation because the work differs. */
export const IDENTITY_WAIT = { timeoutMin: 5, intervalSec: 3 };
/**
 * A proof cycle is 60–110 seconds of real validator work and `execute.wait()` budgets 360s. Seven
 * minutes leaves room for a queue without being an unbounded hang. Do NOT shorten this to make a
 * test faster — it is not a tunable delay.
 */
export const TX_WAIT = { timeoutMin: 7, intervalSec: 8 };

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * Should this invocation wait?
 *
 * Human mode waits by default, because "it is not ready yet" is an implementation detail nobody
 * asked to manage. JSON mode does NOT, because scripts already written against the old
 * fire-and-forget behaviour must not silently start blocking for minutes. Either default is
 * overridden by saying so explicitly.
 *
 * Read from `process.argv` rather than commander's parsed value: declaring `--no-wait` makes
 * commander default `opts.wait` to true, which erases the distinction between "defaulted" and
 * "asked for" — and that distinction is the whole rule.
 */
export function resolveWait(argv: string[] = process.argv): boolean {
  if (argv.includes('--no-wait')) return false;
  if (argv.includes('--wait')) return true;
  return !isJsonMode();
}

export interface WaitBudget { timeoutMs: number; intervalMs: number }

/**
 * Validate `--timeout` and `--poll-interval` BEFORE any network call.
 *
 * Checking after would mean a typo'd timeout had already opened an intent that the user then has
 * to wait out or abandon — the same reasoning `certen fund` applies to its own options.
 */
export function parseWaitBudget(
  timeout: string | undefined,
  pollInterval: string | undefined,
  defaults: { timeoutMin: number; intervalSec: number },
): WaitBudget {
  const timeoutMin = timeout === undefined ? defaults.timeoutMin : Number(timeout);
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
    throw new UsageError('--timeout must be a positive number of minutes', 'INVALID_TIMEOUT');
  }
  const intervalSec = pollInterval === undefined ? defaults.intervalSec : Number(pollInterval);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    throw new UsageError('--poll-interval must be a positive number of seconds', 'INVALID_POLL_INTERVAL');
  }
  return { timeoutMs: timeoutMin * 60_000, intervalMs: intervalSec * 1_000 };
}

/**
 * Statuses `POST /v1/identity` provisioning settles into.
 *
 * The gateway writes `active` or `error` (identity.orchestrator.ts). Anything else is treated as
 * still in flight, which is the safe direction: waiting longer for an unrecognised status costs
 * time, whereas calling it terminal would report an identity ready that never became one.
 */
const IDENTITY_IN_FLIGHT = ['provisioning', 'pending', 'creating'];

function isTerminalIdentityStatus(status: string): boolean {
  return !IDENTITY_IN_FLIGHT.includes(status);
}

/** Say it once, when it changes — a five-minute wait should not be a wall of identical lines. */
function progress(): (message: string) => void {
  let last = '';
  return (message: string) => {
    if (isJsonMode() || message === last) return;
    last = message;
    human(`  ${message}`);
  };
}

/**
 * Poll an identity until it is genuinely usable.
 *
 * "Usable" is `status` terminal AND `can_sign === true`, and those are two separate conditions
 * that fail for different reasons:
 *
 * - `can_sign === false` — provisioning finished but the key on the on-chain key page is not
 *   yours. The identity exists, consumes quota, and can never sign.
 * - `can_sign === null` — the key page could not be READ. That is unknown, not a soft yes; an
 *   Accumulate outage is exactly when this distinction matters most. Reporting it as ready would
 *   be the one wrong answer, so this keeps polling and, if the budget runs out, says plainly that
 *   it could not determine the answer.
 */
export async function waitForIdentity(
  client: CertenClient,
  id: string,
  budget: WaitBudget,
): Promise<Identity> {
  const say = progress();
  const deadline = Date.now() + budget.timeoutMs;
  let last: Identity | undefined;

  say('Provisioning. This takes a minute or two on Accumulate.');

  while (Date.now() < deadline) {
    const response = await client.identity.get(id);
    const identity = response.identity;
    last = identity;
    say(`Status: ${identity.status}.`);

    if (isTerminalIdentityStatus(identity.status)) {
      if (identity.can_sign === true) return identity;

      if (identity.can_sign === false) {
        throw new CliError(
          `Identity ${id} finished provisioning as "${identity.status}" but cannot sign — its key `
          + 'page is not held by your key. It will fail at the signing step of every flow.'
          + (identity.error_message ? ` Gateway said: ${identity.error_message}` : ''),
          'IDENTITY_CANNOT_SIGN',
          EXIT.FAILED,
        );
      }

      if (identity.status === 'error') {
        throw new CliError(
          `Identity ${id} failed to provision.`
          + (identity.error_message ? ` ${identity.error_message}` : ' The gateway gave no reason.'),
          'IDENTITY_PROVISIONING_FAILED',
          EXIT.FAILED,
        );
      }
      // Terminal status, can_sign null: the key page could not be read. Keep asking — this is
      // usually transient — and fall through to the unknown-answer error if it never resolves.
      say(`Status: ${identity.status}, waiting on the key page to confirm it holds your key.`);
    }

    await sleep(budget.intervalMs);
  }

  const minutes = Math.round(budget.timeoutMs / 60_000);

  if (last && isTerminalIdentityStatus(last.status) && last.can_sign == null) {
    throw new CliError(
      `Identity ${id} is "${last.status}" but whether it can sign could not be determined — the `
      + 'on-chain key page was unreadable for the whole wait. The identity may be fine; Accumulate '
      + `may not be. Check again: certen identity get ${id}`,
      'IDENTITY_CAN_SIGN_UNKNOWN',
      EXIT.FAILED,
    );
  }

  // Neither success nor failure: provisioning may still complete. Say which it is, and do not
  // exit 0 — a script must not read "still working" as "ready".
  throw new CliError(
    `Identity ${id} is still "${last?.status ?? 'unknown'}" after ${minutes} min. It may yet `
    + `finish. Check with: certen identity get ${id}`,
    'IDENTITY_WAIT_TIMEOUT',
    EXIT.FAILED,
  );
}

/**
 * Poll a transaction intent to a terminal state.
 *
 * Delegates to the SDK's `execute.wait()` rather than re-implementing the loop, so the CLI and an
 * SDK caller agree on which statuses are terminal. The SDK signals both failure and timeout by
 * throwing a plain `Error`; those are translated here into typed CLI errors so the exit code and
 * the `--json` envelope carry a code a caller can branch on.
 */
export async function waitForTransaction(
  client: CertenClient,
  intentId: string,
  budget: WaitBudget,
): Promise<Record<string, unknown>> {
  const say = progress();
  say('Waiting for the proof cycle. This is 60-110 seconds of real validator work.');

  try {
    const result = await client.execute.wait(intentId, {
      timeoutMs: budget.timeoutMs,
      intervalMs: budget.intervalMs,
      onPoll: (tx) => {
        const status = (tx as unknown as { status?: string }).status;
        if (status) say(`Status: ${status}.`);
      },
    });
    return result as unknown as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "still <status> after <n>ms" is the SDK's timeout wording. A timeout is not a failed intent
    // — it may still complete — and conflating the two would tell a user their work was lost.
    const timedOut = /still .* after \d+ms/.test(message);
    throw new CliError(
      timedOut
        ? `${message.replace(/^certen: /, '')}. It may yet complete. Check with: certen tx status ${intentId}`
        : message.replace(/^certen: /, ''),
      timedOut ? 'TX_WAIT_TIMEOUT' : 'TX_FAILED',
      EXIT.FAILED,
    );
  }
}
