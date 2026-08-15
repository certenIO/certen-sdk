# Changelog — @certen.io/cli

## 0.7.0 — one response shape

**Breaking for `--json` consumers.** Requires a gateway from 2026-08 or later.
### Added — `certen proof open <link>`

Read a proof someone shared with you. **Runs with no API key configured** — the recipient of a
share link has no CERTEN account, and every other share command (`share`, `shares`, `shares revoke`)
serves the sender.

```
certen proof open https://gateway.kompendium.co/v1/proof/shared/<token>
certen proof open <link> --out proof.json
```

An expired or revoked link exits non-zero saying to ask for a fresh one, rather than reporting that
the proof does not exist.

### Added — `certen verify <receipt-id>`

Confirm a charge instead of being told it is fine.

```
PASS  digest      sha256(canonical_json(body)) matches the stated digest.
PASS  signature   ed25519 signature verifies against published key bd4a7a92f29958b9.
PASS  inclusion   This receipt is leaf 1254 of 1269.
PASS  root        Audit path folds to the root of the independently fetched signed head at 1269.
SKIP  anchor      No anchored tree head covers this receipt yet.
```

The receipt already carried a `verification` block; it is CERTEN checking CERTEN. This recomputes
everything from published data and compares the folded root against a tree head fetched separately.

**It exits non-zero when it did not fully verify — including when checks were merely SKIPPED.** An
incomplete run is not a pass, and exiting 0 would let a script report an unverified receipt as
verified. The report survives the failure under `error.details`, matching `certen doctor`.

### Added — `certen ledger`, `certen receipts`, `certen receipt`

Where the money went, and proof of what you were charged — neither was reachable from the terminal.

```
certen ledger --all                  # every balance change, paged for you
certen receipts                      # NUMBER, WHEN, TYPE, AMOUNT, EVIDENCE
certen receipt <id> --proof          # signature, and the inclusion proof
```

`EVIDENCE` shows `signed + logged`, because `logged` is what decides whether an inclusion proof
exists — without it you ask for one, get a 404, and cannot tell "not yet" from "wrong id".

The anchor line reads `covering_head`, not `head`: a receipt whose own tree head is unanchored is
still anchored by any later root that commits to it, and reporting `head` would call a perfectly
good receipt unproven for every gap between anchors. An unattested anchor time is labelled a loose
upper bound rather than presented as the block time.

`--all` pages for you and refuses `--offset` alongside it; a non-numeric `--limit` and
`--tree-size` without `--proof` are both rejected before any network call.

### Added — `certen payers` and `certen payers add`

Register a wallet you send from, so deposits credit on sight instead of needing a one-time payment
opened for the exact amount before every send. This is what a 402 already told you to do, at an
endpoint no command could reach.

```
certen payers add 0xAbC… --chain base-sepolia --label treasury
certen payers                                  # what is registered
```

A malformed address is rejected before the network call, an empty list says so plainly rather than
looking like success, and a 409 (the address belongs to another organization on that chain) exits
non-zero — a funding script must not read it as "attribution is set up".

### Changed — `certen balance` makes one request instead of two

It fetched the balance and `/v1/billing/obligations` concurrently, because the balance alone could
not say how much was actually left to commit. The gateway now reports that with the balance, so the
second request is gone. Against an older gateway the command still falls back to it — printing
`spendable_usd` in the "Left to commit" slot would report committed money as available.

### Added — `certen pricing`, and `--sku` on `certen quote`

There was no way to ask the CLI what anything costs. `certen quote` prices one operation and takes
its sku from a vocabulary nothing published — and it had no `--sku` flag at all, so it could only
ever price the default. Asking "what does CERTEN cost" meant reading the gateway's refusals.

```
$ certen pricing --chain base-sepolia

  SKU                 CHAIN         PRICE
  identity.provision  *             $5.00
  proof.execute       base-sepolia  $0.35 + gas
```

`+ gas` marks prices that are completed at execution, so a floor is not read as a total. `*` is the
entry that applies to any chain without one of its own, and is kept when filtering by chain —
dropping it would report identity provisioning as unpriced on a chain where it costs $5.

