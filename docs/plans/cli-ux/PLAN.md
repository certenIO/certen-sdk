# CERTEN CLI UX simplification — plan

Status: proposal · Author: review of `certen-sdk@origin/main` (sdk/cli 0.10.0, mcp 0.5.0, proof-verify 0.1.0)
and `api-gateway@origin/main`, 2026-10-14.

> **Read this first.** Both local checkouts used for this review were stale (`certen-sdk` main was
> 86 commits behind `origin/main`; `api-gateway` was on a feature branch 118 commits behind). Every
> finding below was checked against `origin/main`. Anyone executing this plan must start from a
> freshly fetched `origin/main`.

---

## 1. The problem, measured

The published "Run a first CERTEN transaction" walkthrough asks a new developer to do this:

| # | What they do | Why it's there |
|---|---|---|
| 1 | `npm i -g @certen.io/cli`, `certen --version` | install |
| 2 | `certen chains --refresh` | check the gateway serves Base Sepolia |
| 3 | `certen login` (or `auth login --api-key -`) | credential |
| 4 | `certen whoami` | check the credential |
| 5 | `certen init --name … --chains base-sepolia --key dev` | key + identity |
| 6 | `certen identity list`, `identity get ID`, `portfolio`, `doctor`, `keys show dev` | find and copy the identity ID, ADI URL, key page URL, abstract account, key hash |
| 7 | hand-written `curl` to `kermit.accumulatenetwork.io/v3` | check the key page really holds their key hash |
| 8 | check three balances separately: Accumulate credits, org gateway balance, destination gas | each one stalls the flow differently |
| 9 | faucet → maybe a wallet → transfer to a contract address | gas for the abstract account |
| 10 | `certen tx create --identity ID --to-chain … --from ADDR --to … --amount … --sign-with dev --wait --timeout 6` | the actual transaction |
| 11 | `tx status`, `proof get`, `proof verify`, `proof verify --rpc` | find out what happened |
| 12 | compare the proved recipient/amount/chain with their own notes; check the recipient's balance | effect check |

That's **about 17 commands, one raw JSON-RPC call, five values copied by hand** (identity UUID, ADI
URL, key page URL, abstract account address, intent ID) and **three separate funding systems**
before the developer sees one outcome. Most of it is bookkeeping the CLI already has the data for.

### Root causes in the code (origin/main)

1. **No context.** The CLI records identities (`config.identities`, `lastIdentity()`), but only
   `init` reads them. `tx create` and `call` still use `requiredOption('--identity')`; `--sign-with`
   is required everywhere; `doctor` hardcodes `chainHint = 'base-sepolia'`
   (`packages/cli/src/commands/doctor.ts:80`).
2. **Two transfer paths with different ergonomics.** `call` derives `adiUrl`, `fromAddress` and
   `chainId` from the identity. `tx create` does not derive them and refuses without `--from`
   (`transaction.ts:172`), so the most basic action, sending value, is the hardest command to type.
3. **Identifiers are inconsistent.** `identity get`/`tx create`/`call` take a UUID. `governance *`
   takes an ADI URL (`governance.ts:70-118`). The portfolio may not return UUIDs at all
   (`identity list` prints `—` and tells you to upgrade the gateway).
