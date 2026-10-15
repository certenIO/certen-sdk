# CLI UX simplification: progress ledger

The state of `docs/plans/cli-ux/PLAN.md`, carried between sessions. Update it in the same session as
the work. Phase status values: `not-started` · `in-progress` · `in-review` (PR open) · `merged` ·
`blocked`. A phase is `merged` only when the human has merged its PR.

| Phase | Title | Status | PR |
|---|---|---|---|
| 0 | Sync, baseline, AGENTS.md header | merged | #27 (da4aeb4) |
| 1 | Context (W1) | in-progress (branch `ux/phase-1-context`) | not opened |
| 2 | Readiness (W3) | not-started | |
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
4. **The signing key defaults only where omitting it is an error today.** `call` without `--sign-with` fails
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
   `identity mnemonic <id-or-url>` takes a one-time retrieval target, not an identity reference; `pending list` and
   `portfolio` `--identity` are filters, so absence must keep meaning "all", not "the context identity"; `doctor`'s hardcoded
   chain hint is Phase 2 (PLAN W3); `init` writing the context is Phase 3 (`setup`).
8. The confirmation **card** is Phase 4. Phase 1 echoes each context-derived value on stderr (both modes), before any
   passphrase prompt and before the signing summary; Phase 4's card renders the same `ResolvedContext` sources.

### Tasks (each with its acceptance check; checked off as completed)

- [ ] 1. Profiles in config: active-profile selection (`--profile` > `CERTEN_PROFILE` > `config.profile` > `default`),
  per-profile settings, per-profile credential and gateway URL, no migration for `default`. *Check: `config-profiles.test.ts`.*
- [ ] 2. `--profile` as a global flag that may appear anywhere, like `--json`. *Check: conformance case + `--help --json` lists it.*
- [ ] 3. `src/context.ts`: `resolveContext()`; precedence flag > env > profile > single candidate; ambiguity is a usage
  error listing candidates; mainnet-default refusal; echo helper. *Check: `context.test.ts`.*
- [ ] 4. `src/identity-ref.ts`: `resolveIdentityRef()` for UUID / ADI / alias, local record first, then gateway.
  Local records gain `name`. *Check: `identity-ref.test.ts` against a fake client.*
- [ ] 5. `--timeout` / `--poll-interval` accept `90s`, `6m`, `1h`; a bare number keeps its meaning (minutes / seconds), in all 7 places. *Check: `duration.test.ts` + a subprocess case per command family.*
- [ ] 6. `certen context` and `certen use identity|key|chain|profile|gateway|allow-mainnet-default`. *Check: conformance cases + subprocess tests in both modes.*
- [ ] 7. Wire the resolver into `call` (identity, chain, key), `tx create` (identity, `--to-chain`, derived `--from`),
  `tx inspect`, `identity get|link-chain`, the six `governance` operations, `pending sign`, `pending list`, `portfolio`, `fund`. *Check: subprocess tests against the fake gateway (`context-commands.test.ts`).*
- [ ] 8. `tx create` derives `--from` from the identity like `call`, and reuses the one identity read for the funding guard
  and the ADI (5 → 4 round trips). *Check: `tx-create-derives-from.test.ts` + measure-onboarding.*
- [ ] 9. Context echo on stderr for every non-flag value, in table and `--json` mode, before any passphrase prompt. *Check: `context-echo.test.ts`.*
- [ ] 10. Docs: CHANGELOG (cli), `docs/CLI-CONTRACT.md` (`context` / `use` envelopes, `--profile`, new error codes), README /
  CLI README, root help grouping, PLAN corrections. *Check: `git diff` lists them; conformance + readme tests green.*
- [ ] 11. Measurement: a `context` journey in `scripts/lib/onboarding-journeys.mjs` (the same transaction on the Phase 1 CLI),
  before/after against the pinned `published` baseline. *Check: `measure-onboarding.test.ts` pins it.*
- [ ] 12. Gates, user-run transcript (offline), §5 self-review, push, PR body. *Check: outputs quoted.*

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

## Conflicts between sources of truth

- **Commit trailers.** The session's attribution reminder asked for a `Co-Authored-By` trailer on commits.
  HARNESS-PROMPT §7 (and the standing certenIO convention in the user's memory) say one plain line, no
  trailers. Followed the higher source: the user's own rules and the harness. No trailer on any commit.
