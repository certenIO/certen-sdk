# Changelog — @certen.io/cli

## 0.11.1 — the first release of everything below (2026-10-17)

**`0.11.0` was never published.** Its release run failed in the workflow's own test step, before anything was packed or staged: six CLI tests wrote a damaged key file, or a config holding an API key, with the default file mode, and off Windows the CLI refuses a file that group or world can read
(`KEY_FILE_INSECURE`, `CONFIG_PERMISSIONS`) before it looks inside, so on Linux they reported the refusal instead of the error each test is about. The CLI's behaviour is unchanged and was right; only those test fixtures were wrong, and they now write owner-only files as the CLI itself does.
Everything in the `0.11.0` section below is in this release, and it is the section to read: the exit-code change, the new commands and the signing prompts are all there. Needs `@certen.io/sdk` 0.11.0.

## 0.11.0 — (not published; released as 0.11.1) context, readiness, setup and gas, send and receipts, and a CLI that tells you the next step (CLI UX plan, 2026-10-16)

**Read this if a script branches on exit code `1`:** seven key-store failures move from exit `1` / `UNKNOWN_ERROR` to exit `2` with a code of their own (the table is in `docs/CLI-CONTRACT.md`
section 14, and the first section below lists them). Everything else is additive: new commands, flags, `--json` fields and codes, and every existing command and flag keeps its meaning.
Two things can look different to a person: the signing commands now ask before they sign **when you are at a terminal** (piped, they behave exactly as before), and the funding guard compares
the balance with the amount and an estimate of the gas, not only with zero (`--force` bypasses it as before). Needs `@certen.io/sdk` 0.11.0.

### Included — the key store speaks in codes; older advice says `setup` (CLI UX, Phase 6 follow-ups)

One exit-code change, on purpose and for a short list of failures, and nothing else that works today changes. A maintainer versions and publishes this.

### Changed (exit codes: read this if a script branches on `== 1`)
- **Key-store failures are typed, and seven of them move from exit `1` / `UNKNOWN_ERROR` to exit `2`.** They were bare errors, so `keys show nope` was indistinguishable from a rejected request. Now, exit **2**: `UNKNOWN_KEY` (no key with that name, from every command that takes one, the same
  answer `certen use key nope` always gave), `INVALID_KEY_NAME`, `KEY_EXISTS`, `INVALID_HASH`, `PASSPHRASE_REQUIRED` (an encrypted key with no passphrase available; it used to be reported as `WRONG_PASSPHRASE`), `PASSPHRASE_MISMATCH` and `NO_TTY`.
  Exit **1**, as before but with a code now: `WRONG_PASSPHRASE`, `KEY_FILE_CORRUPT`, `KEY_FILE_UNSUPPORTED`, `KEY_FILE_INSECURE`. Every message is word for word what it was; each failure also ends with its `next:` (`certen keys list`, `certen keys path`, `certen keys verify <key>`). A script that branches on `!= 0` is unaffected.
  Table in `docs/CLI-CONTRACT.md` section 14.
- **Every message that told a person to run `certen init` first now says `certen setup`** (`status`, `doctor`, `signup`, `context`, and the identity-reference and readiness fixes), including `certen setup --key <name>` after `signup --with-key`. `init` is unchanged and keeps every flag; a test now scans every string the CLI can print for the old advice.

### Fixed
- **`signup --with-key` never uses an unlocked session.** With the experimental `keys unlock` switch on, it would have signed the 32 bytes the gateway chose without a prompt. The passphrase prompt is the one moment a person is made to notice a key is being used, so `signup --with-key` now always asks (`setup` already did). Answers review question 5 (`docs/security/keys-unlock-review.md`); the switch is still off by default.
- **A key that needs a passphrase when none can be supplied is `PASSPHRASE_REQUIRED`, not `WRONG_PASSPHRASE`**, and a damaged key file says so (`KEY_FILE_CORRUPT`) instead of the JSON parser's words.

### Not changed, on purpose
- **Where a report goes.** `doctor`, `status`, `gas` and the readiness card print their report on stdout and exit `1` when it is a problem, like `diff` and `grep`; the failure line and `next:` are on stderr. This was reported as a bug in `doctor` alone; it is the behaviour of the whole family and `gas`'s report is its product, so it is documented (section 15) and pinned instead (`doctor.test.ts` gained the table-mode tests it lacked).

### Included — learnability: `next:` on every failure, a help that leads with five commands (CLI UX, Phase 5)

Nothing that works today changes. Every command and flag keeps its meaning and its exit code; the `--json` change is one added field, and the human change is one added line at the end of a failure. A maintainer versions and publishes this.