4. **Readiness is scattered and only reported at org level.** `doctor` runs org-wide checks
   ("some identity can sign", "all chain accounts have gas"). Nothing checks *the identity and
   chain I'm about to use*. Nothing reads Accumulate credits, and nothing independently checks the
   key page (that's why the docs tell people to `curl` kermit).
5. **Funding is confusing.** `certen fund` tops up the *org's gateway balance* (stablecoin).
   Destination gas for the abstract account is a different thing with no command at all, just a
   faucet URL. The funding guard only refuses on a balance it has *observed* as zero; it doesn't
   check amount + gas.
6. **The outcome takes four commands to read.** After `--wait`, the user still runs `proof get`,
   `proof verify` and `proof verify --rpc`, and checks the effect by hand. Nothing puts together the
   one record the docs say to keep: intent ID, Accumulate tx ID, destination tx hash, proof.
7. **Help points at the wrong first action.** Root help and `init` suggest
   `certen call … --fn 'confirm(bytes32)' --arg 0x00…` against a placeholder contract. The task the
   docs actually teach first is a transfer.
8. **Small frictions add up.** `--timeout` is unitless minutes (`--timeout 6`); the passphrase is
   prompted on every signing command; `tx create` exposes `--from-chain accumulate`,
   `--contract-address` and `--signer-public-key` in its main help.

What's already good and must be kept: the `--json` envelope contract and exit codes, device-flow
login inside `init`, idempotent `init`, sign-what-you-see (`checkIntentSigning`, refusing to sign
blind), local proof verification through `@certen.io/proof-verify`, `doctor`'s "show the first
blocker", and the `reason_code` outcome model.

---

## 2. Target experience

```bash
npm i -g @certen.io/cli

certen setup                                  # sign in, key, identity, on-chain check, funding: until "Ready"
certen send 0.0001 ETH --to 0xRecipient       # preview, confirm, sign, wait, verify, receipt
```

What `certen setup` prints at the end (human mode):

```
  Ready to transact on base-sepolia

  ✓ Signed in        gateway.kompendium.co · org acme-dev
  ✓ Signing key      dev (encrypted)              hash 9f2c…41ab
  ✓ Identity         acc://jason-dev.acme         active
  ✓ Key page         acc://jason-dev.acme/book/1  holds your key (read from Accumulate, not the gateway)
  ✓ Accumulate       1,240 credits
  ✓ Gateway balance  $4.80 spendable
  ✓ Gas              0x7a3…c91  0.0021 ETH on base-sepolia

  Saved as your default context. Next:
    certen send 0.0001 ETH --to 0x…
```

When gas is missing, setup doesn't exit with a URL. It shows the address, a faucet link and an
EIP-681 URI, then **waits for the funds to arrive** (Ctrl-C is safe and resumable):

```
  ✗ Gas              0x7a3…c91 has 0 ETH on base-sepolia
      Send ≥ 0.001 ETH there: https://www.alchemy.com/faucets/base-sepolia
      Wallet link: ethereum:0x7a3…c91@84532?value=1e15
      Waiting for funds… (Ctrl-C to stop; run `certen setup` again to continue)
```

What `certen send` prints:

```
  Send 0.0001 ETH on base-sepolia
    from  acc://jason-dev.acme  →  0x7a3…c91 (abstract account)
    to    0xRecipient…
    fee   ≈ $0.04 gateway · ≈ 0.00002 ETH gas
  The signature authorises exactly this (checked against your request).
  Sign with "dev"? [Y/n]

  ● signed  ● anchored on Accumulate  ● executed on base-sepolia  ● proof verified locally

  Receipt  intent 7c1e…  ·  acc tx 3b9a…  ·  base-sepolia tx 0x51d…  (basescan link)
  Effect   recipient +0.0001 ETH (block 1834412)
  Proof    VERIFIED: 5 of 5 layers carried, checked here   (certen receipt 7c1e… --explain)
  Saved    ~/.certen/receipts/7c1e….json
```

Targets the golden path must meet, enforced by `scripts/measure-onboarding.mjs` (extended) in CI:

| Metric | Today | Target |
|---|---|---|
| Commands from install to a verified outcome | ~17 + curl | **3** (install, `setup`, `send`) |
| Values copied by hand | 5 | **0** (only the recipient, which the user picks) |
| Funding systems the user has to reason about | 3, separately | 1 checklist with one fix for each item |
| Commands to read the outcome | 4 | 0 (part of `send`); 1 to view it again (`receipt`) |
| Passphrase prompts in the golden path | 2–3 | 1 per command (opt-in session unlock: 0) |

Advanced users lose nothing: every existing command and flag keeps working (see §5).

---

## 3. The plan: eight workstreams

Each one ships separately, is useful alone, and goes in the order given in §4.

### W1. Context: stop asking for what the CLI already knows

- Add an **active context** to `~/.certen/config.json`: `{ identity, key, chain }`, plus named
  **profiles** (`--profile`, `CERTEN_PROFILE`) for people who switch between testnet and mainnet
  or between orgs. Store the gateway URL per profile.
- `certen use identity <id|adi|alias>`, `certen use key <name>`, `certen use chain <slug>`,
  `certen context` (show it). `setup` writes the context when it finishes.
- **One resolver** (`resolveContext()` in a new `src/context.ts`), used by every command. Order:
  flag > env (`CERTEN_IDENTITY`, `CERTEN_KEY`, `CERTEN_CHAIN`) > profile > a single-candidate
  default (e.g. exactly one local key). An ambiguous resolution is a usage error that lists the
  candidates, never a guess.
- **One identity reference type** everywhere: UUID, `acc://` ADI URL, or a local alias. It
  resolves to `{id, adi_url}` (by local record first, then gateway). Governance commands accept
  UUIDs; UUID commands accept ADI URLs.
- Relax `requiredOption('--identity')` and the mandatory `--sign-with` to optional-with-default.
  Relaxing a required flag doesn't break any working invocation.
- **Safety rule:** when a value came from context rather than a flag, the command says so on stderr
  (`using identity acc://jason-dev.acme (context)`), and the confirmation card shows it.
  **Mainnet chains never come from a default.** A value-moving command on a mainnet chain needs
  `--chain` spelled out, or a profile explicitly marked `allow_mainnet_default: true`.

### W2. `certen setup`: one resumable onboarding command

Rework `init` into a step machine and add `setup` as its primary name (`init` stays as an alias,
same flags). Steps, each with check → act → verify, skipped when already satisfied:

1. **Gateway**: reachable, serves this CLI version (`check:gateway` logic), serves the requested chain
   (replaces `chains --refresh` as a manual step).
2. **Signing key**: reuse or create (encrypted by default). This comes *before* the credential,
   because a new user's key is what creates their account.
3. **Credential**: one question when nothing is configured: "Sign in to an existing CERTEN account
   (browser), or create one with this key?" Existing → device flow; new → keypair signup
   (`selfSignup`, no browser). Then the existing paste/stdin fallback. `--token` (registration
   token) for CI. Replaces `login` + `whoami` in the journey.
4. **Identity**: reuse from context, or create and wait.
5. **Key page check**: require the gateway's `can_sign === true` (the gateway already reads the key
   page from Accumulate), **and** independently read the key page from Accumulate (endpoint from
   `GET /v1/chains` → `accumulate.api`, overridable with `--accumulate-rpc`) and confirm that
   `keys[].publicKeyHash` contains the local key's hash. The second read turns the docs' manual
   `curl` into code and means the user doesn't have to trust the gateway's flag. If the two
   disagree, that's a blocker. Put it in the SDK (`verifyKeyPageHolds(keyPageUrl, hash, {rpc})`), reusing
   `@certen.io/proof-verify`'s Accumulate encoding, so MCP and the SDK get the same check.
