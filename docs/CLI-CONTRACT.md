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
{ "ok": false, "error": { "code": "RATE_LIMIT_EXCEEDED", "message": "…", "retryable": true, "next": "certen errors RATE_LIMIT_EXCEEDED", "status": 429, "requestId": "…" } }
```

- Always exactly one top-level object, newline-terminated. A command that produces several payloads
  emits them as an array in `data`; a command that produces none emits `"data": null`. stdout is
  never empty and never contains two concatenated objects.
- `status` and `requestId` appear only when the gateway supplied them.
- `next` is the one command to run after this failure: a single `certen ...` line, present on every failure envelope. It is additive (a consumer
  that ignores unknown keys is unaffected) and is described in section 11.
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
  "retryable": false, "next": "certen status",
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
  "code": "PAYMENT_REQUIRED", "message": "Payment required", "retryable": false, "next": "certen fund <usd>", "status": 402,
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
- `error.next` for `PAYMENT_REQUIRED` is the fixed `certen fund <usd>` (and `certen errors COMMITMENT_EXCEEDED` for that code), **not** `resolve.cli_command`: `next` is
  never built from gateway text (section 11). `resolve.cli_command` stays what it was, a field you may read; deciding to run it is yours.

### 3. Exit codes

| Code | Meaning | What an automated caller should do |
|:--:|---|---|
| `0` | Success | Continue. |
| `1` | The gateway answered, and the operation did not succeed | Read `error.code`. Do not retry unless `retryable` is true. |
| `2` | Usage error — bad invocation, unknown command, missing flag, no API key configured | Fix the invocation. Never retry. |
| `3` | The gateway could not be reached | **Nothing was submitted.** Safe to retry. |
| `4` | `proof verify`: **partial** — the layers the proof carries were checked and one is not established. `send`, `receipt` and `watch` (section 10): the receipt is **PARTIAL** (something is not established; `data.receipt.gaps` names each) or still **pending** | Read `data.layers` (`proof verify`) or `data.receipt.gaps` (section 10): every layer with `verdict: not_checked` names why. This is not a verified proof, and not a failure either. |
| `5` | `proof verify`: **no evidence** — nothing the Accumulate side can be checked from (`data.evidence.code`: `PROOF_V2_EVIDENCE_NOT_SERVED`, or `PROOF_SERVICE_UNAVAILABLE`). `send`, `receipt` and `watch`: the same, as `data.receipt.proof.verdict: "no_evidence"` | The gateway serves no proof v2 document for this proof (yet). Do not treat the gateway's own receipt as verification. |
| `130` | `setup`, `gas`, `send` and `watch`: **stopped with Ctrl-C while waiting** (`error.code` `INTERRUPTED`): for funds in `setup` and `gas`, for the proof cycle in `send` and `watch` | Nothing was left half-done. For `setup` and `gas`, run the same command again to continue. For `send` and `watch` **the intent keeps running** (nothing was cancelled): `error.details.resume` is the command that picks it back up, and the receipt so far is saved. Never a failure of the operation. |

The distinction between `2` and `3` is the one that matters most: `3` guarantees no request was
accepted, so a retry cannot double-execute.

Exit `3` is exactly the SDK's `NETWORK_ERROR`. Other SDK errors also carry `status: 0` because they were
raised locally, and they are **not** "unreachable": `WAIT_TIMEOUT`, `INTENT_FAILED` and `PROOF_NOT_ASSIGNED`
are about an intent the gateway already holds, so they exit `1`; retrying the command by opening the
intent again would be wrong. (Before, any status-0 error exited `3`.)

### Signing: `SIGNING_DATA_MISMATCH`, `BLIND_SIGNING_REFUSED`

Every command that signs with a local key (`send`, `tx create --sign-with`, `call`, `governance <operation> --sign-with`, `pending sign --sign-with`) first rebuilds the unsigned transaction the gateway returned
(`signing_data.transaction` and `signing_data.signature_metadata`), recomputes the transaction hash, the signature-metadata hash and the signing hash, requires them to equal what the gateway sent, and
matches what the transaction authorises (principal, each leg's chain, target, value and calldata, expected events, deadline, additional authorities, the signing key, the vote, or the governance operation) to
the request. It prints the result on stderr before signing (`You are about to sign: …`, inside the confirmation card of section 10); `--json` output carries it as `signing`. `--yes` and `--json` skip the
**question** the card asks, never this check.

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
  "exitCodes": { "0": "ok", "1": "operation failed", "2": "usage error", "3": "gateway unreachable", "4": "proof verify: partial (a layer is not established)", "5": "proof verify: no evidence to check", "130": "stopped with Ctrl-C while waiting (setup, gas); nothing was left half-done" },
  "commands": [ { "name": "identity", "path": "certen identity", "commands": [ … ] } ]
} }
```

Each command carries `path` (how to invoke it), `arguments`, `options` and nested `commands`. On an
option, `required` means the flag must be present; `takesValue` means it accepts a value. They are
different things, and conflating them is an easy mistake.

The tree is the parser, so it lists every command and option. The *grouping* in `certen --help` for a person (the root help leads with `setup`, `send`, `call`,
`status`, `receipt`, and puts plumbing under "Advanced"; `tx create --help` lists its key-page and contract-address options under "Advanced options") is a
presentation of the same commands, not a different set: nothing is hidden from the tree or from the help, and the tree is unchanged by it.

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
`--public-key` must all be available (`--identity` may come from your context, see section 7). Omitting any of them exits `2` with
`error.code` `MISSING_SIGNER_DETAILS`, naming every flag that is missing, **before any request is made**.

Both paths open a sign REQUEST and do not cast the vote; finish with `certen pending submit`.

### 7. Context: `certen context`, `certen use`, `--profile`

A command that acts as an identity, signs with a key or targets a chain takes each from, in this order:
the flag, the environment (`CERTEN_IDENTITY`, `CERTEN_KEY`, `CERTEN_CHAIN`), the active profile, and
finally the single candidate there is (the only recorded identity, the only local key, the identity's
only linked chain). Several candidates and none chosen is never a guess: it exits `2` and lists them,
**before any request is made**.

**A value from context is said, not silent.** Every value that did not come from a flag is echoed on
**stderr**, in table and `--json` mode alike, before any passphrase prompt:

```
using identity acc://alpha.acme (the only identity recorded on this machine)
using chain base-sepolia (from profile "default")
using key dev (from CERTEN_KEY)
using from 0xE293…cAcB (derived: the abstract account of acc://alpha.acme on base-sepolia)
```

stdout is still exactly one envelope. These lines are not part of the contract's data; the
`certen context` command is the machine-readable view.

**A default never points a value-moving command at a mainnet.** `call`, `tx create` and `fund` refuse a
chain that is not a known testnet when it came from the environment, a profile or a single candidate:
exit `2`, `MAINNET_DEFAULT_REFUSED`, before any request. `--chain` on the command line is the person's own
choice and always works; a profile may opt in with `certen use allow-mainnet-default on`. A chain that cannot
be classified counts as "not a known testnet". A chain the CLI would refuse anyway keeps its own
`UNSUPPORTED_CHAIN`, naming where it came from.

**What is never defaulted.** A signing key is defaulted only by `call` and `identity create`, where leaving it out was
always an error. `tx create`, `governance <operation>` and `pending sign` without `--sign-with` open the intent
and return signing data for an external signer, and still do. `identity retire` always takes its identity
explicitly, and `pending list` / `portfolio` `--identity` are filters: left out, they mean "all".

**One identity reference.** Wherever an identity is named, it may be a UUID, an `acc://` ADI URL, or the name
it was created with (or its ADI label). The CLI sends the gateway the form each route takes: a UUID to
`/v1/identity`, `/v1/transaction`; the ADI URL to `/v1/governance`.

**Profiles.** A profile is a gateway URL, a context and a credential. `--profile <name>` is global (before or
after the subcommand, like `--json`); `CERTEN_PROFILE` and `certen use profile <name>` set it otherwise. The
`default` profile is the config that has always existed. A named profile has its own API key and never reads
another profile's.

#### `certen context`

Local: no network, no API key. One envelope:

```json
{ "ok": true, "data": {
  "profile": "default",
  "profiles": ["default", "testnet"],
  "gateway": { "url": "https://gateway.kompendium.co", "source": "default" },
  "credential": { "source": "file", "key_prefix": "ck_live_abcd" },
  "identity": { "value": "11111111-…", "source": "single", "detail": "the only identity recorded on this machine",
                "adi_url": "acc://alpha.acme", "name": "alpha" },
  "key":      { "value": "dev", "source": "env", "detail": "CERTEN_KEY", "exists": true },
  "chain":    { "value": "base-sepolia", "source": "profile", "detail": "profile \"default\"", "known_testnet": true },
  "allow_mainnet_default": false,
  "candidates": { "identity": [ { "id": "…", "adi_url": "…", "name": "alpha" } ], "key": ["dev"], "chain": ["base-sepolia"] }
} }
```

