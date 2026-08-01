/**
 * The error catalog, as data.
 *
 * One definition, three consumers: the table in `llms-full.txt`, the table in `docs/errors.md`,
 * and the reconciliation test that checks `retryable` here against `CertenError.isRetryable` in
 * the SDK. Before this existed the doc listed codes with no retry guidance at all, so an agent
 * had to infer the retry decision from the HTTP status — and inferring it wrong on a value
 * transfer is the expensive mistake this whole repo is arranged to prevent.
 *
 * `retryable` MUST equal what `CertenError.isRetryable` computes for the same status. That
 * getter is the implementation; this table is the contract.
 */
export const ERROR_CODES = [
  {
    code: 'BAD_REQUEST',
    status: 400,
    retryable: false,
    meaning: 'The request body or parameters are invalid.',
    fix: 'Fix the request. Retrying an unchanged body produces the same 400 forever.',
  },
  {
    code: 'VALIDATION_ERROR',
    status: 400,
    retryable: false,
    meaning: 'Request body failed schema validation.',
    fix: 'Read `details[]` — it names the offending property and the rule it broke.',
  },
  {
    code: 'UNAUTHORIZED',
    status: 401,
    retryable: false,
    meaning: 'Authentication is missing or invalid.',
    fix: 'Check the X-API-Key header. A missing key and a wrong key both land here.',
  },
  {
    code: 'FORBIDDEN',
    status: 403,
    retryable: false,
    meaning: 'The API key is deactivated, expired, or lacks the required scope.',
    fix: 'Compare the operation\'s required scope against the key. Scopes are listed per operation below.',
  },
  {
    code: 'NOT_FOUND',
    status: 404,
    retryable: false,
    meaning: 'The resource does not exist or is not accessible to this key.',
    fix: 'A spent sign_request_id also 404s. Request fresh signing data rather than resubmitting.',
  },
  {
    code: 'CONFLICT',
    status: 409,
    retryable: false,
    meaning: 'The resource already exists (e.g. duplicate identity name).',
    fix: 'Reuse the existing resource, or choose a different name.',
  },
  {
    code: 'RATE_LIMIT_EXCEEDED',
    status: 429,
    retryable: true,
    meaning: 'Too many requests.',
    fix: 'The SDK already backs off and retries using Retry-After. Do not add a second retry loop.',
  },
  {
    code: 'INTERNAL_ERROR',
    status: 500,
    retryable: true,
    meaning: 'An unexpected server error.',
    fix: 'Safe to retry — the SDK does, up to maxRetries.',
  },
  {
    code: 'BAD_GATEWAY',
    status: 502,
    retryable: true,
    meaning: 'A downstream service (api-bridge, proofs service) returned an error.',
    fix: 'Safe to retry. If it persists, the gateway is degraded, not your request.',
  },
  {
    code: 'NETWORK_ERROR',
    status: 0,
    retryable: true,
    meaning: 'Synthesized by the SDK when the request never reached the gateway, including on timeout.',
    fix: 'Safe to retry ONLY because every POST carries an Idempotency-Key. Do not strip it. '
      + 'If it is a timeout rather than an outage, raise `timeoutMs` instead of retrying.',
  },
];

/**
 * Some errors carry no machine-readable `code` — an edge-level 502 has a `text/plain` body. Since
 * 0.4.0 the SDK maps those to a documented code by status, so `error.code` stays inside this
 * catalog no matter which layer produced the failure. 503 and 504 both report `BAD_GATEWAY`: they
 * mean the same thing to a caller, which is that a downstream service did not answer.
 */
export const STATUS_FALLBACK_NOTE = true;

/** Codes an automated caller may retry without human judgement. */
export const RETRYABLE = ERROR_CODES.filter((e) => e.retryable).map((e) => e.code);
