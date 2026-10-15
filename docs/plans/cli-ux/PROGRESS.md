# CLI UX simplification: progress ledger

The state of `docs/plans/cli-ux/PLAN.md`, carried between sessions. Update it in the same session as
the work. Phase status values: `not-started` · `in-progress` · `in-review` (PR open) · `merged` ·
`blocked`. A phase is `merged` only when the human has merged its PR.

| Phase | Title | Status | PR |
|---|---|---|---|
| 0 | Sync, baseline, AGENTS.md header | merged | #27 (da4aeb4) |
| 1 | Context (W1) | merged | #28 (7c9fb45) |
| 2 | Readiness (W3) | in-progress (work complete, branch `ux/phase-2-readiness` pushed; PR to be opened by a human, `gh` is not installed) | not opened |
| 3 | Setup + gas (W2, W6) | not-started | |
| 4 | Send + receipt (W4, W5) | not-started | |
| 5 | Learnability (W7) | not-started | |
| 6 | Agents (W8) | not-started | |

---

## Baseline (taken before any change, 2026-10-15)

Taken on `main` at `558608f` (fast-forwarded from `27cac1e`; local `main` was 86 commits behind
`origin/main`, and is now level with it). Node v24.20.0, npm 11.19.0 (`.nvmrc` says 24.20.0; the
`engines` floor is 22). Windows 11. Working tree: only the untracked `docs/plans/` directory.

| Gate | Result |
|---|---|
| `npm install` | exit 0; reports 5 vulnerabilities (2 moderate, 3 high), see "Found, not fixed" |
| `node scripts/build-all.mjs` | exit 0, `all packages built` |
| `node scripts/typecheck-all.mjs` | exit 0, `all packages typecheck` |
| `node scripts/test-all.mjs` | exit 0, **1415 passed in 95 files**, 0 failed, 0 skipped (95s) |
| `node scripts/test-counts.mjs` | exit 0, sdk 536, cli 421, mcp 201, verify 257; README and AGENTS.md counts current |
| `npm run agentgen:check` | exit 0, `4 artifacts up to date (125 spec operations, 82 SDK methods across 17 resources)` |

Pre-existing failures: **none**. Package versions at baseline: sdk 0.10.0, cli 0.10.0, mcp 0.5.0,
proof-verify 0.1.0.

Tool availability: `gh` is **not installed** on this machine (not on the Bash or PowerShell PATH, nor in
the standard install locations). `gh pr view` and `gh pr create` cannot run here; see Phase 0, task 7.

## Plan accuracy check (done in Phase 0)

PLAN §1's claims about the code were re-read against `origin/main`. All hold:
`doctor.ts:80` hardcodes `chainHint = 'base-sepolia'`; `transaction.ts:97` has
`requiredOption('--identity')` and `:172` requires `--from`; `call.ts:45` requires `--identity`;
`governance.ts:70-118` takes an ADI URL; `lastIdentity()` is read only by `init.ts:193`;
`doctor` already has `--all`.

Two things the plan does not say, recorded here so later phases do not trip on them:

1. **The "published walkthrough" is not in this repo.** PLAN §1's 12-step table describes a page the
   plan calls "published". The repo's own guide, `docs/guides/first-proof-in-three-commands.md`, is a
   shorter path (`login` → `init` → `call` → `proof get`). Phase 0 measures both and labels the 12-step
   journey as transcribed from PLAN §1, not from the live page. **A human should compare it with the
   live page once.**
2. **AGENTS.md's layout block already lists `packages/verify/`.** Only the one-line header (versions,
   and the missing fourth package) was stale. Phase 0 fixes that.

---

## Phase 0: Sync, baseline, AGENTS.md header

Branch `ux/phase-0-baseline`. Acceptance (HARNESS-PROMPT §8): `docs/plans/cli-ux/` committed in this PR;
ledger created with baseline; AGENTS.md header fixed; `measure-onboarding` baseline recorded for the
documented first-transaction path.

- [x] 1. Sync to `origin/main`, take the baseline. *Check: the Baseline table above.*
- [x] 2. Plan accuracy check. *Check: the section above.*
- [x] 3. AGENTS.md header: versions match each `package.json`, and `@certen.io/proof-verify` is named.
  *Check: new test `agents-md.test.ts` failed 4/5 on the old header (red), passes 5/5 now.* Commit `c6417d4`.
