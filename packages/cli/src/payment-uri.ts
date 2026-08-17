/**
 * Turning a payment target into something a wallet can consume, and a wait into something a person
 * can plan around.
 *
 * Funding asked someone to carry four values from a terminal into a wallet by hand: a token
 * contract, a chain, a treasury address and an exact amount. **A mistyped recipient is the one
 * error in this product that loses real money and cannot be reversed** — no retry, no support
 * ticket, no proof to appeal to.
 *
 * Isolated in its own module because both functions here are pure arithmetic over values the
 * gateway supplied, and both are wrong in ways that are invisible on screen: an off-by-one decimal
 * looks like a plausible number, and a wait estimate that is silently zero looks like a fast chain.
 */

/**
 * What the gateway sends back when a payment is opened. Only the fields a URI needs.
 *
 * Deliberately structural rather than importing the SDK type: this module must be callable with
 * exactly the gateway's own values and nothing reformatted on the way in.
 */
export interface PaymentTargetFields {
  chain_id: number;
  token_address: string;
  token_decimals: number;
  deposit_address: string;
}

/**
 * Convert a decimal amount string into the token's smallest unit, exactly.
 *
 * String arithmetic, not `Number(amount) * 10 ** decimals`. That expression is wrong for values
 * this function will certainly see: `25.10 * 1e6` is `25099999.999999996` in IEEE-754, which
 * truncates to 25099999 — a payment one unit short of the amount attribution matches on, so the
 * deposit is received and never credited. The failure is silent on both sides.
 *
 * Throws rather than rounding when the amount carries more precision than the token can express.
 * Quietly dropping a digit would change what the user pays.
 */
export function toSmallestUnit(amount: string, decimals: number): string {
  const clean = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) {
    throw new Error(`"${amount}" is not a positive decimal amount.`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`${decimals} is not a usable token decimal count.`);
  }

  const [whole, fraction = ''] = clean.split('.');
  if (fraction.length > decimals) {
    // Only ever raised by trailing zeros beyond the token's precision, which are safe to drop —
    // anything else would silently alter the amount.
    const significant = fraction.slice(decimals).replace(/0+$/, '');
    if (significant.length > 0) {
      throw new Error(
        `${amount} has more precision than this token supports (${decimals} decimals). `
        + 'Rounding it would change what you pay.',
      );
    }
  }

  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  // BigInt, so a large amount cannot lose its low digits the way a float would.
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
  return units.toString();
}

/**
 * Build an EIP-681 payment request for an ERC-20 transfer.
 *
 * `ethereum:<token>@<chainId>/transfer?address=<recipient>&uint256=<amount>`
 *
 * The shape is counter-intuitive and worth stating: the address BEFORE the `@` is the **token
 * contract**, and the recipient is the `address` parameter. Reversing them produces a URI that a
 * wallet will happily open and that transfers nothing — or, worse, calls an unknown method on the
 * treasury address.
 *
 * Every value comes from the gateway's response untouched. Nothing here re-derives a chain id from
 * a slug or re-formats an address, because that is precisely the transcription this exists to
 * eliminate.
 */
export function buildPaymentUri(target: PaymentTargetFields, amountUsd: string): string {
  for (const [name, value] of Object.entries({
    token_address: target.token_address,
    deposit_address: target.deposit_address,
  })) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(value ?? ''))) {
      throw new Error(`${name} is not an address: ${String(value)}`);
    }
  }
  if (!Number.isInteger(target.chain_id) || target.chain_id <= 0) {
    throw new Error(`chain_id is not a numeric EVM chain id: ${String(target.chain_id)}`);
  }

  const units = toSmallestUnit(amountUsd, target.token_decimals);
  return `ethereum:${target.token_address}@${target.chain_id}`
    + `/transfer?address=${target.deposit_address}&uint256=${units}`;
}

/**
 * Seconds per block, for turning a confirmation count into a wait somebody can plan around.
 *
 * Approximate on purpose, and every caller must present the result as an estimate. These are the
 * observed cadences of the testnets this CLI targets; an L2 that batches will occasionally be much
 * faster or much slower than its nominal block time.
 */
const BLOCK_SECONDS: Record<string, number> = {
  'ethereum-sepolia': 12,
  'base-sepolia': 2,
  'arbitrum-sepolia': 0.25,
};

export interface WaitEstimate {
  seconds: number;
  /** Rendered for a person: `about 24 seconds`, `about 2 minutes`. */
  text: string;
  /** The chain whose cadence produced this, so the estimate is checkable rather than magic. */
  basis: string;
}

/**
 * How long `min_confirmations` is likely to take on this chain.
 *
 * Returns null for a chain with no known cadence rather than guessing. A wrong estimate on the
 * command someone is already waiting on is worse than no estimate: it is the number they decide to
 * interrupt against, and interrupting a funding flow is how people send twice.
 */
export function estimateWait(chain: string, confirmations: number): WaitEstimate | null {
  const perBlock = BLOCK_SECONDS[chain];
  if (perBlock === undefined) return null;
  if (!Number.isFinite(confirmations) || confirmations <= 0) return null;

  const seconds = Math.max(1, Math.round(perBlock * confirmations));
  return { seconds, text: humanDuration(seconds), basis: chain };
}

/** `95` -> `about 2 minutes`. Coarse by design: false precision reads as a promise. */
export function humanDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `about ${s} second${s === 1 ? '' : 's'}`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * `252` -> `4m 12s`. Exact, unlike `humanDuration`.
 *
 * Used for a quote's remaining validity, where the caller is deciding whether to act NOW and a
 * rounded "about 4 minutes" on a quote with 20 seconds left would be actively misleading.
 */
export function preciseDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  const rest = s % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}
