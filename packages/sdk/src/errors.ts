/**
 * Error taxonomy. `CertenError.code` mirrors the gateway's response.code
 * field; callers can switch on it for typed retries / user-visible
 * messages.
 */
export class CertenError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId?: string;
  public readonly details?: unknown;
  /**
   * The gateway's parsed response body, when it sent one.
   *
   * Kept because some refusals carry the FIX and not just the diagnosis: a 402
   * arrives with a live payment target, and discarding the body left the caller
   * holding a message string. Undefined when the body was not JSON (an edge 502,
   * an HTML error page) and when there was no response at all.
   */
  public readonly body?: unknown;

  constructor(
    message: string,
    status: number,
    code: string,
    opts: { requestId?: string; details?: unknown; body?: unknown } = {},
  ) {
    super(message);
    this.name = 'CertenError';
    this.status = status;
    this.code = code;
    this.requestId = opts.requestId;
    this.details = opts.details;
    this.body = opts.body;
  }

  /**
   * True when repeating this identical request can eventually succeed on its own.
   *
   * Status alone gets two cases wrong, and both are decided by the CODE:
   *
   * - `IDEMPOTENCY_KEY_IN_FLIGHT` is a 409, which status-wise reads as "do not retry" — but the
   *   whole point of that code is that an identical request is already running, and retrying the
   *   SAME key is precisely the correct response. Treating it as terminal fails a request that
   *   would have succeeded a moment later.
   * - `PLAN_QUOTA_EXCEEDED` is a 429, which reads as "back off and retry" — but it is a quota for
   *   the billing period, not a per-second rate. No amount of backing off clears it, so retrying
   *   only burns the attempts a genuinely transient failure would need.
   */
  get isRetryable(): boolean {
    if (this.code === 'NETWORK_ERROR') return true;
    // Code beats status, in both directions.
    if (this.code === 'IDEMPOTENCY_KEY_IN_FLIGHT') return true;
    if (this.code === 'PLAN_QUOTA_EXCEEDED') return false;
    if (this.status >= 500 && this.status < 600) return true;
    if (this.status === 429) return true;
    if (this.status === 408) return true;
    return false;
  }

  /** True for client-side input mistakes. Never auto-retry these. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }

  /** Convenience: standard error subclasses surface by status. */
  static fromAxios(
    message: string,
    status: number,
    code: string,
    opts?: { requestId?: string; details?: unknown; body?: unknown },
  ): CertenError {
    if (status === 401 || status === 403) return new CertenAuthError(message, status, code, opts);
    if (status === 429) return new CertenRateLimitError(message, status, code, opts);
    // Before the generic 4xx branch: a payment problem is not a malformed request,
    // and a host product needs to tell those apart to know whether to show a
    // "top up" prompt or a validation message.
    if (status === 402) return new CertenPaymentRequiredError(message, status, code, opts);
    if (status >= 500) return new CertenServerError(message, status, code, opts);
    if (status >= 400) return new CertenBadRequestError(message, status, code, opts);
    return new CertenError(message, status, code, opts);
  }
}

export class CertenAuthError extends CertenError {}
export class CertenRateLimitError extends CertenError {
  /** Reset window in seconds when the gateway sent Retry-After. */
  get retryAfterSec(): number | undefined {
    const v = (this.details as { retryAfter?: number } | undefined)?.retryAfter;
    return typeof v === 'number' ? v : undefined;
  }
}
export class CertenBadRequestError extends CertenError {}
export class CertenServerError extends CertenError {}

/** A live way to settle a 402, minted by the gateway with the refusal. */
export interface PaymentResolution {
  /** Reference the deposit is matched by. */
  payment_intent: string;
  chain: string;
  to_address: string;
  /** Send EXACTLY this. Attribution matches the amount, so a different one will not credit. */
  amount_usd: string;
  expires_at: string;
  /** True when an already-open payment covered the shortfall and was reused. */
  reused_existing: boolean;
  portal_url: string;
  cli_command: string;
  note: string;
}

