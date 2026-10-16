# Security review: `certen keys unlock` (a key that stays unlocked for a while)

Status: **written for review, not signed off.** The feature is built, tested and **inert by default**. Making it default-on is a decision for
a human reviewer after reading this page (CLI UX plan W7; harness rule: `keys unlock` is not turned on without a written security review).

Author: the engineer carrying out the CLI UX plan, Phase 5. Reviewer: see the sign-off block at the end.

## 1. What it is, and why

Every command that signs with a local key asks for that key's passphrase. Someone doing five sends in a row types it five times, and
tends to answer by setting `CERTEN_KEY_PASSPHRASE` in their shell for the day, which is strictly worse: the passphrase then sits in the
environment of every process they start, for as long as the shell lives, with no expiry and no way to take it back.

`certen keys unlock <name> [--for <duration>]` is the bounded alternative: the key is decrypted once, the **decrypted key** is kept in the
OS keyring with an absolute expiry, and signing commands use it without asking until it expires or `certen keys lock` wipes it.

| | |
|---|---|
| `certen keys unlock <name> [--for <duration>]` | Default `15m`, at most `8h`. Units `s`, `m`, `h` (a bare number is minutes, as `--timeout` is). Prints `name`, `public_key_hash`, `unlocked_until` (ISO 8601) and `for_seconds`; a reminder on stderr. |
| `certen keys lock [name] [--all]` | Wipes the session of one key, or of every local key. Idempotent. Works with the switch off. |
| `certen keys list` | With the switch on, gains `unlocked_until` (ISO 8601 or `null`). With it off, unchanged. |
| `certen keys delete <name> --yes` | With the switch on, also wipes that key's session. With it off, unchanged. |

What a session replaces is **only the passphrase**. Every signing path still rebuilds what it is about to sign (`checkIntentSigning`),
still shows the confirmation card, still asks `[Y/n]` where a person is at a terminal, and still refuses to sign blind. A session does
not make any signature the person has not seen; it makes the passphrase prompt go away.

Commands that consume a session: everything that opens a key through `resolveSigner` (`send`, `call`, `tx create --sign-with`,
`governance <op> --sign-with`, `pending sign --sign-with`, `identity create --sign-with`, `init`, `signup --with-key`) and `keys sign`.

Deliberately **not** consumers: `keys verify` (it exists to check that the passphrase opens the key; a session would skip exactly that),
`keys generate`, and `setup` (it signs its sign-up nonce with the passphrase it already holds from creating the key).

## 2. What is stored, where, for how long

| | |
|---|---|
| Store | The OS keyring through `@napi-rs/keyring` (Windows Credential Manager, macOS Keychain, Linux Secret Service). Service `certen`, account `unlock:<key name>`. |
| Content | One JSON string, about 200 bytes: `{"v":1,"key_hash":"<sha256 of the public key, hex>","seed":"<32-byte Ed25519 seed, base64>","unlocked_at":<epoch ms>,"expires_at":<epoch ms>}` |
| Not stored | The passphrase. Anywhere. Ever. |
| Lifetime | `expires_at - unlocked_at` is at most 8 hours (default 15 minutes). **Expiry is enforced on use, not by a timer** (section 6). |
| Removed by | `keys lock`, `keys lock --all`, `keys delete`, and the first command that looks at an entry that has expired or does not check out. |
| Fallback | None. If there is no usable keyring, `unlock` refuses with `KEYRING_UNAVAILABLE` and nothing is written anywhere else. |

Local to the machine and to the key name. Sessions are **not per profile**: the key files in `~/.certen/keys` are not either, so a session
for `dev` is usable by any profile of the same user that signs with `dev`.

## 3. Assets and trust boundaries

Assets, in order of value: the decrypted Ed25519 seed of a signing key (it controls an Accumulate key page, so what it signs moves value
on other chains); the passphrase; the integrity of "what the person saw is what was signed".

Boundaries:

1. **CLI process** (trusted): decrypts, writes, reads, checks, signs, zeroes buffers.
2. **OS keyring** (trusted to the extent the OS protects it): shared with every process the same user runs. It is not a secret store against code running as that user; it protects against other users and against the disk at rest.
3. **Everything else running as the user** (not trusted): can read the keyring entry on most platforms, can write one.
4. **The gateway** (not trusted with key material): never receives the seed or the passphrase. Unchanged by this feature.

