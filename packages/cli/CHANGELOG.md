# Changelog — @certen.io/cli

## 0.7.0 — one response shape

**Breaking for `--json` consumers.** Requires a gateway from 2026-08 or later.
### Added — `certen fund` closes the money path

Four changes to the last step of onboarding, which is the only one where a mistake costs money
rather than time.

**A link a wallet can open.** `--uri` emits an EIP-681 request carrying the token contract, the
numeric chain, the recipient and the amount in the token's smallest unit — so the transfer stops
being four values transcribed by hand. **A mistyped recipient is the one error in this product that
loses real money irreversibly.** The amount is converted with string and BigInt arithmetic, never
floats: `25.10 * 1e6` is `25099999.999999996` in IEEE-754, which truncates to one unit short of the
amount attribution matches on — a deposit that arrives and is never credited, with nothing on either
side saying why. It is also in the machine payload unconditionally, so a script building a deep link
never repeats that arithmetic.

**Register the payer when you know which wallet you are sending from.** `--payer 0x…` registers it
inline, so future deposits credit on sight with no exact-amount match to beat. `init --payer` existed
but runs before anyone has chosen a wallet. A payer failure can never break the payment: the deposit
target is valid regardless, and reporting a payer problem as a payment problem would send someone
hunting for a transfer that was never made.

**How long it will take.** `Credited after 3 confirmation(s)` became `— about 6 seconds on
base-sepolia`, computed from block time and labelled an estimate. A confirmation count alone gives no
way to tell a slow chain from a broken command, which is when people interrupt and send twice.

**One payload per reader.** `fund` printed the raw table *and* the readable instructions, the same
defect fixed in `balance`. It mattered more here once the table carried the payment URI: a person saw
the long link whether or not they asked, which buried the deposit address.

### Changed — `certen quote` says how long the price is good for

`--id` reported a status and an expiry timestamp, leaving the reader to subtract against a clock to
answer the only question they had. Now `Valid for another 4m 12s`, with `seconds_remaining` on the
SDK response so a caller can branch without touching a date.

### Changed — `certen balance` answers the question instead of listing the figures

Three things, all on the one command someone runs to find out whether they can keep working.

**It printed everything twice.** The raw key/value table rendered alongside the readable summary, so
every figure appeared once as `available_usd  -72.355716` and again as `Available -$72.35` — with
`credit`, a nested object, showing as a line of raw JSON in between. The useful rendering came
second, under eleven lines of noise. Machine consumers now get the payload and a person gets the
summary, which is what every other command in this group already did.

**A negative balance is a drawdown, not a fault.** `Available -$72.35` was the first line a credit
account saw, with nothing to say that drawing on a credit line is how the account is meant to work.
It now reads `Drawn on credit $72.36`.

**The thresholds are stated as a distance.** `Warning at $125.00 drawn · service stops at $250.00`
published the limits without the number they are measured against, so the reader had to find
`available_usd`, negate it, and compare by hand — to answer whether their service is about to stop.
It now reads `Drawn $72.36 of $250.00 (first warning at $125.00)`, and past the warning threshold it
leads with the headroom and the command to fix it.

### Fixed — money rendered two different ways

There were two copies of the currency formatter. `billing.ts` handled a leading minus and
`whoami.ts` did not, so a drawn-down account rendered `-$72.35` in one command and the malformed
`$-72.35` in the other. Both are replaced by one exported helper, which also rounds the cents
half-up rather than truncating — the old one displayed `-72.355716` as `-$72.35`, a cent kinder to
the account than the truth.

### Added — `certen signup --with-key`

Onboarding with nobody in the loop at all.

```
certen keys create dev              # a keypair, never leaves this machine
certen signup --with-key dev        # an organization, in one step
certen init --key dev               # identity, chains, verified
```

No browser, no email, no waiting for anyone to approve anything. The CLI signs a server-issued nonce
with a key it already has; CERTEN sees a public key and a signature and never the private half —
which is what non-custodial should mean at signup, not only afterwards.

### Added — `certen orgs` and `certen signup --token`

Onboarding an organization without a browser.

```
certen orgs invite --name "Acme" --expires 7d   # a human, once, in advance
certen signup --token crt_...                   # the machine, later, alone
```

`certen signup` previously printed a code and waited — indefinitely — for somebody to open a
browser and approve it. That is right for a person at a terminal and a wall for CI, for a platform
provisioning its customers, and for an agent starting up. `--token` is the same command with the
human moved earlier in time.

`certen orgs list` shows what each token became, which is the link between a decision someone made
and an organization now on their bill. `certen orgs revoke` stops an unredeemed one; a token that
has already been redeemed cannot be revoked, and says so rather than implying the organization can
be un-created.

### Added — `certen identity mnemonic`

Collect the mnemonic from a `signing_mode: "provider"` identity. There was no way to do this from
the CLI at all, and the retrieval token is consumed on first read and expires in about ten minutes —
so the seed was lost by default unless someone hand-rolled the request.

**Writes to a file, mode 0600, rather than printing.** Stdout is scrollback, CI logs, and whatever
is recording the session; a seed phrase outlives its usefulness there by years. `--print` is there
for anyone who genuinely wants it on screen, and `--json` gives the value to a script that asked.