`identity`, `key` and `chain` are `null` when nothing is chosen (the candidates say what could be).
`source` is `flag` | `env` | `profile` | `single`; for `context` it is never `flag`. `gateway.source` is `env`,
`profile`, `default-profile` or `default`; `credential.source` is `env`, `keyring`, `file` or `null`.

#### `certen use …`

Each writes to the active profile and prints one envelope, `{ "profile": "…", "<field>": <value or null> }`:

| Command | Data (besides `profile`) |
|---|---|
| `use identity <ref>` / `--unset` | `identity` (the UUID), `adi_url`, `verified` (`true` only when the gateway confirmed it in this command) |
| `use key <name>` / `--unset` | `key`, `public_key_hash`, `encrypted` |
| `use chain <chain>` / `--unset` | `chain`, `known_testnet` |
| `use gateway <url>` / `--unset` | `gateway` |
| `use profile <name> [--create]` | `active_profile`, `profiles` |
| `use allow-mainnet-default on\|off` | `allow_mainnet_default` |

#### Errors (all exit `2`, all raised before any request unless noted)

| `error.code` | When |
|---|---|
| `MISSING_IDENTITY` / `MISSING_CHAIN` | nothing supplies one |
| `AMBIGUOUS_IDENTITY` / `AMBIGUOUS_CHAIN` | several candidates, none chosen (the message lists them); `AMBIGUOUS_IDENTITY` also when two identities share a name |
| `MAINNET_DEFAULT_REFUSED` | a value-moving command, a chain that is not a known testnet, taken from a default |
| `MISSING_SIGNING_KEY` | unchanged code; the message now lists the keys when there are several |
| `UNKNOWN_KEY` | a key named by a profile or `use key` is not on this machine |
| `INVALID_IDENTITY_REF` | not a UUID, an ADI URL or a name (an account or key page under an ADI is refused) |
| `UNKNOWN_IDENTITY_ALIAS` | no recorded identity has that name; the message lists the recorded ones |
| `IDENTITY_NOT_FOUND` | the gateway has no such identity for this organization (`use identity`, ADI lookup) |
| `IDENTITY_ID_UNRESOLVED` | an ADI this machine has no record of, on a gateway too old to return ids in the portfolio |
| `PROFILE_NOT_FOUND`, `INVALID_PROFILE_NAME`, `MISSING_PROFILE_NAME`, `DUPLICATE_PROFILE_FLAG` | `--profile` / `CERTEN_PROFILE` / `use profile` |
| `INVALID_GATEWAY_URL`, `MISSING_VALUE`, `CONFLICTING_UNSET`, `INVALID_VALUE` | `use …` |

#### Durations

`--timeout` and `--poll-interval` take a positive whole number and a unit (`s`, `m`, `h`, `d`): `--timeout 90s`,
`6m`, `1h`. A bare number keeps its meaning (minutes for a timeout, seconds for a poll interval). Anything else
is `INVALID_TIMEOUT` / `INVALID_POLL_INTERVAL` (exit `2`) before any request. Waiting is never shortened by it:
the defaults are unchanged.

### 8. Readiness: `certen status`, and the checks `doctor` adds

`certen status` answers the question asked just before sending: is **this identity, on this chain, with this key** able to act, and if
not, what is the first thing in the way? It is `client.readiness()` from the SDK, rendered. Which identity, chain and key comes from the
context (section 7), and every value taken from it is echoed on **stderr** first.

```
certen status [--identity <ref>] [--chain <chain>] [--sign-with <key>]
              [--amount <whole units>] [--token <symbol>] [--accumulate-rpc <url>] [--gas-reserve <amount|none>] [--all]
```

**Exit codes.** `0` only when the state is `ready`. `1` when it is `blocked` **or** `unconfirmed` (the envelope says which). `3` when the
gateway could not be reached. `2` for a mistake in the invocation, before any request.

**Unknown is not ready.** A check that could not be answered is `unknown`; a check whose prerequisite failed is `skipped`. `ready` is true
only when every check is `ok` or `warn`, so a key page that could not be read from Accumulate leaves the answer `unconfirmed` (exit `1`)
whatever the other checks say. This is deliberately stricter than the funding guard on `call` / `tx create`, which never blocks on a
balance it cannot read.

On success (`ready`), one envelope:

```json
{ "ok": true, "data": { "readiness": {
  "ready": true,
  "state": "ready",
  "first_blocker": null,
  "context": {
    "identity_id": "11111111-…", "adi_url": "acc://alpha.acme", "key_page_url": "acc://alpha.acme/book/1",
    "chain": "base-sepolia", "abstract_account": "0xE293…cAcB",
    "accumulate_rpc": "https://kermit.accumulatenetwork.io/v3", "key_hash": "9f2c…"
  },
  "checks": [
    { "name": "gateway",            "status": "ok", "detail": "registry v2026-10-15, 3 chains" },
    { "name": "credential",         "status": "ok", "detail": "accepted" },
    { "name": "signing key",        "status": "ok", "detail": "dev (encrypted), hash 9f2c…41ab", "data": { "key": "dev", "public_key_hash": "9f2c…", "encrypted": true } },
    { "name": "identity",           "status": "ok", "detail": "acc://alpha.acme is active" },
    { "name": "chain",              "status": "ok", "detail": "base-sepolia is served and linked (abstract account 0xE293…cAcB)" },
    { "name": "key page",           "status": "ok", "detail": "acc://alpha.acme/book/1 holds your key (9f2c…41ab), read from Accumulate (kermit.accumulatenetwork.io), not the gateway",
      "data": { "independent": "holds", "gateway_can_sign": true, "keys_on_page": 1, "accept_threshold": 1, "version": 2 } },
    { "name": "accumulate credits", "status": "ok", "detail": "1240 on the key page, as Accumulate reports it" },
    { "name": "gateway balance",    "status": "ok", "detail": "$5.000000 spendable, $5.000000 left to commit" },
    { "name": "gas",                "status": "ok", "detail": "0xE293…cAcB on base-sepolia holds 0.0021 ETH; about 0.0001 ETH is needed for gas (an estimate)",
      "data": { "balance": "0.0021", "needed": "0.0001", "amount": "0", "gas_reserve": "0.0001", "gas_reserve_is_estimate": true } }
  ]
} } }
```

When it is not `ready`, the **same `readiness` object** is carried under `error.details` (the diagnosis ran; signalling the failure must
not cost the caller it), exactly as `doctor` does:

| `error.code` | Exit | When |
|---|---|---|
| `NOT_READY` | `1` | `state` is `blocked`: a check failed |
| `NOT_CONFIRMED` | `1` | `state` is `unconfirmed`: nothing failed, but a check could not be answered (`unknown`) or was not evaluated (`skipped`) |
| `NETWORK_ERROR` | `3` | the gateway could not be reached (every check after `gateway` is `skipped`) |

**Fields.**

- `checks` is ordered by dependency and **always the same length**: a check that was not evaluated is `skipped`, never omitted. Names, in order:
  `gateway`, `credential`, `signing key`, `identity`, `chain`, `key page`, `accumulate credits`, `gateway balance`, `gas`.
- `status` is `ok` | `warn` | `fail` | `unknown` | `skipped`. Every check that is not `ok` has a `code` (stable, upper snake case) and a `fix`:
  `{ "text": "…", "command"?: "…", "url"?: "…" }`. `text` is plain words; `command` is the line to type, when the CLI has one; `url` is where to do it.
- `first_blocker` is the first `fail`, else the first `unknown` / `skipped`; `null` when ready.
- `data` carries the facts a verdict was drawn from, so a caller need not parse `detail`. Fields are only ever added.
- `context.accumulate_rpc` is `null` when no independent read was made.

**The key page is read twice**, from two parties. The gateway's `can_sign` is one party's word; the CLI also asks an **Accumulate node**
(`--accumulate-rpc`, else the endpoint `GET /v1/chains` advertises) for the key page and compares its key hashes with the hash of the local
key. No CERTEN credential is sent to that node, and no redirect is followed. It trusts the node it asked; it does not check a Merkle receipt.

| `code` on `key page` | `status` | Meaning |
|---|---|---|
| (none) | `ok` | Accumulate lists the key and the gateway agrees (or cannot say) |
| `KEY_PAGE_DISAGREES` | `fail` | the two reads disagree: Accumulate shows the key but the gateway says it cannot sign, or the gateway says it can and the page lacks the key. A blocker; neither read is preferred |
| `KEY_PAGE_LACKS_KEY` | `fail` | the page was read and does not list the key, and the gateway agrees it cannot sign |
| `IDENTITY_CANNOT_SIGN` | `fail` | the gateway says it cannot sign (and Accumulate could not be read, or no key was given) |
| `KEY_PAGE_UNCONFIRMED` | `unknown` | Accumulate could not be read, or has no such account. The gateway's word alone is not enough |
| `KEY_PAGE_NOT_INDEPENDENTLY_CHECKED` | `warn` | no key was given to compare |
| `KEY_PAGE_MISSING` | `fail` | the identity has no key page on record |