6. **Accumulate credits (new)**: read `credit_balance` (live from the key page) and compare it with
   the per-intent cost. There is no top-up endpoint today (§6 G6), so the fix is a precise
   instruction plus a portal link.
7. **Gateway balance**: the existing `billing.balance()`; fix = `certen fund`.
8. **Destination gas**: per linked chain. Fix = address + faucet + EIP-681 URI; with `--wait-for-funds`
   (the default when interactive) poll until the balance is above the threshold.
9. **Context**: write `{identity, key, chain}`; print the readiness card and the next command.

Flags: `--name`, `--key`, `--chain(s)`, `--yes`, `--no-wait-for-funds`, `--accumulate-rpc`,
`--profile`. Exit codes: `0` ready; `1` blocked (envelope carries `readiness` with the first
blocker); `3` unreachable. If interrupted, rerun the same command; it picks up where it stopped.

### W3. Readiness: one model, three surfaces

- New SDK function `client.readiness({identity, chain, key?, amount?})` returns an ordered list of
  checks `{name, status: ok|fail|warn|unknown, detail, fix: {command?, url?, text}}` plus
  `ready: boolean` and `first_blocker`. Checks: gateway, credential, identity provisioned,
  key page holds key (independent), Accumulate credits, gateway balance, gas ≥ amount + estimated
  gas, chain served.
