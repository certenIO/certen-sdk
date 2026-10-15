import {
  chainInfo, faucetForChain, nativeSymbolFor, readNativeBalance, describeUnverifiable, assessGas, nativeAmountOf,
  type CertenClient, type NativeBalanceReading,
} from '@certen.io/sdk';
import { CliError, EXIT } from './errors.js';
import { normalizeChain } from './chains.js';

/**
 * The zero-balance abstract account guard.
 *
 * This is the most expensive silent failure in the product, and it is documented everywhere
 * except where it happens. A fresh identity gets a deterministic abstract account on each linked
 * chain, with a zero balance. An intent that moves value from it is accepted, signed and
 * submitted — every step reports success — and then parks at `anchoring` forever, because the
 * execution leg cannot run on chain. Nothing in any API response says so. The intent simply never
 * reaches a terminal state, and the user is left debugging a gateway that is behaving correctly.
 *
 * So: refuse before submitting, and name the address that needs funding.
 *
 * What it refuses:
 * - a positively observed zero gas balance (`ABSTRACT_ACCOUNT_UNFUNDED`);
 * - a positive balance that cannot cover the native amount being moved, or the amount plus an ESTIMATE of the gas to move it
 *   (`ABSTRACT_ACCOUNT_UNDERFUNDED`). The amount half is a fact. The gas half is the catalogue's per-chain reserve, which is a planning
 *   figure and not a quote (the gateway publishes no per-execution gas cost), so the message says it is an estimate and `--force` is the
 *   way past it. The comparison is the SDK's `assessGas`, the same one `client.readiness()` uses, so the two cannot disagree about
 *   where a refusal starts;
 * - a gas balance that cannot be IDENTIFIED (`ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE`), by name: the
 *   chain's gas token is unknown to the catalogue, the gateway reported balances none of which is
 *   that token, or it reported the gas row as unreadable. The guard used to look for an `ETH` row on
 *   every chain, so on a chain whose gas is not ETH it found nothing and let the intent through.
 *
 * What it lets through: the chain not appearing in the portfolio, the account having no balances
 * reported yet, or the portfolio lookup failing. A guard that blocked every time the portfolio view
 * lagged would break legitimate work, which is a worse failure than the one it prevents.
 */

/**
 * Where to send testnet gas, per chain, from the SDK's chain catalogue. Printed with the refusal,
 * because the fix is the point. Accepts a slug or a numeric chain id.
 */
export function faucetFor(chain: string): string | undefined {
  return faucetForChain(chain);
}

/**
 * Does this intent move value? A zero or absent amount needs no funded account.
 *
 * The field name says the unit: `amount` is whole units (a transfer's "0.0001"), `value` is base units (a contract call's wei). Both
 * have always been read here; the difference did not matter while all that was asked was "is it above zero".
 */
export function movesValue(intent: Record<string, unknown>): boolean {
  const amount = intent.amount ?? (intent as { value?: unknown }).value;
  if (amount === undefined || amount === null) return false;
  const n = Number(String(amount));
  // A non-numeric amount is not evidence of zero — let the gateway judge the shape.
  return Number.isFinite(n) ? n > 0 : true;
}

/** The part of this intent that is paid in the chain's native token, in whole units; undefined when none of it is, or it cannot be read. */
function nativeAmountOfIntent(chain: string, intent: Record<string, unknown>): string | undefined {
  const token = (intent.tokenSymbol ?? intent.token) as string | undefined;
  if (intent.amount !== undefined && intent.amount !== null) return nativeAmountOf(chain, { amount: intent.amount, tokenSymbol: token });
  return nativeAmountOf(chain, { amount: (intent as { value?: unknown }).value, amountUnit: 'base', tokenSymbol: token });
}

interface ChainFunding {
  address: string;
  /** What the reported balances say about the gas, read by the chain's own native symbol. */
  reading: NativeBalanceReading;
  deployed: boolean;
}

/**
 * Read one identity's funding position on one chain.
 *
 * Returns null whenever the answer is not knowable, which the caller must treat as "do not
 * block" rather than as zero.
 */
/**
 * Per-chain balances as `GET /v1/identity/{id}` already returns them.
 *
 * Accepted so a caller that has just fetched the identity does not pay for a second read of the
 * same numbers — see the note on `assertFundedForValue`.
 */
export type KnownBalances = Array<{
  chain_id: string;
  address: string;
  token?: string;
  balance: string;
}>;

function fromKnown(balances: KnownBalances, chain: string): ChainFunding | null {
  const want = normalizeChain(chain);
  const onChain = balances.filter((b) => normalizeChain(b.chain_id) === want);
  if (onChain.length === 0) return null;
  // The NATIVE balance is what pays for execution; a token balance on the same account does not
  // make the execution leg runnable, and on a chain whose gas is not ETH an `ETH` row is not gas.
  return {
    address: onChain[0].address,
    reading: readNativeBalance(want, onChain),
    // Not reported by this endpoint, and not read by anything: the guard decides on the balance.
    deployed: true,
  };
}