- [x] 4. `measure-onboarding --journey <name>`: an offline mode that drives the real built CLI through a
  documented journey against an in-process fake gateway, in a temp `HOME`, and reports commands, round
  trips and hand-copied values. *Check: new test `measure-onboarding.test.ts` (8 tests): both journeys
  behave as declared; `--url` is refused; the temp HOME is gone afterwards; `--fault cannot-sign` goes
  red; a login without `--no-keyring` is refused. Real `~/.certen` unmodified (newest file 2026-10-09).*
- [x] 5. Record the measured baseline for both journeys. *Check: tables below, reproducible with
  `node scripts/measure-onboarding.mjs --journey guide` and `--journey published`.*
- [x] 6. Commit `docs/plans/cli-ux/` and document `--journey` in the README. *Check: `git show --stat 07f7429` lists PLAN, HARNESS-PROMPT, PROGRESS; README "Measuring, rather than asserting" describes `--journey`.*
- [~] 7. Gates, the user-run transcript, self-review against PLAN §5, push the branch. PR: **needs a
  human** (`gh` is not installed). *Check: gate output, the user-run transcript and the PLAN §5 checklist are in the
  drafted PR body (kept outside the repo, in the session scratchpad); the human pastes it when opening the PR.*

### Measured baseline (offline, fake gateway; origin/main `558608f`, sdk/cli 0.10.0)

Round trips are what reached the fake gateway; "values copied" and "passphrase prompts" are declared by
the journey (`scripts/lib/onboarding-journeys.mjs`). Wall-clock varies by machine and is not pinned.
Reproduce: `node scripts/measure-onboarding.mjs --journey published`.

| Metric | `guide` (repo docs) | `published` (PLAN §1) | PLAN §2 target |
|---|---|---|---|
| `certen` commands | 4 | **16** | 3 (install, `setup`, `send`) |
| Steps that are not a `certen` command | 1 (install) | **5** (install, raw JSON-RPC `curl`, faucet, wallet transfer, by-hand effect check) | 0 |
| HTTP round trips (measured) | 11 | **35** | n/a (regression ceiling) |
| Values copied by hand | 2 (`identity_id`, `intent_id`) | **5** (`identity_id`, `adi_url`, `key_page_url`, `abstract_account`, `intent_id`); plus the key hash compared by eye | 0 |
| Passphrase prompts | 2 | **2** | 1 per command |

The plan's "about 17 commands, one raw JSON-RPC call, five values" is reproduced: 16 `certen` commands plus
the install is 17, one `curl`, five values. The plan's "2–3 passphrase prompts" measures as 2 on this path.