- `setup` runs it to drive its steps. **`certen status`** (new) prints it for the current context.
  `doctor` becomes `status --all` plus the org-wide checks it already has (keep `doctor`; take out
  the hardcoded `base-sepolia`). `send`/`call` run it as a pre-flight before unlocking the key.
- MCP gets a read-tier `certen_readiness` tool built on the same function.
- Replace the zero-only funding guard with the readiness gas check (amount + estimated gas).
  Keep the existing rule that an *unknown* balance doesn't block, and keep `--force`.

### W4. Task verbs: `send`, and a context-aware `call`

- **`certen send <amount> <asset> --to <addr> [--chain c] [--identity i] [--sign-with k]`**, with
  natural positional order (`send 0.0001 ETH --to 0x…`). It's built on `execute.transfer` / the
  same intent `tx create` builds, and derives `fromAddress` from the identity exactly like `call`.
  The asset symbol is checked against the chain's native symbol (`nativeSymbolFor`) or a known
  token, so "ETH" on a TEL chain is refused instead of guessed. Amounts stay whole units, given as
  strings; a value that looks like wei (long integer, > 10^12) is refused with a hint, as today.
- `call` loses its required `--identity`/`--sign-with` (context) and gets the same preview card.
- **One confirmation card** for every value-moving or authorising command (`send`, `call`,
  `tx create --sign-with`, governance, pending sign). It renders the existing `checkIntentSigning`
  summary in a compact form: chain, from, to, amount, fee (a `/v1/pricing` estimate labelled as an
  estimate until §6 G5 exists), extra authorities, expiry, and
  whether it matched the request. Interactive: `[Y/n]`. `--yes` or `--json` skips the prompt but
  never skips the check. Mainnet: the default answer is `n` and the chain name is shown in
  capitals.
- `tx create` stays as the plumbing command, but derives `--from` when it's missing (the same
  `abstractAccountFor` as `call`), so the existing README invocation gets shorter without breaking.

### W5. Outcome: the receipt is the product

- `send`/`call` (human mode, wait on by default) end with the **receipt card** from §2. This means:
  1. waiting until terminal (existing `waitForTransaction` + `intentOutcome`);
  2. collecting intent ID, Accumulate tx ID, destination tx hash + explorer URL (chain catalogue);
  3. **checking the effect**: for a native transfer, the recipient's balance before and after at
     the execution block, using the user's `--rpc` if given, else the gateway; for a call, the
     expected event if `--expect` was given;
  4. **verifying the proof locally** through the existing `proof verify` path. If the bundle
     isn't served yet (the ~100s backfill), say "proof pending" and give the exact resume command.
     Don't block for more than the budget, and never show PARTIAL or NO EVIDENCE as verified;
  5. writing `~/.certen/receipts/<intent>.json` (request record + all IDs + verdicts).
- **`certen receipt <intent>`**: show the receipt again, refresh pending parts, `--explain` to print
  the per-layer table (G1b, G2, L5, …), `--rpc` to re-check against your own node, `--share` to
  make a share link. The existing `tx status`, `proof get/verify` keep working.
- **`certen watch <intent>`**: pick a wait back up after Ctrl-C. While waiting, Ctrl-C prints
  "the intent keeps running; resume with `certen watch <id>`" and exits 130.
