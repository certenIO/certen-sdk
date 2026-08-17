/**
 * Every error code this SDK's release knew about.
 *
 * Vendored deliberately. `spec/errors.json` sits at the monorepo root and is not shipped inside this
 * package, and `doctor` needs a baseline at RUNTIME to notice that the gateway has moved ahead of
 * it. Version skew between a client and a gateway is routine — they deploy separately — and its
 * symptoms are the most misleading on the surface: a call to a path the deployment does not serve
 * 404s, which reads as "wrong URL" until somebody thinks to compare versions.
 *
 * Generated from the vendored catalogue. `packages/sdk/test/error-catalog.test.ts` asserts this list
 * matches it exactly, so the two cannot drift without a test failing.
 */
export const VENDORED_ERROR_CODES: readonly string[] = [
  'BAD_GATEWAY',
  'BAD_REQUEST',
  'BILLING_DISABLED',
  'CHAIN_NOT_PRICEABLE',
  'CHAIN_SUSPENDED',
  'CHAIN_UNRESOLVED',
  'COMMITMENT_EXCEEDED',
  'CONFLICT',
  'ENTITLEMENT_UNAVAILABLE',
  'FORBIDDEN',
  'FX_UNAVAILABLE',
  'IDEMPOTENCY_KEY_IN_FLIGHT',
  'IDEMPOTENCY_KEY_MISMATCH',
  'INSUFFICIENT_BALANCE',
  'INTERNAL_ERROR',
  'LEDGER_ACCOUNT_NOT_LOCKED',
  'LEDGER_MISSING_ORG',
  'LEDGER_NEGATIVE_HOLD',
  'LEDGER_UNBALANCED',
  'LEDGER_UNEXPECTED_ORG',
  'LEDGER_ZERO_LEG',
  'LOG_DIVERGENCE',
  'NOT_FOUND',
  'NO_PRICE_BOOK',
  'PAYMENT_REQUIRED',
  'PLAN_QUOTA_EXCEEDED',
  'QUOTE_EXPIRED',
  'QUOTE_MISMATCH',
  'RATE_LIMIT_EXCEEDED',
  'RECEIPT_COMPUTATION_MISMATCH',
  'RECEIPT_KEY_NOT_REGISTERED',
  'RECEIPT_KEY_UNAVAILABLE',
  'SCHEMA_CONSTRAINT',
  'SERVICE_TOKEN_UNCONFIGURED',
  'SHARE_NO_LONGER_VALID',
  'SLOW_DOWN',
  'TIMESTAMP_SERVICE_UNAVAILABLE',
  'TOO_MANY_REQUESTS',
  'UNAUTHORIZED',
  'VALIDATION_ERROR',
];
