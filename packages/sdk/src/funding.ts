import { AxiosInstance } from 'axios';
import { CertenError } from './errors.js';

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
 * **The check is one-directional by design.** It refuses ONLY on a positively observed zero
 * balance. If the balance cannot be read — the chain is absent from the portfolio, the account is
 * not deployed, the lookup fails — the intent proceeds. A guard that blocked on missing data would
 * break legitimate work every time the portfolio view lagged, which is a worse failure than the one
 * it prevents. It is a courtesy, not a gate the product depends on.
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
 * Numeric EVM chain id → registry slug.
 *
 * `GET /v1/portfolio` returns `chain_id` as a slug on some chain accounts and as a numeric EVM id
 * on others, in the same response. Comparing raw strings matched the slug entries and silently
 * skipped the numeric ones — so this guard did nothing on exactly the accounts it was written to
 * protect, until both sides were normalized.
 */
const NUMERIC_CHAIN_IDS: Record<string, string> = {
  11155111: 'ethereum-sepolia',
  84532: 'base-sepolia',
  421614: 'arbitrum-sepolia',
  11155420: 'optimism-sepolia',
  80002: 'polygon-amoy',
};

export function normalizeChainId(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  return NUMERIC_CHAIN_IDS[raw] ?? raw;
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
 * Refuse a value-moving intent from an abstract account positively known to be empty.
 *
 * Reads the portfolio directly rather than taking a client, so this stays usable from inside
 * `ExecuteResource`, which holds only an axios instance.
 */
export async function assertFundedForValue(
  http: AxiosInstance,
  params: { identityId: string; chain: string | undefined; amount: unknown },
): Promise<void> {
  if (!params.chain || !movesValue(params.amount)) return;

  let address: string | undefined;
  let balance: string | undefined;
  try {
    const { data } = await http.get('/v1/portfolio', { params: { identity: params.identityId } });
    const want = normalizeChainId(params.chain);
    const identities = (data as {
      identities?: Array<{ chains?: Array<{ chain_id: string; address: string; balances?: Array<{ token?: string; balance: string }> }> }>;
    }).identities ?? [];

    for (const identity of identities) {
      for (const chain of identity.chains ?? []) {
        if (normalizeChainId(chain.chain_id) !== want) continue;
        // The NATIVE balance is what pays for execution. A token balance on the same account does
        // not make the execution leg runnable.
        const native = (chain.balances ?? [])
          .find((b) => !b.token || b.token === 'ETH' || b.token === 'native');
        if (!native) return;
        address = chain.address;
        balance = native.balance;
      }
    }
  } catch {
    // An unavailable portfolio must never block a transaction.
    return;
  }

  if (address === undefined || balance === undefined) return;
  if (Number(balance) > 0) return;

  throw new CertenUnfundedAccountError(address, normalizeChainId(params.chain));
}