- Durations accept units everywhere: `--timeout 6m`, `90s`, `1h`. A bare number still means
  minutes, for compatibility.
- The receipt's JSON shape is a new, documented part of the `--json` contract
  (`docs/CLI-CONTRACT.md`) with conformance tests.

### W6. Funding without the guesswork

- Split the meanings: **`certen gas [--chain c] [--wait]`** for the abstract account's destination
  gas (address, balance, faucet, EIP-681/QR, wait for arrival). **`certen fund`** keeps meaning
  the org gateway balance. Its help and the readiness card say "gateway balance (pays CERTEN fees)",
  not "fund".
- `certen credits` (or a `credits` line in `status`) shows Accumulate credits and how to top up,
  using whatever the gateway provides (§6).
- When a faucet can't pay a contract address, `gas` says so and gives the two-step workaround
  in one block (fund a dev wallet, then `gas --from-wallet` prints the exact transfer to make).
- If the gateway gets a testnet drip or sponsored gas (§6), `setup` uses it automatically on
  testnets and this whole step disappears for most users.

### W7. Less to learn: help, errors and docs

- Root help leads with **setup · send · call · status · receipt**. Everything else goes in groups,
  and plumbing (`tx create/sign/inspect`, `keys sign`, `pending submit`, `admin`, `oauth-clients`,
  `orgs`) goes under an "Advanced" group. Nothing is hidden or removed.
- Every failure envelope and human error ends with exactly one `next:` command (e.g.
  `IDENTITY_CANNOT_SIGN` → `certen status`; `ABSTRACT_ACCOUNT_UNFUNDED` → `certen gas --wait`).
  Add `next` as an optional field in the JSON error envelope; adding a field doesn't break the contract.
- **Passphrase friction**: (a) one prompt per command, as today; (b) opt-in
  `certen keys unlock dev --for 15m`, which keeps the decrypted key in the OS keyring with an expiry
  (`@napi-rs/keyring`, already a dependency) and wipes it on expiry or `keys lock`. Never on by
  default, and refused when the keyring is unavailable. This needs a security review before release.
- Docs: rewrite "Run a first CERTEN transaction" around `setup` → `send` → `receipt`, with a
  short "What just happened" section that keeps the substance of the current page (async
  provisioning, three resources, layer verdicts, why exit 0 ≠ everything verified) as explanation,
  not as steps. Update `README`, `docs/guides/first-proof-in-three-commands.md`,
  `onboard-an-identity.md`, `skills/certen/SKILL.md`, and `llms.txt` via agentgen templates.

### W8. Same experience for agents and the SDK

- Readiness, identity reference resolution, key page checking, transfer-from-identity derivation and
  receipt assembly go into the **SDK** (`client.readiness()`, `client.identity.resolve()`,
  `client.execute.send()`, `assembleReceipt()`), and the CLI is a thin renderer on top. This
  follows the existing pattern (`doctor`, `checkIntentSigning`, `intentOutcome` all live in the SDK).
- MCP: add `certen_readiness` (read) and `certen_receipt` (read). Under the existing tier rules,
  `send` is a write-tier tool that never takes key material. It returns signing data plus the
  summary, as the intent tools already do.

---

## 4. Phasing

| Phase | Ships | Contents | Size |
|---|---|---|---|
| 0 | — | Sync to origin, baseline `measure-onboarding` numbers, fix stale AGENTS.md header (versions, layout incl. `packages/verify`) | S |
| 1 | cli 0.11 | **W1 context** + identity reference type + duration units + `tx create` derives `--from` | M |
| 2 | sdk/cli 0.12 | **W3 readiness** in SDK (incl. independent key page check + credits) → `certen status`, `doctor` scoped; funding guard on amount + gas | M |
| 3 | cli 0.13 | **W2 `setup`** step machine with wait-for-funds, `certen gas` (W6 part) | M |
| 4 | sdk/cli 0.14 | **W4 `send`** + confirmation card for all signing commands; **W5 receipt/watch** | L |
| 5 | cli 0.15 | **W7** help/next/docs rewrite; `keys unlock` (behind security review) | M |
| 6 | mcp | **W8** MCP readiness/receipt tools; llms.txt regen | S |
| G | gateway | §6 gateway changes. Separate repo and separate PRs; the CLI degrades gracefully without them | M–L |