## 4. How an entry is checked every time it is used

An entry read back from a shared store is a claim, not a fact. `sessionSigner` accepts it only if **all** of these hold, and otherwise
**deletes it** and falls back to asking for the passphrase (one line on stderr says what happened; `--json` stdout is untouched):

1. It parses, is version `1`, and has the right field types (finite numbers for the times).
2. `key_hash` equals the key file's `publicKeyHash` (it belongs to this key).
3. `expires_at > unlocked_at` and `expires_at - unlocked_at <= 8h` (a window `unlock` could have made).
4. `unlocked_at <= now + 60s` (the clock has not been turned back since it was made).
5. `now < expires_at` (not expired; the boundary instant is expired).
6. `expires_at - now <= 8h` (not edited, or the clock has not moved, to extend it).
7. The seed is 32 bytes **and derives exactly the public key in the key file**. This is the check that makes a planted entry harmless: another key's seed, or noise, signs nothing.

With the experimental switch off, **none of this runs and the keyring is not even read** (`sessionSigner` and `unlockedUntil` return before loading the module).

## 5. Threats

"Residual" is what is left after the mitigation. Where the residual is the point of the feature, it says so.

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | **Malware or a hostile script running as the same user** reads the keyring entry and signs offline. | Bounded window (default 15 min, cap 8 h). `keys lock` ends it at once. Nothing is exposed that is not exposed anyway to the same attacker while the passphrase is typed, or while `CERTEN_KEY_PASSPHRASE` is set. | **High during the window**, by design: the session trades silence for convenience. Before this feature the same attacker needed a keylogger or the env var; now reading one credential is enough. This is the main thing to weigh. |
| T2 | **Another local user** on the same machine. | OS per-user keyring isolation (DPAPI on Windows, per-user Keychain, per-user Secret Service session). | Depends on the OS; not tested here. |
| T3 | **Laptop stolen, powered off.** | Keyring is bound to the user's login; disk encryption is the user's. An expired session is never honoured. | **The bytes of an expired session stay in the keyring until a CLI run or `keys lock` deletes them (section 6).** An attacker who obtains the OS login could read a stale entry. |
| T4 | **Laptop stolen, logged in and locked.** | Screen lock; the keyring is unlocked with the login session on all three platforms, so this is as strong as the OS lock. | As T1 for an attacker past the lock. |
| T5 | **Laptop stolen, unlocked.** | None beyond the window. | Full exposure for the rest of the window. |
| T6 | **Clock rolled back** to stretch a session. | Checks 3, 4 and 6 in section 4. | A rollback of less than 60 s stretches a session by less than 60 s. A forward jump expires it early (fails safe). |
| T7 | **A planted or edited keyring entry.** | Section 4: wrong key hash, wrong window, or a seed that does not derive the key file's public key are all refused and deleted. | An attacker who can write the keyring can make a command ask for the passphrase and print a notice; it cannot make the CLI sign with a key the person did not unlock. It can also **delete** a real session (an annoyance, not a leak). |
| T8 | **Shared across profiles.** | None: keys are machine-wide, so are sessions. | A session for `dev` serves every profile of the user that signs with `dev`. Same trust boundary as the key file. |
| T9 | **Crash, kill -9, power loss** leaves an entry. | The next command that looks at it enforces expiry and deletes it; `keys lock --all`. | Same bytes-after-expiry residual as T3. |
| T10 | **Keyring backup or sync** copies the entry off the machine. | None in this code. | **Unverified.** Windows Credential Manager persistence and enterprise roaming, and macOS Keychain synchronisation, are properties of how `@napi-rs/keyring` creates entries; they were not checked. A reviewer should confirm that entries do not roam or sync. |
| T11 | **Process listing, shell history, environment** reveal the secret. | The seed is never in argv or the environment. The only argument is `--for`. The passphrase reaches `unlock` the way it always reached any command (prompt, or `CERTEN_KEY_PASSPHRASE`). | If the env var is used to supply the passphrase at unlock time, it is as visible as it always was. |
| T12 | **An agent or script running as the user, with `--yes`**, signs while the key is unlocked. | The card, `checkIntentSigning`, the refusal of blind signing, the mainnet-default rules and `send`'s `CONFIRMATION_REQUIRED` still apply: it can only sign what it can describe correctly and what passes the check. `--yes` skips the question, not the check. | **An unlocked key lets an automated caller move value with no secret.** Do not unlock on a machine that runs agents you do not trust. `signup --with-key` also signs a gateway-chosen nonce with a session (the keypair-signup concern recorded in the Phase 3 ledger applies, unchanged). |
| T13 | **Headless Linux, no Secret Service.** | The probe (write, read back, delete a non-secret value) fails before the passphrase is asked for, with `KEYRING_UNAVAILABLE` (exit 2). There is no file fallback. | None: the feature is simply unavailable there. |
| T14 | **Secret left in process memory.** | The seed `Buffer` is zeroed after the write and after each signer is built. | JavaScript strings (the base64 and the JSON) cannot be zeroed and live until collected, as the decrypted key already did within a command. Core dumps and swap are as they were. |
| T15 | **A deleted key stays usable.** | `keys delete` wipes that key's session first (switch on). | With the switch off, `keys delete` does not touch the keyring; `keys lock --all` clears a session an earlier run left. |
| T16 | **A keyring error message echoes the secret.** | Error text from the keyring is scrubbed of the seed (base64 and hex) before it is shown; tested. | None known. |

