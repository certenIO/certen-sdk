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

## Release note — 0.4.0 (tagged and published by a human)

`packages/cli/package.json` is bumped to 0.4.0; publishing happens when someone pushes a `cli-v0.4.0`
tag. Table output is unchanged, so anything not passing `--json` behaves exactly as before, with one
exception:

- **"No API key configured" now exits `2` instead of `1`.** It is a usage error: nothing was sent,
  and retrying cannot help. Scripts that treated any non-zero exit as failure are unaffected; scripts
  that specifically tested `-eq 1` need updating.
