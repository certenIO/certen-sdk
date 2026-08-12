import type { CertenClient } from '@certen.io/sdk';
import { CliError, EXIT } from './errors.js';

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
async function fundingFor(
  client: CertenClient,
  identityId: string,
  chain: string,
): Promise<ChainFunding | null> {
  try {
    const portfolio = await client.portfolio.get(identityId);
    for (const identity of portfolio.identities ?? []) {
      for (const c of identity.chains ?? []) {
        if (c.chain_id !== chain) continue;
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
): Promise<void> {
  if (force || !chain || !movesValue(intent)) return;

  const funding = await fundingFor(client, identityId, chain);
  if (!funding) return;

  const balance = funding.balance;
  if (balance === null) return;
  if (Number(balance) > 0) return;

  const faucet = faucetFor(chain);
  throw new CliError(
    `The abstract account ${funding.address} on ${chain} holds no ${chain.includes('sepolia') ? 'testnet ' : ''}`
    + 'gas. This intent would be accepted, signed and submitted, and would then park at "anchoring" '
    + 'forever, because the execution leg cannot run on chain.\n'
    + `  Fund it first${faucet ? `: ${faucet}` : '.'}\n`
    + '  Then run this command again. Pass --force to submit anyway.',
    'ABSTRACT_ACCOUNT_UNFUNDED',
    EXIT.FAILED,
  );
}