async function fundingFor(
  client: CertenClient,
  identityId: string,
  chain: string,
): Promise<ChainFunding | null> {
  try {
    const portfolio = await client.portfolio.get(identityId);
    // Both sides are normalized: the gateway returns `chain_id` as a slug on some chain accounts
    // and as a numeric EVM id on others, in the same response. Comparing raw strings matched the
    // slug entries and silently skipped the numeric ones — so the guard did nothing on exactly
    // the accounts it was written to protect.
    const want = normalizeChain(chain);
    for (const identity of portfolio.identities ?? []) {
      for (const c of identity.chains ?? []) {
        if (normalizeChain(c.chain_id) !== want) continue;
        // The native balance is the one that pays for execution, found by the chain's own native
        // symbol. A token balance on the same account does not make the execution leg runnable.
        return {
          address: c.address,
          reading: readNativeBalance(want, c.balances),
          deployed: c.deployed,
        };
      }
    }
    return null;
  } catch {
    // An unavailable portfolio must never block a transaction. The guard is a courtesy, not a
    // gate the product depends on.
    return null;
  }
}

/**
 * Refuse a value-moving intent from an abstract account that is positively known to be empty.
 *
 * `force` exists because someone deliberately exercising the anchoring path should be able to,
 * and because a guard with no override becomes something people work around rather than with.
 */
export async function assertFundedForValue(
  client: CertenClient,
  identityId: string,
  chain: string | undefined,
  intent: Record<string, unknown>,
  force: boolean,
  /**
   * Balances the caller has ALREADY fetched, from `identity.get()`.
   *
   * `GET /v1/identity/{id}` returns a `balances` array carrying the same chain, address and native
   * balance this guard reads out of `/v1/portfolio`. `certen call` fetches the identity first (it
   * needs `can_sign` before prompting for a passphrase) and then paid for a second read of numbers
   * it was already holding — a round trip on the critical path of the main flow, for nothing.
   *
   * Omit it and the portfolio is fetched as before; `certen tx create` has no identity in hand.
   */
  known?: KnownBalances,
  /** Override the catalogue's gas reserve (whole native units); `null` for none. An estimate either way. */
  gasReserve?: string | null,
): Promise<void> {
  if (force || !chain || !movesValue(intent)) return;

  const named = normalizeChain(chain);
  // Before any read: on a chain whose gas token is unknown, no balance row can be identified as the
  // gas, so the answer is already known to be unknowable.
  if (nativeSymbolFor(named) === undefined) {
    throw unverifiable(undefined, named, { state: 'unknown-native', chain: named });
  }

  const funding = known ? fromKnown(known, chain) : await fundingFor(client, identityId, chain);
  if (!funding) return;

  const reading = funding.reading;
  // Nothing reported for the account yet is not evidence of zero, and an unreadable balance is not a refusal on its own authority.
  if (reading.state === 'no-balances') return;
  if (reading.state !== 'funded' && reading.state !== 'empty') throw unverifiable(funding.address, named, reading);

  const assessment = assessGas({ chain: named, reading, amount: nativeAmountOfIntent(named, intent), reserve: gasReserve });
  const faucet = faucetFor(named);
  const fundIt = `  Fund it first${faucet ? `: ${faucet}` : '.'}\n  Then run this command again. Pass --force to submit anyway.`;
  switch (assessment.state) {
    case 'sufficient':
      return;
    case 'unknown':
      // `readNativeBalance` called it funded but it is not a plain decimal ("1e-7"): unreadable, and named as such.
      throw unverifiable(funding.address, named, assessment.reading);
    case 'empty':
      throw new CliError(
        `The abstract account ${funding.address} on ${named} holds no ${chainInfo(named)?.environment === 'testnet' ? 'testnet ' : ''}`
        + 'gas. This intent would be accepted, signed and submitted, and would then park at "anchoring" '
        + 'forever, because the execution leg cannot run on chain.\n'
        + fundIt,
        'ABSTRACT_ACCOUNT_UNFUNDED',
        EXIT.FAILED,
      );
    case 'short':
      throw new CliError(
        (assessment.kind === 'amount'
          ? `The abstract account ${funding.address} on ${named} holds ${assessment.balance} ${assessment.symbol}, less than the `
            + `${assessment.amount} ${assessment.symbol} this intent moves. It would be accepted, signed and submitted, and would then never execute.\n`
          : assessment.reserve === '0'
            ? `The abstract account ${funding.address} on ${named} holds ${assessment.balance} ${assessment.symbol}, which is all of the `
              + `${assessment.amount} ${assessment.symbol} this intent moves: nothing would be left to pay for gas, and without gas it parks at "anchoring" forever.\n`
            : `The abstract account ${funding.address} on ${named} holds ${assessment.balance} ${assessment.symbol}; moving ${assessment.amount} ${assessment.symbol} `
              + `and paying for the execution needs about ${assessment.needed} ${assessment.symbol} (the gas share, ${assessment.reserve} ${assessment.symbol}, is an `
              + 'estimate, not a quote). Without gas it parks at "anchoring" forever.\n')
        + fundIt,
        'ABSTRACT_ACCOUNT_UNDERFUNDED',
        EXIT.FAILED,
      );
  }
}

function unverifiable(address: string | undefined, chain: string, reading: NativeBalanceReading): CliError {
  return new CliError(
    `Cannot verify that the abstract account${address ? ` ${address}` : ''} on ${chain} holds gas: `
    + `${describeUnverifiable(chain, reading)}. An intent from an unfunded account is accepted, signed `
    + 'and submitted, and then parks at "anchoring" forever.\n'
    + '  Check the account\'s gas yourself, then pass --force to submit anyway.',
    'ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE',
    EXIT.FAILED,
  );
}
