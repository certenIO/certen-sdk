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

  constructor(
    message: string,
    status: number,
    code: string,
    opts: { requestId?: string; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'CertenError';
    this.status = status;
    this.code = code;
    this.requestId = opts.requestId;
    this.details = opts.details;
  }

  /** True for transient downstream errors that are safe to retry. */
  get isRetryable(): boolean {
    if (this.code === 'NETWORK_ERROR') return true;
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
  static fromAxios(message: string, status: number, code: string, opts?: { requestId?: string; details?: unknown }): CertenError {
    if (status === 401 || status === 403) return new CertenAuthError(message, status, code, opts);
    if (status === 429) return new CertenRateLimitError(message, status, code, opts);
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
