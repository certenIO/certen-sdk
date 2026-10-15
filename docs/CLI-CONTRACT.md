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
| `130` | `setup` and `gas` only: **stopped with Ctrl-C while waiting for funds** (`error.code` `INTERRUPTED`) | Nothing was left half-done. Run the same command again to continue. Never a failure of the operation. |

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
  "exitCodes": { "0": "ok", "1": "operation failed", "2": "usage error", "3": "gateway unreachable", "4": "proof verify: partial (a layer is not established)", "5": "proof verify: no evidence to check", "130": "stopped with Ctrl-C while waiting (setup, gas); nothing was left half-done" },
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
