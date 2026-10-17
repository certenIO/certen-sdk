import { randomUUID } from 'node:crypto';
import {
  CertenClient, evmAddressProblem, nativeSymbolFor, wholeUnitAmountProblem,
  type TransactionIntent, type TransactionQuoteResponse,
} from '@certen.io/sdk';
import { UsageError } from './errors.js';
import { dollars, printable } from './gateway-text.js';

/**
 * The gateway's ESTIMATE of an intent: what admission would price it at and whether it would be admitted, asked of `POST /v1/transaction/quote`.
 *
 * **An estimate, and every line of it says so.** The route creates, charges and signs nothing and promises nothing: no quote id comes back, balances
 * move, a chain can be suspended, and it lists the gates it did NOT look at. The CLI never shows its figure without those lists, and never calls
 * it a price.
 *
 * **It can never block or change a send.** `fetchEstimate` does not throw. A gateway without the route, one that is slow, one that answers with
 * something that is not an estimate, a refusal of the intent: each becomes "unavailable" with a reason, and `certen send` carries on exactly as it
 * did before this existed. The send's own checks (readiness, the signing check, the confirmation) are the ones that decide anything.
 */

/** How long a send waits for the estimate. It is a convenience on the card, so it gets a short leash and no retries. */
export const ESTIMATE_TIMEOUT_MS = 10_000;

export type Estimate =
  | { state: 'available'; quote: TransactionQuoteResponse }
  | { state: 'unavailable'; code: string; reason: string };

/**
 * The shared checks of a native transfer that `send` and `quote` both make without the network: the amount, and the recipient. Throws the usage
 * errors `send` has always thrown, with the same words.
 */
export function assertTransferInputs(amount: string, to: string): void {
  const amountProblem = wholeUnitAmountProblem(amount);
  if (amountProblem) throw new UsageError(amountProblem, 'INVALID_AMOUNT');
  if (!/[1-9]/.test(amount)) throw new UsageError('The amount must be greater than zero.', 'INVALID_AMOUNT');
  const addressProblem = evmAddressProblem(to);
  if (addressProblem) throw new UsageError(`--to: ${addressProblem}`, 'INVALID_ADDRESS');
}

/**
 * The native symbol a transfer on `chain` moves, or a usage error: a chain whose token this client does not know, or an asset that is not it.
 * A mismatch is refused and never guessed ("ETH" on a TEL chain is not sent as TEL), and a token is not sent at all: what a token transfer moves
 * (the token contract and its decimals) is chosen downstream, so it cannot be checked before signing.
 */
export function nativeAssetFor(chain: string, asset: string, amount: string, to: string): string {
  const symbol = nativeSymbolFor(chain);
  if (!symbol) {
    throw new UsageError(`${chain} is not a chain this client knows the native token of, so what a transfer there moves cannot be checked before signing.`, 'UNSUPPORTED_CHAIN');
  }
  if (asset.trim().toUpperCase() !== symbol.toUpperCase()) {
    throw new UsageError(
      `${chain} moves ${symbol}, and you asked to send ${asset}. certen send moves a chain's native token only: what a token transfer moves (the token contract and `
      + 'its decimals) is chosen downstream, so it cannot be checked before signing, and nothing is signed that cannot be checked. '
      + `To send ${symbol}: certen send ${amount} ${symbol} --to ${to}. For a token, certen call with its transfer(address,uint256) shows exactly what it will call.`,
      'UNSUPPORTED_ASSET',
    );
  }
  return symbol;
}

/**
 * The intent `certen send` opens for a native transfer, field for field.
 *
 * It mirrors what the SDK's `execute.send` builds, because the estimate is only worth showing if it is an estimate of THAT request. That includes
 * what it leaves out: `send` validates the asset against the chain's native symbol but does not put a `tokenSymbol` in the intent (a native transfer
 * has none), so neither does this. The test that pins it runs a real send against the fake gateway and compares the intent it submitted with the one
 * quoted (everything but the per-call id and time), so a change in one cannot leave the other behind.
 */
export function transferIntent(p: { adiUrl: string; chain: string; fromAddress: string; toAddress: string; amount: string }): TransactionIntent {
  return {
    adiUrl: p.adiUrl,
    id: randomUUID(),
    initiatedBy: p.adiUrl,
    timestamp: Date.now(),
    fromChain: 'accumulate',
    toChain: p.chain,
    fromAddress: p.fromAddress,
    toAddress: p.toAddress,
    amount: p.amount,
  };
}