**Gas.** `gas` judges the abstract account's native balance (whole units, as the gateway reports it) against `--amount` plus a per-chain
**estimate** of what one execution costs. The gateway publishes no per-execution gas figure, so the estimate is a planning figure held in
the chain catalogue, labelled as an estimate in `detail` and in `data.gas_reserve_is_estimate`; `--gas-reserve <amount>` replaces it and
`--gas-reserve none` removes it. A chain with no estimate is checked on the amount alone and says so (`GAS_NOT_ESTIMATED`, `warn`). Codes:
`ABSTRACT_ACCOUNT_UNFUNDED` (a zero balance), `ABSTRACT_ACCOUNT_UNDERFUNDED` (positive, but below the amount, or below the amount plus the
estimate; `data.shortfall_kind` is `amount` or `gas`), `ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE` (`unknown`: the balance was not reported,
or could not be read). These are the same codes the submit-time funding guard uses, and the same comparison.

**Credits.** `accumulate credits` fails only on zero (`ACCUMULATE_CREDITS_EMPTY`). The gateway publishes no per-intent credit cost, and the
spec does not say whether `creditBalance` counts whole credits or hundredths of one, so a low-water mark would be a guess. The number is
shown exactly as the key page reports it, and `data.source` says whether Accumulate or the gateway supplied it.

**`certen status --all`** checks every identity recorded on this machine on each chain it is linked to. The organization-wide checks are
made once, with the first context. One envelope: `{ "ok": true, "data": { "contexts": [ { "identity_id", "adi_url", "chain", "readiness" } ] } }`;
when any context is not ready, the same `contexts` array is under `error.details` and the message says how many. The local record does not
say which key an identity was created with, so the key page is compared with the local key only for the identity the context names; for
the others it is `warn` (`KEY_PAGE_NOT_INDEPENDENTLY_CHECKED`).

**`certen doctor`** keeps its organization-wide checks and its shape. When the context names an identity and a chain, five more checks are
appended, always the same five, `skipped` (with the reason) when they cannot run: `identity`, `chain`, `key page`, `accumulate credits`,
`gas`. In `doctor`'s vocabulary (`ok` | `warn` | `fail` | `skipped`) an `unknown` is a `warn` whose `detail` begins `could not confirm:`; it
is never a pass. `doctor` takes `--identity`, `--chain` and `--sign-with` to name the pair explicitly. Where a fix needs a chain it names the
context's, or the placeholder `<chain>`; it never names a chain nobody chose.

#### Errors (exit `2`, raised before any request)

| `error.code` | When |
|---|---|
| `INVALID_AMOUNT` | `--amount` is not a decimal in whole units, or looks like wei; `--gas-reserve` is not a decimal or `none` |
| `INVALID_ACCUMULATE_RPC` | `--accumulate-rpc` is not an http(s) URL, or carries a username or password |
| `NO_IDENTITIES`, `NO_CHAINS` | `--all` with nothing recorded, or no linked chain on record |
| `MISSING_IDENTITY`, `AMBIGUOUS_IDENTITY`, `MISSING_CHAIN`, `AMBIGUOUS_CHAIN` | as in section 7 |

### 9. Setup and gas: `certen setup`, `certen gas`

**`certen setup`** takes a machine from nothing to an identity that can act on a chain, in one resumable command, and **exits `0` only when
it is ready**: every readiness check (section 8) is `ok` or `warn`. Nothing crashing is not ready; a check that could not be answered is not ready.

```
certen setup [--name <name>] [--identity <ref>] [--key <name>] [--chain <chain> | --chains <a,b>] [--yes]
             [--existing-account | --new-account | --token <registration token>] [--org-name <name>]
             [--no-passphrase] [--no-keyring] [--no-browser] [--payer <address>]
             [--wait-for-funds | --no-wait-for-funds] [--amount <whole units>] [--gas-reserve <amount|none>] [--accumulate-rpc <url>]
             [--timeout <duration>] [--funds-timeout <duration>] [--poll-interval <interval>]
```

Steps, in this order, each skipped when already satisfied: the gateway (reachable, serves the chain); the signing key (**before** the account,
because a new account is created by it); the sign-in; the identity; the context (written as soon as identity, key and chain are settled);
readiness (`client.readiness()`, the same card as `certen status`); and, if gas is the only thing in the way, a wait for it.

**Running it again continues; it does not repeat.** The identity is recorded locally the moment the gateway returns its id, before the wait,
so a run that was interrupted or timed out while provisioning is picked up rather than repeated (an organisation made with a key may hold one
identity until approved, and a second create is refused). A working credential is never replaced by an option. `--yes` never creates an
account and never retires an identity.

**Which kind of account.** With no API key configured, exactly one of `--token <registration token>` (CI), `--new-account` (an organisation
created with the signing key: the only thing that crosses the wire is a signature over a nonce, no browser), or `--existing-account` (the
device flow, with a pasted key as the fallback for a gateway without it). On a terminal with none of them, the question is asked, with no
default, **before** any key is made. With no terminal, or with `--yes`, and none of them, it exits `2` with `NO_API_KEY` naming the three. A
credential that is configured and works is kept, whatever else was passed.

**Passphrase.** A new signing key is encrypted. With `--yes` and no terminal it needs `CERTEN_KEY_PASSPHRASE` or an explicit `--no-passphrase`
(`PASSPHRASE_REQUIRED`, exit `2`, otherwise): an unencrypted key is a choice, never what happens because a prompt had no one to ask.

**Waiting for funds.** On by default only where a person is watching (a terminal and not `--json`); `--wait-for-funds` turns it on anywhere and
`--no-wait-for-funds` off. It starts only when gas is the **only** failing check and the gap is one that sending funds fixes (an empty or short
account, or a balance not reported yet); a gas row that cannot be identified, or any other failing or unknown check, is a blocker with its fix and
no wait. It polls the identity read (one request per poll) at `--poll-interval` (default 6s) for up to `--funds-timeout` (default 30m).

| Exit | `error.code` | When |
|:--:|---|---|
| `0` | (success) | ready |
| `1` | `NOT_READY` / `NOT_CONFIRMED` | `readiness.state` is `blocked` / `unconfirmed` (as in section 8). If gas is what is missing, `error.details.funding` says what to send where |
| `1` | `FUNDS_WAIT_TIMEOUT` | it waited and no funds arrived in time. The setup is saved; run it again |
| `1` | `CREDENTIAL_REJECTED` | the gateway rejected the configured credential (never replaced unless asked) |
| `1` | `IDENTITY_PROVISIONING_FAILED` | the identity ended in `error`. The message names `certen identity retire <id> --yes`; setup retires only when a person answers yes at a terminal |
| `1` | `SELF_SERVICE_DISABLED` | the gateway does not allow creating an account from a key; the message names the other ways in |
| `1` | `KEY_STORAGE_FAILED` | an account was created and its key (returned once) could not be saved. The message says how to sign in to it |
| `2` | `NO_API_KEY`, `CONFLICTING_OPTIONS`, `PASSPHRASE_REQUIRED`, `AMBIGUOUS_KEY`, `AMBIGUOUS_IDENTITY`, `AMBIGUOUS_CHAIN`, `UNKNOWN_KEY`, `INVALID_AMOUNT`, `INVALID_ACCUMULATE_RPC`, `INVALID_TIMEOUT`, `INVALID_POLL_INTERVAL`, `UNSUPPORTED_CHAIN` | a mistake in the invocation, raised before anything is made (the chain is judged after the registry is read) |
| `3` | `NETWORK_ERROR` | the gateway could not be reached. Retryable; nothing was made |
| `130` | `INTERRUPTED` | Ctrl-C while waiting for funds. Nothing is half-done |

On success, one envelope:

```json
{ "ok": true, "data": {
  "ready": true, "api_url": "https://gateway.kompendium.co", "profile": "default", "chain": "base-sepolia",
  "context": { "identity_id": "11111111-…", "adi_url": "acc://alpha.acme", "key": "dev", "chain": "base-sepolia" },
  "created": { "key": true, "account": true, "identity": true },
  "readiness": { "ready": true, "state": "ready", "first_blocker": null, "context": { }, "checks": [ ] },
  "steps": [ { "step": "gateway", "status": "done", "detail": "registry v2026-10-15, 3 chains" } ],
  "next_command": "certen tx create --to 0xRecipient --amount 0.0001 --sign-with dev --wait"
} }
```

`created` says what THIS run made; a rerun reports all three `false`. `steps[].status` is `done` | `skipped` | `created` | `waited`, in the
order the steps ran (`gateway`, `signing key`, `sign-in`, `identity`, `context`, `readiness`, and `gas` when it waited). `readiness` is exactly
section 8's object. When setup is not ready, `error.details` carries the same `readiness`, `steps`, `context` and `created`, and `funding` when
gas is the only gap:

```json
"funding": {
  "chain": "base-sepolia", "symbol": "ETH", "address": "0xE293…cAcB", "balance": "0",
  "minimum": "0.0001", "suggested": "0.001", "send": "0.001", "least": "0.0001", "satisfied": false, "estimated": true,
  "faucet": "https://www.alchemy.com/faucets/base-sepolia",
  "payment_uri": "ethereum:0xE293…cAcB@84532?value=1000000000000000",
  "steps": [ "Send 0.001 ETH to … (0.0001 ETH is the least that works; the rest saves a second trip)." ],
  "wallet_steps": [ "Some faucets refuse a contract address, and this account is one. …", "Then, from that wallet, send 0.001 ETH to … " ]
}
```