## 6. Decisions a reviewer should challenge

- **Expiry is enforced on use. There is no daemon.** A background process that wipes at the deadline would be one more thing to start, kill and get wrong on three operating systems. The cost is stated in T3 and T9: **after the deadline the bytes remain in the keyring until the next CLI run, `keys list`, `keys lock`, or `keys delete`**. They are never honoured and are deleted on first sight. If that is not acceptable, the alternatives are a detached sweeper (best-effort, platform-specific) or a wipe-on-exit hook for the unlock process (which cannot exist, since `unlock` returns at once). See open question Q1.
- **The seed, not the passphrase.** A person reuses a passphrase (it opens other things, and a stolen one outlives the key it protected); a seed opens exactly one key. Storing the passphrase would also make every session a passphrase-recovery oracle. The cost: the seed is the key, so the keyring entry is as valuable as the key file's plaintext for its window.
- **A cap of 8 hours, and 15 minutes by default.** The window is the risk, and a window nobody can shorten is a worse feature than one that has to be renewed. 8 h is one working day. The cap is checked at unlock (`UNLOCK_DURATION_INVALID`) and again on every read (checks 3 and 6), so an edited entry cannot exceed it either.
- **No file fallback.** A file is a different and weaker store (the key file is already one); the user can choose it explicitly for the API key with `--no-keyring`, and there is nothing equivalent to choose here. A missing keyring means the feature is off for that machine, not that it degrades.
- **Probe before the passphrase.** A person who types a passphrase and is then told there is nowhere to keep the result has been asked for a secret for nothing; it also keeps the failure path free of key material.
- **`keys verify` ignores sessions.** Its purpose is to test the passphrase, and it is the `next:` command after `WRONG_PASSPHRASE`.
- **Per key, not per profile, not per command.** Simplest model that matches how keys are stored.

## 7. The experimental switch

`keyUnlockEnabled()` in `packages/cli/src/session-unlock.ts` returns true only when `CERTEN_EXPERIMENTAL_KEY_UNLOCK=1`. One function gates
both halves: **creating** a session and **consuming** one. With the switch off:

- `keys unlock` refuses (`KEY_UNLOCK_NOT_ENABLED`, exit 2, `next: certen keys --help`) before it asks for anything;
- signing commands never read the keyring; a perfectly valid session left by an earlier run is ignored, not honoured and not deleted;
- `keys list` and `keys delete` behave exactly as before;
- `keys lock` still works, because wiping is always safe and a session made by a build where the switch was on must be removable by one where it is not.

To make it default-on after sign-off, change the body of `keyUnlockEnabled` from

```ts
return env[UNLOCK_ENV] === '1';
```

to

```ts
return env[UNLOCK_ENV] !== '0';
```

(so `CERTEN_EXPERIMENTAL_KEY_UNLOCK=0` still turns it off), then update the tests that pin the off-by-default behaviour: `the experimental switch` in
`key-unlock.test.ts`, and the `with the switch off` cases in `key-unlock-commands.test.ts`. Rename the variable once the word "experimental" is no longer true.

