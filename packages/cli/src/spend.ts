import { randomUUID } from 'node:crypto';
import { CertenClient, CertenError } from '@certen.io/sdk';
import { CliError, UsageError, EXIT } from './errors.js';
import { printable } from './gateway-text.js';
import type { Prompter } from './prompt.js';

/**
 * What the two commands that spend the PLATFORM'S money have in common: `credits topup` (ACME for a key page's credits) and `gas --drip` (native
 * token for an account's gas).
 *
 * Neither takes money from the person typing. Both draw on a sponsor account the operator funds, which is why the gateway ships them switched off,
 * limits them per request, per identity and per day, and refuses to run them without an Idempotency-Key. That shapes what this CLI does:
 *
 * - **Nothing spends unattended.** At a terminal the person is asked, and a bare Enter is no. Anywhere else (a pipe, CI, `--json`) the command
 *   refuses to start unless `--yes` was passed, before it reads or sends anything. `--json` is deliberately NOT consent here, unlike the commands
 *   that sign: a machine that asked for an envelope has not said it is happy to spend someone else's money.
 * - **The key is the caller's to keep.** One is generated when none is given, it is printed in every outcome, and `--idempotency-key` sends it
 *   again. A repeat with the same key is never a second draw, so a script that retries after a crash or a timeout must pass the one it was told.
 * - **One attempt.** The client used here does not retry on its own: a limit is a window and not a blip, and what to do after an unknown outcome
 *   is the caller's decision, made with the key in hand.
 */

/** What the gateway accepts as an Idempotency-Key: 1 to 255 characters from A-Z a-z 0-9 _ . : - (its catalogue says so under IDEMPOTENCY_KEY_REQUIRED). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,255}$/;

/** The key a command will send: the person's, checked here, or a fresh one. Raised before any request, so a bad key costs a message. */
export function resolveIdempotencyKey(given: string | undefined): string {
  if (given === undefined) return `certen-${randomUUID()}`;
  if (!IDEMPOTENCY_KEY.test(given)) {
    throw new UsageError(
      '--idempotency-key must be 1 to 255 characters from A-Z a-z 0-9 _ . : - (the gateway refuses anything else). Use the key the earlier attempt printed, exactly.',
      'INVALID_IDEMPOTENCY_KEY',
    );
  }
  return given;
}

/** The client for a call that spends: this credential and gateway, and one attempt. */
export function spendClient(apiKey: string, baseUrl: string): CertenClient {
  return new CertenClient({ apiKey, baseUrl, maxRetries: 0 });
}

/**
 * Refuse BEFORE anything is read or sent when this would spend the platform's funds with nobody to say yes.
 *
 * Passes when `--yes` was given or when a person is at a terminal (they will be asked). Does not pass for `--json`, which is not an answer.
 */
export function assertCanSpend(opts: { yes: boolean; prompter: Prompter; command: string; what: string }): void {
  if (opts.yes || opts.prompter.interactive) return;
  throw new UsageError(
    `${opts.command} spends the platform's funds (${opts.what}), and there is no one at a terminal to confirm it. Run it where you can answer, or pass --yes to say yes in advance. `
    + 'A script that retries must pass the same --idempotency-key each time: a new key is a new draw.',
    'CONFIRMATION_REQUIRED',
  );
}

/** Ask, with "no" as the answer to a bare Enter. `--yes` has already answered. */
export async function confirmSpend(prompter: Prompter, yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  return prompter.confirm(question, false);
}

export interface SpendFailureContext {
  /** What was being asked for, in the words of the message: `credit top-up`, `gas drip`. */
  what: 'credit top-up' | 'gas drip';
  /** What it would have done had it worked, for "may have been": `the credits may have been added`. */
  mayHave: string;
  key: string;
  /** The command that repeats it with the same key. Printed, never run. */
  repeat: string;
  /** What to try instead when the feature is off or refused. */
  instead: string;
  chain?: string;
}