`minimum` is what lets the readiness gas check pass: the chain's gas reserve (an **estimate**; no per-execution figure is published) plus
`--amount`. `suggested` is ten reserves, so the next few sends do not each need a faucet. `send` is the difference from `balance` (all of
`suggested` when the balance is unknown); `least` is the least to send now to clear `minimum` (`"0"` when it is already cleared). A chain with no estimate has `null` for the three and `estimated: false`: no number is invented.
`payment_uri` is an EIP-681 request with the network, the account and the amount set, in **integer wei**. Nothing in `funding` is a quote.

**`certen gas`** is the abstract account's gas on one chain: what it holds, what to send where, and (with `--wait`) the moment it arrives. It
is not `certen fund`, which tops up the organization's gateway balance (the stablecoin that pays CERTEN's fees). It signs nothing and takes no
key; `--from-wallet` prints the transfer to make from a wallet you control.

```
certen gas [--chain <chain>] [--identity <ref>] [--amount <whole units>] [--gas-reserve <amount|none>]
           [--wait] [--from-wallet] [--timeout <duration>] [--poll-interval <interval>]
```

Which identity and chain comes from the context (section 7), echoed on stderr. **Exit `0` only when the account has enough** (the `gas` check of
section 8 is `ok` or `warn`). Otherwise `1`, with `error.code` the check's code (`ABSTRACT_ACCOUNT_UNFUNDED`, `ABSTRACT_ACCOUNT_UNDERFUNDED`,
`ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE`), `FUNDS_WAIT_TIMEOUT` or `CHAIN_NOT_LINKED` (the identity has no account on that chain); `2` for a
mistake in the invocation; `3` unreachable; `130` interrupted. The envelope carries the whole plan either way, under `data` on success and
`error.details` on failure, so a script can show the address and the wallet link without parsing prose:

```json
{ "identity_id": "11111111-…", "abstract_account": "0xE293…cAcB", "funded": false,
  "chain": "base-sepolia", "symbol": "ETH", "address": "0xE293…cAcB", "balance": "0", "minimum": "0.0001", "suggested": "0.001", "send": "0.001", "least": "0.0001",
  "satisfied": false, "estimated": true, "faucet": "https://…", "payment_uri": "ethereum:0xE293…cAcB@84532?value=1000000000000000",
  "steps": [ ], "wallet_steps": [ ],
  "check": { "name": "gas", "status": "fail", "code": "ABSTRACT_ACCOUNT_UNFUNDED", "detail": "…" } }
```

`waited: true` is added when `--wait` returned because the funds arrived; `timed_out: true` / `interrupted: true` on the failures that end a wait.
`funded` is the readiness check's verdict; `satisfied` is the plan's own arithmetic on the balance it was given, and the two agree on every balance
the check can read.

**Not changed:** `certen init` exits `0` once its own steps are done, whether or not the account can act yet, and keeps its output. `setup` is the
strict command; it shares the credential, key and identity steps with `init` rather than replacing it.

### 10. Send, receipts and the confirmation card: `certen send`, `certen receipt`, `certen watch`

Three commands, one document. **`send`** moves native value and ends in a **receipt**; **`receipt`** shows it again, refreshing whatever was
pending; **`watch`** picks a wait back up. The receipt is the record the walkthrough always told people to keep (the intent, the Accumulate
transaction, the destination transaction, the proof), assembled for them, with what is established kept apart from what is not.

#### The confirmation card

Every command that signs shows one card before the signature: `send`, `call`, `tx create --sign-with`, `governance <operation> --sign-with` and
`pending sign --sign-with`. It is on **stderr in both modes** (it is never part of the envelope). It carries a headline in the person's own terms
(`Send 0.0001 ETH on base-sepolia`), the recipient and the sender in full, a fee line, a `context` row naming every value the person did **not**
type and where it came from, then the rebuilt summary (`You are about to sign: …`, verbatim, as in the Signing section above) and the line *The
signature authorises exactly this: it was rebuilt from the gateway's bytes and matched to your request.* Under it, at a terminal, the question
`Sign with "<key>"?`.

- **The question is asked only of a person.** At a terminal, without `--yes` and without `--json`. The default answer is yes on a known testnet and **no
  on anything else**, where the card also puts the chain name in capitals and says `NOT A KNOWN TESTNET: this moves real funds` (a chain nobody can
  classify is treated the same way: unknown is not ok). A `no` ends the command with `SIGNING_DECLINED` (exit `1`; `error.details.intent_id` when an intent
  had already been opened, which then expires unsigned). Nothing was signed, charged or moved.
- **`--yes` skips the question, never the check.** The rebuild-and-match of the signing data (the Signing section above) runs inside the SDK before any
  signature and has no switch. `--yes` is new on `call`, `tx create`, `governance <operation>` and `pending sign` (and on `send`).
- **Where nobody can answer, the commands that have always signed unattended keep doing so.** `call`, `tx create --sign-with`, `governance` and
  `pending sign --sign-with` print the card and sign when piped, exactly as before: refusing them would break scripts that work today. **`send` is new
  and strict**: with no terminal, no `--yes` and no `--json` it exits `2` with `CONFIRMATION_REQUIRED` before it reads a passphrase or makes a request.
  `--json` counts as an answer: the caller that asked for an envelope is a program.
- **The fee line is an estimate, or it says it is not available.** It is the price book's `proof.execute` entry for the chain (`GET /v1/pricing`, platform
  fee only; a `quoted` entry adds gas when it executes, up to a ceiling) plus the chain's gas reserve (the same planning figure as readiness, section 8).
  A price book that cannot be read, or has no such entry, prints `Not available: …`, never a number. `send` always reads it; the other four commands read it
  only when a person is going to see the question (a script does not pay for a request it will not read).

#### `certen send`

```
certen send <amount> <asset> --to <address> [--chain <chain>] [--identity <ref>] [--sign-with <key>] [--yes] [--dry-run]
            [--wait | --no-wait] [--timeout <duration>] [--poll-interval <interval>] [--rpc <url>] [--force]
            [--gas-reserve <amount|none>] [--accumulate-rpc <url>] [--proof-class on_demand|on_cadence]
            [--idempotency-key <key>] [--expires-in <duration>]
```

`certen send 0.0001 ETH --to 0xRecipient` is the whole transfer. Identity, chain and key come from the context (section 7), each echoed on stderr when it
was not typed, and **a chain that is not a known testnet never comes from a default** (`MAINNET_DEFAULT_REFUSED`, exit `2`; spell it out with `--chain`). In this
order:

1. **The invocation, with no network.** `<amount>` is **whole units** as a decimal string (`INVALID_AMOUNT`, exit `2`, for a wei-looking integer of ten or more digits, a
   non-decimal, or zero). `--to` must be an EVM address; **a mixed-case address whose EIP-55 checksum does not hold is refused** (`INVALID_ADDRESS`, exit `2`) and the
   message names the correct capitalisation. An all-lower-case or all-upper-case address carries no checksum and is accepted. `<asset>` must be the chain's native
   symbol: **`send` moves a chain's native token only** (`UNSUPPORTED_ASSET`, exit `2`, for anything else; `ETH` on a chain whose gas is TEL is refused, not sent as TEL). What
   a token transfer moves (the token contract and its decimals) is chosen downstream, so it cannot be rebuilt and checked before signing, and nothing is signed that cannot
   be checked; the message names `certen call` with `transfer(address,uint256)`. A chain the catalogue does not know is `UNSUPPORTED_CHAIN` (exit `2`).
   `--rpc` (or `CERTEN_RPC_URL`) must be an http(s) URL with no username or password (`INVALID_RPC`, exit `2`; the message never repeats the URL, which can carry a key).
   With no signing key, `MISSING_SIGNING_KEY` (exit `2`) unless `--dry-run`; with nobody to confirm, `CONFIRMATION_REQUIRED` (above).
2. **Readiness, before anything is unlocked.** `client.readiness()` (section 8) for this identity, chain, key and amount, and the fee estimate, in parallel. **A passphrase is never
   asked for in order to fail.** A *failing* check refuses with `NOT_READY` (exit `1`, `error.details.readiness` with `first_blocker` set to the one that stopped it; `NETWORK_ERROR`,
   exit `3`, when the gateway is unreachable). An `unknown` check is **shown on stderr and does not block**: a balance the gateway has not reported yet is not evidence of zero, and the
   funding guard has never blocked on one. `--force` excuses the gas checks (`ABSTRACT_ACCOUNT_UNFUNDED`, `ABSTRACT_ACCOUNT_UNDERFUNDED`) and nothing else, which is all it has ever meant.
