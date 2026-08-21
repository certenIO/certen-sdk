# The `certen --json` machine contract

`certen` has two output modes with different audiences and very different guarantees.

**Table mode** (the default) is for humans. Column widths, wording and layout may change in any
release. Do not parse it.

**JSON mode** (`--json`) is a contract. It is enforced by
[`packages/cli/test/conformance.test.ts`](../packages/cli/test/conformance.test.ts), which runs the
built binary as a subprocess and asserts every rule below. Changing any of them is a breaking change
for every automated caller, not a test tweak.

## Why this exists

Before this contract, every failure exited `1` and explained itself in English on stderr. An
automated caller could not tell "you passed a malformed address" from "the gateway is down" without
parsing prose — and those two want opposite responses. One is a bug to fix; the other is worth
retrying. For a CLI that authorizes cross-chain execution against real funds, guessing wrong is
expensive in a way that is not recoverable.

## Rules

### 1. `--json` may appear anywhere

`certen --json identity get X` and `certen identity get X --json` are identical. The flag is resolved
before argument parsing, so it applies even to failures that happen while resolving credentials.

**`output: "json"` in `~/.certen/config.json` is not this contract.** That setting predates the
envelope and makes table-mode commands print their raw payload as JSON — no `ok`, no `error`, no
exit-code guarantees. It is kept for backward compatibility. Automated callers must pass `--json`
explicitly rather than relying on a machine's local config, which they cannot see.

### 2. Exactly one JSON object on stdout

Success:

```json
{ "ok": true, "data": { } }
```

Failure:

```json
{ "ok": false, "error": { "code": "RATE_LIMIT_EXCEEDED", "message": "…", "retryable": true, "status": 429, "requestId": "…" } }
```

- Always exactly one top-level object, newline-terminated. A command that produces several payloads
  emits them as an array in `data`; a command that produces none emits `"data": null`. stdout is
  never empty and never contains two concatenated objects.
- `status` and `requestId` appear only when the gateway supplied them.
- **Everything else goes to stderr** — confirmations, hints, warnings, commander's own parse errors.
  stderr is free-form and is not a contract.

#### A failure that still produced a result carries it

Some commands fail and nonetheless have an answer worth handing over. `certen doctor` is the case
this exists for: the diagnosis ran successfully and every check it performed is exactly what an
automated caller wants — but "a check failed" must still be a non-zero exit, or CI treats a broken
setup as a working one. Discarding the checks in order to signal the failure would make the machine
interface strictly less useful than the human one.

So the failure envelope may carry an additive `details` object:

```json
{ "ok": false, "error": {
  "code": "DOCTOR_CHECKS_FAILED", "message": "2 check(s) failed: api key, local signing key",
  "retryable": false,
  "details": { "checks": [ { "name": "gateway reachable", "status": "ok", "detail": "…" } ] }
} }
```

- `details` appears only when a command has something structured to report alongside the failure.
- Its **shape is per-command**, documented by that command, and is not part of this contract beyond
  the guarantee that it is a JSON object.
- It is additive: a consumer that ignores unknown keys is unaffected. This is the same property the
  402 payment fields below rely on.

`certen doctor` is currently the only command that uses it. Its `details.checks` is the same array
`--json doctor` returns under `data.checks` on a successful run, so a caller can read one shape
regardless of outcome.

#### Payment failures carry the fix

A refusal for lack of funds (`status: 402`, code `PAYMENT_REQUIRED` or
`COMMITMENT_EXCEEDED`) adds three keys, so an automated caller can settle and retry without
parsing prose:

```json
{ "ok": false, "error": {
  "code": "PAYMENT_REQUIRED", "message": "Payment required", "retryable": false, "status": 402,
  "shortfall_usd": "0.230000",
  "quote_id": "q-77",
  "resolve": {
    "payment_intent": "dep_9f2", "chain": "base", "to_address": "0x409E…",
    "amount_usd": "0.230000", "expires_at": "…", "reused_existing": false,
    "portal_url": "…/portal#funding?intent=dep_9f2",
    "cli_command": "certen fund 0.230000 --chain base",
    "note": "Send exactly …"
  }
} }
```

- These keys are **absent** on any other failure — they never appear as nulls.
- `resolve` is `null` when the gateway could not offer a payment target (no chain configured for
  deposits, for instance). The refusal is still valid; there is simply no one-step fix.
- Send **exactly** `resolve.amount_usd`. Attribution matches the amount, so a different figure
  will not credit automatically.
- `retryable` is `false` and must be honoured: only money changes this outcome, so a retry loop
  is pure load.
- Re-send with `quote_id` once funded to keep the price you were quoted, before it expires.

### 3. Exit codes

| Code | Meaning | What an automated caller should do |
|:--:|---|---|
| `0` | Success | Continue. |
| `1` | The gateway answered, and the operation did not succeed | Read `error.code`. Do not retry unless `retryable` is true. |
| `2` | Usage error — bad invocation, unknown command, missing flag, no API key configured | Fix the invocation. Never retry. |
| `3` | The gateway could not be reached | **Nothing was submitted.** Safe to retry. |