`certen quote --sku <sku>` now prices any of them, and exits non-zero when pricing is not
configured rather than reporting an empty catalogue.

### Changed — `certen call` no longer reads the same balances twice

It fetched the identity (it needs `can_sign` before prompting for a passphrase), then fetched
`/v1/portfolio` for balances the identity response had already returned — a round trip on the
critical path of the main flow, for numbers it was holding.

The guard now takes those balances when the caller has them, and still reads the portfolio when the
gateway sends none, so an older gateway does not silently lose the guard.

### Added — `certen tx list --all`

Fetches every page instead of the first. Answering "how many intents failed this month" previously
meant a shell loop incrementing `--offset` and knowing when to stop; getting that wrong reads as
"there were none".

With `--all`, `--limit` is the page size rather than a cap, and `--offset` is rejected — `--all`
starts from the beginning, so the two together have no coherent meaning.

### Breaking — `certen identity` JSON output is no longer wrapped

`certen --json identity get <id>` and `certen --json identity create` returned the identity nested
under an `identity` key. It is now at the top level, matching every other command and the API.

```bash
# before
certen --json identity get "$ID" | jq -r '.data.identity.can_sign'
# after
certen --json identity get "$ID" | jq -r '.data.can_sign'
```

The envelope itself (`{ ok, data }` / `{ ok, error }`) and the exit codes are unchanged, as is table
output, which was never a contract. See `docs/CLI-CONTRACT.md`.

### Fixed — `certen tx status --json` reports absent fields as `null`

`proof_id`, `proof_bundle_url`, `accum_tx_hash` and `error_message` came back as `""` when the
gateway had no value, so `.proof_id != null` was true for a transaction with no proof. They are now
`null`. A script testing `if .proof_id then` is unaffected; one testing `!= null` was wrong before
and is right now.

### Fixed — `can_sign` distinguishes "cannot sign" from "could not check"

An unreadable key page reported `can_sign: false`. It now reports `null`, and the table prints
`unknown`. The two have different fixes: one is repairable with `certen identity update
--public-key`, the other is a retry.

## 0.6.0 — from eighteen steps to four

### Added — `certen login` / `certen signup`

The device authorization grant. The CLI prints a short code, you approve it in a portal session you
already trust, and the key arrives over the CLI's own channel. **The secret is never displayed and
never passes through a clipboard or shell history.** Requires a gateway that serves
`/v1/portal/device`; against an older one it says so and points at the portal.

### Added — `certen init`, `call`, `proof`, `chains`, `whoami`, `doctor`, `identity retire`

`init` creates only what is missing, waits until the identity can actually sign, and records the id
so a later run reuses it rather than burning org quota. `call` is a proof-gated contract call in one
command — it derives the ADI URL, the abstract account and the numeric chain id from the identity,
and type-checks `--arg` against the Solidity signature before anything is sent. `proof` retrieves,
bundles, shares and verifies. `doctor` names the one thing blocking you and the command that fixes
it.

### Behavioural change — usage errors now exit 2

A wrong invocation used to exit 1, indistinguishable from a rejected request. Several commands threw
untyped errors; they now exit 2 as the contract always specified. Scripts branching on any non-zero
exit are unaffected; scripts that treated 1 as "the gateway said no" should re-check.

### Behavioural change — `auth login` verifies the key before saving it

A typo'd or revoked key used to be written and then surface as an opaque 401 at whatever command ran
next. It is now checked first and **not saved if rejected**. A 403 means the key is real but
unscoped and is accepted with a note. `--api-key -` reads from stdin; omitting it prompts.

### Behavioural change — human mode waits by default

`identity create` and `tx create` poll to a usable state. `--json` keeps the old fire-and-forget
default so existing scripts do not silently start blocking.

### Added — the unfunded-account guard, and `error.details`

A value transfer from an empty abstract account is refused before submitting, naming the faucet;
`--force` overrides. And a failure that still produced a result carries it under `error.details` —
`certen --json doctor` returns every check that way, so signalling the failure never costs you the
diagnosis. See docs/CLI-CONTRACT.md.

## 0.5.0 — money commands, and a refusal that tells you how to fix it

### Added — `certen balance` and `certen fund`