3. **`--dry-run` stops here.** A failing check refuses first, dry run or not (so a dry run that exits `0` is one that would go on). Otherwise it prints what would be sent and exits `0`; nothing is signed or sent. `data`:

   ```json
   { "dry_run": true,
     "request": { "kind": "transfer", "chain": "base-sepolia", "chain_id": 84532, "identity_id": "396f863c-…", "adi_url": "acc://alpha.acme",
                  "from": "0xE293…cAcB", "to": "0x2222…2222", "amount": "0.0001", "asset": "ETH", "contract_call": null },
     "fee": { "state": "estimated", "sku": "proof.execute", "chain": "base-sepolia", "platform_fee_usd": "0.040000", "mode": "quoted", "max_charge_usd": "0.500000",
              "gas_reserve": "0.0001", "gas_symbol": "ETH", "price_book_version": "2026-10-15", "note": "An estimate from the price book: the platform fee only. Gas is priced when it executes, up to a ceiling." },
     "readiness": { "ready": true, "state": "ready", "first_blocker": null, "context": { }, "checks": [ ] } }
   ```
4. **The recipient's balance, if you gave a node.** With `--rpc`, the node's `eth_chainId` is checked against the chain (a node on another network is refused, `EVM_RPC_WRONG_CHAIN`) and the
   recipient's balance is read **before** the value moves. A node that cannot be used stops the send here, with nothing signed (exit `1`, the `EVM_RPC_*` code): someone who asked for an
   independent check should not discover it was not made after the value has gone.
5. **Unlock, open, check, confirm, sign.** The passphrase is read now; the intent is opened; the SDK rebuilds and matches the signing data (`SIGNING_DATA_MISMATCH` and friends,
   exit `1`); the card is shown; a person says yes (or `--yes` / `--json` did).
6. **The outcome.** Unless `--no-wait` (and with `--json` the default is `--no-wait`, as for `tx create`; pass `--wait`), it waits for the proof cycle (60–110 seconds; the budget is
   `--timeout`, default 7 minutes, never shortened), verifies the proof **here**, checks the value arrived, writes the receipt and prints it.

**Exit codes of `send`, `receipt` and `watch` come from the receipt** (and are the same for all three):

| Exit | When |
|:--:|---|
| `0` | `verdict: "verified"`, or `"unproven"` (the action executed and its proof can never be produced; nothing can be verified, and it says so). Also `send --no-wait`, after the signature is in (the receipt reads `pending`) |
| `1` | `verdict: "failed"`: the intent failed (`TX_FAILED`, an `ok:false` envelope), or a layer of the proof was checked and does not hold (an `ok:true` envelope whose `receipt.verdict` is `failed`, like `proof verify`). Also `TX_WAIT_TIMEOUT` (the wait ran out; the intent may still complete), `NOT_READY`, `SIGNING_DECLINED` and the pre-signing refusals above |
| `2` | a mistake in the invocation (codes above), raised before any request |
| `3` | the gateway could not be reached (`NETWORK_ERROR`); nothing was signed |
| `4` | `verdict: "partial"` (something is not established: `receipt.gaps` names each) or `"pending"` (not finished, or executed with its proof still being produced) |
| `5` | `verdict: "partial"` and `receipt.proof.verdict: "no_evidence"`: nothing about the Accumulate side could be checked |
| `130` | Ctrl-C while waiting (`INTERRUPTED`). **The intent keeps running**; nothing was cancelled |

So `0` is "done **and** checked", never merely "done": a script that reads `0` as verified is right, and one that must tolerate "done, not yet checked" accepts `4`.

On a finished wait, one envelope on stdout (the card, the progress and the human receipt are stderr in `--json` mode):

```json
{ "ok": true, "data": { "receipt": { }, "saved_to": "/home/me/.certen/receipts/7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13.json" } }
```

(`saved_to` is `null` only for `receipt` when a saved file this version cannot read is left alone; see below.) When the wait **ends in an error** the receipt is saved from the last
thing the gateway said and travels in the error, so the ids are not lost with the terminal:

```json
{ "ok": false, "error": { "code": "TX_WAIT_TIMEOUT", "message": "…", "retryable": false, "details": {
    "intent_id": "7c1e3b0a-…", "last_status": "anchoring", "last_class": "in_flight", "timeout_ms": 420000,
    "receipt": { }, "receipt_path": "/home/me/.certen/receipts/7c1e3b0a-….json", "resume": "certen watch 7c1e3b0a-…" } } }
```

`TX_FAILED` (`reason_code`, `reason`) and `INTERRUPTED` (exit `130`; `last_status`) carry the same three additions. If Ctrl-C arrives before the first reading there is nothing to save and the
error carries only what it already had. Ctrl-C stops the **wait**, not the intent: the handler exists for the length of the wait and no longer, and `resume` is the command that continues.

#### `certen receipt` and `certen watch`

```
certen receipt [<intent>] [--list] [--explain] [--rpc <url>] [--expect <address:topic0[:topic1]>] [--share] [--offline] [--refresh]
certen watch <intent> [--timeout <duration>] [--poll-interval <interval>] [--rpc <url>] [--expect <address:topic0[:topic1]>]
```

**`receipt`** with no argument shows the most recent saved receipt (it says which, on stderr; `NO_RECEIPTS`, exit `2`, when there is none). With an intent id it reads the intent,
**re-verifies the proof here**, re-checks the effect (with `--rpc`), and rewrites the saved receipt, keeping its `created_at`, its `request` and its pre-signing snapshot. Any intent can be
shown, not only one this machine sent; a receipt for one it did not send has no request on record, so there is no effect to check and its verdict rests on the proof alone. Options:

- **`--list`**: `data` is `{ "receipts": [ { "intent_id", "updated_at", "verdict", "kind", "headline", "path" } ] }`, newest first. Asks the gateway nothing.
- **`--offline`**: shows the saved receipt as it is and asks nothing (`refreshed: false`; `NO_SAVED_RECEIPT`, exit `2`, when none can be used). It cannot be combined with `--rpc`, `--share` or `--refresh` (`CONFLICTING_FLAGS`, exit `2`).
- **`--refresh`**: read the gateway again and re-verify even when the saved receipt is **final**. A final receipt (`verified`, `failed` or `unproven`) has nothing pending, so a bare `receipt` shows it as saved without asking the gateway (`refreshed: false`, and a line on stderr says so): asking again could only make it weaker, because a bare `receipt` consults no node of yours. `--rpc`, `--expect` and `--share` are asking, so they read the gateway. A `partial` or `pending` receipt is always refreshed.
- **`--explain`**: the human receipt also lists the proof layer by layer (stdout in table mode, stderr with `--json`). The envelope always carries the layers in `receipt.proof.layers`.
- **`--rpc <url>`** (or `CERTEN_RPC_URL`): a node you trust on the execution chain. The bundle's receipts root and block hash are compared with the header it returns (closing the proof's execution layer), and the recipient's balance is read from it.
  With no snapshot saved before signing, the balance at the block before the execution block is the baseline (a node that no longer holds that state makes the effect `unreadable`, not `not_observed`).
- **`--expect <address:topic0[:topic1]>`**: an event the execution receipt must contain, as in `proof verify`. For a contract-call receipt it decides `effect.expected_event`.
- **`--share`**: `proof.share` on the receipt's `ids.proof_id`: a link a counterparty opens to verify the proof with no CERTEN account. `data.share` is `{ "url", "expires_at" }`.
  A receipt without a proof id is `NOTHING_TO_SHARE` (exit `1`).

`data` is `{ "receipt", "saved_to", "refreshed": true }` (plus `share`, and `saved_receipt_kept`, below).

**A saved receipt is never silently made weaker.** If this read establishes *less* than the saved receipt because less was asked, the saved receipt was compared with a node of yours (`proof.node_checked`) or had read the recipient's balance and this read did neither, the read is shown but the file is **left as it is**: `saved_to` is the existing file, `saved_receipt_kept` says why (`"it was compared with a node of yours and this read was not"`), and stderr says `The saved receipt was left as it is`. Run it again with `--rpc` to refresh that one. A *contradiction* (a proof layer that now fails) is news and is always saved. `watch` follows the same rule. **A saved receipt that this version cannot use** (not JSON, another intent's, or a `receipt_version` newer than this CLI reads) is reported on
stderr, a fresh receipt is built from the gateway, and **the file is left as it is** (`saved_to: null`): it is never overwritten.

**`watch <intent>`** waits (in `--json` mode too: `watch` exists to wait), then shows the receipt. It reads the intent once first, so one that has already finished is not waited for. It
picks up where Ctrl-C or a timeout left off: `send`, `watch` and `receipt` share one implementation and cannot disagree about what they believe. `data` is `{ "receipt", "saved_to" }`; same exit codes and
error details as above. `--timeout` and `--poll-interval` take `90s`, `6m`, `1h` (a bare number is minutes / seconds) and default to the proof-cycle budget used everywhere.

#### The receipt document

`receipt_version` is `1`. New fields are additive; a field never changes type or disappears. A version this CLI does not know is "unusable", never half-read.