### Added
- **Every failure ends with exactly one command to run: `next:`.** In `--json` it is `error.next`, a single `certen ...` line on every failure envelope (additive: a consumer that ignores unknown keys is unaffected); in table mode it is the **last line on stderr**, `  next: <command>`. `NO_API_KEY` ends `next: certen setup`, an identity that cannot sign `certen status`, an unfunded abstract account `certen gas --chain base-sepolia --wait`, a wait that ran out `certen watch <intent-id>`, a wrong flag `certen <command> --help`, a gateway that could not be reached `certen doctor`, and a code the gateway publishes `certen errors <CODE>` (what it means and whether retrying can help). Where the code that raised the error holds the chain, key or intent id (the funding guard, `send`, `status`, `setup`, `wait`, the receipt commands), `next` names them. See `docs/CLI-CONTRACT.md` section 11.
  - **It is a hint to run, not a promise it fixes the cause**, and **it is never built from gateway text.** `next` is a line a person may paste into a shell and an agent may run, so the only values interpolated into it are ones the CLI checks against a strict pattern (a UUID, a chain slug, a local key name); anything else becomes a `<placeholder>`, and a line that is not one plain `certen ...` command is replaced. A 402's `resolve.cli_command` is still a field you may read; it is not a `next`.
  - **Every failure has one**, including a usage error found by the parser (the help of the command that found it), a gateway code nobody has catalogued (placed by its HTTP class) and an untyped failure (the failing command's help). A drift test reads the CLI's source and fails when any code a `CliError` or `UsageError` is built with has no entry of its own, and a second holds every line the table can produce to the real command tree (the command exists, every `--flag` is declared on it), so a new code cannot ship without a next step and advice cannot go stale.
- **`certen keys unlock <name> [--for <duration>]` and `certen keys lock [name] [--all]` (experimental, off by default).** Keeps the *decrypted key* (never the passphrase) in your OS keyring until it expires, so signing commands in that window do not ask for the passphrase; `keys lock` wipes it. The default is 15 minutes and the longest 8 hours; the expiry is checked every time the key is used (there is no background process, so `keys lock` is how to be sure it is gone); it never falls back to a file where there is no OS keyring (`KEYRING_UNAVAILABLE`); a key stored without a passphrase has nothing to unlock (`KEY_NOT_ENCRYPTED`). It replaces the passphrase and nothing else: the confirmation card and the check of what is signed still run. **It does nothing unless `CERTEN_EXPERIMENTAL_KEY_UNLOCK=1` is set**, because it ships behind a written security review (`docs/security/keys-unlock-review.md`); with the switch off, every command, output and prompt is exactly what it was, and a keyring entry someone planted is never read. `keys lock` works either way, and `keys list` gains `unlocked_until` only while the switch is on. New codes: `KEY_UNLOCK_NOT_ENABLED`, `UNLOCK_DURATION_INVALID`, `KEY_NOT_ENCRYPTED`, `LOCK_TARGET_REQUIRED` (exit 2).

### Changed
- **`certen --help` leads with the five commands a person types**, in the order of the journey: **Start here** (`setup`, `send`, `call`, `status`, `receipt`), then Follow it through (`watch`, `proof`, `gas`, `doctor`), Your account (`whoami`, `context`, `use`, `identity`, `keys`, `chains`, `portfolio`, `login`, `signup`, `auth`, `init`), Approve (`pending`, `governance`), Money (`balance`, `fund`, `pricing`, `quote`, `payers`, `ledger`, `receipts`, `verify`) and, last, **Advanced** (`tx`, `admin`, `scopes`, `webhooks`, `oauth-clients`, `orgs`, `errors`). The quickstart is `setup`, `send`, `receipt` instead of a contract call against a placeholder address. Nothing is hidden or removed (a test asserts every registered command is listed, once), and `certen --help --json` is unchanged.
- **`tx create --help` puts the plumbing options under their own heading, "Advanced options":** `--from-chain`, `--contract-address`, `--signer-key-page`, `--signer-public-key`. They still work, still appear, and keep their defaults; a person meeting the command for the first time sees the flags a transfer needs first.
- `init`'s closing hint and the identity hints point at `setup`, `send` and `receipt` rather than the long `call` form.

### Not changed, on purpose
- **The text of existing messages.** Several still say "Run: certen init" or "Check with: certen tx status" (older advice that remains valid); `next:` is the up-to-date, single answer beside them, and the pinned tests keep their wording.
- **Exit codes, the one-envelope rule, `retryable` and `details`**, and the verdict exits (`4`, `5`, `130`) of `proof verify`, `send`, `receipt` and `watch`. A verdict is not a failure and carries no `error.next`.

### Included — send and receipts (CLI UX, Phase 4)

Nothing that works today changes. Every command and flag keeps its meaning, and every `--json` change is a new command, an added field, a new flag or a new code. The one thing that can look different to a person is that the signing commands now ask before they sign **when you are at a terminal**; piped, they behave exactly as before. A maintainer versions and publishes this.

### Added
- **`certen send <amount> <asset> --to <address>`**: the whole transfer, as one command. `certen send 0.0001 ETH --to 0xRecipient` takes what a person knows and does the rest in the order that keeps them safe: it checks the invocation with no network, checks **readiness before it asks for a passphrase**, shows the confirmation card, signs, waits for the proof cycle (Ctrl-C safe), verifies the proof here, checks the value arrived, and writes a receipt. Identity, chain and key come from your context and are echoed on stderr when you did not type them; **a chain that is not a known testnet never comes from a default**.
  - **Readiness before the passphrase.** `send` runs the same checks as `certen status` (your key page from Accumulate, the credits, the gateway balance, the gas for *this* amount) before anything is unlocked, so a passphrase is never asked for in order to fail. A failing check refuses (`NOT_READY`, with the readiness in `error.details`); a check that could not be answered is shown and **does not block**, as the funding guard has always worked. `--force` excuses the gas checks only, which is all it has ever meant.
  - **Native token only.** What a token transfer moves (the contract and its decimals) is chosen downstream, so it cannot be rebuilt and checked before signing, and nothing is signed that cannot be checked. Any other asset is refused by name (`UNSUPPORTED_ASSET`), and `ETH` on a chain whose gas is TEL is refused, not guessed. A wei-looking amount and a zero amount are refused (`INVALID_AMOUNT`).
  - **A recipient with a bad checksum is refused** (`INVALID_ADDRESS`): a mixed-case address that does not match its EIP-55 checksum is a mistyped one, and the message names the correct capitalisation. All-lower-case and all-upper-case addresses carry no checksum and are accepted.
  - **`send` needs a person or `--yes`.** With no terminal, no `--yes` and no `--json` it exits `2` with `CONFIRMATION_REQUIRED` before it reads a passphrase. `--dry-run` runs the checks and prints what would be sent. `--no-wait` returns once the signature is in (exit `0`; the receipt reads `pending`); `--json` is `--no-wait` unless you pass `--wait`, as for `tx create`.
  - Flags: `--to`, `--chain`, `--identity`, `--sign-with`, `--yes`, `--dry-run`, `--wait`/`--no-wait`, `--timeout`, `--poll-interval`, `--rpc`, `--force`, `--gas-reserve`, `--accumulate-rpc`, `--proof-class`, `--idempotency-key`, `--expires-in`. See `docs/CLI-CONTRACT.md` section 10.
- **A receipt, written for you.** The record the walkthrough always told people to keep (the intent, the Accumulate transaction, the destination transaction, the proof) used to take four commands and a hand comparison to assemble. `send` ends with it and saves it to `~/.certen/receipts/<intent>.json` (`0600`, written atomically, holding no key, passphrase, API key or node URL). It says what is **established and what is not**: four stages (`signed`, `anchored`, `executed`, `proof verified locally`), whether the **proof holds, checked here**, whether **the value arrived**, and a `verdict` of `verified`, `partial`, `failed`, `pending` or `unproven` with every `gap` named. **PARTIAL and NO EVIDENCE are never shown as verified.** The destination transaction hash comes from the verified execution proof (or, marked as such, the validators' own record); it is never guessed. The JSON shape is documented, versioned (`receipt_version: 1`) and pinned.
  - **Exit `0` means done *and* checked.** `send`, `receipt` and `watch` exit `0` for a verified receipt, `1` for a failed one, `4` for a partial or still-pending one, `5` for no evidence, `130` for Ctrl-C. A script that reads `0` as verified is right.
  - **VERIFIED needs a node of yours.** The proof's execution layer stays `not_checked` until its receipts root is compared with a block header from a node you trust, so without `--rpc` (or `CERTEN_RPC_URL`) a receipt is an honest PARTIAL naming that layer. With one, the recipient's balance is also read from it before signing and after the execution block, with the node's chain id checked first and **its URL never printed or saved** (hosted nodes put a key in the path). A proof whose Accumulate page chains were not captured is PARTIAL too, which is what the repository's test capture is: **a VERIFIED receipt end to end is unverified live.**
- **`certen receipt [intent]`**: show a receipt again, refreshing whatever was pending and re-verifying the proof here. With no argument, the most recent. `--list` lists the saved ones, `--offline` shows one without asking the gateway, `--explain` prints the proof layer by layer, `--rpc` and `--expect` as above, and `--share` makes a link a counterparty can open to verify the proof with no CERTEN account. It works for any intent, not only one this machine sent. (`certen receipts` is unchanged: it is the billing receipts.)
- **`certen watch <intent>`**: wait for an intent to finish, then show its receipt. **Ctrl-C stops the wait, not the intent**: it prints how to continue (`certen watch <intent>`), exits **130**, and a receipt is saved from the last thing the gateway said, in the failure envelope too (`details.receipt`, `details.receipt_path`, `details.resume`), however the wait ended (a failed intent and a timeout included).
- **The confirmation card, on every command that signs.** `send`, `call`, `tx create --sign-with`, `governance <operation> --sign-with` and `pending sign --sign-with` now show one card before the signature: what is about to happen in your own terms (whole units, the recipient in full), a fee line, every value you did not type and where it came from, the rebuilt summary (`You are about to sign: …`, verbatim) and a question. **The question is asked only at a terminal**, only without `--yes` and `--json`; the default answer is yes on a known testnet and **no on anything else**, where the chain name is in capitals. `--yes` is new on all five. It skips the question and **never** the check that the transaction the gateway returned is the one you asked for. A person who answers no gets `SIGNING_DECLINED` (exit `1`) and nothing is signed.
- **`call --wait` ends with the receipt** in table mode (after its usual output, saved like any other; a receipt that cannot be built is a hint, never a failed call). `--json` is untouched **unless you name an event with the new `--expect <address:topic0[:topic1]>`**: asking for that check is asking for its answer, so the envelope gains `receipt` and `receipt_path` (additive) and the exit code is the receipt's (a fixture-style PARTIAL is `4`, an event that is not in the proof's receipt is `1`). `--expect` needs the wait (`EXPECT_NEEDS_WAIT`, exit 2, before any request) and is checked for shape before any request (`INVALID_EXPECT`).
- **A saved receipt is never silently made weaker.** `send --rpc` and, later, a bare `receipt` is the natural sequence, and the second read has no node of yours: it is shown, and it does not replace the saved receipt that was checked against one (`saved_receipt_kept`). A final receipt (verified, failed, unproven) is shown as saved without asking the gateway; `receipt --refresh` reads it again.
- New codes: `CONFIRMATION_REQUIRED`, `INVALID_ADDRESS`, `UNSUPPORTED_ASSET`, `INVALID_RPC`, `INVALID_INTENT_ID`, `NO_RECEIPTS`, `NO_SAVED_RECEIPT`, `CONFLICTING_FLAGS`, `INVALID_EXPECT`, `EXPECT_NEEDS_WAIT` (exit 2); `WRONG_PASSPHRASE`, `SIGNING_DECLINED`, `NOTHING_TO_SHARE`, `RECEIPT_NOT_SAVED`, `NOT_READY` from `send`, and `EVM_RPC_INVALID`, `EVM_RPC_UNREADABLE`, `EVM_RPC_ERROR`, `EVM_RPC_WRONG_CHAIN`, `EVM_RPC_CHAIN_UNKNOWN`, `EVM_RPC_NO_BLOCK` (exit 1). `INTERRUPTED` (130) is now also raised by `send` and `watch`.
- `CERTEN_RPC_URL`: a node of yours, used by `send`, `receipt` and `watch` when `--rpc` is not given.

### Changed
- **A wrong passphrase is found when the key is opened, not when it signs.** `resolveSigner` decrypts once, up front: a wrong passphrase used to surface at the moment of signing, after the intent was open and after you had read the card and said yes, as an untyped `UNKNOWN_ERROR`. It is now `WRONG_PASSPHRASE` (exit 1) before anything exists, and the signature afterwards no longer pays a second second of key derivation.
- **`proof verify --rpc` goes through the SDK, and a node that has no such block is now an error, not a pass.** This fixes a bug: when the node you named returned no block (pruned, lagging, or on another network), the CLI compared the bundle with a bare block number, which matched itself, and the execution layer read **verified** against a node that never had the block. It now exits `1` with `EVM_RPC_NO_BLOCK`, naming the host (never the URL), and the same is true of a node that sends a header without a receipts root. The inline code that fetched the header is the SDK's `verifyEvidence`, which `send`, `watch` and `receipt` use too, so they cannot disagree about what a header check means.
- Root `--help` lists `send`, `receipt` and `watch` beside `call` (the grouping has since been rewritten: see the learnability entry above).

### Not changed, on purpose
- **`call` keeps its own pre-flight** (the identity read, `can_sign` and the funding guard on amount plus gas). Giving it the full readiness read would add three requests to the flagship command and to every stub that tests it, and nothing existing breaks. `send` has the full read.
- **The `--json` envelope and the exit code of `call` and `tx create` are unchanged**: the receipt is added to their *human* output only (`call`), and `certen receipt <intent> --json` is the receipt. A script that has always signed with `call` or `tx create --sign-with` unattended keeps working, because the question is asked only at a terminal.
- **`send` does not move tokens.** It moves the chain's native token and refuses anything else by name; for a token, `certen call` with `transfer(address,uint256)` shows exactly what it will call before you sign.
- **The fee on the card is an estimate or it says it is not available**: the price book's `proof.execute` entry (platform fee only; gas is priced when it executes) and the chain's gas reserve, which is a planning figure, not a quote. The gateway publishes no per-execution fee; `POST /v1/quote` would create a binding quote, so it is not used.
- The root `--help` quickstart and the long-form `init` hint still showed the `call` line when this was written; the learnability entry above rewrites them around `setup` / `send` / `receipt`.

### Included — setup and gas (CLI UX, Phase 3)

Nothing that works today changes. Every command and flag keeps its meaning, `init` is untouched in behaviour, output and exit code, and every `--json` change is a new command, an added field or a new code. A maintainer versions and publishes this.

### Added
- **`certen setup`**: from nothing to an identity that can act on a chain, in one resumable command, and **it exits `0` only when you are ready**. It checks the gateway (and that it serves your chain: no separate `chains --refresh`), makes or reuses your signing key, **then** gets you an account, then the identity, then runs the same readiness checks as `certen status` (your key page read from Accumulate, the key page's credits, the gateway balance, the gas on the abstract account), and saves identity, key and chain as your context. Run it again and it continues instead of repeating.
  - **The key comes first, because a new account is created by it.** With no API key configured you say how to get one: `--new-account` creates an organization with your signing key (the only thing that crosses the wire is a signature over a nonce: no browser, no secret to copy), `--existing-account` signs you in to the one you have (the device flow; a pasted key is the fallback for a gateway without it), `--token <registration token>` redeems one (CI). At a terminal with none of them it asks, with no default, before it makes any key. Without a terminal, or with `--yes`, and none of them, it is a usage error that names the three (`NO_API_KEY`, exit 2). A credential that is configured and works is kept, whatever else you passed (so a CI job can rerun the same command with a spent token).
  - **It does not create a second identity.** The identity is recorded locally the moment the gateway returns its id, before the wait: an organization made with a key may hold one identity until it is approved, and a run that was interrupted or timed out while provisioning would otherwise lose the id and have the rerun refused. A recorded identity that is still provisioning is waited on; one that ended in `error` is offered `certen identity retire` on a terminal (and only on a yes: `--yes` never retires) and otherwise fails with the exact command.
  - **It waits for gas** when gas is the only thing in the way: it shows the account, what to send, the faucet and an EIP-681 wallet link, then polls until the funds arrive. That is the default at a terminal; `--wait-for-funds` does it anywhere and `--no-wait-for-funds` never (piped output and `--json` stop and say what to send, because a CI job must not hang for half an hour on a faucet). It only waits when the gap is one that sending funds fixes and nothing else is failing. Ctrl-C is safe: the context is saved before the wait, it prints how to continue, and exits **130**.
  - Flags: `--name`, `--identity`, `--key`, `--chain`/`--chains`, `--yes`, `--existing-account`, `--new-account`, `--token`, `--org-name`, `--no-passphrase`, `--no-keyring`, `--no-browser`, `--payer`, `--wait-for-funds`/`--no-wait-for-funds`, `--amount`, `--gas-reserve`, `--accumulate-rpc`, `--timeout`, `--funds-timeout` (default 30m), `--poll-interval`. A new signing key is encrypted: without a terminal, `--yes` needs `CERTEN_KEY_PASSPHRASE` or an explicit `--no-passphrase`. See `docs/CLI-CONTRACT.md` section 9.
  - On the measured walkthrough (offline, fake gateway): the `setup` journey is **7 commands where the `readiness` journey it improves on is 12**, and `setup-wait` (one `setup` that waits for the gas) is **6**. The same two values are still copied by hand (the address, for a faucet, and the intent id) and the round trips are the same 32 (the wait's extra polls replace the second run). Reproduce with `node scripts/measure-onboarding.mjs --journey setup-wait`.
- **`certen gas`**: the abstract account's gas on one chain. What it holds, what to send where (the address, an amount, the faucet, an EIP-681 link with the amount in exact integer wei), and with `--wait` the moment it arrives. `--amount` adds what you are about to send; `--from-wallet` prints the two-step route for a faucet that refuses a contract address (a wallet you control, then the transfer from it). It signs nothing and takes no key. Exit `0` only when the account has enough. **It is not `certen fund`**, which tops up the organization's gateway balance (the stablecoin that pays CERTEN's fees); both help texts now say so.
- Exit code **130**: stopped with Ctrl-C while `setup` or `gas` was waiting for funds (`INTERRUPTED`; listed by `certen --help --json`). Nothing is left half-done.
- New codes: `FUNDS_WAIT_TIMEOUT` (exit 1), `INTERRUPTED` (130), `CREDENTIAL_REJECTED`, `IDENTITY_PROVISIONING_FAILED`, `SELF_SERVICE_DISABLED`, `KEY_STORAGE_FAILED` and `CHAIN_NOT_LINKED` (exit 1), `CONFLICTING_OPTIONS`, `PASSPHRASE_REQUIRED` and `AMBIGUOUS_KEY` (exit 2).

### Changed
- **`status` and `doctor` name the command that fixes a gas gap**: `certen gas --chain <chain> --wait`, instead of only a faucet URL (and not `fund`, which is a different balance). `doctor`'s fix keeps the faucet after it.
- **`certen login --json` and `signup --json` now print the approval code and link on stderr.** They were silent in JSON mode, so a device flow started that way waited for an approval nobody had been told to give. stdout is still exactly one envelope.
- Root `--help` leads its quickstart with `certen setup`, and lists `setup` and `gas`. `init`'s help points at `setup`.

### Not changed, on purpose
- **`init` is not an alias of `setup`.** It keeps its order (credential first), its output and its exit code: it exits `0` once its steps are done, whether or not the account can act yet, and the pinned `guide` / `published` journeys run it on an unfunded account. `setup` is the strict one. They share the sign-in (device flow, then paste) and payer-registration code instead of keeping two copies.
- The testnet gas drip and sponsored gas are gateway work (PLAN G1) and do not exist yet: `setup` does not call an endpoint that is not there. The gas amounts are the planning figures from `status` (an estimate, not a quote).


### Included — readiness (CLI UX, Phase 2)

Nothing that works today changes. Every command and flag keeps its meaning, and every `--json` change is an added field or a new command. The one behaviour that gets stricter is the funding guard, below, and it can be bypassed with `--force` exactly as before. A maintainer versions and publishes this.

### Added
- **`certen status`**: is this identity, on this chain, with this key, able to act, and if not, what is the first thing in the way? One card (or one `--json` envelope) over the gateway, the credential, your signing key, the identity, the chain, the key page, the key page's credits, the organization's gateway balance and the gas on the abstract account. Identity, chain and key come from your context, and each is said on stderr. `--amount` judges the gas against what you are about to send; `--accumulate-rpc` names the Accumulate node; `--gas-reserve` replaces the gas estimate (or `none`); `--all` checks every identity recorded on this machine on each chain it is linked to. Exit `0` only when ready, `1` when blocked or when something could not be confirmed, `3` when the gateway is unreachable. See `docs/CLI-CONTRACT.md` section 8.
- **The key page is read from Accumulate, not only from the gateway.** The walkthrough ended in a hand-written `curl` to the Accumulate API so you could see for yourself that the key page lists your key. `status` does it: it asks an Accumulate node (the one the gateway advertises, or `--accumulate-rpc`) and compares the key page's key hashes with your local key's. No CERTEN credential is sent to that node and no redirect is followed. The gateway's answer and Accumulate's are two reads: when they disagree that is a blocker with its own code (`KEY_PAGE_DISAGREES`), not a preference for either, and a page that could not be read is `unknown`, never a pass on the gateway's word alone.
- `doctor` takes `--identity`, `--chain` and `--sign-with` to name the pair it scopes to (default: your context).
- New error codes: `NOT_READY` and `NOT_CONFIRMED` (exit 1), `INVALID_ACCUMULATE_RPC`, `NO_IDENTITIES`, `NO_CHAINS` (exit 2), and `ABSTRACT_ACCOUNT_UNDERFUNDED` (exit 1, below). `INVALID_AMOUNT` is now also raised by `status`.

### Changed
- **`doctor` is scoped to your context and no longer names a chain nobody chose.** Its fixes said `base-sepolia` whoever you were: someone on another chain was told to fund the wrong one, and someone on a mainnet context to pay on a testnet. They now name your context's chain, or the placeholder `<chain>` when there is none. The closing `Next:` hint drops what your context already supplies, and always spells the chain out so it works as printed. When the context names an identity and a chain, `doctor` appends five checks about that pair (`identity`, `chain`, `key page`, `accumulate credits`, `gas`), always the same five, `skipped` with the reason when they cannot run. In `doctor`'s vocabulary a check that could not be confirmed is a `warn` beginning `could not confirm:`, never a pass, and an unfunded abstract account stays the warning `doctor` has always made it (a call that forwards no value is unaffected; `certen status` is the one that fails it). With no context nothing is added, so the list is unchanged for anyone who had none. **Cost: with a context, `doctor` makes two more reads, the identity and the key page from Accumulate (6 → 8 requests in the measured walkthrough; the chain registry it needs, it already read).** `doctor` now contacts an Accumulate node, the one the gateway advertises, which it did not before.
- **The funding guard on `call` and `tx create` checks the amount and an estimate of the gas, not only for a zero.** It still refuses a balance that is positively zero (`ABSTRACT_ACCOUNT_UNFUNDED`), and now also one that is positive but cannot cover the amount being sent, or the amount plus the gas to send it (`ABSTRACT_ACCOUNT_UNDERFUNDED`). The amount half is a fact. The gas half is an **estimate, not a quote**: the gateway publishes no per-execution gas cost, so it is a per-chain planning figure, and the message says so; `--force` is the way past it, as before. A balance that cannot be read still never blocks, a token transfer's amount is not counted against the gas balance, and a chain with no estimate is checked on the amount alone. `call --value` is wei and is now compared as wei.

### Fixed
- `call`'s funding guard now receives `--value` under the field that says its unit (base units), instead of under `amount` (whole units).

### Included — context, profiles and units (CLI UX, Phase 1)

Nothing that works today changes. Every command and flag keeps its meaning; required flags only became optional (with a default taken from your context, said on stderr), and every `--json` change is an added field. A maintainer versions and publishes this.

### Added
- **`certen context`** shows the identity, key, chain and gateway commands will use, and where each came from (the flag, an environment variable, the profile, or "the only one there is"). It is local: no network, no API key.
- **`certen use identity|key|chain <value>`** chooses them once (`--unset` clears). `use identity` takes a UUID, an `acc://` ADI URL or a name, and stores the UUID; a UUID this machine has never seen is checked against the gateway when there is a credential, and saved with a "not verified" note when there is not. `use gateway <url>`, `use profile <name> [--create]` and `use allow-mainnet-default on|off` complete the set.
- **Profiles.** A profile is a gateway, a context and a credential. `--profile <name>` (before or after the subcommand, like `--json`), `CERTEN_PROFILE`, or `certen use profile`. The `default` profile is the config you already have: its credential and gateway stay where they were, so nothing is migrated. A named profile has **its own API key** (OS keyring account `api_key:<profile>`, or inside the profile) and never falls back to the default profile's, because that key belongs to another gateway.
- **One identity reference, everywhere**: a UUID, an `acc://` ADI URL, or the name an identity was created with (or its ADI label). `call`, `tx create`, `tx inspect`, `identity get|retire|link-chain`, all six `governance` operations, `pending list|sign` and `portfolio` accept all three, and send the gateway the form its route takes (`/v1/identity` wants a UUID, `/v1/governance` an ADI URL). Local records are consulted first; the gateway's portfolio (which carries each identity's `id`) is the fallback. Two identities answering to one name is a question that lists them, never a guess.
- **`CERTEN_IDENTITY`, `CERTEN_KEY`, `CERTEN_CHAIN`**, between a flag and a profile.
- **Durations with units**: `--timeout 90s|6m|1h|2d` and `--poll-interval 2s|1m` on `call`, `tx create`, `tx status`, `identity create`, `init`, `fund` and `login`/`signup`. A bare number keeps its meaning (minutes; seconds for the interval). No wait budget or default changed.
- New error codes, all exit 2: `MISSING_IDENTITY`, `AMBIGUOUS_IDENTITY`, `MISSING_CHAIN`, `AMBIGUOUS_CHAIN`, `MAINNET_DEFAULT_REFUSED`, `UNKNOWN_KEY`, `UNKNOWN_IDENTITY_ALIAS`, `INVALID_IDENTITY_REF`, `IDENTITY_NOT_FOUND`, `IDENTITY_ID_UNRESOLVED`, `PROFILE_NOT_FOUND`, `INVALID_PROFILE_NAME`, `MISSING_PROFILE_NAME`, `DUPLICATE_PROFILE_FLAG`, `INVALID_GATEWAY_URL`, `MISSING_VALUE`, `CONFLICTING_UNSET`, `INVALID_VALUE`. See `docs/CLI-CONTRACT.md`.
- `profile` is added to the `--json` output of `auth login`, `auth status` and `whoami`.

### Changed
- **`call`**: `--identity`, `--chain` and `--sign-with` are no longer required when the context supplies them. Leaving `--sign-with` out was always an error, so a context key (a profile's, `CERTEN_KEY`, or your only local key) cannot change what any working invocation does. Several local keys and none chosen is still `MISSING_SIGNING_KEY` (now listing them).
- **`identity create`** takes the same context key when no key is given (leaving it out was always `MISSING_SIGNING_KEY`), says which key before the passphrase prompt, never chooses between several, and does not touch the context when `--public-key` / `--public-key-hash` is given. The key it picks owns the identity, and the identity is quota.
- **`identity mnemonic <id> <token>`** accepts a UUID, an ADI URL or a name for the id, resolved before the one-time token is spent. A retrieval URL works exactly as before.
- **`--timeout` / `--poll-interval` no longer accept hex or exponent spellings** (`0x10`, `1e3`). They were never documented and were read as surprising values. A decimal (`0.5`) and every documented form still work.
- **`tx create`** derives `--from` from the identity's abstract account on `--to-chain`, as `call` does (`NO_ABSTRACT_ACCOUNT` names the fix when there is none). When it derives, one identity read serves the ADI, the account and the funding guard: **5 → 4 round trips** on the transfer path. With an explicit `--from` or an `--intent` it makes exactly the requests it made before. `--identity` and `--to-chain` come from the context when not given.
- **`governance`** `--identity` is no longer required, and takes a UUID or a name as well as the ADI.
- **`fund`** takes `--chain` from the context when not given (`CHAIN_REQUIRED` still says so when nothing supplies one). An identity's linked chain is not a default here: what is funded is the organization's balance.
- `identity create` and `init` record the name an identity was created with, so `--identity <name>` finds it. The chain-registry cache records each chain's `environment`.
- An unsupported chain that came from a default now says where it came from (`CERTEN_CHAIN: "basee" is not a supported chain…`).

### Safety
- **A default never points a value-moving command at a mainnet.** `call`, `tx create` and `fund` refuse a chain that is not a known testnet when it came from an environment variable, a profile or a single candidate (`MAINNET_DEFAULT_REFUSED`), unless the profile says `use allow-mainnet-default on`. `--chain` on the command line is always the person's own choice. A chain nobody can classify counts as not a known testnet: unknown is not ok.
- **Every value taken from context is said on stderr** (`using identity acc://alpha.acme (the only identity recorded on this machine)`), in table and `--json` mode, before any passphrase prompt and before the summary of what a signature authorises. A value you typed is not repeated.
- **No signing key is defaulted where leaving it out is a supported mode.** `tx create`, `governance <op>` and `pending sign` without `--sign-with` open the intent and return signing data for an external signer or HSM; signing there on a guess would start signing for people who rely on that.
- `identity retire` never takes its identity from the context, and `pending list` / `portfolio` `--identity` stay filters (left out, you see everything).

## 0.10.0 — RB7b: verify what you trust, sign what you see (2026-10-09)

**Breaking** changes are marked; the minor carries them (0.x).

### Breaking
- **Node 22 or 24** (`engines.node >=22`).
- **`certen proof verify` verifies locally, layer by layer**, and exits `4` (partial) or `5` (no evidence) as well as `0`/`1`; its `--json` output changes shape. It never reports inclusion from a `verified` flag.
- **Exit `3` means only that the gateway was not reached and nothing was submitted** (`NETWORK_ERROR`). It used to be returned for every error with status 0, which told a script an existing intent was safe to resubmit. `INTENT_FAILED`, `WAIT_TIMEOUT`,
  `PROOF_NOT_ASSIGNED` and the proof errors now have their own codes.
- **A bare hash is never signed** (`BLIND_SIGNING_REFUSED`, exit 2); `tx create`, `call`, `governance` and `pending sign` check what they sign first (see below).
- `certen tx status --wait` announces `executed` as progress and `completed_unproven` as what it is (exit 0, `data.status` unchanged).
- `certen keys sign --hash` is refused (`BLIND_SIGNING_REFUSED`). `certen keys sign --name <key> --signing-data <@file|->` rebuilds the gateway's signing data offline, requires the signature metadata to name that key, prints what it authorises, and signs the recomputed hash: the air-gap and HSM path no longer signs blind.
- The OS keyring is reached through `@napi-rs/keyring` (an optional dependency; the archived `keytar` is gone). Where no keyring is usable (headless Linux) the command refuses by name (`KEYRING_UNAVAILABLE`) and writes nothing.

### Fixed
- `certen auth login` worked on no stock install (the undeclared `keytar`); it now works. `certen auth logout` no longer clears the config when it could not remove the key from the keyring.
- Moved to commander 14.

### Included — sign what you see (RB7b Phase F)

### Changed (breaking)
- `tx create --sign-with`, `call`, `governance <operation> --sign-with` and `pending sign --sign-with` rebuild the transaction the gateway returned, check it against the request and print what the signature
  authorises (stderr) before signing. A mismatch exits 1 with `SIGNING_DATA_MISMATCH`; nothing is signed. They need a gateway that returns the unsigned transaction.
- A bare hash is never signed: `tx sign`, `pending submit` and `governance sign` no longer accept `--sign-with` / `--hash` (exit 2, `BLIND_SIGNING_REFUSED`). `--signature` + `--public-key` still work for a
  signature made elsewhere. `pending sign --sign-with` replaces the two-step `pending sign` then `pending submit --sign-with --hash` (transaction hashes only).
- `pending sign` without `--sign-with` reports `signing_unchecked` and a warning when the signing data could not be checked.

### Added
- `certen tx inspect <id>` and `certen governance inspect <id>`: recompute every hash of what is awaiting a signature and show what it would authorise; `tx inspect --intent` also matches it to your request. They sign nothing.
### Included — `proof verify` checks the proof (RB7b Phase E)

### Changed (breaking)
- `certen proof verify` verifies a proof layer by layer, locally, with `@certen.io/proof-verify`. It no longer reports inclusion from the gateway's receipt or from a
  `verified` flag in the bundle. `--json` output changes shape (`overall`, `independent`, `layers`, `covers`, `notCovered`, `failure`, `execution`, `bundleStatements`,
  `evidence`, `gateway`); see docs/CLI-CONTRACT.md.
- New exit codes for `proof verify`: `4` partial (a layer is not established) and `5` no evidence (`PROOF_V2_EVIDENCE_NOT_SERVED`). `3` still means only that the gateway
  was unreachable. A live proof the gateway serves no proof v2 document for exits `5` until the route is deployed.
- `--govroot <hex>` compares the govRoot v3 computed here with an expected one.

### Fixed
- The entrypoint overwrote the exit code a command set through `process.exitCode`, so a failed check could exit `0` (`proof verify`'s outcome check, `keys verify`).
  It now honours it.
### Included — `--expires-in`, `--authority`, and why an intent failed

### Added
- `certen call` and `certen tx create`: `--expires-in <duration>` (s/m/h/d → `expires_at`) and
  repeatable `--authority <acc-url>` (→ `additional_authorities`). Invalid values exit 2 before any request.
  `--expires-in` must be 90s to 7d and is measured when the intent is opened, after any passphrase prompt;
  a local header-field refusal from the SDK (status 0) exits 2, never 3.
  Header authorities are refused by the gateway by default (`HEADER_AUTHORITY_NOT_EXECUTABLE`); the
  failure envelope carries `guidance` and human mode prints what to do instead.
- `certen tx status` always includes `reason_code`, `completion_basis`, `expires_at` and
  `additional_authorities` (null when unset), and explains the reason in human mode.
- `TX_FAILED` carries `details: { intent_id, reason_code, reason }`.

## 0.9.1 — the passphrase prompt answers the keyboard

### Fixed — `keys generate` hung forever at the passphrase prompt

The hidden prompt called `stdin.setEncoding('binary')` before reading, which makes every `data`
event a **string**. The reader iterated it expecting bytes, so `case 0x0a` never matched and
`byte >= 0x20` compared a string to a number: Enter did nothing, typing did nothing, and Ctrl-C
did nothing. The only way out was killing the terminal. Present in 0.7.1, 0.7.2, 0.8.0, 0.8.1,
0.8.2 and 0.9.0, and hit by the first partner to run the first command in the README.

The stream now stays in buffer mode. While fixing it the reader also gained what a terminal
actually sends: Ctrl-D as cancel on an empty line, Ctrl-U to clear, CRLF counted as one Enter,
and multi-byte characters kept whole — including one split across two chunks by a paste, and
backspace deleting a whole character rather than one byte of it. Fourteen tests drive the prompt
against a fake TTY; thirteen of them fail against the old code.

Both documented escape hatches were unaffected and still work:
`keys generate --name dev --no-passphrase`, and `CERTEN_KEY_PASSPHRASE=… keys generate`.

## 0.9.0 — `proof verify` checks the outcome, locally, from a share link

`certen proof verify <share-link>` fetches the bundle with no API key and, when it carries the
execution proof (component 5), walks the receipt's trie proof to the receipts root from the bundle's
own bytes and lists the receipt's events. `--expect <address:topic0[:topic1]>` names an event that
must be there; `--rpc <url>` fetches block N's header from a node you trust and compares its
receipts root and hash, at which point Certen was not trusted for the outcome at all. Inclusion is
read from the bundle's chained proof. Line 3 of the verdict, "Outcome", used to say NOT CHECKED on
every run; it now says VERIFIED, FAILED, or why it could not be checked. A bundle file (`@path`) is
accepted the same way. Exit status is non-zero when the outcome fails or the expected event is absent.

## 0.8.2 — ships against SDK 0.8.2

No CLI change. `identity create --wait` and every command that waits on an intent inherit the SDK's
fix: a wait no longer gives up on one slow or failed poll while its deadline has time left.

## 0.8.1 — `--account` on add-authority and remove-authority

`governance add-authority --account book` puts the authority on the identity's key book as well as
the identity, so seats and thresholds face the policy signer, not only spends. `--account <url>`
names any account under the identity. Ships against `@certen.io/sdk` 0.8.1.

## 0.8.0 — governance from the command line, signed in one step

### Added — `governance add-key`, `remove-key`, `add-authority`, `remove-authority`, `sign`

The gateway's governance endpoint has taken these operations for months; the CLI exposed two of
them and could not sign any. Every governance command now accepts `--sign-with <key>` and submits
the signature in the same step, or prints `signing_data.hash_to_sign` for an external signer and
`governance sign` submits what it produced. `--signer-key-page` picks a page of the book.

`add-authority --authority acc://owner-policy.acme/book` is the one that matters for autonomous
agents: from then on every transaction the identity submits waits for that book to sign too, which
is how the headless policy signer regulates an agent that cannot opt out.

### Fixed — `proof share --expires-in` took seconds and sent them as hours

`--expires-in 259200` (three days) asked the gateway for 259,200 hours. The flag is deprecated
and now converts; `--hours <n>` is the replacement, with `--max-views <n>` alongside it.

## 0.7.2 — the CLI runs when you install it

### Fixed — the binary did nothing at all on Linux and macOS

`npx @certen.io/cli signup ...` printed nothing, sent nothing, and exited **0**. So did every other
command. Not a failure anyone could act on: no error, no output, no request reaching the gateway,
and therefore nothing in the gateway's logs to find either. From outside it looked like a CLI that
installed correctly and had simply decided not to speak.

The last statement in the entrypoint decides whether the file was run as a program or imported by
a test:

```js
import.meta.url === pathToFileURL(process.argv[1]).href   // 0.7.1
```

Node resolves symlinks before it records `import.meta.url`, and does not for `process.argv[1]` —
that stays the path as typed. Every POSIX install exposes this package as a **symlink** at
`node_modules/.bin/certen` pointing into `dist/`, and `npx` is no exception. So the two strings
were never equal, the guard was false, and `run()` was never called. The whole CLI was inside an
`if` that could not be true for a real user.

Windows is why it shipped: npm writes a `.cmd` shim there rather than a symlink, and the shim
invokes node on the real path, so `argv[1]` arrived already resolved and the comparison passed.
The test suite is why it stayed: all of it — conformance included — spawns `node dist/index.js`
directly, which is the one invocation path with no symlink in it, and the one no user takes.

`argv[1]` is now resolved with `realpathSync` before the comparison, so both sides are the real
path. A new test, `test/installed-bin.test.ts`, runs the built binary **through a symlink** and
asserts it produces output — the case the suite could not previously express.

Nothing else changed. There is no behaviour difference for anyone on Windows, and none for anyone
who was invoking `dist/index.js` by path.

## 0.7.1 — sign a pending transaction by hash

### Added — `certen pending sign <target>` accepts what people actually have

A pending transaction was signable only by its inbox UUID. But the id a person is holding usually
comes from the explorer, from `queryTx`, or from a `/v1/sign` response — and that is a transaction
hash or a TxID, not an inbox id. The gap forced a lookup to translate one into the other, and got
an opaque gateway 400 when they guessed.

All four forms now resolve, with no `--type` flag to get wrong:

```
certen pending sign 4f3c…-…-…                 # inbox id (UUID)      -> pending_action
certen pending sign 882d1793…b1ad811          # 64-hex hash          -> pending_tx
certen pending sign 0x882d1793…b1ad811        # the same, 0x-prefixed
certen pending sign acc://882d…@panel.acme    # TxID, as pasted
```

The forms are disjoint, so the type is inferred rather than declared. Resolution lives in
`@certen.io/sdk` (`resolveSignTarget`) and is shared with the MCP server — two copies would drift,
and a drifted resolver signs the wrong preimage: a valid signature attached to nothing.

An unrecognised target is refused with `INVALID_SIGN_TARGET` and never guessed at.

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

### Fixed — the CLI test suite no longer flakes (properly, this time)

Every test in that package spawns the CLI as a real subprocess, against vitest's 5s default — a
budget sized for in-process tests. The slowest case measured **4353ms**, about 13% headroom, so
ordinary scheduling load tipped a passing test over; `doctor.test.ts` failed in a full run and
passed alone. Raised to 20s, roughly 4.5x the measured worst case.

**That fix was inert for a whole phase.** It was written into
`packages/cli/vitest.config.ts`, and a per-package config only applies when vitest is invoked with
that package as its root — while `scripts/test-all.mjs` runs a single process from the repository
root. Its own comment claimed "the root config already globs them"; no root config existed. So every
run kept using 5s, and the suite flaked twice in one session, both times at exactly 5000ms.

The timeout now lives in a root `vitest.config.ts`, which sets **only** the timeouts —
declaring `include` there would change discovery, and a glob subtly narrower than the default drops
test files with no failure anywhere. `packages/sdk/test/test-config.test.ts` asserts the root config
exists, that its timeout is a real number rather than a present key, that discovery is left alone,
and that all three packages are still found.

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