const EXPLAINED: Record<string, (c: SpendFailureContext, gateway: string) => string> = {
  CREDIT_TOPUP_DISABLED: () => 'Credit top-up is not switched on at this gateway. The operator turns it on (it draws on the platform\'s sponsor account), and retrying will not. Nothing was added or charged.',
  DRIP_DISABLED: (c) => `The gas drip is not switched on at this gateway. The operator turns it on (it draws on the platform's sponsor wallet), and retrying will not. Nothing was sent. ${c.instead}`,
  CREDIT_TOPUP_LIMIT: (_c, g) => `A credit limit was reached (the most one request may add, or a daily limit for this identity or organization): ${g}. Nothing was added. Retrying now will not help: try again after the window, or ask for fewer credits.`,
  DRIP_LIMIT: (c, g) => `A drip limit was reached: ${g}. Nothing was sent. Retry after the window the message gives. ${c.instead}`,
  DRIP_TESTNET_ONLY: (c) => `The gas drip is for testnets only, and ${c.chain ?? 'this chain'} is not one. Nothing was sent. ${c.instead}`,
  DRIP_UNAVAILABLE: (c, g) => `The platform cannot send a drip on ${c.chain ?? 'this chain'} right now: ${g}. Nothing was sent. Retry later. ${c.instead}`,
  DRIP_RECIPIENT_REJECTS: () => 'This account cannot receive a drip: its contract did not accept a plain transfer of the native token. Nothing was sent. Contact support with the account address.',
};

/**
 * What to throw for an error from the spending call.
 *
 * A refusal the gateway states clearly (off, a limit, a mainnet, a recipient that rejects) becomes a plain message that says nothing was spent and
 * what to do instead. An outcome nobody knows (no response, a 5xx, a timeout) says the spend MAY have happened and hands over the key to repeat
 * it with, because that is the one case where a retry could be a second draw if the key were new. Everything else is the error as it was: a 4xx
 * the gateway gave means nothing was applied, and its own message and class (a 402's payment target, for one) are the better account.
 *
 * `retryable` stays the SDK's judgement, so the envelope agrees with the SDK (a limit says retryable: it is, after its window; this CLI just
 * does not retry it on its own).
 */
export function spendFailure(err: unknown, ctx: SpendFailureContext): unknown {
  if (!(err instanceof CertenError)) return err;
  const gateway = printable(err.message.replace(/^certen: /, ''), 240);
  const explained = EXPLAINED[err.code];
  // No response, a timeout or a server error: the request may have been acted on. (Another status-0 error is a refusal raised here, before anything left.)
  const unknownOutcome = err.code === 'NETWORK_ERROR' || err.status >= 500 || err.status === 408;
  const inFlight = err.code === 'IDEMPOTENCY_KEY_IN_FLIGHT';

  let message: string;
  if (explained) {
    // A refusal the gateway states, even as a 503 (off, unavailable): it said nothing was done, so it is not an unknown outcome.
    message = explained(ctx, gateway);
  } else if (inFlight) {
    message = `The first request with this Idempotency-Key is still running, so its outcome is not known yet. Wait a moment, then repeat with the SAME key (${ctx.key}): ${ctx.repeat}. A new key would be a second draw.`;
  } else if (unknownOutcome) {
    message = `${gateway}. The request may or may not have reached the gateway, so ${ctx.mayHave}. Repeating it with the same key can never draw twice: ${ctx.repeat}`;
  } else {
    return err;
  }

  const failure = new CliError(
    message, err.code, err.code === 'NETWORK_ERROR' ? EXIT.UNREACHABLE : EXIT.FAILED, err.isRetryable,
    { idempotency_key: ctx.key, ...(ctx.chain ? { chain: ctx.chain } : {}) },
  );
  // The gateway's status and request id stay on the envelope, as they do for any other failure.
  return Object.assign(failure, { status: err.status || undefined, requestId: err.requestId });
}