```json
{ "receipt_version": 1,
  "intent_id": "7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13",
  "kind": "transfer",
  "created_at": "2026-10-16T03:23:06.085Z", "updated_at": "2026-10-16T03:25:41.512Z",
  "gateway": "https://gateway.kompendium.co",
  "request": { "kind": "transfer", "chain": "base-sepolia", "chain_id": 84532, "identity_id": "396f863c-879c-4046-8591-3f0405c5f6bd", "adi_url": "acc://alpha.acme",
               "from": "0xE293e95Ec1471155d977448B99B0922C2828cAcB", "to": "0x2222222222222222222222222222222222222222",
               "amount": "0.0001", "asset": "ETH", "contract_call": null },
  "signed_with": { "key": "dev", "public_key_hash": "90b1a11d61b6bb3039d5b46141af38a77c23c8c7c194223793f6a4f09a83c91c" },
  "status": { "gateway_status": "completed", "class": "terminal_success", "outcome": "completed", "terminal": true,
              "reason_code": null, "reason": null, "completion_basis": "proof_artifact", "validator_state": "settled" },
  "ids": { "intent_id": "7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13",
           "accumulate_tx": "acc://abababababababababababababababababababababababababababababababab@alpha.acme/data",
           "accumulate_tx_hash": "abababababababababababababababababababababababababababababababab",
           "destination_tx": "0x591707ddd9c0292196f0671b48f8ec71c696f5c7c97ca9d39a629ead652d5d48", "destination_tx_source": "proof",
           "destination_chain": "base-sepolia", "destination_block": 46437431,
           "proof_id": "11111111-2222-4333-8444-555555555555", "write_back_tx": null },
  "links": { "destination_tx": "https://sepolia.basescan.org/tx/0x591707ddd9c0292196f0671b48f8ec71c696f5c7c97ca9d39a629ead652d5d48",
             "accumulate_explorer": "https://explorer.accumulatenetwork.io" },
  "stages": [ { "id": "signed", "label": "signed", "state": "done" },
              { "id": "anchored", "label": "anchored on Accumulate", "state": "done", "detail": "abababab…" },
              { "id": "executed", "label": "executed on base-sepolia", "state": "done", "detail": "0x591707dd…" },
              { "id": "proof_verified", "label": "proof verified locally", "state": "done" } ],
  "effect": { "kind": "native_transfer", "state": "confirmed", "amount": "0.0001", "symbol": "ETH",
              "detail": "The recipient's balance rose by exactly 0.0001 ETH (at block 46437431 on the node at sepolia.base.org). The abstract account's balance fell by 0.0001 ETH (as the gateway reports it).",
              "recipient": { "source": "rpc", "host": "sepolia.base.org", "address": "0x2222222222222222222222222222222222222222", "symbol": "ETH",
                             "before": "0.2", "after": "0.2001", "delta": "0.0001", "at_block": 46437431 },
              "sender": { "source": "gateway", "address": "0xE293e95Ec1471155d977448B99B0922C2828cAcB", "symbol": "ETH",
                          "before": "0.001", "after": "0.0009", "delta": "-0.0001", "at_block": null } },
  "proof": { "verdict": "verified", "detail": "11 of 11 layers carried, all checked here from the proof's own bytes.",
             "checked_here": true, "node_checked": true,
             "layers": [ { "id": "trust_base", "title": "Genesis network values are bound to the pinned incarnation", "verdict": "verified", "statement": "S2", "evidence": { } },
                         { "id": "outcome", "title": "The execution on the destination chain", "verdict": "verified", "statement": "S6", "evidence": { } } ],
             "layers_total": 11, "layers_verified": 11, "layers_not_carried": 3, "not_established": [],
             "proof_id": "11111111-2222-4333-8444-555555555555", "evidence": { "found": true } },
  "verdict": "verified",
  "headline": "VERIFIED: 11 of 11 layers carried, checked here",
  "gaps": [],
  "recipient_snapshot": { "address": "0x2222222222222222222222222222222222222222", "wei": "200000000000000000", "host": "sepolia.base.org",
                          "chain_id": 84532, "taken_at": "2026-10-16T03:23:01.204Z" } }
```

(`proof.layers[]` is shortened here: the real list is every layer of the proof document, as in `proof verify`.)

| Field | Meaning |
|---|---|
| `kind` | `transfer` (from `send`), `contract_call` (from `call`), `intent`, or `unknown` for a receipt built from an intent id alone |
| `request` | What was asked for, as the CLI sent it. `null` for an intent this machine did not send (kept from the saved receipt on a refresh). `amount` is whole units; `contract_call` is `{ target, function_signature, value_wei }` for a call |
| `signed_with` | The local key's name and its public key hash. No secret is ever recorded |
| `status` | The gateway's status verbatim (`gateway_status`), its class (`in_flight`, `executed`, `terminal_success`, `terminal_gas_only`, `terminal_failure`, `unknown`), the named `outcome` (`completed`, `completed_unproven`, `executed`, `failed`, `pending`, `unknown`), and the reason and completion basis when there are any |
| `ids` | Everything worth keeping. **`destination_tx` is not a field of the intent**: it is the transaction of the **verified execution proof** (`destination_tx_source: "proof"`), else the validators' own `settlement_tx` (`"validators"`, not yet proved), else `null`. It is never guessed. `accumulate_tx_hash` is the 64-hex hash extracted from `accumulate_tx` |
| `links` | `destination_tx` is an explorer link, only for an EVM chain whose explorer the gateway's registry names; `accumulate_explorer` is the Accumulate explorer's base (no path is guessed) |
| `stages` | `signed`, `anchored`, `executed`, `proof_verified`, each `state` `done` · `pending` · `failed` · `unknown` · `skipped`, with a `detail` where there is one. `proof_verified` is `done` only for a verified proof; a PARTIAL proof is `unknown`, never `done` |
| `effect` | Did the value arrive. `kind`: `native_transfer`, `contract_call` or `none`. `state`: **`confirmed`** (the recipient's balance rose by at least the amount, read from a node of yours; or the expected event is in the receipt) · **`not_observed`** (it did not; `detail` names why that can be benign, and the proof is what says what executed) · **`unchecked`** (no node was given, so the recipient was not read: the gateway cannot read another address) · **`unreadable`** (a node was given and could not be used, or there is no baseline) · `not_applicable` (nothing to compare: a call with no expected event, or no request on record). `recipient` is read from **your** node (`source: "rpc"`, `host` only, never the URL); `sender` is the abstract account as the gateway reports it, **supporting evidence that never decides the state**. `delta` is signed, `after` minus `before`. A balance difference is an observation between two moments, and `detail` says so |
| `proof` | `verdict`: `verified` · `partial` · `failed` · `no_evidence` · `unavailable` (the proof could not be fetched: not the same as there being none) · `pending` · `not_applicable` (the intent failed, or its proof can never exist). `checked_here` is true only when a verifier ran in this process over bytes the gateway served; `node_checked` is true only when the bundle's receipts root and block hash were compared with a header from a node you gave. `layers[]` are the proof's layers (`verified` · `failed` · `not_checked` · `not_in_document`, with `reason`, `statement` and `evidence`); `not_established` lists the carried layers that are `not_checked`; `evidence` is `{ found, code?, reason?, bundle_error? }` as in `proof verify` |
| `verdict` | The weakest honest reading: **`verified`** · **`partial`** · **`failed`** · **`pending`** · **`unproven`** |
| `headline` | One line, in plain words, that a person can read instead of the rest. Not a contract; `verdict` is |
| `gaps` | What is not established, one entry each: `{ code, text }` |
| `recipient_snapshot` | The recipient's balance taken before signing (`address`, `wei`, `host`, `chain_id`, `taken_at`), so a later `receipt --rpc` can still measure the rise. `null` without `--rpc` |

**How the verdict is reached.** A failed intent (`failed`, `expired`, `error`) is `failed`; `completed_unproven` is `unproven`; anything not finished, or `executed` with the proof still being
produced, is `pending`. A `completed` intent is `verified` **only if** its proof is `verified` **and** the effect is `confirmed` (or `not_applicable`). A proof with a layer that was checked and does
not hold is `failed`. Everything else is `partial`: a proof with a layer not established, no evidence, a proof that could not be fetched, or a verified proof whose value-arrival check was
`not_observed`, `unchecked` or `unreadable` (the headline says which). **PARTIAL and NO EVIDENCE are never shown as verified, and unknown is never ok.**

**`gaps`.** `verified` always has `gaps: []`, and a `partial` or `pending` receipt always has at least one (a `failed` receipt for an intent that failed, and `unproven`, have none: the status itself is the whole story). The codes:

| `code` | Meaning |
|---|---|
| `INTENT_NOT_TERMINAL` | The intent has not finished |
| `PROOF_PENDING` | It executed; its proof bundle is still being produced |
| `PROOF_NOT_FETCHED` | The proof could not be fetched right now (a 5xx or a network failure: not the same as there being none) |
| `PROOF_NO_EVIDENCE` | Nothing about the Accumulate side could be checked (`PROOF_V2_EVIDENCE_NOT_SERVED` and the like) |
| `PROOF_LAYER_NOT_ESTABLISHED` | A layer the document carries is `not_checked`; `text` names it and why |
| `PROOF_LAYER_FAILED` | A layer was checked and does not hold |
| `NODE_NOT_CONSULTED` | The execution layer rests on the validators' own statement of the block until it is compared with a header from a node you trust (or the node you gave could not be used, and `text` says why) |
| `EFFECT_UNCHECKED` · `EFFECT_UNREADABLE` · `EFFECT_NOT_OBSERVED` | The three non-confirming states of `effect`, with its `detail` |

**What VERIFIED needs, plainly.** The proof's execution layer (S6) leaves `not_checked` only when the receipts root is compared with a block header from **a node of yours**
(`--rpc` or `CERTEN_RPC_URL`), because until then it is the validators' statement about themselves. **Without one, a receipt is PARTIAL, naming that layer, however good the rest is**; that is the
honest reading, not a gap in the CLI. Likewise a proof whose Accumulate page chains were not captured (`G1_chains` is `not_checked`, `g1_chain_uncaptured`) is PARTIAL: the
repository's conformance capture is one, so **offline runs against the test fake end in PARTIAL (exit `4`) naming `G1_chains` and the execution layer, and a VERIFIED receipt end to end is
unverified live** (it needs a live proof whose page chains are captured, and a node of yours). The `verified` rules above are pinned by tests over constructed inputs; the live path is for a human to run.

**Your node.** `--rpc` / `CERTEN_RPC_URL` is the caller's: http(s) only, no username or password in the URL, no redirect followed, the reply bounded in size and time, and no CERTEN credential ever sent to it. **The URL is
never printed, saved or returned**: hosted node providers put an API key in the path, so every message, the receipt and the envelope name only the host. The node's `eth_chainId` must equal the chain (a balance
from another network would mean nothing). A flag is `INVALID_RPC` (exit `2`) if it is not usable; at run time:

