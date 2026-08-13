# Changelog — @certen.io/cli

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
