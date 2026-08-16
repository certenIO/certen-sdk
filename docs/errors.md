# Error Handling

All error responses from the CERTEN Gateway API follow a consistent format and use standard HTTP status codes.

## Error Response Format

```json
{
  "error": "Human-readable error message",
  "code": "MACHINE_READABLE_CODE"
}
```

Validation errors include additional detail:

```json
{
  "error": "Validation error",
  "code": "VALIDATION_ERROR",
  "details": [
    {
      "keyword": "required",
      "params": { "missingProperty": "name" },
      "message": "must have required property 'name'"
    }
  ]
}
```

## Error Codes

The `Retryable` column is the contract. `CertenError.isRetryable` implements it, the CLI's `--json`
envelope reports it as `error.retryable`, and `packages/sdk/test/error-catalog.test.ts` fails if this
table, that getter, and the shared catalog in `tools/agentgen/lib/errors.mjs` ever disagree.

**Retry only the codes marked yes.** Every other code is a condition that will not change on its own,
so retrying it just burns attempts. The SDK already retries the retryable ones with exponential
backoff — a second retry loop wrapped around it is wrong.

| Code | HTTP Status | Retryable | Description |
|------|-------------|-----------|-------------|
| `BAD_REQUEST` | 400 | no | The request body or parameters are invalid |
| `VALIDATION_ERROR` | 400 | no | Request body failed schema validation |
| `UNAUTHORIZED` | 401 | no | Authentication is missing or invalid |
| `FORBIDDEN` | 403 | no | The API key is deactivated, expired, or lacks permission |
| `NOT_FOUND` | 404 | no | The requested resource does not exist or is not accessible |
| `CONFLICT` | 409 | no | The resource already exists (e.g., duplicate identity name) |
| `RATE_LIMIT_EXCEEDED` | 429 | yes | Too many requests; the SDK backs off and retries using `Retry-After` |
| `CHAIN_UNRESOLVED` | 400 | no | The chain identifier could not be resolved to a deployment |
| `PAYMENT_REQUIRED` | 402 | no | The balance does not cover this work; nothing was charged and no work started |
| `INSUFFICIENT_BALANCE` | 402 | no | The ledger refused the charge for lack of funds |
| `COMMITMENT_EXCEEDED` | 402 | no | The balance is already promised to pending intents awaiting quorum |
| `QUOTE_EXPIRED` | 409 | no | The quote expired before the work was submitted; request a new one |
| `QUOTE_MISMATCH` | 409 | no | The quote describes different work than what was submitted |
| `IDEMPOTENCY_KEY_IN_FLIGHT` | 409 | yes | An identical request with this key is still running; retry the SAME key |
| `IDEMPOTENCY_KEY_MISMATCH` | 409 | no | This key was already used with a different body; use a new key |
| `SHARE_NO_LONGER_VALID` | 410 | no | The share link was real and is now revoked, expired, or out of views |
| `PLAN_QUOTA_EXCEEDED` | 429 | no | A plan quota for the period is exhausted; waiting will not clear it |
| `TOO_MANY_REQUESTS` | 429 | yes | Generic throttle; wait for `Retry-After` |
| `SLOW_DOWN` | 429 | yes | Polling the device-authorization flow faster than it allows |
| `INTERNAL_ERROR` | 500 | yes | An unexpected server error occurred |
| `BAD_GATEWAY` | 502 | yes | A downstream service (api-bridge, proofs service) returned an error |
| `NETWORK_ERROR` | — | yes | Synthesized by the SDK when the request never reached the gateway |

`NETWORK_ERROR` is safe to retry **only** because every POST carries an `Idempotency-Key`. Without
one, a retried network error can open a second intent — on a value transfer, that means paying twice.
Do not disable `autoIdempotencyKey`. It also covers timeouts: if a call is slow rather than failing,
raise `timeoutMs` on the client instead of retrying.

**Errors without a `code`.** Some failures do not come from the gateway application — an edge-level
502 has a `text/plain` body and no `code` field. Since SDK 0.4.0 those are mapped to a documented
code by HTTP status (`502`/`503`/`504` → `BAD_GATEWAY`, `500` → `INTERNAL_ERROR`, and so on), so
`error.code` stays inside this table whichever layer failed. A `code` the gateway actually sends
always wins. Before 0.4.0 every edge 502 reported `UNKNOWN_ERROR`, so code branching on
`BAD_GATEWAY` never matched.

## HTTP Status Code Summary

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 201 | Resource created |
| 400 | Bad request / validation error |
| 401 | Authentication required |
| 403 | Access denied |
| 404 | Not found |
| 409 | Conflict |
| 429 | Rate limited |
| 500 | Internal server error |
| 502 | Bad gateway (downstream failure) |

## Common Scenarios

### Missing API Key

```
HTTP 401
{ "error": "Missing X-API-Key header" }
```

### Invalid Request Body

```
HTTP 400
{ "error": "identity_id is required", "code": "BAD_REQUEST" }
```

### Resource Not Found

```
HTTP 404
{ "error": "Identity not found", "code": "NOT_FOUND" }
```

### Downstream Service Failure

```
HTTP 502
{ "error": "Failed to prepare transaction intent", "code": "BAD_GATEWAY" }
```

### Rate Limited

```
HTTP 429
{ "error": "Rate limit exceeded", "code": "RATE_LIMIT_EXCEEDED" }
```

## Retry Guidance

- **4xx errors**: Do not retry automatically. Fix the request and try again.
- **429 errors**: Wait until the `X-RateLimit-Reset` timestamp, then retry.
- **502 errors**: Retry with exponential backoff. The downstream service may be temporarily unavailable.
- **500 errors**: Retry with exponential backoff. If persistent, contact support.
