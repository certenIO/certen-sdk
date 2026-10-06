import { AxiosInstance } from 'axios';
import { CertenError } from './errors.js';
import { chainSlug, nativeSymbolFor, readNativeBalance, describeUnverifiable } from './chains.js';
import type { NativeBalanceReading } from './chains.js';

/**
 * The unfunded abstract account guard.
 *
 * This is the most expensive silent failure the platform can produce, and it is invisible at every
 * point where someone might notice it. A fresh identity gets a deterministic abstract account on
 * each linked chain, with a zero balance. An intent that moves value from it is accepted, signed
 * and submitted — every call returns success — and then parks at `anchoring` forever, because the
 * execution leg cannot run on chain. No response says so. The intent simply never reaches a
 * terminal state, and the failure is usually blamed on the gateway.
 *
 * So the SDK refuses before submitting, and says why.
 *
 * **What it refuses, and what it lets through.**
 *
 * - A positively observed zero gas balance is refused ({@link CertenUnfundedAccountError}).
 * - A gas balance that cannot be IDENTIFIED is refused by name
 *   ({@link CertenFundingUnverifiableError}): the chain's gas token is unknown to the catalogue,
 *   the gateway reported balances none of which is that token, or it reported the gas row as
 *   unreadable. The first two used to pass silently on any chain whose gas is not called `ETH` —
 *   the guard looked for an `ETH` row, found none, and waved the intent through.
 * - The portfolio being unreachable, or the chain not appearing in it at all, lets the intent
 *   proceed. A guard that blocked every time the portfolio view lagged would break legitimate work,
 *   which is a worse failure than the one it prevents.
 *
 * `skipFundingCheck: true` bypasses all of it, deliberately and visibly.
 */

/** Thrown instead of submitting an intent that could never execute. */
export class CertenUnfundedAccountError extends CertenError {
  readonly address: string;
  readonly chain: string;

  constructor(address: string, chain: string) {
    super(
      `The abstract account ${address} on ${chain} holds no gas. This intent would be accepted, `
      + 'signed and submitted, and would then park at "anchoring" forever, because the execution leg '
      + 'cannot run on chain. Fund it first, or pass skipFundingCheck: true to submit anyway.',
      // 0 is the SDK's "this never reached the gateway" status, which is exactly true here: the
      // guard runs before the request, and nothing was submitted.
      0,
      'ABSTRACT_ACCOUNT_UNFUNDED',
    );
    this.name = 'CertenUnfundedAccountError';
    this.address = address;
    this.chain = chain;
  }

  /** Never. Funding is a human act; retrying changes nothing. */
  get isRetryable(): boolean {
    return false;
  }
}

export type FundingUnverifiableReason = 'unknown-native' | 'native-not-reported' | 'unreadable';

/**
 * Thrown instead of submitting a value-moving intent whose gas balance could not be identified.
 *
 * Not the same claim as {@link CertenUnfundedAccountError}: the account may well be funded. What is
 * known is that this client cannot tell, and an unfunded account is a silent, permanent stall.
 */
export class CertenFundingUnverifiableError extends CertenError {
  readonly address: string | undefined;
  readonly chain: string;
  readonly reason: FundingUnverifiableReason;

  constructor(address: string | undefined, chain: string, reason: FundingUnverifiableReason, why: string) {
    super(
      `Cannot verify that the abstract account${address ? ` ${address}` : ''} on ${chain} holds gas: ${why}. `
      + 'An intent from an unfunded account is accepted, signed and submitted, and then parks at '
      + '"anchoring" forever. Check the account\'s gas yourself, then pass skipFundingCheck: true to submit.',
      0,
      'ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE',
    );
    this.name = 'CertenFundingUnverifiableError';
    this.address = address;
    this.chain = chain;
    this.reason = reason;
  }

  /** Only an unreadable balance can change on its own; the other two are facts about the chain. */
  get isRetryable(): boolean {
    return this.reason === 'unreadable';
  }
}

/**
 * Numeric EVM chain id → registry slug, from the chain catalogue (`chains.ts`).
 *
 * `GET /v1/portfolio` used to return `chain_id` as a slug on some chain accounts and as a numeric
 * EVM id on others, in the same response, because the gateway stored whatever the caller sent.
 * Comparing raw strings matched the slug entries and silently skipped the numeric ones — so this
 * guard did nothing on exactly the accounts it was written to protect.
 *
 * The gateway now canonicalizes on write and has backfilled the old rows, so a current gateway
 * returns slugs only. This stays anyway, and not out of superstition: the SDK is versioned
 * independently and is routinely pointed at a gateway older than itself. A guard that silently
 * stops guarding against an older peer is worse than no guard, because nothing signals the gap.
 */
export function normalizeChainId(value: string | number | null | undefined): string {
  return chainSlug(value);
}

/** Does this amount move value? A zero or absent amount needs no funded account. */
export function movesValue(amount: unknown): boolean {
  if (amount === undefined || amount === null || amount === '') return false;
  const n = Number(String(amount));
  // A non-numeric amount is not evidence of zero. Assume it moves value and let the gateway judge
  // the shape — the opposite default would skip the guard on exactly the malformed input that most
  // warrants a second look.
  return Number.isFinite(n) ? n > 0 : true;
}

/**
 * Refuse a value-moving intent from an abstract account positively known to be empty, or whose gas
 * balance cannot be identified.
 *
 * Reads the portfolio directly rather than taking a client, so this stays usable from inside
 * `ExecuteResource`, which holds only an axios instance.
 */
export async function assertFundedForValue(
  http: AxiosInstance,
  params: { identityId: string; chain: string | undefined; amount: unknown },
): Promise<void> {
  if (!params.chain || !movesValue(params.amount)) return;

  const want = normalizeChainId(params.chain);
  // Before any read: on a chain whose gas token is unknown, no balance row can be identified as the
  // gas, so the answer is already known to be unknowable.
  if (nativeSymbolFor(want) === undefined) {
    const reading: NativeBalanceReading = { state: 'unknown-native', chain: want };
    throw new CertenFundingUnverifiableError(undefined, want, 'unknown-native', describeUnverifiable(want, reading)!);
  }

  let address: string | undefined;
  let reading: NativeBalanceReading | undefined;
  try {
    const { data } = await http.get('/v1/portfolio', { params: { identity: params.identityId } });
    const identities = (data as {
      identities?: Array<{ chains?: Array<{ chain_id: string; address: string; balances?: Array<{ token?: string; balance: string }> }> }>;
    }).identities ?? [];

    for (const identity of identities) {
      for (const chain of identity.chains ?? []) {
        if (normalizeChainId(chain.chain_id) !== want) continue;
        // The NATIVE balance is what pays for execution. A token balance on the same account does
        // not make the execution leg runnable — and on a chain whose gas is not ETH, an `ETH` row
        // is not the gas either.
        const r = readNativeBalance(want, chain.balances);
        // Nothing reported for the account yet (not deployed, not indexed): not evidence of zero.
        if (r.state === 'no-balances') return;
        address = chain.address;
        reading = r;
      }
    }
  } catch {
    // An unavailable portfolio must never block a transaction.
    return;
  }

  if (address === undefined || reading === undefined) return;
  switch (reading.state) {
    case 'funded':
      return;
    case 'empty':
      throw new CertenUnfundedAccountError(address, want);
    case 'unknown-native':
    case 'native-not-reported':
    case 'unreadable':
      throw new CertenFundingUnverifiableError(address, want, reading.state, describeUnverifiable(want, reading)!);
    default:
      return;
  }
}
