import { AxiosInstance } from 'axios';
import { CertenError } from './errors.js';
import {
  chainInfo, chainSlug, nativeSymbolFor, readNativeBalance, describeUnverifiable, gasReserveFor, parseUnits, formatUnits,
} from './chains.js';
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
 * - A balance that is positive but cannot cover the amount being moved plus the gas to move it is
 *   refused ({@link CertenUnderfundedAccountError}). Zero is the extreme case of this and keeps its
 *   own error. The gas half is an ESTIMATE (see {@link assessGas}); the amount half is not.
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

/**
 * Thrown instead of submitting a value-moving intent from an account that holds some gas, but not enough: either less than the amount
 * being moved, or too little left over once it is.
 *
 * `kind: 'amount'` is a fact (the account holds less than it is about to send). `kind: 'gas'` is judged against an ESTIMATE of what one
 * execution costs, which is why it is overridable and says so.
 */
export class CertenUnderfundedAccountError extends CertenError {
  readonly address: string;
  readonly chain: string;
  readonly kind: 'amount' | 'gas';
  /** Whole native units, as strings, so nothing here is a float. */
  readonly balance: string;
  readonly needed: string;
  readonly symbol: string;

  constructor(address: string, chain: string, shortfall: Extract<GasAssessment, { state: 'short' }>) {
    super(
      shortfall.kind === 'amount'
        ? `The abstract account ${address} on ${chain} holds ${shortfall.balance} ${shortfall.symbol}, less than the ${shortfall.amount} ${shortfall.symbol} this intent moves. `
          + 'It would be accepted, signed and submitted, and then never execute. Fund it first, or pass skipFundingCheck: true to submit anyway.'
        : `The abstract account ${address} on ${chain} holds ${shortfall.balance} ${shortfall.symbol}; moving ${shortfall.amount} ${shortfall.symbol} and paying for the execution needs about `
          + `${shortfall.needed} ${shortfall.symbol}${shortfall.reserve === '0' ? ' (nothing would be left over for gas)' : ` (the gas share, ${shortfall.reserve} ${shortfall.symbol}, is an estimate, not a quote)`}. `
          + 'Without gas the intent is accepted, signed and submitted, and then parks at "anchoring" forever. Fund it first, or pass skipFundingCheck: true to submit anyway.',
      0,
      'ABSTRACT_ACCOUNT_UNDERFUNDED',
    );
    this.name = 'CertenUnderfundedAccountError';
    this.address = address;
    this.chain = chain;
    this.kind = shortfall.kind;
    this.balance = shortfall.balance;
    this.needed = shortfall.needed;
    this.symbol = shortfall.symbol;
  }

  /** Never. Funding is a human act; retrying changes nothing. */
  get isRetryable(): boolean {
    return false;
  }
}

export type FundingUnverifiableReason = 'unknown-native' | 'native-not-reported' | 'unreadable';

/**
 * What the native balance on an abstract account says about a value-moving intent.
 *
 * One function, used by the SDK's guard, the CLI's guard and `client.readiness()`: three copies of "is there enough" would drift, and the
 * place they would drift is the amount of money at which a refusal starts.
 *
 * - `unknown`: the balance could not be read as a number (not reported yet, the wrong token, unreadable). **Never** a refusal on its own
 *   authority: an unknown balance does not block a submission, and is never reported as funded.
 * - `empty`: positively zero.
 * - `short`: positive, but below what is needed. `kind: 'amount'` when it cannot even cover the amount; `kind: 'gas'` when it covers the
 *   amount but not the amount plus the gas reserve (or leaves nothing at all for gas).
 * - `sufficient`: enough. `estimated` says whether a gas reserve was part of the judgement; false means the chain has no estimate and only
 *   the amount was checked.
 *
 * Every quantity is exact integer arithmetic in base units and reported in whole units.
 */
export type GasAssessment =
  | { state: 'unknown'; reading: NativeBalanceReading }
  | { state: 'empty'; symbol: string; balance: string; amount: string; reserve: string; needed: string }
  | {
    state: 'short'; kind: 'amount' | 'gas'; symbol: string; balance: string; amount: string; reserve: string; needed: string;
    /** How much more would clear it, or null when only "something left over for gas" would (the whole balance was being moved). */
    shortfall: string | null;
  }
  | { state: 'sufficient'; symbol: string; balance: string; amount: string; reserve: string; needed: string; estimated: boolean };