/**
 * The account cannot pay for this work. HTTP 402.
 *
 * Distinct from `CertenBadRequestError` because nothing is wrong with the request
 * — it is priced, valid, and would succeed once funded. A host product needs that
 * distinction to decide between showing a top-up prompt and showing a validation
 * error.
 *
 * Two codes arrive here and they need different remedies:
 *
 *   PAYMENT_REQUIRED     the balance does not cover this request. Add funds.
 *   COMMITMENT_EXCEEDED  the balance would cover this request alone, but pending
 *                        intents have already claimed it. Add funds OR wait for
 *                        those to settle or expire — see `pendingIntents`.
 *
 * Never retried automatically, and never should be: the outcome cannot change
 * until money moves, so a retry loop is just load.
 *
 * `resolution` is null when the gateway could not mint a target (no chain
 * configured for deposits, for instance). The refusal is still valid; there is
 * simply no one-step fix to offer, so fall back to `portalUrl` on your own UI.
 */
export class CertenPaymentRequiredError extends CertenError {
  private get payload(): Record<string, unknown> {
    return (typeof this.body === 'object' && this.body !== null)
      ? this.body as Record<string, unknown>
      : {};
  }

  private nested(key: string): Record<string, unknown> {
    const v = this.payload[key];
    return (typeof v === 'object' && v !== null) ? v as Record<string, unknown> : {};
  }

  private str(obj: Record<string, unknown>, key: string): string | undefined {
    const v = obj[key];
    return typeof v === 'string' ? v : undefined;
  }

  /** True when pending commitments, not the raw balance, caused the refusal. */
  get isCommitmentExceeded(): boolean {
    return this.code === 'COMMITMENT_EXCEEDED';
  }

  /** How much more is needed, as a fixed-6dp decimal string. */
  get shortfallUsd(): string | undefined {
    return this.str(this.nested('balance'), 'shortfall_usd')
      ?? this.str(this.nested('commitments'), 'shortfall_usd');
  }

  get spendableUsd(): string | undefined {
    return this.str(this.nested('balance'), 'spendable_usd');
  }

  /** Non-terminal intents that have already claimed balance. Commitment case only. */
  get pendingIntents(): number | undefined {
    const v = this.nested('commitments').pending_intents;
    return typeof v === 'number' ? v : undefined;
  }

  /** Re-send the request with this to reuse the price you were quoted. */
  get quoteId(): string | undefined {
    return this.str(this.nested('quote'), 'id');
  }

  /** After this, the quoted price is gone and the work must be re-quoted. */
  get quoteExpiresAt(): string | undefined {
    return this.str(this.nested('quote'), 'expires_at')
      ?? this.str(this.payload, 'quote_expires_at');
  }

  /** The payment target, or null when the gateway could not offer one. */
  get resolution(): PaymentResolution | null {
    const r = this.payload.resolve;
    if (typeof r !== 'object' || r === null) return null;
    const o = r as Record<string, unknown>;
    return typeof o.payment_intent === 'string' ? (r as PaymentResolution) : null;
  }

  /** Deep link for your own UI to send the customer to. */
  get portalUrl(): string | undefined {
    return this.resolution?.portal_url;
  }

  /** The exact command that settles this from a terminal. */
  get cliCommand(): string | undefined {
    return this.resolution?.cli_command;
  }

  /**
   * One line fit to show a person, whichever code arrived.
   *
   * Provided so every host product does not re-derive the same sentence, and get
   * the commitment case wrong by telling the customer to add funds when waiting
   * would also work.
   */
  get summary(): string {
    const short = this.shortfallUsd;
    if (this.isCommitmentExceeded) {
      const n = this.pendingIntents;
      return `Pending work has already claimed this balance${n ? ` (${n} intent${n === 1 ? '' : 's'})` : ''}`
        + `${short ? `, leaving ${short} USD short` : ''}. Add funds, or wait for it to settle.`;
    }
    return short
      ? `Not enough funds: ${short} USD short of this request.`
      : 'Not enough funds for this request.';
  }
}