Per-step round trips, `published` (the ratchet pinned in `measure-onboarding.test.ts`):
`--version` 0 · `chains --refresh` 1 · `auth login` 1 · `whoami` 2 · `init` 4 · `identity list` 1 ·
`identity get` 1 · `portfolio` 1 · `doctor` 6 · `keys show` 0 · `balance` 1 · `tx create` 5 ·
`tx status` 1 · `proof get` 2 · `proof verify` 4 · `proof verify --rpc` 5. Both `proof verify` runs return
exit 4 (an honest PARTIAL: the capture's page chains are unbound), the same verdict
`proof-verify.test.ts` expects for these fixtures.

Observations for later phases, from the per-step endpoints:

- `GET /v1/transaction/{intent}` is read **5 times** between `tx create --wait` and `proof verify --rpc`
  (`create` polls it, then `tx status`, `proof get`, and both `proof verify` runs each re-read it). Phase 4's
  receipt can read it once.
- `tx create` reads `GET /v1/portfolio` for the funding guard **and** `GET /v1/identity/{id}` for the ADI
  URL, two reads for facts one identity read already carries. `call` reuses the identity read; `tx create` does not.
- **15 of the 35 round trips are repeat reads of three endpoints**: `GET /v1/billing/balance` ×5 (`auth login`,
  `whoami`, `init`, `doctor`, `balance`), `GET /v1/portfolio` ×5 (`init`, `identity list`, `portfolio`,
  `doctor`, `tx create`) and `GET /v1/transaction/{id}` ×5. They are separate commands today, so they cannot
  share a read; `setup` / `status` / the receipt can. `doctor` alone costs 6 and `whoami` 2.
- The `guide` path measures 11 round trips but leaves the abstract account **unfunded** and only works
  because `confirm(bytes32)` forwards no value. Funding is what the `published` journey adds (and what
  Phase 3's `setup` has to own).

**How to read these numbers.** They are a floor to compare across phases, not a forecast of live traffic. The
fake answers every wait on the first poll, so `init`, `call --wait` and `tx create --wait` each count one
poll where a live run polls repeatedly (identity provisioning at a 3 s interval over ~45-90 s; the proof cycle
at 8 s over 60-110 s). The runner passes `--json` on every step so values can be carried forward; round trips
and exit codes were checked **equal to human mode** for all 12 commands that reach the gateway (`auth login`,
`init`, `whoami`, `identity list`, `identity get`, `portfolio`, `doctor`, `balance`, `tx create`, `tx status`,
`proof get`, `proof verify`).

What the offline measurement does not cover, and a human has to: the device-flow `certen login` (a browser
and a person; the journeys use the documented `auth login --api-key -` fallback and say so in the output),
real provisioning and proof-cycle time (60–110 s), real gas funding, and the live gateway's behaviour.
Unverified live.

---

---

## Phase 1: Context (W1)

Branch `ux/phase-1-context`, from `main` at `da4aeb4` (Phase 0 merged as #27). Acceptance (HARNESS-PROMPT §8):
`certen context`, `certen use identity|key|chain`, profiles; one `resolveContext()`; identity ref accepts
uuid / `acc://` URL / alias in every command incl. governance; `tx create` derives `--from`; `--timeout`
accepts `90s|6m|1h`; mainnet-default refusal tested; context echo tested in both modes.

### Baseline for this phase (before any change, 2026-10-15, `main` = `da4aeb4`)

| Gate | Result |
|---|---|
| `npm install` | exit 0 (same 5 advisories as Phase 0) |
| `node scripts/build-all.mjs` | exit 0 |
| `node scripts/typecheck-all.mjs` | exit 0 |
| `node scripts/test-all.mjs` | exit 0, **1429 passed in 97 files**, 0 failed, 0 skipped |
| `npm run agentgen:check` | exit 0, 4 artifacts up to date (125 operations, 82 SDK methods) |

Pre-existing failures: none.

### Design decisions, from reading the code (the plan is silent or wrong on these)

1. **The gateway's identity routes take a UUID only** (`/v1/identity/{id}` has a UUID pattern). An ADI URL or an
   alias is therefore resolved CLIENT-side. ADI → UUID: local record first, then `GET /v1/portfolio?identity=<adi>`.
   The portfolio now returns each identity's `id` (gateway 2026-08), so PLAN §1 root cause 3 ("the portfolio may
   not return UUIDs") and ask G3 are outdated; an older gateway that omits `id` gives a named usage error, never a guess.
2. **Which form each route wants**, from the vendored spec and the gateway source: `/v1/transaction` takes a UUID,
   `/v1/governance` an ADI URL, `/v1/portfolio` and `/v1/pending` either, `/v1/sign` `pending_tx` either. The resolver
   returns `{ id, adi_url }` and each command passes the form its route takes.
3. **An alias is the name an identity was created with** (stored on the local record, new field `name`) **or the
   label of its ADI** (`acc://jason-dev.acme` → `jason-dev`), matched case-insensitively among the identities recorded on
   this machine. Two matches is an ambiguity error listing both.
4. **The signing key defaults only where omitting it is an error today.** `call` and `identity create` without a key fail
   (`MISSING_SIGNING_KEY`), so a context key can fill it. `tx create`, `governance <op>` and `pending sign` without
   `--sign-with` are a supported mode (open the intent, return signing data for an external signer or HSM); defaulting a
   key there would start signing for people who rely on that. So no key default in those three. (`send` in Phase 4 signs with the context key.)
5. **A profile is gateway URL + context + credential.** Sending one profile's API key to another profile's gateway
   would leak a credential, so credentials are per profile: keyring account `api_key:<profile>` / `profiles.<name>.api_key` for
   a named profile; the `default` profile keeps its credential at the top level exactly as before (no migration, no change
   for existing users). A named profile never falls back to the default profile's key.
6. **"Mainnet" means "not a known testnet".** The SDK catalogue holds testnets only; the registry cache is extended
   (additive) with each chain's `environment`. A chain that is not a known testnet never comes from a default (env var,
   profile or single-candidate) on a value-moving command (`call`, `tx create`, `fund`) unless the profile says
   `allow_mainnet_default`; `--chain` on the command line always wins.
7. **Not touched, with reasons:** `identity retire` keeps a required explicit argument (destructive: never from context);
   `identity mnemonic <id> <token>` takes any spelling of the id (resolved before the one-time token is spent) and leaves a retrieval URL alone; `pending list` and
   `portfolio` `--identity` are filters, so absence must keep meaning "all", not "the context identity"; `doctor`'s hardcoded
   chain hint is Phase 2 (PLAN W3); `init` writing the context is Phase 3 (`setup`).
8. The confirmation **card** is Phase 4. Phase 1 echoes each context-derived value on stderr (both modes), before any
   passphrase prompt and before the signing summary; Phase 4's card renders the same `ResolvedContext` sources.

### Tasks (check = the acceptance check; evidence = what was run)

- [x] 1. **Profiles in config**: active profile (`--profile` > `CERTEN_PROFILE` > saved > `default`), per-profile settings, credential and gateway URL, no migration for `default`.
  Check: `config-profiles.test.ts`. Evidence: red first, then green; the existing `config.test.ts` passes untouched.
- [x] 2. **`--profile` as a global flag** that may appear anywhere, like `--json`.
  Check: `global-flags.test.ts`, conformance cases. Evidence: `--help --json` lists the option.
- [x] 3. **`src/context.ts`**: `resolveContext()`; flag > env > profile > single candidate; ambiguity is a usage error listing candidates; mainnet-default refusal; echo helper.
  Check: `context.test.ts`.
- [x] 4. **`src/identity-ref.ts`**: `resolveIdentityRef()` for UUID / ADI / name, local record first, then the gateway. Local records gain `name` (written by `identity create` and `init`).
  Check: `identity-ref.test.ts` against a fake client.
- [x] 5. **`--timeout` / `--poll-interval` accept `90s`, `6m`, `1h`**; a bare number keeps its meaning, in all seven places (`call`, `tx create`, `tx status`, `identity create`, `init`, `fund`, `login|signup`).
  Check: `duration.test.ts`; `wait.test.ts` is unchanged and green.
- [x] 6. **`certen context` and `certen use identity|key|chain|gateway|profile|allow-mainnet-default`.**
  Check: `context-commands.test.ts` (human and `--json`), 11 conformance cases (18 → 29).
- [x] 7. **Wire the resolver in**: `call` (identity, chain, key), `tx create` (identity, `--to-chain`, derived `--from`), `tx inspect`, `identity get|link-chain|retire|create|mnemonic`, the six `governance` operations, `pending list|sign`, `portfolio`, `fund`.
  Check: `context-wiring.test.ts` and `context-identity-create.test.ts`, against a stub gateway with honest signing data.
- [x] 8. **`tx create` derives `--from`** like `call`, with one identity read serving the ADI, the account and the funding guard (5 → 4 round trips).
  Check: `context-wiring.test.ts` asserts exactly `GET identity, POST transaction, POST signature`; `--journey context` shows it.
- [x] 9. **Context echo on stderr** for every non-flag value, in table and `--json` mode, before any passphrase prompt.
  Check: `context-wiring.test.ts` (both modes, one stdout line) and the transcript in the PR body.
- [x] 10. **Docs**: CHANGELOG, `docs/CLI-CONTRACT.md` section 7, both READMEs, the llms template (regenerated; `agentgen:check` clean), the skill, the first-proof guide, PLAN corrections.
  Check: `git diff` lists them.
- [x] 11. **Measurement**: a `context` journey (the same transaction on this CLI) beside the unchanged `guide` and `published` baselines.
  Check: `measure-onboarding.test.ts` pins `context` (34 round trips, 4 values) next to `published` (35, 5).
- [x] 12. **Gates, offline transcript, §5 self-review, push.** Outputs are quoted in the PR body.
  **Opening the PR needs a human**: `gh` is not installed on this machine.

### Phase 1 results

**Measured (offline, fake gateway, `node scripts/measure-onboarding.mjs --journey <name>`):** the same transaction, before and after.

| | `published` (the documented path today) | `context` (the same path on this CLI) | Change |
|---|---|---|---|
| `certen` commands | 16 | 16 | none: Phase 1 changes what each step costs, not how many there are |
| HTTP round trips | 35 | **34** | `tx create`: 5 → 4 (one identity read serves the ADI, the account and the funding guard) |
| Values copied by hand | 5 (`identity_id`, `adi_url`, `key_page_url`, `abstract_account`, `intent_id`) | **4** | the identity UUID is no longer carried between steps |
| `tx create` flags typed | `--identity <uuid> --to-chain base-sepolia --from <0x…> --to <addr> --amount 0.0001 --sign-with dev --wait --timeout 6` | `--to <addr> --amount 0.0001 --sign-with dev --wait --timeout 6m` | `--identity`, `--to-chain`, `--from` come from the context |
| Passphrase prompts | 2 | 2 | Phase 4's session unlock, not this phase |

The remaining four copies are the work of later phases: `adi_url` and `key_page_url` exist only to feed the raw `curl` (Phase 2's independent key-page check),
`abstract_account` only to fund it (Phase 3), `intent_id` to read the outcome (Phase 4's receipt). The pinned `guide` and `published` baselines did not move,
which is the evidence that nothing existing changed: they drive the unchanged invocations through the changed CLI.

**Tests:** 1429 → **1633** in 97 → 105 files (cli 435 → 639; conformance 18 → 29). Gates on the final tree: build ✓ typecheck ✓ `test-all` ✓ `agentgen:check` ✓ `test:counts` ✓ (quoted in the PR body).

**Proven in the transcript, not only in tests:** the echo is on stderr in table and `--json` mode with exactly one line on stdout; two identities and no choice
lists both before any request; a mainnet default is refused before any request while a typo keeps its sharper error; `tx create` with `--sign-with` makes three
requests (identity read, open, signature) and prints the echo before the "You are about to sign" summary; a named profile does not borrow the default profile's key.

**Unverified live / limits stated plainly:**
- The per-profile keyring account (`api_key:<profile>`) is tested against an in-memory keyring, not the real Windows credential store. The `default` profile's account is unchanged (`api_key`).
- `use identity <uuid>` against a real gateway was exercised against a stub only (a 200, a 404, an unreachable host, no credential).
- Nothing here touched a live gateway, signed for real, or minted a credential (HARNESS §4).

---

## Phase 2: Readiness (W3)

Branch `ux/phase-2-readiness`, from `main` at `7c9fb45` (Phase 1 merged as #28). Acceptance (HARNESS-PROMPT §8):
`client.readiness()` in the SDK with an independent key page check (reusing proof-verify's Accumulate encoding) and credits;
`certen status`; `doctor` scoped to the context with no hardcoded chain; the funding guard checks amount + estimated gas; MCP not yet touched.

### Baseline for this phase (before any change, 2026-10-15, `main` = `7c9fb45`)

| Gate | Result |
|---|---|
| `npm install` | exit 0 |
| `node scripts/build-all.mjs` | exit 0 |
| `node scripts/typecheck-all.mjs` | exit 0 |
| `node scripts/test-all.mjs` | exit 0, **1633 passed in 105 files**, 0 failed, 0 skipped |
| `npm run agentgen:check` | exit 0 |

Pre-existing failures: none.

### Design decisions, from reading the code and the gateway (the plan is silent or wrong on these)

1. **The independent key page read is a JSON-RPC `query` to the Accumulate node, with no CERTEN credential.** It is the same call the gateway's own
   `computeCanSign` makes (`result.account.keys[].publicKeyHash`, a hex string OR a serialised Node Buffer `{type:'Buffer',data:[…]}`; both are accepted, or
   a key that is on the page reads as absent). PLAN W2 says to reuse `@certen.io/proof-verify`'s Accumulate encoding. **That does not apply to this read and the SDK
   cannot take the dependency**: the comparison is a hash match on JSON the node returns, nothing is binary-encoded, and `proof-verify` pulls in `accumulate-sdk-opendlt`
   and `node:crypto`, which the SDK's browser entry is statically forbidden to reach (`browser-entry.test.ts`). What the read trusts is stated in the output: the
   Accumulate node it asked, not the CERTEN gateway. It does not check a Merkle receipt (that would need a trusted anchor the client does not hold).
2. **The endpoint** is `--accumulate-rpc`, else `GET /v1/chains` → `accumulate.api`. The registry's block can drift (PLAN §6 G9), so a node that has no record of the page is
   reported as unreadable with that reason, never as "the key is absent".
3. **Two reads that disagree are a blocker with their own code** (`KEY_PAGE_DISAGREES`), not a preference for either: the page holds the key but the gateway says it cannot
   sign, or the gateway says it can and Accumulate shows the local key missing from the page. An unreadable independent read is `unknown`, never `ok`.
4. **Statuses**: `ok | warn | fail | unknown | skipped`. PLAN lists four; `skipped` is added because a check whose prerequisite failed was not evaluated, and doctor already
   distinguishes that from "evaluated and could not tell". `ready` is true only when every check is `ok` or `warn`; `state` is `ready | blocked | unconfirmed`.
5. **Fixes**: the SDK states what to do in plain words (`fix.text`, `fix.url`); the CLI adds `fix.command` from the check's `code`, as `doctor`'s `localizeFix` does today. The SDK
   never names a CLI command.
6. **Native balances are whole-unit decimal strings, not wei.** The gateway's bridge returns `ethers.formatEther(balance)` (api-bridge `evm.handler.ts`), so `0.0021` is 0.0021 ETH.
   Amount + gas is compared in base units with exact integer arithmetic. The `call`/`contractCall` path passes `--value` in **wei** under the same field name the transfer path
   uses for whole units, so the guard now takes the unit explicitly (`amount` = whole units, `value` = base units).
7. **There is no published per-execution gas figure** (`/v1/quote` prices the platform's own legs in USD, and is flat-priced, so empty of gas, on the chains here; PLAN G5 is
   still open). The gas need is therefore a **catalogue reserve** (`gasReserve`, whole native units), labelled an estimate wherever it is shown, overridable (`--gas-reserve`,
   `gasReserve`) and bypassable (`--force`). The figures are planning numbers chosen in this change, not measurements. **A human should replace them with measured values.**
   A chain with no reserve (Telcoin Adiri) is checked on the amount alone and says so as a `warn`.
8. **Credits are checked for zero only.** The gateway publishes no per-intent credit cost, and the unit of `creditBalance` (raw units or whole credits) is not pinned by the spec, so
   a low-water mark would be a guess that could be wrong by 100×. Zero is a certain failure in either unit. The number is shown exactly as the key page reports it.
9. **`doctor` stays an org-wide diagnosis** and gains the context-scoped checks (chain, key page, credits, gas) when a context identity resolves. Its fixes name the context chain, or `<chain>`; never
   `base-sepolia`. `status` is the context-scoped command; `status --all` covers every identity recorded on this machine.
10. **Exit codes for `status`**: 0 only when `ready`; 1 when blocked or unconfirmed (the envelope's `readiness.state` says which); 3 when the gateway is unreachable.

### Tasks (check = the acceptance check; evidence = what was run)

- [x] 1. **Catalogue**: `gasReserve` per chain, `gasReserveFor()`, `parseUnits()` / `formatUnits()`.
  Check: `gas-assessment.test.ts` (exactness, the reserve table). Evidence: green.
- [x] 2. **Key page read**: `readKeyPage()`, `verifyKeyPageHolds()` (no credential, no redirect, bounded size and time, both hash spellings, unreadable never absent).
  Check: new `key-page.test.ts` (17 tests, a real localhost Accumulate node). Evidence: green.
- [x] 3. **Gas assessment**: `assessGas()` pure; the SDK guard, the CLI guard and `readiness()` all use it (amount + reserve, unit explicit, token amounts not counted, unknown still never blocks, `--force` kept).
  Check: `gas-assessment.test.ts`, `funding-guard-amount.test.ts` (CLI), `funding-and-wait.test.ts` (SDK). Evidence: five existing tests used nominal balances (`'1'`, `'1000'`) that were "funded" only because the guard looked for zero; they were given balances that cover the amount (same property asserted).
- [x] 4. **`client.readiness()`**: ordered checks, `ready/state/first_blocker`, `scope: 'context'`, `registry` reuse.
  Check: new `readiness.test.ts` (47 tests; a real localhost gateway and a real localhost Accumulate node). Evidence: mutation-checked (making `unknown` read `ok`, and a disagreement read as a plain lack, turned 7 tests red; restored).
- [x] 5. **`certen status`** (+ `--all`), human card and `--json`.
  Check: new `status.test.ts` (18 tests), 6 conformance cases (`conformance.test.ts`, section 8). Evidence: the transcript in the PR body.
- [x] 6. **`doctor` scoped to the context**; no hardcoded chain.
  Check: new `doctor-context.test.ts` (11 tests); the source contains no chain slug. Evidence: mutation-checked (restoring the hardcoded slug turned 4 tests red; restored).
- [x] 7. **Fake gateway serves the Accumulate read; `readiness` journey measured**; a declared failure must fail for the declared reason (`expectError`).
  Check: `measure-onboarding.test.ts` (`readiness` pinned at 32 round trips, `published` and `context` moved by exactly the `doctor` line). Evidence: `--fault key-page-lacks-key` goes red naming the reason.
- [x] 8. **Docs**: CHANGELOGs (cli, sdk), `docs/CLI-CONTRACT.md` section 8, `packages/cli/README.md`, the first-proof guide, the skill, the llms template (regenerated), root help, PLAN corrections.
  Check: `git diff` lists them; `agentgen:check` clean; `test:counts` refreshed.
- [x] 9. **Gates, offline transcript, §5 self-review, push.** Outputs are quoted in the PR body. **Opening the PR needs a human**: `gh` is not installed on this machine.

### Phase 2 results

**Measured (offline, fake gateway, `node scripts/measure-onboarding.mjs --journey <name>`):** the same transaction, before and after.

| | `context` (Phase 1 CLI) | `readiness` (Phase 2 CLI) | Change |
|---|---|---|---|
| `certen` commands | 16 | **12** | `identity list`, `identity get`, `portfolio`, `doctor`, `keys show` and `balance` are replaced by two runs of `status` |
| Steps outside the CLI | 5 | **3** | the hand-written `curl` to Accumulate is gone (install, fund, the by-hand effect check remain) |
| HTTP round trips | 36 (34 before `doctor` grew) | **32** | `status` is 4 requests: the registry, the balance, the identity, and the key page from Accumulate |
| Values copied by hand | 4 (`adi_url`, `key_page_url`, `abstract_account`, `intent_id`) | **2** (`abstract_account`, `intent_id`) | the ADI and key page URL existed only to feed the curl |
| Compared by eye | 1 (`key_hash`) | **0** | `status` compares the key page with the local key |
| Passphrase prompts | 2 | 2 | Phase 4's session unlock |

`doctor` moved on purpose: **6 → 8 requests** in the measured walkthrough (it now also reads the identity and the key page from Accumulate when a context exists), which is why `published` is 37 (was 35) and `context` 36 (was 34). Every other line of the `guide`, `published` and `context` baselines is exactly as measured, the evidence that nothing else changed.

**Tests:** 1633 → **1776** in 105 → 111 files (sdk 536 → 627, cli 639 → 691). Gates on the final tree: build ✓ typecheck ✓ `test-all` ✓ `agentgen:check` ✓ `test:counts` ✓ (quoted in the PR body).

**Proven in the transcript, not only in tests:** `status` before funding is blocked on the gas and on nothing else, names the account, the amount and the faucet, and exits 1; after funding it is ready and exits 0; the key page is read from the Accumulate stand-in with no CERTEN credential; a disagreement between the gateway and Accumulate is a named blocker; a wei-looking `--amount` is refused before any request; `doctor` names the context's chain and drops what the context supplies from its `Next:` hint.

**Deferred by the plan's own phasing, not by this phase:** the `send`/`call` pre-flight ("run readiness before unlocking the key", PLAN W3 last bullet). `send` does not exist until Phase 4, whose confirmation card needs the same readiness data; `call` keeps its existing pre-flight (the identity read, `can_sign`, and the funding guard, which now judges amount + gas).

**Unverified live / limits stated plainly:**
- Nothing here touched a live gateway, a real Accumulate node, signed for real, or minted a credential (HARNESS §4). The Accumulate read was exercised against a localhost stand-in that answers the way the gateway's own `computeCanSign` expects (`result.account.keys[].publicKeyHash`); **a human should run `certen status` once against the real gateway and the real kermit endpoint.**
- The gas reserve figures are planning numbers, not measurements (decision 7). **A human should replace them with measured values.**
- The unit of the key page's `creditBalance` is unconfirmed, which is why credits fail only at zero (decision 8).

## Found, not fixed

- **`npm install` reports 5 vulnerabilities (2 moderate, 3 high).** Present on a clean `main`; not
  examined. `scripts/audit-residuals.json` and `scripts/check-audit.mjs` exist, so this may already be
  triaged. Out of scope for this plan.
- **AGENTS.md "Gotchas" says the gateway "exposes 106 operations; the SDK wraps 24".** `agentgen` now
  reports 125 spec operations and 82 SDK methods. The two counts may not mean the same thing, so I did
  not change the sentence. Worth a look by whoever owns that page.

- **Proxy settings break every CLI test that spawns the CLI against a loopback fake.** The CLI talks through
  axios, which honours `HTTP_PROXY`; with one set and no `NO_PROXY`, a call to `127.0.0.1` goes to the proxy
  (verified: `NETWORK_ERROR connect ECONNREFUSED 127.0.0.1:9`, no request reaches the fake). The new
  journey runner sets `NO_PROXY`. The existing tests (`call-init.test.ts`, `proof-verify.test.ts`, ...) pass
  the caller's environment through unchanged, so they would fail on a machine with a proxy configured. Not
  reproduced across the whole suite, only shown for one command; worth a one-line fix in their shared env.
- **`gh` is not installed on this Windows machine**, so this harness cannot run `gh pr view` / `gh pr create`.
  A human opens each phase's PR (or installs `gh` and re-runs the session).

- **A failed balance read on the gateway's bridge looks like an empty account.** In the local `api-bridge` checkout, `src/chains/evm.handler.ts` (`getAddressBalance`) answers an RPC failure with
  `balance: '0'` plus an `error` field, and `api-gateway` drops the `error` (`portfolio.orchestrator.ts`, `identity.orchestrator.ts`), so a funded account can read as `0`. The funding guard and `status` then say "holds
  no gas" for an account that is fine, and cannot tell unknown from zero (the gateway does report `unavailable` on a DIFFERENT failure path). `--force` gets past the guard; `status` has no override. A gateway change
  (report `unavailable`), not asked for here; checked against local checkouts that may be behind `origin/main`.
- **No per-execution gas figure and no per-intent credit cost are published** (PLAN G5/G6), and the spec does not say whether the key page's `creditBalance` counts whole credits or hundredths. Readiness therefore uses a
  catalogue gas estimate (labelled) and fails credits only at zero. Measured values, or the quote endpoint carrying them, would replace both.
- **The local identity record does not store which key created the identity**, so `status --all` can compare the local key only with the identity the context names; the others get a `warn`. `setup` (Phase 3) writes the context and could record the key.
- **The Accumulate endpoint comes from the gateway's registry unless `--accumulate-rpc` is given** (PLAN G9: the advertised block can drift). The read is a fixed JSON-RPC `query`, no credential, no redirect, bounded size and time, http(s) only,
  but a gateway that advertised an internal address would have the CLI make that one POST. The same trust as pointing the CLI at that gateway at all; recorded rather than hidden.
- **Many existing test fixtures write native balances in wei-looking digits** (`'1000000000000000'`) where the live gateway sends whole-unit decimals (`'0.001'`). Harmless to a zero check; wrong for an amount comparison. The journeys' fake gateway now sends the live
  shape; the older per-test fixtures were left (they only need "positive") and the few that meant "enough" were given balances that cover the amount.
- **The pre-existing `call` funding guard was handed `--value` (wei) under the whole-unit field name.** Harmless while only "above zero" was asked; fixed here because the comparison needed the unit (`value` = base units).
- **`init`'s closing hint and the root `--help` quickstart still print the long form** (`certen call --identity <id> --chain ... --sign-with ...`). It remains valid (a typed value wins), and Phase 5 rewrites it around `setup` / `send` / `receipt`.
- **`doctor`'s hardcoded `base-sepolia` hint** is Phase 2 (PLAN W3): `doctor` becomes scoped to the context there.
- **`init` does not write the context.** It records the identity (now with its name) and the context resolves single candidates, so the journey works without it. Writing the context is `setup`'s job (Phase 3).
- **A stale local record is not self-healing for an identity retired from another machine.** `identity retire` forgets it locally, but a retire elsewhere leaves this machine's record; the next use fails with the gateway's own 404, which is clear. Not fixed.
- **Working-tree line endings on this machine are CRLF for some pre-existing files** (git normalises to LF per `.gitattributes`, and the commits are clean). Scripts that edit those files preserve whatever they find.
- **Shell heredocs eat backslashes in this environment.** It twice produced a subtly wrong regex or a broken string in a scripted test edit. One looser-than-intended regex slipped into a test and was caught on review and fixed; edits containing regexes now go through the Edit tool.

## Conflicts between sources of truth

- **Commit trailers.** The session's attribution reminder asked for a `Co-Authored-By` trailer on commits.
  HARNESS-PROMPT §7 (and the standing certenIO convention in the user's memory) say one plain line, no
  trailers. Followed the higher source: the user's own rules and the harness. No trailer on any commit.