`balance` prints available, held, credit line, spendable, and **left to commit** — spendable minus
what pending intents have already claimed. Showing only the balance would tell you that you can
afford work that is already spoken for.

`fund <amount> --chain <chain>` prints where to send stablecoin and waits until it is credited.
It never touches a wallet or a key: signing and sending stay with you. `--no-wait` prints the
details and exits; `--poll-interval` and `--timeout` control the wait. An uncredited or expired
payment exits non-zero, because a funding script must not read one as paid.

Every option is validated before the network call — a typo in `--timeout` used to open a real
payment intent first.

### Changed — a 402 now prints the way out

A refusal for lack of funds shows the shortfall, the address, the exact amount, the reference, both
`certen fund …` and the portal link, and the quote id to retry with — then states plainly that
nothing was charged and no work was started. All on stderr; stdout is untouched.

In `--json`, the failure envelope gains `shortfall_usd`, `quote_id` and `resolve` on payment
failures only. They are absent on every other error rather than present as nulls. See
docs/CLI-CONTRACT.md.

### Fixed — the error reporter no longer flattens SDK errors

`handleError` copied a `CertenError` into an object literal before reporting it. The values
survived; the class identity did not — so a payment refusal could not be recognised and its payment
target was silently dropped. The fields it copied are all readable on the instance, `isRetryable`
getter included, so nothing was gained by the copy.

## 0.4.0 — `--json` is a machine contract

Adds a stable, tested output contract for scripts and AI agents. **Human output is unchanged**: if
you do not pass `--json`, this release behaves exactly as 0.3.1 did, with one exception noted under
Breaking.

Before this, every failure exited `1` and explained itself in English on stderr. An automated caller
could not distinguish "you passed a malformed address" from "the gateway is down" without parsing
prose — and those want opposite responses. One is a bug to fix; the other is worth retrying. For a
CLI that authorizes cross-chain execution against real funds, guessing wrong is expensive in a way
that is not recoverable.

The full specification is [docs/CLI-CONTRACT.md](../../docs/CLI-CONTRACT.md), enforced by
`test/conformance.test.ts`, which runs the built binary as a subprocess and checks the real process's
stdout and exit code.

### Added

- **Global `--json`**, accepted anywhere in the argument list — `certen --json tx status X` and
  `certen tx status X --json` are identical. It is resolved before argument parsing, so it applies
  even to failures that occur while resolving credentials.
- **One JSON envelope on stdout and nothing else.** `{"ok":true,"data":…}` or
  `{"ok":false,"error":{"code","message","retryable","status?","requestId?"}}`. A command producing
  several payloads emits an array in `data`; one producing none emits `"data":null`. stdout is never
  empty and never carries two concatenated objects. All human-facing text moves to stderr.
- **Meaningful exit codes:** `0` ok · `1` operation failed · `2` usage error · `3` gateway
  unreachable. `3` guarantees nothing was submitted, so a retry cannot double-execute.
- **`error.retryable`**, taken from the SDK's own `CertenError.isRetryable`, so the CLI and the SDK
  hand an automated caller the identical retry decision.
- **`certen --help --json`** returns the entire command tree — every command, argument, flag and exit
  code — in one call, instead of scraping help text once per subcommand.

### Fixed

- **Usage errors on subcommands bypassed error handling entirely.** `exitOverride()` is not inherited
  by commander subcommands, so a missing required flag (`certen identity create` with no `--name`)
  called `process.exit(1)` inside commander: no envelope was emitted, stdout stayed empty, and a
  usage error was indistinguishable from a failed request. It is now applied to every command in the
  tree.

### Breaking

- **"No API key configured" now exits `2` instead of `1`.** It is a usage error: nothing was sent,
  and retrying cannot help. The same applies to a config file with unsafe permissions and to a
  missing keyring backend. Scripts treating any non-zero exit as failure are unaffected; scripts
  testing specifically for `-eq 1` need updating.

### Note

`output: "json"` in `~/.certen/config.json` is **not** this contract. That setting predates the
envelope and makes commands print their raw payload — no `ok`, no `error`, no exit-code guarantees.
It is kept for backward compatibility. Automated callers should pass `--json` explicitly rather than
depend on a machine's local config, which they cannot see.