## 8. What a reviewer should verify

Tests (`packages/cli/test`), all in-process against an in-memory keyring, a throwaway `HOME`, and an injected clock. None reaches the network
or the real `~/.certen`.

| Claim | Where |
|---|---|
| Inert unless the value is exactly `1`; unlock refuses before asking or touching the keyring | `key-unlock.test.ts` > "the experimental switch" |
| With the switch off a valid entry is not read, not honoured, not deleted; `lock` still works | same |
| Stores the seed, key hash and window, never the passphrase; under 400 bytes | `key-unlock.test.ts` > "unlocking" |
| Refusals come before the passphrase is read: unencrypted key, unknown key, no keyring, keyring that cannot hold a value | same |
| A failing write leaves nothing behind, and the error carries no key material (including a keyring that echoes the value) | same |
| A wrong passphrase leaves nothing in the keyring | same |
| `--for`: default, units, the exact ceiling, zero, negative, words, fractions | `key-unlock.test.ts` > "--for" |
| Honoured to the last millisecond, refused at the boundary and deleted | `key-unlock.test.ts` > "using a session" |
| Another key's seed under this key's hash; an entry for another key; a clock turned back; an expiry edited far ahead; a future start; eleven kinds of malformed entry | same |
| Nothing about the seed reaches stderr, whatever the verdict | same |
| `resolveSigner` signs with no prompt and without reading `CERTEN_KEY_PASSPHRASE`; asks again after expiry; ignores sessions with the switch off; a planted entry cannot make it sign with the wrong key | `key-unlock.test.ts` > "the signer seam" |
| `lock` one, all, idempotent, no keyring, a keyring that will not delete (all names tried, all listed), an invalid name | `key-unlock.test.ts` > "locking" |
| Exit codes, one envelope on stdout, `next:` after each refusal, no secret in any output | `key-unlock-commands.test.ts` |
| `keys list` is byte-identical with the switch off; `unlocked_until` with it on | same > "certen keys list" |
| `keys delete` wipes the session with the switch on and does not touch the keyring with it off | same > "certen keys delete" |
| `keys verify` still needs the passphrase while a session is valid | same > "what the session does not touch" |

Mutation checks run when this was written (each turned tests red, then the code was restored byte-identical): skipping the
public-key derivation check (3 tests), skipping the expiry check (4 tests), reading the session with the switch off (2 tests).

By reading `packages/cli/src/session-unlock.ts`, a reviewer should confirm: the seed is never logged, interpolated into an error, put in
`details`, or passed as an argument; `seed.fill(0)` runs on every exit path; the only things written are the probe value and the session JSON.

## 9. Not verified

- **No real credential store was used.** Windows Credential Manager, macOS Keychain and Linux Secret Service behaviour (per-app access prompts, blob size limits, persistence and roaming, what a `deletePassword` returns after an external delete) was reasoned about from the library's documentation and tested only through an in-memory stand-in with the same interface. A human should run `certen keys unlock`, `keys list`, a `send`, and `keys lock` once on each platform they care about.
- The 60-second clock skew and the 8-hour cap are judgement calls, not measurements.
- Whether `@napi-rs/keyring` creates entries that roam or sync (T10).

## 10. Open questions for the reviewer

- **Q1.** Is "expired but not yet wiped until the next CLI run" acceptable (T3, T9), or should `unlock` also start a best-effort detached sweeper, or should every CLI command begin with a cheap sweep of expired entries?
- **Q2.** Should a session be refused (or require `--yes-i-know`) for keys whose identity is on a **mainnet** chain, or should `send`/`call` on mainnet always prompt for the passphrase regardless of a session? Today the confirmation card's default answer on mainnet is `n`, which is the only extra protection.
- **Q3.** Should sessions be bound to a profile or to a gateway, so that a session made for a testnet identity cannot serve a mainnet one?
- **Q4.** Is 8 h the right ceiling, and should the default be shorter?
- **Q5.** Should `signup --with-key` (which signs a gateway-chosen nonce) refuse to use a session, since the reason for the prompt there is partly to make the person notice?

## 11. Sign-off

| | |
|---|---|
| Reviewer | |
| Date | |
| Decision | ☐ approved to default-on &nbsp; ☐ approved to stay behind the switch &nbsp; ☐ changes required |
| Conditions / notes | |