/** The client that asks for an estimate: the same credential and gateway, one attempt, a short timeout. */
export function estimateClient(apiKey: string, baseUrl: string): CertenClient {
  return new CertenClient({ apiKey, baseUrl, maxRetries: 0, timeoutMs: ESTIMATE_TIMEOUT_MS });
}

/** Ask for the estimate. Never throws: whatever goes wrong is "unavailable", with a reason a person can read. */
export async function fetchEstimate(client: CertenClient, intent: TransactionIntent, proofClass?: 'on_demand' | 'on_cadence'): Promise<Estimate> {
  try {
    const quote = await client.transaction.quote({ intent, ...(proofClass ? { proofClass } : {}) });
    // Only the gateway's own statement that this is an estimate is taken as one: a body that does not say so is not shown as a figure.
    if (!quote || typeof quote !== 'object' || quote.estimate !== true) {
      return { state: 'unavailable', code: 'ESTIMATE_UNREADABLE', reason: 'the gateway answered, but not with an estimate' };
    }
    return { state: 'available', quote };
  } catch (err) {
    const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'ESTIMATE_FAILED';
    if (code === 'ENDPOINT_NOT_ON_GATEWAY') return { state: 'unavailable', code, reason: 'this gateway does not serve the estimate route (it is older than this CLI)' };
    if (code === 'NETWORK_ERROR') return { state: 'unavailable', code, reason: 'the gateway did not answer the estimate in time' };
    const message = err instanceof Error ? err.message.replace(/^certen: /, '') : String(err);
    return { state: 'unavailable', code, reason: `${code}: ${printable(message, 160)}` };
  }
}

const list = (items: unknown): string => (Array.isArray(items) && items.length > 0 ? items.map((x) => printable(x, 80)).join(', ') : 'nothing listed');

/** What the gateway's price and funds sections say, in one or two sentences that do not claim more than they state. */
function priceLines(q: TransactionQuoteResponse): string[] {
  const b = q.billing ?? {};
  if (b.state === 'disabled') return ['billing is off on this gateway: nothing is priced'];
  if (b.state === 'not_gated') return ['this operation is not priced'];
  if (b.state !== 'priced') return [`billing state ${printable(b.state) || 'not given'}: no price`];

  const p = b.price ?? {};
  const out: string[] = [];
  out.push(p.total_usd === undefined
    ? 'priced, but the gateway gave no figure'
    : `about ${dollars(p.total_usd)} to open this now (platform fee ${dollars(p.platform_fee_usd)} + gas ${dollars(p.gas_usd)}; capped at ${dollars(p.max_total_usd)})`);

  const f = b.funds ?? {};
  if (f.state === 'unreadable') {
    out.push('your gateway balance could not be read, so whether it covers this is not known');
  } else if (f.covered === true) {
    out.push(`your gateway balance covers it (remaining ${dollars(f.remaining_usd)})`);
  } else if (f.covered === false) {
    const refused = f.gate && f.gate !== 'passes' ? ` and admission would answer ${printable(f.gate, 40)} now` : b.enforcing === false ? ' (this gateway records a shortfall without refusing it)' : '';
    out.push(`your gateway balance does NOT cover it: short by ${dollars(f.shortfall_usd)}${refused}`);
  }
  return out;
}

/**
 * The estimate as lines, for the confirmation card, the dry run and `certen quote`. The caveat and both lists are part of it every time: a figure
 * on its own would read as a price.
 */
export function estimateLines(estimate: Estimate): string[] {
  if (estimate.state === 'unavailable') return [`unavailable: ${estimate.reason}. Sending is not affected.`];
  const q = estimate.quote;
  return [
    ...priceLines(q),
    `AN ESTIMATE as of ${printable(q.evaluated_at, 40) || 'an unstated time'}: it creates, charges and signs nothing, and promises nothing`,
    `checked: ${list(q.checked)}`,
    `NOT checked: ${list(q.not_checked)}`,
  ];
}

/** The estimate for a machine: the gateway's body when there is one, and otherwise the reason there is not. Additive to an envelope. */
export function estimateJson(estimate: Estimate): { estimate: TransactionQuoteResponse | null; estimate_unavailable?: { code: string; reason: string } } {
  return estimate.state === 'available'
    ? { estimate: estimate.quote }
    : { estimate: null, estimate_unavailable: { code: estimate.code, reason: estimate.reason } };
}