Takes the `mnemonic_retrieval.url` straight from the create response, or an id and token separately.
An unparseable target fails before any request is issued, because a half-parsed target would spend a
one-shot token for nothing.

### Added — `certen oauth-clients`

`list`, `create`, `rotate-secret`, `remove`. A deployment could authenticate with client credentials
and could not create the client those credentials belong to, which is where "automated" stopped
being true.

`rotate-secret --grace <seconds>` is the one worth knowing: the previous secret keeps working while
the fleet picks up the new one, so changing a credential is not an outage. `remove` is the opposite
and says so — it revokes every live token immediately.

### Added — `certen errors`

`certen errors` lists every code the gateway you are talking to can return; `certen errors <CODE>`
explains one. Needs no API key. This is the command to run when a code shows up in a log and the
question is whether to retry, pay, or wake someone — `retryable` answers "can this exact request
ever work", and a `platform` audience says plainly that there is nothing on your side to change.

### Added — `certen quote --id`

Read back a quote you already hold instead of guessing whether it is still good. Same command as
issuing one, because it is the same question; it answers "still usable" outright rather than leaving
a status string and a timestamp to compare by hand.

### Added — `certen auth revoke-token`

Revoke a leaked OAuth2 token from the terminal. **Works with no API key configured** — the gateway
authenticates the request with the token itself, and requiring the credential you are trying to
contain would be backwards.

Reads from stdin or a prompt when no argument is given, so a live token does not land in shell
history or a process listing. `--refresh` marks it as a refresh token, whose revocation also kills
every access token descended from it.

### Fixed — the CLI test suite no longer flakes

Every test in that package spawns the CLI as a real subprocess, against vitest's 5s default — a
budget sized for in-process tests. The slowest case measured **4353ms**, about 13% headroom, so
ordinary scheduling load tipped a passing test over; `doctor.test.ts` failed in a full run and
passed alone. Raised to 20s, roughly 4.5x the measured worst case: a genuine slowdown still fails
rather than hanging, but noise no longer reads as a broken test.

### Added — `certen webhooks`

`list`, `add`, `remove`, `verify`, `rotate-secret`, `deliveries`, `redeliver`.

`certen webhooks deliveries` is the command that earns the group: it shows the status, HTTP code and
error for each attempt, and prints the exact `redeliver` command for anything that failed. Without
it a dropped delivery was indistinguishable from an event that never fired. `--failed` narrows to
just the ones that did not arrive.

Registering prints the signing secret with a plain warning that it is shown once — the only
recovery is rotating, which invalidates whatever the previous secret was already signing.

### Changed — `certen receipts get <id>` replaces `certen receipt <id>`

Two top-level commands differing by one character, sitting adjacent in help. Now one group, matching
`tx` and `identity`: `certen receipts` lists, `certen receipts get <id>` fetches one. `certen verify`
stays top-level — it is the command that answers "can I prove this charge", and burying it would
hide it.

Both commands were added in this same release and neither has shipped, so nothing external breaks.

### Changed — commands fetch only the identity data they read

`certen call`, `certen init` and `certen identity retire` all fetched an identity with every
enrichment: on-chain governance, per-chain balances, and pending counts. `call` reads the balances
(for the unfunded-account guard) and never touches governance or pending; the other two need none of
it. Each unused enrichment is a live query — governance is a network round trip, balances runs once
per linked chain — and they sat on the critical path of the flagship command.

### Added — `scripts/measure-onboarding.mjs`

Records round trips, wall-clock and endpoints touched for each step of the first-run journey, by
running the real CLI through a counting proxy. Onboarding had never been measured end to end, so
there was no way to tell whether any of this work reduced friction or moved it.

First run: 12 requests, 10.7s. After bounding the gateway health probe: **12 requests, 4.9s** — both
measured against a local gateway with every downstream absent, so they are a floor for the read path
and nothing more.

Against production (`https://gateway.kompendium.co`, 2026-08-16): **14 requests, 5.5s**. Two of the
eight steps exit non-zero there — `certen pricing` and `certen scopes` — not because of anything in
the CLI, but because `GET /v1/pricing` and `GET /v1/scopes` are not deployed yet. The measurement
found the same gap `npm run check:gateway` reports, from the other direction.

### Changed — `certen whoami` reports your organization and scopes instead of guessing

It printed `organization: "not exposed to API keys — see the portal"`, and reported permissions as
`scopes_observed` — a guess assembled from which probe calls happened to return 200 rather than 403,
which can only ever describe the scopes it thought to test for.

It now reads `GET /v1/me`: the real organization name, the granted scopes, the key id and its rate
limit. Still two requests, but the third call to `/v1/admin/usage` is gone — it existed only to
infer whether the key held `admin:read` — so `whoami` no longer needs that scope at all.

**Breaking for `--json` consumers:** `scopes_observed` (an object of booleans) is replaced by
`scopes` (an array of granted scope names), and `organization` is now `{ id, name }` rather than an
explanatory sentence.

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

### Added — `certen ledger`, `certen receipts`

Where the money went, and proof of what you were charged — neither was reachable from the terminal.

```
certen ledger --all                  # every balance change, paged for you
certen receipts                      # NUMBER, WHEN, TYPE, AMOUNT, EVIDENCE
certen receipts get <id> --proof     # signature, and the inclusion proof
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