The distinction between `2` and `3` is the one that matters most: `3` guarantees no request was
accepted, so a retry cannot double-execute.

### 4. `retryable` matches the SDK exactly

`error.retryable` is taken from the SDK's own `CertenError.isRetryable`. A script that switches
between the CLI and the SDK does not have to re-derive which failures are worth another attempt —
the answer is the same on both paths. The catalog lives in
[`tools/agentgen/lib/errors.mjs`](../tools/agentgen/lib/errors.mjs) and is reconciled against the
SDK by test.

Retryable: `RATE_LIMIT_EXCEEDED`, `INTERNAL_ERROR`, `BAD_GATEWAY`, `NETWORK_ERROR`. Everything else
is a condition that will not change on its own.

### 5. `certen --help --json` returns the whole command tree

One call, no scraping:

```bash
certen --help --json
```

```json
{ "ok": true, "data": {
  "name": "certen", "version": "0.3.1",
  "exitCodes": { "0": "ok", "1": "operation failed", "2": "usage error", "3": "gateway unreachable" },
  "commands": [ { "name": "identity", "path": "certen identity", "commands": [ … ] } ]
} }
```

Each command carries `path` (how to invoke it), `arguments`, `options` and nested `commands`. On an
option, `required` means the flag must be present; `takesValue` means it accepts a value. They are
different things, and conflating them is an easy mistake.

### 6. `pending sign <target>` infers what it is signing

`certen pending sign` takes one argument and works out from its shape which kind of target it is.
There is no `--type` flag, because the two id formats are disjoint and a flag would only be a new
way to disagree with the argument.

| Form | Example | Resolves to |
|---|---|---|
| Inbox action id (UUID) | `f47ac10b-58cc-4372-a567-0e02b2c3d479` | `pending_action` |
| Transaction hash | `2e3d512d…79fc6` (64 hex) | `pending_tx` |
| Hash with a `0x` prefix | `0x2e3d512d…79fc6` | `pending_tx` |
| TxID | `acc://2e3d512d…79fc6@alice.acme/data` | `pending_tx` |

Anything else exits `2` with `error.code` `INVALID_SIGN_TARGET` and makes no request.

An inbox id comes from `certen pending list`, and the gateway derives the identity, the signer and
the key from the inbox row. A transaction hash has no such row behind it — it is the route for an
identity that was never polled into anyone's inbox — so `--identity`, `--signer-url` and
`--public-key` must all be supplied. Omitting any of them exits `2` with `error.code`
`MISSING_SIGNER_DETAILS`, naming every flag that is missing, **before any request is made**.

Both paths open a sign REQUEST and do not cast the vote; finish with `certen pending submit`.

## Example: a correct retry loop

```bash
for attempt in 1 2 3; do
  out=$(certen --json tx status "$ID"); code=$?
  case $code in
    0) echo "$out" | jq -r '.data.status'; break ;;
    2) echo "$out" | jq -r '.error.message' >&2; exit 2 ;;          # never retry
    *) [ "$(echo "$out" | jq -r '.error.retryable')" = true ] || exit $code
       sleep $((attempt * 2)) ;;
  esac
done
```

## Release note — 0.7.0 (breaking for `--json` consumers)

`certen --json identity get` and `certen --json identity create` no longer nest the identity under an
`identity` key. Its fields are at the top level of `data`, matching every other command and the API
itself:

```bash
certen --json identity get "$ID" | jq -r '.data.can_sign'     # was .data.identity.can_sign
```

The envelope (`{ ok, data }` / `{ ok, error }`), the exit codes, and every rule above are unchanged.
Table output is unchanged too — it was never a contract.

This tracks a gateway change made while there are no external integrators; see the gateway's
`docs/api-conventions.md` for the rule it settles. **A 0.7.x CLI requires a gateway from 2026-08 or
later**, and a 0.6.x CLI cannot read a current one.

Two `--json` field fixes ship with it, both of which make an absent value readable:

- `proof_id`, `proof_bundle_url`, `accum_tx_hash` and `error_message` are `null` when there is no
  value. They were `""`, so `.proof_id != null` was true for a transaction that had no proof.
- `can_sign` is `null` when the on-chain key page could not be read, where it was previously `false`.
  "Cannot sign" and "could not check" have different fixes.

## Release note — 0.4.0 (tagged and published by a human)

`packages/cli/package.json` is bumped to 0.4.0; publishing happens when someone pushes a `cli-v0.4.0`
tag. Table output is unchanged, so anything not passing `--json` behaves exactly as before, with one
exception:

- **"No API key configured" now exits `2` instead of `1`.** It is a usage error: nothing was sent,
  and retrying cannot help. Scripts that treated any non-zero exit as failure are unaffected; scripts
  that specifically tested `-eq 1` need updating.
