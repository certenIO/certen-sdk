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
  {
    code: 'INTENT_FAILED',
    status: 0,
    retryable: false,
    meaning: 'Raised by `execute.wait()` when the intent reached `failed` or `expired`: the gateway answered, and its answer was that the intent will not execute. `reasonCode` says why.',
    fix: 'Branch on `reasonCode` (`expired` wants a new intent, `target_reverted` is a business outcome, `expectation_unmet` wants the target investigated). Do not retry the same intent.',
  },
  {
    code: 'WAIT_TIMEOUT',
    status: 0,
    retryable: false,
    meaning: 'Raised by `execute.wait()` when time ran out before the intent reached the state it was waiting for. Neither success nor failure: the intent may still complete. `lastStatus` and `lastClass` say what the last poll saw.',
    fix: 'Wait again or read the intent with `transaction.get`; do not open a second intent. `lastClass` of `executed` means the action ran and its proof is still being produced.',
  },
  {
    code: 'PROOF_NOT_ASSIGNED',
    status: 0,
    retryable: false,
    meaning: 'Raised by `execute.proof()` when the intent has neither a proof id nor an Accumulate transaction hash. `reason` is `proof_pending` (executed; the proof is still being produced), `execution_proof_unavailable` (executed; the proof can never be produced) or `not_assigned`.',
    fix: '`proof_pending`: ask again later. `execution_proof_unavailable`: there is nothing to wait for. `not_assigned`: the intent has not reached a state that has a proof yet.',
  },
  {
    code: 'FOREIGN_ORIGIN_URL',
    status: 0,
    retryable: false,
    meaning: 'The client refused to send a request to a url outside its own gateway\'s origin, before anything was sent: a `submit_url` in a response, a request url, or a redirect that named another host. `details` carries `url`, `baseUrl` and `source`.',
    fix: 'Do not follow it. A gateway response that names another host is misconfigured or has been tampered with; nothing was signed or sent and no credential left the process. Check the base url and the gateway before retrying.',
  },
  {
    code: 'INVALID_PATH_PARAMETER',
    status: 0,
    retryable: false,
    meaning: 'An id, hash or token passed to a call was empty, not text or a number, or made only of dots, so it cannot name one resource. Raised before any request is sent.',
    fix: 'Pass the real id. The SDK encodes every id as a single path segment; it refuses an empty one rather than requesting a different route (identity.get("") would have listed identities).',
  },
  {
    code: 'PROOF_V2_EVIDENCE_NOT_SERVED',
    status: 0,
    retryable: false,
    meaning: "The gateway serves no proof v2 document for this proof (a 404 or 501 on GET /v1/proof/{id}/v2), so the Accumulate side of the proof cannot be checked locally.",
    fix: "Nothing about the proof is wrong. Verify against a gateway that serves the document, or read Accumulate and the destination chain yourself. Never treat the gateway's own flag as verification.",
  },
  {
    code: 'SIGNING_DATA_MISMATCH',
    status: 0,
    retryable: false,
    meaning: "Refused to sign: the transaction the gateway returned does not hash to what it sent, or is not what was asked for. details.field names the difference.",
    fix: "Do not sign. The gateway or something between you and it returned a transaction other than the one you asked for; report it.",
  },
  {
    code: 'SIGNING_DATA_ABSENT',
    status: 0,
    retryable: false,
    meaning: "Refused to sign: the gateway returned no unsigned transaction or signature metadata to check.",
    fix: "Use a gateway that returns signing_data.transaction and signing_data.signature_metadata. There is no option to sign without them.",
  },
  {
    code: 'SIGNING_VERIFIER_UNAVAILABLE',
    status: 0,
    retryable: false,
    meaning: "Refused to sign: @certen.io/proof-verify, which checks what a gateway asks you to sign, is not installed or cannot load.",
    fix: "npm install @certen.io/proof-verify. In a browser, signing through the SDK is refused until the verifier runs there.",
  },
  {
    code: 'SIGNING_EXPECTATION_UNAVAILABLE',
    status: 0,
    retryable: false,
    meaning: "Refused to sign: the SDK cannot state what this request must produce (a token transfer, a tuple argument, a chain outside the catalogue, or a governance operation with no verifier), so it cannot check the transaction.",
    fix: "Use a request the SDK can describe, or verify the transaction yourself with verifySigningData and sign the hash outside the SDK.",
  },
  {
    code: 'SIGNING_DECLINED',
    status: 0,
    retryable: false,
    meaning: "The beforeSign callback returned false after reading what the signature would authorise, so nothing was signed.",
    fix: "Nothing to fix; this is the caller declining.",
  },
  {
    code: 'PAYMENT_REQUIRED',
    status: 402,
    retryable: false,
    meaning: 'The balance does not cover this work. Nothing was charged and no work was started.',
    fix: 'The body carries a binding quote and a live payment target. Send exactly `resolve.amount_usd` to `resolve.to_address`, then retry with `quote_id` before `quote_expires_at`. Retrying without paying returns the same 402.',
  },
  {
    code: 'INSUFFICIENT_BALANCE',
    status: 402,
    retryable: false,
    meaning: 'The ledger refused the charge for lack of funds.',
    fix: 'Add funds. Gate on `remaining_usd` from the balance, not `spendable_usd` — the latter ignores work already committed.',
  },
  {
    code: 'COMMITMENT_EXCEEDED',
    status: 402,
    retryable: false,
    meaning: 'The balance covers this request but not everything already promised. Multi-signature intents charge when quorum is reached, which can be weeks after they were opened.',
    fix: 'Read `billing.obligations()` to see which pending intents claimed the balance, or add funds.',
  },
  {
    code: 'QUOTE_EXPIRED',
    status: 409,
    retryable: false,
    meaning: 'The quote passed its expiry before the work was submitted.',
    fix: 'Request a new quote and retry with it. Quotes are free.',
  },
  {
    code: 'QUOTE_MISMATCH',
    status: 409,
    retryable: false,
    meaning: 'The quote does not describe the work being submitted — a different chain, sku, or leg count.',
    fix: 'Quote the work you are actually about to do, then pass that `quote_id`.',
  },
  {
    code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
    status: 409,
    retryable: true,
    meaning: 'An identical request with this Idempotency-Key is still running.',
    fix: 'Wait and retry with the SAME key. A new key would perform the work a second time.',
  },
  {
    code: 'IDEMPOTENCY_KEY_MISMATCH',
    status: 409,
    retryable: false,
    meaning: 'This Idempotency-Key was already used with a different request body.',
    fix: 'A key binds to one request. Use a new key, or resend the original body unchanged.',
  },
  {
    code: 'SHARE_NO_LONGER_VALID',
    status: 410,
    retryable: false,
    meaning: 'The share link was real and is now revoked, expired, or out of views.',
    fix: 'Ask the sender for a fresh link. This does NOT mean the proof does not exist.',
  },
  {
    code: 'PLAN_QUOTA_EXCEEDED',
    status: 429,
    retryable: false,
    meaning: 'A plan limit for the period is exhausted — a quota, not a per-second rate.',
    fix: 'Waiting will not clear this within the period. Raise the plan limit.',
  },
  {
    code: 'TOO_MANY_REQUESTS',
    status: 429,
    retryable: true,
    meaning: 'Generic throttle.',
    fix: 'Wait for the `Retry-After` header. The SDK honours it automatically.',
  },
  {
    code: 'SLOW_DOWN',
    status: 429,
    retryable: true,
    meaning: 'Polling the device-authorization flow faster than it allows.',
    fix: 'Increase the poll interval to the value the flow published.',
  },
  {
    code: 'CHAIN_UNRESOLVED',
    status: 400,
    retryable: false,
    meaning: 'The chain identifier could not be resolved to a deployment.',
    fix: 'List valid chains with `chains.list()`.',
  },
  {
    code: 'HEADER_AUTHORITY_NOT_EXECUTABLE',
    status: 422,
    retryable: false,
    meaning: 'The intent names `additional_authorities`, which the gateway refuses by default: validators do not yet execute intents carrying header authorities.',
    fix: 'Remove `additional_authorities`. Make a required co-signer an authority on the ACCOUNT instead (governance `add_authority`), or have it accept in a separate transaction first.',
  },
  {
    code: 'ADDITIONAL_AUTHORITIES_INVALID',
    status: 400,
    retryable: false,
    meaning: '`additional_authorities` is not a list of at most 8 `acc://` key book URLs, or its two spellings (top level and `intent.additionalAuthorities`) disagree. The message names the entry.',
    fix: 'Fix the list: at most 8 `acc://` key book URLs, sent under one spelling or with both identical.',
  },
  {
    code: 'ADDITIONAL_AUTHORITY_IS_PRINCIPAL_BOOK',
    status: 400,
    retryable: false,
    meaning: '`additional_authorities` names the principal ADI\'s own key book, which already authorizes the intent through its account.',
    fix: 'Remove it. List only OTHER parties whose signature this transaction also needs.',
  },
  {
    code: 'CHAIN_NOT_ENABLED',
    status: 422,
    retryable: false,
    meaning: 'The chain is in the CERTEN network catalogue but this gateway has not enabled it, so it is neither served, quoted nor linkable.',
    fix: 'Use a chain listed by `chains.list()`. Retrying cannot enable it: that is an operator decision.',
  },
  {
    code: 'EXPIRES_AT_INVALID',
    status: 400,
    retryable: false,
    meaning: '`expires_at` is not an RFC 3339 date-time with a timezone, or its two spellings disagree.',
    fix: 'Send e.g. `2026-09-14T12:00:00Z`.',
  },
  {
    code: 'EXPIRES_AT_OUT_OF_RANGE',
    status: 400,
    retryable: false,
    meaning: '`expires_at` is in the past, too soon, or too far ahead. The message states the accepted window.',
    fix: 'Send a deadline inside the window the message names.',
  },
  {
    code: 'INTENT_EXPIRED',
    status: 409,
    retryable: false,
    meaning: 'The intent passed its `expires_at` before it was signed, so it can no longer complete. It is now failed with `reason_code` `expired` and nothing was charged.',
    fix: 'Create a new intent, with a later `expires_at` if the signers need more time.',
  },
  {
    code: 'UNKNOWN_CHAIN',
    status: 400,
    retryable: false,
    meaning: 'No chain by that name is served. It never becomes valid on retry. The message names the closest match when there is one.',
    fix: 'Use the closest match the message names, or list valid chains with `chains.list()`.',
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
