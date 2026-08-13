import type { CertenClient } from '@certen.io/sdk';
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
 * The check is deliberately one-directional. It refuses ONLY on a positively observed zero
 * balance. If the balance cannot be read — the chain is not in the portfolio, the account is not
 * deployed yet, the lookup fails — the intent proceeds. A guard that blocked on missing data
 * would break legitimate work every time the portfolio view lagged, which is a worse failure than
 * the one it prevents.
 */

/** Where to send testnet gas, per chain. Printed with the refusal, because the fix is the point. */
const FAUCETS: Record<string, string> = {
  'ethereum-sepolia': 'https://sepoliafaucet.com',
  'base-sepolia': 'https://www.alchemy.com/faucets/base-sepolia',
  'arbitrum-sepolia': 'https://www.alchemy.com/faucets/arbitrum-sepolia',
};

export function faucetFor(chain: string): string | undefined {
  return FAUCETS[chain];
}

/** Does this intent move value? A zero or absent amount needs no funded account. */
export function movesValue(intent: Record<string, unknown>): boolean {
  const amount = intent.amount ?? (intent as { value?: unknown }).value;
  if (amount === undefined || amount === null) return false;
  const n = Number(String(amount));
  // A non-numeric amount is not evidence of zero — let the gateway judge the shape.
  return Number.isFinite(n) ? n > 0 : true;
}

interface ChainFunding {
  address: string;
  /** Native-token balance as the gateway reported it, or null when it could not be read. */
  balance: string | null;
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
  // make the execution leg runnable.
  const native = onChain.find((b) => !b.token || b.token === 'ETH' || b.token === 'native');
  return {
    address: onChain[0].address,
    balance: native ? native.balance : null,
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
        // The native balance is the one that pays for execution. A token balance on the same
        // account does not make the execution leg runnable.
        const native = (c.balances ?? []).find((b) => !b.token || b.token === 'ETH' || b.token === 'native');
        return {
          address: c.address,
          balance: native ? native.balance : null,
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
): Promise<void> {
  if (force || !chain || !movesValue(intent)) return;

  const funding = known ? fromKnown(known, chain) : await fundingFor(client, identityId, chain);
  if (!funding) return;

  const balance = funding.balance;
  if (balance === null) return;
  if (Number(balance) > 0) return;

  const named = normalizeChain(chain);
  const faucet = faucetFor(named);
  throw new CliError(
    `The abstract account ${funding.address} on ${named} holds no ${named.includes('sepolia') ? 'testnet ' : ''}`
    + 'gas. This intent would be accepted, signed and submitted, and would then park at "anchoring" '
    + 'forever, because the execution leg cannot run on chain.\n'
    + `  Fund it first${faucet ? `: ${faucet}` : '.'}\n`
    + '  Then run this command again. Pass --force to submit anyway.',
    'ABSTRACT_ACCOUNT_UNFUNDED',
    EXIT.FAILED,
  );
}
