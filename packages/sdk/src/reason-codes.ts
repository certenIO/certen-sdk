import type { TransactionReasonCode } from './types.js';

/**
 * One sentence per `reason_code`, fit to show a person.
 *
 * A `Record` over the union rather than a switch with a default, so adding a value to
 * `TransactionReasonCode` without describing it is a compile error.
 *
 * Held, denied and expired are three different outcomes and are worded so they cannot be confused:
 * a denial is a party saying no, an expiry is a deadline passing with signatures still missing.
 */
export const REASON_CODE_DESCRIPTIONS: Readonly<Record<TransactionReasonCode, string>> = {
  target_reverted:
    'The destination contract rejected the call. CERTEN completed its part; retrying the identical call reverts again.',
  policy_denied:
    'A policy refused the intent. Nothing executed.',
  network_failed:
    'The network failed the transaction. Nothing is known to have executed.',
  post_submission_timeout:
    'The transaction was submitted but no outcome was observed in time. Check the destination chain before retrying.',
  pre_submission_error:
    'The intent failed before it was submitted. Nothing executed.',
  expired:
    'The deadline (expires_at) passed before every required signature arrived. Nothing executed and no fee or gas was charged.',
  expectation_unmet:
    'The call executed but the events it committed to (expectedEvents) are missing from the destination receipt. This is not a success.',
};

export function isTransactionReasonCode(code: unknown): code is TransactionReasonCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(REASON_CODE_DESCRIPTIONS, code);
}

/** A readable line for any `reason_code`, including one this SDK release does not know. */
export function describeReasonCode(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return isTransactionReasonCode(code)
    ? REASON_CODE_DESCRIPTIONS[code]
    : `The gateway reported reason "${code}", which this SDK version does not recognise.`;
}