| `error.code` | Exit | Meaning |
|---|:--:|---|
| `EVM_RPC_INVALID` | 1 | The endpoint is not http(s), or carries a username or password |
| `EVM_RPC_UNREADABLE` | 1 | No answer in time, a non-200, an oversize reply, a reply that is not JSON or has no result |
| `EVM_RPC_ERROR` | 1 | The node returned a JSON-RPC `error` (its message, shortened) |
| `EVM_RPC_WRONG_CHAIN` | 1 | The node is on another chain (`details`: `expected`, `actual`, `host`) |
| `EVM_RPC_CHAIN_UNKNOWN` | 1 | The chain is not in the catalogue, so the node cannot be checked to be on it |
| `EVM_RPC_NO_BLOCK` | 1 | The node has no such block (pruned, lagging or another network), or sends a header without a receipts root: **it compared nothing with the proof** |

In `send` an unusable node stops the send before signing. In `receipt` and `watch` the proof is still checked **without** it and the gap `NODE_NOT_CONSULTED` names why. In `proof verify --rpc` it is an error.
`proof verify --rpc` goes through the same SDK code as the receipt; **before this release a node that had no such block made the execution layer read `verified`** (a bare block number was compared with itself), and it
is now `EVM_RPC_NO_BLOCK`.

#### Where receipts live

`~/.certen/receipts/<intent_id>.json`, mode `0600` in a `0700` directory, written **atomically** (beside its name, then renamed over it, so a Ctrl-C or a full disk leaves the previous receipt intact). A receipt holds ids, addresses,
hashes, verdicts, the gateway's address and a node's **host**; it holds no key, no passphrase, no API key and no node URL, so it is safe to attach to a ticket. It is written once the intent id exists and **however the wait ends**
(a failed intent, a timeout and Ctrl-C included; the first reading of a wait is saved at once). `RECEIPT_NOT_SAVED` (exit `1`) says the transaction is unaffected and names the intent id to keep. Tests and tools point `HOME` / `USERPROFILE` at a
temporary directory.

**`call` in table mode.** `call --wait` (not `--json`) ends with the same receipt after its usual output, and saves it; a receipt that cannot be built is a hint on stderr, never a failed call. Its `--json` envelope (the transaction) and its exit code are unchanged; `certen receipt <intent> --json` is the receipt.

#### New error codes

| `error.code` | Exit | Where |
|---|:--:|---|
| `CONFIRMATION_REQUIRED` | 2 | `send` with no terminal, no `--yes`, no `--json` |
| `SIGNING_DECLINED` | 1 | a person answered no to the card (any signing command); `details.intent_id` when an intent was opened |
| `INVALID_ADDRESS` | 2 | `send --to` is not an EVM address, or its EIP-55 checksum does not hold |
| `UNSUPPORTED_ASSET` | 2 | `send`: the asset is not the chain's native token |
| `UNSUPPORTED_CHAIN` | 2 | `send`: the chain is not one the CLI can state the native token of |
| `INVALID_RPC` | 2 | `--rpc` / `CERTEN_RPC_URL` is not usable (never repeats the URL) |
| `INVALID_INTENT_ID` | 2 | `receipt` / `watch` was given something that is not an intent id |
| `NO_RECEIPTS` | 2 | `receipt` with no argument and none saved |
| `NO_SAVED_RECEIPT` | 2 | `receipt --offline` with no usable saved receipt |
| `CONFLICTING_FLAGS` | 2 | `receipt --offline` with `--rpc`, `--share` or `--refresh` |
| `INVALID_EXPECT` | 2 | `--expect` is not `<address>:<topic>[:<topic>]` with 0x and the right number of hex characters (`call`, `receipt`, `watch`) |
| `EXPECT_NEEDS_WAIT` | 2 | `call --expect` without the wait (`--no-wait`, or `--json` without `--wait`) |
| `WRONG_PASSPHRASE` | 1 | any signing command: the key could not be decrypted. Raised when the key is opened, **before** any intent exists (it used to surface at signing time as an untyped error) |
| `NOT_READY` | 1 | `send` pre-flight found a failing check (`details.readiness`) |
| `NOTHING_TO_SHARE` | 1 | `receipt --share` on a receipt with no proof id |
| `RECEIPT_NOT_SAVED` | 1 | the receipt could not be written; the transaction is unaffected |
| `EVM_RPC_*` | 1 | your node (above) |
| `INTERRUPTED` | 130 | `send` / `watch`: Ctrl-C while waiting (`details.resume`, `details.receipt`) |

`WAIT_ABORTED` is the SDK's code for the same event (`execute.wait()` with an `AbortSignal`); the CLI reports it as `INTERRUPTED`. `TX_FAILED` and `TX_WAIT_TIMEOUT` are unchanged, and now also carry `receipt`, `receipt_path`
and `resume` when raised by `send` or `watch`.

### 11. Every failure ends with one command: `error.next`

A failure that ends in prose leaves the reader to work out what to type. The CLI already knows: the code says what went wrong, the command
that was running says where, and for nearly every failure there is a single command that moves forward. So **every failure, in both modes,
ends with exactly one**:

- `--json`: `error.next`, a string, on every failure envelope (additive: a consumer that ignores unknown keys is unaffected);
- table mode: the **last line on stderr**, `  next: <command>`.

```json
{ "ok": false, "error": {
  "code": "ABSTRACT_ACCOUNT_UNFUNDED",
  "message": "The abstract account 0x7a3…c91 on base-sepolia holds no testnet gas. …",
  "retryable": false,
  "next": "certen gas --chain base-sepolia --wait"
} }
```

```
Error [IDENTITY_CANNOT_SIGN]: Identity acc://jason-dev.acme cannot sign — its key page is not held by your key. …
  next: certen status
```

Rules, each of them held by a test:

- **One plain command line.** `next` is a single line that starts with `certen ` and holds nothing a shell would act on. `<angle>` tokens
  (`certen use chain <chain>`, `certen watch <intent-id>`, `certen fund <usd>`) are placeholders for a value **you** choose; a command
  with no placeholder can be run as printed.
- **It is a hint to run, not a promise.** `next` is the single most useful next command, not a guarantee that it fixes the cause. It is never
  run for you, and a caller that runs it automatically is choosing to.
- **Never built from gateway text.** `next` is a line a person may paste into a shell and an agent may run, so a gateway that said "run
  `certen fund 99999`" must not be able to put that on it. The only values interpolated into it are ones the CLI checks against a strict pattern: a
  UUID (an intent or identity id), a chain slug (lowercase letters, digits and hyphens), or a local key name. Anything else becomes the
  placeholder (`<intent-id>`, `<chain>`, `<key>`). The payment target in a 402 (`resolve.cli_command`, section 2) is a field you may read, never a `next`.
  Whatever is handed in is also checked at the end: a line that is not one plain `certen ...` command is replaced.
