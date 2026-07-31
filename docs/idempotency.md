# Idempotency-Key

The Certen API gateway honors `Idempotency-Key` on every mutating route
(`POST`, `PATCH`, `DELETE` with side effects). Behavior matches the
Stripe model — opaque, header-only, content-bound, and 24-hour-cached
by default.

## Sending an idempotency key

Stamp a unique string (1–255 chars, alphanumeric + `_ - . :`) in the
`Idempotency-Key` request header:

```
POST /v1/transactions
Idempotency-Key: req_8a72f1b3c9d5
Content-Type: application/json

{ ... }
```

The gateway records the (org, key) tuple along with a SHA-256 hash of
your request body. Replays of the same body within the TTL window
return the cached response. Replays with a **different body** under
the same key return `409 IDEMPOTENCY_KEY_MISMATCH` — the gateway
will not silently re-execute or return a stale response.

## TTL

Default: **24 hours**. Some routes opt into longer TTLs (e.g. up to
7 days for long-lived workflow operations) — the route documentation
calls these out.

## Replay semantics

When a replay matches, the response is identical to the original:
same status code, same body. The reply additionally carries:

| Header | Value |
|--------|-------|
| `X-Idempotency-Replay` | `true` |
| `X-Original-Request-Id` | the `request_id` of the original (when known) |
| `Idempotency-Replay`   | `true` (legacy alias; same as `X-Idempotency-Replay`) |

## Errors are NOT cached

Round-2 #21: if the cached response has `status >= 500`, the gateway
treats the next retry as **fresh**, not a replay. This means a
transient downstream failure doesn't trap you in a permanent 5xx for
24 hours — you can retry the same key safely. (4xx responses *are*
cached. They represent a deterministic decision on the original
input.)

## In-flight protection

If a request with the same key is still executing, the gateway returns
`409 IDEMPOTENCY_KEY_IN_FLIGHT`. Retry after a short backoff. The
in-flight state is held under a transaction-scoped row lock so a
process crash releases it within seconds.

## Concurrency races

Two pods receiving the exact same key at the exact same moment are
disambiguated by a Postgres unique-violation handler — the loser of
the INSERT race observes the winner's row and replays (or 409s on
in-flight). You don't need to do anything special on the client side.

## When NOT to send a key

- `GET` requests. The gateway ignores it.
- `POST /v1/oauth/token`. Token issuance is naturally idempotent on
  the server side and an idempotency key would just waste DB rows.
  The Node SDK exposes `skipIdempotencyFor: ['/v1/oauth/token']` to
  opt out automatically.

## Server-side cleanup

Expired rows are purged hourly by the maintenance job. The purge
counter is exported as `certen_gateway_maintenance_purged_total{resource="idempotency_keys_expired"}`.