export function assessGas(p: {
  chain: string | number;
  reading: NativeBalanceReading;
  /** The native amount being moved, in whole units. Omit when nothing native moves (a token transfer, or only a readiness check). */
  amount?: string;
  /**
   * The gas reserve in whole units. Undefined takes the catalogue's estimate for the chain; `null` means "no reserve", which is how a caller
   * says it knows better than the catalogue.
   */
  reserve?: string | null;
}): GasAssessment {
  const reading = p.reading;
  if (reading.state !== 'funded' && reading.state !== 'empty') return { state: 'unknown', reading };
  const decimals = chainInfo(p.chain)?.nativeDecimals;
  if (decimals === undefined) return { state: 'unknown', reading: { state: 'unknown-native', chain: chainSlug(p.chain) } };

  const balance = parseUnits(reading.balance, decimals);
  // A number that is not a plain decimal ("1e-7", "unavailable") is not something to do arithmetic on. Unreadable, not zero.
  if (balance === undefined) return { state: 'unknown', reading: { state: 'unreadable', symbol: reading.symbol, balance: reading.balance } };

  // An amount that is not a decimal cannot be compared; the reserve is still judged.
  const amount = p.amount === undefined ? 0n : parseUnits(p.amount, decimals) ?? 0n;
  const reserveText = p.reserve === undefined ? gasReserveFor(p.chain) : p.reserve ?? undefined;
  const reserve = reserveText === undefined ? 0n : parseUnits(reserveText, decimals) ?? 0n;
  const needed = amount + reserve;

  const out = {
    symbol: reading.symbol,
    balance: formatUnits(balance, decimals),
    amount: formatUnits(amount, decimals),
    reserve: formatUnits(reserve, decimals),
    needed: formatUnits(needed, decimals),
  };
  if (balance === 0n) return { state: 'empty', ...out };
  const shortfall = needed > balance ? formatUnits(needed - balance, decimals) : null;
  if (balance < amount) return { state: 'short', kind: 'amount', ...out, shortfall };
  // Moving the whole balance leaves nothing to pay gas with, estimate or no estimate.
  if (balance < needed || (amount > 0n && balance === amount)) return { state: 'short', kind: 'gas', ...out, shortfall };
  return { state: 'sufficient', ...out, estimated: reserve > 0n };
}

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
  params: {
    identityId: string;
    chain: string | undefined;
    amount: unknown;
    /**
     * What `amount` is measured in. `whole` (the default) is a transfer's `amount`: "0.0001" ETH. `base` is a contract call's `value`:
     * wei. The same field name has carried both, which is why this is stated rather than guessed from the digits.
     */
    amountUnit?: 'whole' | 'base';
    /** The token being moved. When it is not the chain's native token the amount is not native, and only the gas is judged. */
    tokenSymbol?: string;
    /** Override the catalogue's gas reserve (whole native units); `null` for none. See {@link assessGas}. */
    gasReserve?: string | null;
  },
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
  const assessment = assessGas({
    chain: want,
    reading,
    amount: nativeAmountOf(want, params),
    reserve: params.gasReserve,
  });
  switch (assessment.state) {
    case 'sufficient':
      return;
    case 'empty':
      throw new CertenUnfundedAccountError(address, want);
    case 'short':
      throw new CertenUnderfundedAccountError(address, want, assessment);
    case 'unknown': {
      const r = assessment.reading;
      if (r.state === 'unknown-native' || r.state === 'native-not-reported' || r.state === 'unreadable') {
        throw new CertenFundingUnverifiableError(address, want, r.state, describeUnverifiable(want, r)!);
      }
      return;
    }
  }
}

/**
 * The part of an intent's amount that is paid in the chain's native token, in whole units, or undefined when none of it is.
 *
 * A token transfer's amount is in the token and does not draw down the gas balance; counting it would refuse an account that holds the
 * token and plenty of gas. A base-unit (wei) value is converted so one comparison serves both spellings.
 */
export function nativeAmountOf(
  chain: string,
  p: { amount: unknown; amountUnit?: 'whole' | 'base'; tokenSymbol?: string },
): string | undefined {
  const info = chainInfo(chain);
  if (!info || p.amount === undefined || p.amount === null) return undefined;
  if (p.tokenSymbol && p.tokenSymbol.toUpperCase() !== info.nativeSymbol.toUpperCase()) return undefined;
  const text = String(p.amount).trim();
  if (p.amountUnit === 'base') return /^\d+$/.test(text) ? formatUnits(BigInt(text), info.nativeDecimals) : undefined;
  return text;
}