- **Every failure has one.** That includes a usage error found by the parser, a failure of a code this CLI has never heard of, and an
  untyped one. The answer comes from the first rung of this ladder that has one:

  | | Where `next` comes from | Example |
  |:--:|---|---|
  | 1 | **The error itself**, when the code that raised it holds the chain, key or id | `NOT_READY` from `send`/`status` is the first failing check's own fix command; `CHAIN_NOT_LINKED` is `certen identity link-chain <that id> --chain <that chain>` |
  | 2 | **The code's entry** in the CLI's table, one for every code the CLI itself raises, and for the SDK's client-side codes | `NO_API_KEY` → `certen setup`; `IDENTITY_CANNOT_SIGN` → `certen status`; `ABSTRACT_ACCOUNT_UNFUNDED` → `certen gas --chain <chain> --wait` |
  | 3 | **The gateway's catalogue**, for a code it publishes that the table does not cover: `certen errors <CODE>` says what it means, whose side it is and whether retrying can help | `RATE_LIMIT_EXCEEDED` → `certen errors RATE_LIMIT_EXCEEDED` |
  | 4 | **The HTTP class**, for a gateway code nobody has catalogued | 401 → `certen setup --existing-account`; 403 → `certen whoami`; 402 → `certen fund <usd>`; 5xx → `certen doctor`; other 4xx → the command's `--help` |
  | 5 | **The failing command's help**, for a usage error or an untyped failure (`certen <command> --help`; `certen --help` at the root); **`certen doctor`** for a typed failure nobody classified | `USAGE_ERROR` from `tx create` → `certen tx create --help` |

  The command that was running is known without parsing `argv`: it is recorded when an action starts, and by the parser for the errors it finds
  before any action does.

Some entries depend on which command raised the code, because the same code wants a different answer: `NO_API_KEY` raised by `setup` (which
cannot ask which kind of account, with no terminal) is `certen setup --existing-account`, by `auth login` it is that command's help, and elsewhere
`certen setup`; `FUNDS_WAIT_TIMEOUT` and `INTERRUPTED` are `certen setup` from `setup`, `certen gas --wait` from `gas`, and `certen watch <intent-id>`
from a wait on an intent (`TX_WAIT_TIMEOUT` and a failed wait name the intent from `error.details.intent_id`: `TX_FAILED` → `certen receipt <intent-id>`);
`NETWORK_ERROR` is `certen doctor`, except from `doctor` itself, where it is `certen context` (which shows the gateway it tried).

**What guarantees it.** `packages/cli/test/next-step.test.ts` reads the CLI's source and fails if any code a `CliError` or `UsageError` is built
with lacks an entry of its own (landing on the fallback does not count), so a new code cannot ship without a next step; it holds every line the table can
produce to the real command tree (the command exists, every `--flag` is one it declares, it is given no more arguments than it takes), so advice cannot go
stale when a flag is renamed; and `conformance.test.ts` pins the envelope and the last stderr line for the cases above, with exactly one `next:`.

Nothing else moves: the exit codes, the one-envelope rule, `retryable`, `details`, and the verdict exits `4`/`5` of `proof verify`, `send`,
`receipt` and `watch` are as before. A verdict is not a failure and carries no `error.next`; its own next step is the `Next:` line a receipt prints on stderr (section 10).

### 12. Keys that stay unlocked for a while: `certen keys unlock`, `certen keys lock` (experimental)

By default every command that signs asks for the key's passphrase, once. `certen keys unlock <name> --for <duration>` keeps the **decrypted key** in
the OS keyring until an expiry, so commands in that window do not ask; `certen keys lock` wipes it. It is **inert unless `CERTEN_EXPERIMENTAL_KEY_UNLOCK=1`
is set**: it ships behind a written security review (`docs/security/keys-unlock-review.md`), and with the switch off every command, output and prompt is
exactly what it was. Nothing below is a stable interface until that review is signed off.

```bash
CERTEN_EXPERIMENTAL_KEY_UNLOCK=1 certen --json keys unlock dev --for 15m
# {"ok":true,"data":{"name":"dev","public_key_hash":"…","unlocked_until":"2026-10-16T08:15:00.000Z","for_seconds":900}}
certen keys lock dev            # or --all
# {"ok":true,"data":{"locked":["dev"],"not_unlocked":[],"keyring":"ok"}}
```

- **What is stored is the decrypted key, never the passphrase** (a passphrase is a human secret that is reused elsewhere), with an absolute expiry. The default is
  `15m` and the longest is `8h` (`90s`, `15m`, `1h`; a bare number is minutes).
- **The expiry is checked every time the key is used**, and a stale, malformed or tampered entry is removed and ignored. There is no background process: bytes can remain in
  the keyring after the expiry until the next CLI run or `keys lock`.
- **A session replaces only the passphrase.** The confirmation card, the rebuild-and-match of what is signed and the question all still run; `--yes` still skips only the question.
- **It never falls back to a file.** With no usable OS keyring it refuses (`KEYRING_UNAVAILABLE`). A key stored without a passphrase has nothing to unlock (`KEY_NOT_ENCRYPTED`).
- `keys lock` always works, with the switch off too. `data.keyring` is `"unavailable"` when no OS keyring can be loaded at all (so nothing can have been unlocked, and nothing is wiped: that is not
  a failure). A keyring that loads and then will not confirm a removal is a failure (`KEYRING_UNAVAILABLE`, exit 2, naming the entries to remove by hand): a person told "locked" must be right.
- With the switch on, `keys list` gains `unlocked_until` (an ISO time, or `null`) per key; with it off the listing is unchanged.

| `error.code` | Exit | |
|---|:--:|---|
| `KEY_UNLOCK_NOT_ENABLED` | 2 | `keys unlock` without the switch |
| `UNLOCK_DURATION_INVALID` | 2 | `--for` is zero, not a duration, or longer than 8 hours |
| `KEY_NOT_ENCRYPTED` | 2 | the key has no passphrase |
| `KEYRING_UNAVAILABLE` | 2 | no OS keyring can be used |
| `WRONG_PASSPHRASE` | 1 | the passphrase did not open the key; nothing is stored |
| `LOCK_TARGET_REQUIRED` | 2 | `keys lock` with neither a name nor `--all` |

### 13. The same two documents for an agent: `certen_readiness`, `certen_receipt` (MCP)

`@certen.io/mcp` answers "can this identity act?" and "what happened to this intent?" with the documents the CLI prints, so an agent and a script read the same
thing. The MCP server is not the CLI: there is no envelope, no exit code and no `~/.certen`. The tool result **is** the object, and an error is an MCP error result
(`isError: true`) whose text is `{"error":{"code","message","status","retryable",…}}`, exactly as every other tool's. Nothing in sections 1 to 12 changes.

| MCP tool | Returns | Same as |
|---|---|---|
| `certen_readiness { identityId, chain, keyHash?, amount?, tokenSymbol? }` | the `readiness` object of section 8 (`ready`, `state`, `first_blocker`, `checks`, `context`) | `certen status --json` → `data.readiness`, less what only a CLI can see (a key on this machine) |
| `certen_receipt { intentId, header?, transfer?, call? }` | the receipt of section 10 (`receipt_version: 1`) | `certen receipt <intent> --json` → `data.receipt` |

Where it differs, and why (each is a rule of the MCP server, tested in `packages/mcp/test`):

- **No tool takes a node to call.** `certen receipt --rpc <url>` has no counterpart. The execution layer is closed with a block `header` the **caller** fetched from its own node:
  `{ receiptsRoot, hash?, number? }`. **`receiptsRoot` is required**: a header with no receipts root (`{}`, or only the block number the bundle itself states) compares nothing, and is refused
  with `INVALID_HEADER` (status `0`, nothing was requested) rather than read as a comparison that passed. `certen_proof_verify` takes the same header under the same rule: before this it
  passed such a header to the verifier, where it found no disagreement and the execution layer read `verified` having compared nothing. A header together with a node is `CONFLICTING_OPTIONS` in the SDK.
- **The recipient's balance cannot be read here**, so a receipt for a `transfer { chain, to, amount }` has `effect.state: "unchecked"`, carries the `EFFECT_UNCHECKED` gap, and is never `verified`
  until the caller has read the recipient from its own node. `call { chain, expect: { address, topic0, topic1? } }` is judged from the proof's own execution receipt, as `--expect` is.
  With neither, the receipt has no request on record: `request` is `null`, `effect.state` is `not_applicable`, and `verified` then speaks to the proof only.
- **`certen_readiness` never names a command.** `checks[].fix` is `{ text, url? }`; `fix.command` is a CLI's addition and an agent has no CLI to run. The Accumulate endpoint for the independent key page read
  is the one the gateway's chain registry advertises, or the operator's `CERTEN_ACCUMULATE_RPC`; it is never an argument.
- **The invocation is checked before a request is made**, with status `0`: `INVALID_IDENTITY_ID` and `INVALID_INTENT_ID` (not a UUID), `INVALID_KEY_HASH`, `INVALID_AMOUNT` (not whole units, or wei-looking),
  `INVALID_ADDRESS` (bad EIP-55 checksum included), `INVALID_TRANSFER`, `INVALID_CALL`, `INVALID_EXPECTATION`, `CONFLICTING_OPTIONS` (`transfer` with `call`), `INVALID_HEADER`, and `UNSUPPORTED_CHAIN` for a chain this server does
  not enable (`CERTEN_ENABLED_CHAINS`).
- **An argument the tool does not have is refused by name, not ignored.** `UNKNOWN_ARGUMENT` lists the ones it takes; `NODE_ARGUMENT_REFUSED` is the same for a name that means "call this node" (`rpc`, `accumulateRpc`, `url`,
  `endpoint`, `node`, …) and says what to do instead. Ignoring it would let an agent believe the node was used. This holds inside `transfer`, `call` and `call.expect` too.
- **It writes nothing.** The result is the record; keep it if you want it.

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
