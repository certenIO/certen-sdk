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

`certen doctor` uses it for `details.checks`, the same array `--json doctor` returns under
`data.checks` on a successful run, so a caller can read one shape regardless of outcome.

`TX_FAILED` (from `tx create --wait`, `tx status --wait` and `call --wait`) carries
`details: { intent_id, reason_code, reason }`, where `reason_code` is the gateway's value (`expired`,
`expectation_unmet`, `target_reverted`, …, or null) and `reason` is one readable sentence. An intent that
`expired` is a `TX_FAILED` too, with `reason_code: "expired"`.

`TX_WAIT_TIMEOUT` (the same commands, when `--timeout` ran out first) is neither success nor failure: the
intent may still complete. It exits `1`, is not retryable, and carries
`details: { intent_id, last_status, last_class, timeout_ms }`. `last_class` is what the last status means:
`in_flight`, `executed`, or `unknown` (a status this CLI does not recognise, which is never treated as done).
Check the intent again; do not open a second one.

#### Intent states a wait can end in

`--wait` follows one table (the SDK's `intent-states.ts`), so the CLI, the SDK and the MCP server agree:

| `data.status` | Wait ends? | Exit | Meaning |
|---|:--:|:--:|---|
| `completed` (also `proven`) | yes | `0` | Executed and proven. `proof get` has something to fetch. |
| `completed_unproven` | yes | `0` | The action **executed**, and its proof can never be produced (billed gas only, fee waived). Branch on `data.status`: there is nothing to verify, so do not treat exit `0` as "a proof exists". |
| `executed` | **no** | — | The action ran on its chain; the proof bundle is still being produced. The wait keeps going and prints it as progress. |
| `failed`, `expired` | yes | `1` | `TX_FAILED`; will not execute. |

`completed_unproven` is never reported as `completed`, and `executed` is never reported as a failure.

#### Refused header authorities carry guidance

`HEADER_AUTHORITY_NOT_EXECUTABLE` (HTTP 422, from `--authority`) adds an additive `guidance` string saying
what to do instead: header authorities are refused by default because validators do not yet execute
intents that carry them, so put the co-signer on the account's authorities. Not retryable.

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
| `4` | `proof verify` only: **partial** — the layers the proof carries were checked and one is not established | Read `data.layers`: every layer with `verdict: not_checked` names why. This is not a verified proof. |
| `5` | `proof verify` only: **no evidence** — nothing the Accumulate side can be checked from (`data.evidence.code`: `PROOF_V2_EVIDENCE_NOT_SERVED`, or `PROOF_SERVICE_UNAVAILABLE`) | The gateway serves no proof v2 document for this proof (yet). Do not treat the gateway's own receipt as verification. |

The distinction between `2` and `3` is the one that matters most: `3` guarantees no request was
accepted, so a retry cannot double-execute.

Exit `3` is exactly the SDK's `NETWORK_ERROR`. Other SDK errors also carry `status: 0` because they were
raised locally, and they are **not** "unreachable": `WAIT_TIMEOUT`, `INTENT_FAILED` and `PROOF_NOT_ASSIGNED`
are about an intent the gateway already holds, so they exit `1`; retrying the command by opening the
intent again would be wrong. (Before, any status-0 error exited `3`.)

### Signing: `SIGNING_DATA_MISMATCH`, `BLIND_SIGNING_REFUSED`

Every command that signs with a local key (`tx create --sign-with`, `call`, `governance <operation> --sign-with`, `pending sign --sign-with`) first rebuilds the unsigned transaction the gateway returned
(`signing_data.transaction` and `signing_data.signature_metadata`), recomputes the transaction hash, the signature-metadata hash and the signing hash, requires them to equal what the gateway sent, and
matches what the transaction authorises (principal, each leg's chain, target, value and calldata, expected events, deadline, additional authorities, the signing key, the vote, or the governance operation) to
the request. It prints the result on stderr before signing (`You are about to sign: …`); `--json` output carries it as `signing`.

| `error.code` | Exit | Meaning |
|---|:--:|---|
| `SIGNING_DATA_MISMATCH` | 1 | The transaction is not what was asked for, or does not hash to what the gateway sent. `error.details` has `field`, `expected`, `actual`. Nothing was signed. |
| `SIGNING_DATA_ABSENT` | 1 | The gateway returned no transaction or signature metadata to check. Nothing was signed. |
| `SIGNING_EXPECTATION_UNAVAILABLE` | 1 | The request is one the CLI cannot state the meaning of (a token transfer, a tuple argument, a chain outside the catalogue). Nothing was signed. |
| `BLIND_SIGNING_REFUSED` | 2 | `--sign-with` with `--hash` on `tx sign`, `pending submit` or `governance sign`, or `--hash` on `keys sign` (use `keys sign --signing-data`, which rebuilds and shows it first). A bare hash is never signed; there is no override. Use the one-step command above, or `tx inspect` / `governance inspect`, then `--signature` + `--public-key`. |

`certen tx inspect <id>` and `certen governance inspect <id>` recompute and show what is awaiting a signature, signing nothing; `tx inspect --intent` also matches it to your request.

### `certen proof verify`

`proof verify <intent id | proof id | tx hash | share link | @bundle.json>` verifies the proof locally, layer by layer. The verdict is computed here from the
proof v2 portable document (`@certen.io/proof-verify`) and the bundle's own execution receipt. **No flag in a bundle is ever read as a verdict**: the bundle's
`verified` is printed as the validators' statement and nothing more, and the gateway's own receipt is printed as "asked of the gateway, not used".

`--json` returns `data`:

| Field | Meaning |
|---|---|
| `overall` | `verified` (every layer the document carries was checked here) · `partial` · `failed` · `no_evidence` |
| `independent` | `true` only for `verified`: the statements in `covers` were derived here with CERTEN not trusted |
| `layers[]` | `{ id, statement, title, verdict, evidence, reason? }` for `trust_base`, `L4`, `L1`, `L2`, `L3`, `G0`, `G1`, `G1_chains`, `L4_set`, `govRootV3`, `outcome`, `G1b`, `G2`, `L5`. `verdict` is `verified`, `failed`, `not_checked` (inside the document's scope, not established: `reason` says why) or `not_in_document` (a layer this document type does not carry) |
| `covers` / `notCovered` | The statements (PROOF_V2 §3: S1…S9) a `verified` result establishes, and those it cannot speak to |
| `failure` | `{ layer, message }` for the first layer that failed |
| `execution`, `headerCheck` | The execution receipt walked to the bundle's receipts root, and the comparison with a header from `--rpc` |
| `bundleStatements` | What the bundle says about itself. Reported, never used |
| `evidence` | `{ found, code?, reason?, bundleError? }`: whether a portable document was found, and why not |
| `gateway` | The gateway's own receipt, for information only |

Exit `0` verified, `1` failed (or an unreadable input that is not a usage error), `2` usage error, `3` gateway unreachable, `4` partial, `5` no evidence. Before this
release `proof verify` exited `0` whenever the gateway reported an anchored receipt and, because the entrypoint overwrote `process.exitCode`, also after a failed
outcome check; the entrypoint now honours the exit code a command sets, and the verdict is the layer verdict above.

`FOREIGN_ORIGIN_URL` also exits `1`: the SDK refused to send to a url outside the gateway's origin (a `submit_url` in a response, or a redirect to
another host) before signing or sending anything, so no credential left the process. Not retryable; `error.details` has `url`, `baseUrl` and `source`.

`INVALID_PATH_PARAMETER` exits `2` (a usage error): an id argument was empty or only dots. Every id is encoded as one path segment, so an id
containing `/`, `?` or `#` reaches the gateway as that literal text and cannot change which endpoint is called.

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
  "exitCodes": { "0": "ok", "1": "operation failed", "2": "usage error", "3": "gateway unreachable", "4": "proof verify: partial (a layer is not established)", "5": "proof verify: no evidence to check" },
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