Phases 1–3 together get the golden path to 4 commands (`setup`, `call`/`tx create` with
context, `proof verify`). Phase 4 gets it to 3 with an automatic receipt.

Each phase: a feature branch, one PR (main is protected), green
`npm run build && npm run typecheck && npm test && npm run agentgen:check`, CHANGELOG entry,
contract doc updated for any `--json` addition, and a measure-onboarding run attached to the PR.
Release and tagging follow the existing staged release workflow, done by a maintainer.

---

## 5. Compatibility and safety rules (non-negotiable)

1. **`--json` contract.** One envelope on stdout; exit codes 0/1/2/3 (and `proof verify`'s 4/5)
   unchanged. New fields are additive. New commands get conformance cases.
2. **Nothing existing breaks.** Every current command and flag keeps its meaning. Required flags
   may become optional; optional ones never become required. `init`, `login`, `doctor` stay.
3. **Never sign blind.** Every new signing path goes through `checkIntentSigning`; `--yes` skips the
   prompt, never the check.
4. **Defaults never move value on mainnet** without an explicit chain (W1 safety rule).
5. **Unknown is not OK.** Readiness reports `unknown` separately and never shows it as ready; a
   PARTIAL proof is never called verified.
6. **No live value movement or credential minting in tests.** Live end-to-end runs on testnet are
   done by a human, or by the existing `e2e-onboarding` workflow with its secrets.
7. **Contract and docs travel with the code.** `docs/CLI-CONTRACT.md`, README, guides, CHANGELOG
   and agentgen output are updated in the same PR as the behaviour.

---

## 6. Gateway: what helps, what already exists

Checked against `api-gateway@origin/main`. Below: what the CLI should use **now**, and what to
ask the gateway for. Every CLI phase works without the asks; each ask removes a step or a guess.

**Already there, under-used by the CLI**

| Capability | Where | Use it for |
|---|---|---|
| Keypair signup: `POST /v1/signup/challenge` + `/v1/signup` creates an org + API key from a signature by a local Ed25519 key, with a $10/30-day trial credit | `routes/signup.routes.ts` | `setup` for a **new** user: make the key first, then sign up with it. No browser at all. (Already in the CLI as `signup --with-key`, but nothing in the journey uses it.) |
| Device flow (RFC 8628) | `routes/device-auth.routes.ts` | `setup` for a user who **already has** an org |
| `GET /v1/identity/:id` computes `can_sign` by reading the key page **directly from Accumulate** and matching `public_key_hash`; `credit_balance` is live from the key page | `identity.routes.ts` (`computeCanSign`) | Readiness: key page and credits checks. The manual kermit `curl` in the docs is already done by the gateway. The CLI's own read (W2 step 5) is a trust-minimising second opinion, not the only check |
| Create response carries `polling{first_poll_after_seconds, interval_seconds, estimated_ready_in_seconds, terminal_states}` | identity create | Drive `setup`'s wait and progress estimate from it instead of hardcoded constants |
| 402 body carries `resolve{to_address, amount_usd, cli_command, portal_url}` + `how_to_pay` | `payment-required.schema.ts` | Render it as a readiness fix, not an error dump |
| `GET /v1/chains` carries `accumulate{network, api, explorer}` and per-chain `explorer` | `config/networks.ts` | Accumulate endpoint for the independent check; explorer links in the receipt |
| `GET /v1/transaction/:id` carries `completion_basis`, `reason_code`, `validator{state, overdue}`, `signatures{still_needed}`, `proof_lookup`, joined `proof{layers…}` | `transaction.orchestrator.ts` | The receipt card and the "why is it stalled" line, without extra calls |
| `GET /v1/proof/:id/v2` portable document | `proof.routes.ts` | Local verification in the receipt (already used by `proof verify`) |
| `GET /v1/health/ready` `reasons[]` incl. `sponsor_below_floor` | health routes | First readiness check ("platform can provision right now") |

**Asks, in priority order**

| # | Ask | Removes | Interim CLI behaviour |
|---|---|---|---|
| G1 | **Testnet gas drip**: `POST /v1/identity/:id/chain-accounts/:chain/drip` (rate-limited, testnet-only, sponsor-funded) | The faucet / dev-wallet / transfer dance: the biggest remaining manual step | `certen gas` with faucet + EIP-681 + wait-for-funds |
| G2 | **Default `fromAddress`** from the identity's linked chain account when the intent omits it | A required value the gateway already knows | CLI derives it (W1/W4) |
| G3 | **`GET /v1/identities`** with UUIDs, plus lookup by `public_key_hash` | Context lost on a new machine; `identity list` printing `—` | Local record plus portfolio by ADI |
| G4 | **`GET /v1/identity/:id/readiness?chain=&amount=`**: one aggregate of status, can_sign, credits, chain account deployed, native balance vs. estimated gas, org spendable | Five reads stitched together client-side | SDK `client.readiness()` aggregates (W3) |
| G5 | **Intent quote/preflight**: `POST /v1/transaction/quote` (fee, estimated gas, chain/identity gates) with no side effects | "fee ≈" guesswork on the confirmation card; failures discovered after signing | Show the price book (`/v1/pricing`) estimate, labelled as an estimate |
| G6 | **Credit top-up** for an existing key page, `POST /v1/identity/:id/credits` (billed) | A dead end when credits run out after the 500 granted at provisioning | Readiness names the shortfall and links the portal |
| G7 | **Long-poll** `?wait=60s` on identity and transaction GET, plus `identity.active`/`identity.error` webhooks | Polling cadence guesses; faster `setup` | Poll on the server's `polling` hints |
| G8 | **Expose address derivation** before linking/provisioning finishes | "Fund this address" can't be shown until the chain step | Show it as soon as `chain_accounts` has it |
| G9 | Hygiene: derive the advertised `accumulate` block from `ACCUMULATE_API_URL` (it can drift today); fix the identity-status docs (`provisioning` vs the real `creating`); drop or implement `completion_evidence` in the status description; align device-flow and keypair-signup key scopes | Wrong endpoint for the independent check; misleading docs | CLI accepts `--accumulate-rpc` |

Operational note for `setup`: self-service is off unless `SELF_SERVICE_ENABLED=true`, and an
unapproved keypair org is capped at **one** identity (`SELF_SERVICE_KEYPAIR_MAX_IDENTITIES=1`). That
slot is used up by a failed attempt until it's retired. So `setup` must reuse an existing identity
aggressively, and on a provisioning `error` it should offer `identity retire` + retry rather than
creating a second identity that will be refused.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| A default identity or chain sends value from the wrong place | Echo resolved context; confirmation card; no mainnet defaults; profiles keep testnet and mainnet apart |
| An independent key page read disagrees with the gateway's `can_sign` | Report both and treat disagreement as a blocker with its own reason code; never silently prefer either |
| `send` waits so long that people think it hangs | Live step line; an honest 60–110s estimate; Ctrl-C resumable with `watch`; budget unchanged (do not shorten) |
| Session unlock widens the key-exposure window | Opt-in, time-boxed, keyring-only, security review gate, documented threat model |
| Readiness adds round trips to every send | Batch reads, reuse `identity.get({include:['balances']})`; measure with `measure-onboarding` and fail CI on regression |
| Scope creep into gateway work blocks the CLI | Every CLI feature works against today's gateway; gateway items only remove steps |
