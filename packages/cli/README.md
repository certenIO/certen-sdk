# `@certen.io/cli`

The `certen` command line for the [CERTEN Gateway](https://gateway.kompendium.co/reference) —
proof-gated cross-chain execution on Accumulate.

**Docs: <https://docs.kompendium.co>** · **Portal: <https://gateway.kompendium.co/portal>**

```bash
npm install -g @certen.io/cli
```

Requires **Node 22 or 24** (`engines.node >=22`).

## From nothing to a proof

```bash
certen setup                              # key, account, identity, on-chain checks and gas, until it says "Ready"

certen send 0.0001 ETH --to 0xRecipient   # preview, confirm, sign, wait, verify the proof here, keep a receipt

certen receipt                            # the record again: what is verified, what is not, and the ids to keep
```

That is the whole path: install, `setup`, `send`. `send` ends with a **receipt** (see [Send, and the receipt](#send-and-the-receipt)); to hand a counterparty
the evidence itself, `certen proof get <intent-id>` or `certen receipt <intent-id> --share`. The other route, a proof-gated **contract call**, is
[further down](#proof-gated-contract-calls): `certen call --to 0xYourContract --fn 'confirm(bytes32)' --arg 0x… --wait`.

`certen setup` is one resumable command. It makes (or reuses) your signing key, **then** the account the key creates (or signs you in to the one
you have), then the identity, waits until the identity can sign, reads your key page from Accumulate, checks the credits, the gateway balance and the
gas on the abstract account, and saves what it settled on as your context. Run it again and it continues instead of repeating: one account, one
identity. It exits `0` only when you are ready to act.

```bash
certen setup --new-account      # no account yet: create one with your signing key (no browser)
certen setup --existing-account # you have one: approve this machine in the portal (never copy a key)
certen setup --token crt_…      # CI: redeem a registration token
```

When gas is the only thing in the way, `setup` does not stop at a URL. It shows the account, a faucet, a wallet link (EIP-681) and what to send, then
**waits for the funds to arrive** (that is the default at a terminal; `--wait-for-funds` does it anywhere, `--no-wait-for-funds` never). Ctrl-C is safe:
run `certen setup` again to continue. The amounts are planning figures, not a quote: the gateway publishes no per-execution gas cost.

`certen gas` is the same, on its own: what the abstract account holds, what to send where, and `--wait` for it. It is **not** `certen fund`, which
tops up the organization's gateway balance (the stablecoin that pays CERTEN's fees).

### Asking the platform for gas or credits: `gas --drip`, `credits topup`

Two commands spend **the platform's** money, not yours: `certen gas --drip` asks it to send testnet gas to an account that is short, and
`certen credits topup --credits 500` adds credits to an identity's key page (1 credit = $0.01; `--credits` is a **count of credits, never ACME**). The
operator switches both off by default, so against most gateways today they answer `DRIP_DISABLED` / `CREDIT_TOPUP_DISABLED` in plain words, and the
manual route (`certen gas` without the flag) is still there.

```bash
certen gas --drip [--wait] [--yes]                          # only when the account is short; a funded account is reported funded and nothing is sent
certen credits topup --credits 500 [--identity <ref>] [--yes] [--idempotency-key <key>]
```

- **Nothing spends unattended.** At a terminal you are asked and a bare Enter is *no*. With nobody to ask (a pipe, CI, `--json`) the command refuses with
  exit `2` before it reads or sends anything, unless you pass `--yes`. `--json` is not consent.
- **The Idempotency-Key is printed every time** (and is in the `--json` result). Pass it back with `--idempotency-key` to repeat the *same* attempt: a
  repeat with the same key can never be a second draw, a new key can. A script that retries must reuse the key it was told.
- **`unconfirmed` is not a success.** If the gateway does not know whether it sent the drip or applied the credits, the command says the credits (or gas)
  **may** be there, exits `1` (`CREDIT_TOPUP_UNCONFIRMED`, `DRIP_UNCONFIRMED`), and names the command that settles it: `certen identity readiness` to read
  the credits back, `certen gas --wait` to watch for the gas. A plain `submitted` / `sent` exits `0`; `submitted` means accepted, not yet confirmed.
- **One attempt, and no retry of a limit.** A limit is a window, and a switch that is off does not turn on by retrying: the CLI sends one request and
  explains. When the connection drops after the request left, the exit is `3` but the spend **may** have happened: repeat with the same key.

The steps one at a time, if you prefer them: `certen login` (approve this machine once in the portal; the key arrives here) and `certen init`
(signing key, identity, funding). `init` is unchanged: it exits `0` once its steps are done, whether or not the account can act yet.

**You never copy an API key.** `certen login` (and `setup --existing-account`) uses the device authorization grant: it prints a
short code, you approve that code in a portal session you already trust, and the CLI collects the
key over its own channel. The secret is never displayed here and never passes through your
clipboard or your shell history.

`certen init` and `certen setup` are idempotent. They create only what is missing, records the identity id so a later
run reuses it, waits until the identity can actually sign, and tells you if an abstract account
needs gas before it can execute anything.

Stuck at any point:

```bash
certen doctor         # names the one thing blocking you, and the command that fixes it
certen status         # is THIS identity, on THIS chain, with THIS key ready to act? the first thing in the way
certen status --amount 0.001   # ...and is there enough gas to send that much
```

`status` reads your key page from Accumulate itself, not only from the gateway (the check the walkthrough used to do with a hand-written `curl`), and
reports anything it could not confirm as unconfirmed rather than ready. It exits `0` only when everything is ready.

**Every failure ends with one line, `next: <command>`**: the command to run. It is the last line on stderr, and `error.next` in the `--json` envelope.

```
Error [ABSTRACT_ACCOUNT_UNFUNDED]: The abstract account 0x7a3…c91 on base-sepolia holds no testnet gas. …
  next: certen gas --chain base-sepolia --wait
```

A wrong flag ends `next: certen <command> --help`; no API key, `certen setup`; an identity that cannot sign, `certen status`; a wait that ran out,
`certen watch <intent-id>`; a rate limit, `certen errors RATE_LIMIT_EXCEEDED` (what it means, and whether retrying can help). Angle brackets are for you to
fill. It is a hint to run, never run for you, and never copied from the gateway. See `docs/CLI-CONTRACT.md` section 11.

### Finding your way around

`certen --help` leads with the five commands a person types, in order, and puts plumbing last. Nothing is hidden, and `certen <command> --help` is
unchanged for every command (`tx create` lists its key-page and contract-address options under "Advanced options").

| Group | Commands |
|---|---|
| **Start here** | `setup` · `send` · `call` · `status` · `receipt` |
| Follow it through | `watch` · `proof` · `gas` · `doctor` |
| Your account | `whoami` · `context` · `use` · `identity` · `keys` · `chains` · `portfolio` · `login` · `signup` · `auth` · `init` |
| Approve | `pending` · `governance` |
| Money | `balance` · `fund` · `pricing` · `quote` · `payers` · `ledger` · `receipts` · `verify` |
| Advanced | `tx` · `admin` · `scopes` · `webhooks` · `oauth-clients` · `orgs` · `errors` |

### Say it once

The CLI records the identity it made, so it stops asking for it. Choose the identity, key and chain once and leave the flags out:

```bash
certen context                       # what the next command will use, and where each value came from
certen use identity jason-dev        # a name, an acc:// ADI URL or a UUID
certen use key dev
certen use chain base-sepolia

certen send 0.0001 ETH --to 0xRecipient
certen call --to 0xYourContract --fn 'confirm(bytes32)' --arg 0x… --wait
```

Flag, then environment (`CERTEN_IDENTITY`, `CERTEN_KEY`, `CERTEN_CHAIN`), then profile, then "the only one there is". Two candidates and no choice
is a question that lists them, never a guess. Every value taken from context is printed on stderr before anything is signed, and a chain that
is not a known testnet is **never** taken from a default by a command that moves value: spell it out with `--chain`.

`--profile <name>` (or `CERTEN_PROFILE`, or `certen use profile`) switches between setups, for example testnet and a second organization. A
profile has its own gateway and its **own API key**, so one profile's key is never sent to another's gateway. `--timeout` takes `90s`, `6m`,
`1h` (a bare number is minutes).

### If your gateway predates device authorization

`certen login` will say so and point at the portal. Mint a key there and hand it over without
putting it in your shell history:

```bash
certen auth login --api-key -   # reads the key from stdin
```

## Your key never leaves this machine

`certen keys generate` creates an Ed25519 key, encrypts it with a passphrase (scrypt + AES-256-GCM),
and writes it to `~/.certen/keys/<name>.json` with `0600` permissions. The CLI sends **signatures**
to the gateway. It never sends a private key, and there is no code path that could.

```bash
certen keys generate --name dev          # prompts for a passphrase (confirmed)
certen keys generate --name ci --no-passphrase   # unencrypted; file permissions only
certen keys list                         # metadata only — never decrypts
certen keys show dev
certen keys verify dev                   # proves the key decrypts and signs correctly
certen keys sign --name dev --signing-data @sd.json   # rebuild, show, then print a signature; sends nothing
certen keys delete dev --yes
certen keys path
```

Set `CERTEN_KEY_PASSPHRASE` to skip the prompt in CI. When it is set and there is no TTY, the CLI
uses it; when neither is available it fails with an explanation rather than hanging on a prompt
nobody can see. Each signing command asks once, after its readiness checks, and a wrong passphrase ends the
command (`WRONG_PASSPHRASE`) before any intent exists.

**Typing it less (experimental).** `certen keys unlock dev --for 15m` keeps the *decrypted key* (never the passphrase) in your OS keyring
until it expires, so signing commands in that window do not ask; `certen keys lock dev` (or `--all`) wipes it. The default is 15 minutes and the
longest 8 hours; it is refused where there is no OS keyring (it never falls back to a file) and for a key stored without a passphrase. It
replaces the passphrase and nothing else: the confirmation card and the check of what is signed still run. **It is inert unless you set
`CERTEN_EXPERIMENTAL_KEY_UNLOCK=1`**, because it ships behind a written security review
([`docs/security/keys-unlock-review.md`](../../docs/security/keys-unlock-review.md)); read that first. `keys lock` works either way, and
`keys list` shows `unlocked_until` only while the switch is on.

**`certen keys sign` sends nothing anywhere.** It is the air-gapped path: generate on one machine, carry the gateway's
`signing_data` to it, carry the signature back. It rebuilds the transaction from that data offline, recomputes every hash,
requires the signature metadata to name this key, prints what the signature would authorise, and signs the recomputed hash.
A bare `--hash` is refused (`BLIND_SIGNING_REFUSED`): there is no way to sign a hash blind.

## Send, and the receipt

```bash
certen send 0.0001 ETH --to 0xRecipient          # identity, chain and key come from your context
certen send 0.0001 ETH --to 0xRecipient --rpc https://sepolia.base.org   # ...and a node of yours closes the proof's last layer
certen send 0.0001 ETH --to 0xRecipient --dry-run   # every check, nothing signed
certen receipt            # the most recent receipt, refreshed
certen watch <intent-id>  # pick a wait back up after Ctrl-C or a timeout
```

`send` takes what you know (how much, of what, to whom) and does the rest in the order that keeps you safe:

1. **It checks the invocation without the network.** The amount is **whole units** (`0.0001` is a ten-thousandth of an ETH; a wei-looking integer is refused). The recipient must be an EVM
   address, and **a mixed-case one whose EIP-55 checksum does not hold is refused** with the correct capitalisation named: that is a mistyped address, and nothing downstream can correct it. The
   asset must be the chain's **native token** (`ETH` on Base Sepolia). What a token transfer moves is chosen downstream and cannot be checked before signing, so a token is refused by name; use
   `certen call` with `transfer(address,uint256)`, which shows exactly what it will call. A chain that is not a known testnet is never taken from a default: spell it out with `--chain`.
2. **It checks readiness before it asks for a passphrase** (the same checks as `certen status`, for this amount), so a passphrase is never asked for in order to fail. A failing check refuses
   and says what to do. A check that could not be answered is shown and does not block. `--force` excuses the gas checks only.
3. **It shows the confirmation card and asks.** What is about to happen in your own terms, the recipient in full, the fee (an estimate from the price book, or "not available"), **the gateway's own
   estimate of this request** (labelled an estimate, with the gates it checked and the ones it did not; "unavailable" when the gateway has no such route or does not answer, and then the send is
   exactly what it would have been; `certen quote <amount> <asset> --to <address>` shows the same before you commit), every value you did not
   type and where it came from, then what the signature will authorise, **rebuilt from the gateway's bytes and matched to your request**. At a terminal it asks `Sign with "dev"? [Y/n]`; on
   anything that is not a known testnet the chain name is in capitals and the default is **no**. `--yes` says yes in advance (it is required when nobody is at a terminal, or `send` refuses before
   reading a passphrase). `--yes` and `--json` skip the question; **nothing skips the check of what is signed**.
4. **It signs, waits for the proof cycle (60–110 seconds, never shortened), verifies the proof here, checks the value arrived, and writes the receipt.** Ctrl-C stops the wait, not the
   intent: it prints `certen watch <intent-id>`, exits `130`, and the receipt so far is already saved.

The same card, with the same question, now precedes the signature in `call`, `tx create --sign-with`, `governance <operation> --sign-with` and `pending sign --sign-with` (each takes `--yes`). Piped,
those commands behave as they always have: the card is shown and they sign, so a script that works today keeps working.

### The receipt

The record the docs have always told you to keep (the intent, the Accumulate transaction, the destination transaction, the proof) used to take four commands and a hand comparison. It is saved to
`~/.certen/receipts/<intent-id>.json` (`0600`; it holds no key, passphrase, API key or node URL) and says what is **established and what is not** (values shortened here; the real one prints them in full):

```
  [done] signed  [done] anchored on Accumulate  [done] executed on base-sepolia  [ ?? ] proof verified locally

  Receipt   intent          7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13
            accumulate tx   acc://ab…ab@alpha.acme/data
            base-sepolia tx 0x5917…5d48   (from the verified proof)
  Effect    The recipient's balance was not checked: no node of yours was given…
  Proof     PARTIAL: 9 of 11 layers carried are established; G1_chains, outcome are not.
  Not established:
    - The execution layer rests on the validators' own statement of the block until it is compared with a header from a node you trust.
```

- **Exit `0` means done *and* checked.** `send`, `receipt` and `watch` exit `0` for **VERIFIED** (or for an action whose proof can never exist, which says so), `1` for a failed intent or a proof layer that does
  not hold, **`4` for PARTIAL or still pending**, `5` for no evidence, `130` for Ctrl-C. A script that reads `0` as verified is right. (`send --no-wait` returns `0` once the signature is in; the receipt reads `pending`.)
- **PARTIAL and NO EVIDENCE are never shown as verified.** The proof's execution layer is only checked when its receipts root is compared with a block header from **a node you trust**, so without `--rpc` (or `CERTEN_RPC_URL`) a receipt
  is an honest PARTIAL that names that layer. With one, the recipient's balance is also read from it before signing and after the execution block (the gateway cannot read another address, and is not counted as a witness).
  The node's chain id is checked first, and its URL is never printed or saved: hosted nodes put a key in the path.
- **A proof whose Accumulate page chains were not captured is PARTIAL too** (`G1_chains`). A fully VERIFIED receipt needs a live proof that carries them: not yet run live, so treat PARTIAL naming those layers as the expected honest result today.
- `certen receipt [intent]` shows it again, **re-verifying the proof here** and refreshing whatever was pending (`--list` lists the saved ones, `--offline` asks nothing, `--explain` prints the layers, `--share` makes a link a
  counterparty opens with no CERTEN account). `certen watch <intent>` waits for an intent to finish and shows it. Both work for any intent, not only ones this machine sent. (`certen receipts` is something else: your billing receipts.)

- **The destination transaction is the validators' word, and is shown that way.** When the gateway reports the transaction an intent made on its destination chain, `send`, `receipt`, `watch`, `call` and
  `tx status` print it under its own `Recorded` row with its settlement, **"as recorded by the validators; not verified"**. The gateway copies it from what the validators wrote down and does not read the
  chain; it is not proof (the `Proof` row is) and is not part of the saved receipt. `--json` carries it as `data.destination` (`null` until recorded, and for an intent on several chains).

`--json` is one envelope with `data.receipt`, `data.saved_to` and `data.destination`; the shape is versioned and documented in [docs/CLI-CONTRACT.md](../../docs/CLI-CONTRACT.md) section 10.

## Proof-gated contract calls

```bash
certen call --identity <uuid> --chain base-sepolia --to 0xTarget \
    --fn 'confirm(bytes32)' --arg 0x… --sign-with dev --wait
```

`call` shows the same confirmation card before it signs (asking at a terminal), and `call --wait` ends with the same receipt after its usual output (its `--json` output is unchanged).

`--fn` takes a Solidity signature and `--arg` repeats positionally. Arguments are checked against
the signature **before** anything is sent — on a proof-gated call, a valid proof of the *wrong*
call is still a valid proof, so a mis-encoded argument is worse than an error.

The ADI URL, the abstract account (`msg.sender` on chain) and the numeric chain id are all derived
from the identity. You do not supply them, and you should not need to know that omitting them
produces a bodyless 502.

`--dry-run` prints the intent that would be sent without sending it — also the starting point if
you need a multi-leg intent, which you then pass to `tx create --intent @file.json`.

### Deadlines: `--expires-in`

```bash
certen call … --expires-in 30m        # s, m, h or d; 90s to 7d
```

Sets `expires_at` to now plus the duration, measured when the intent is opened (after any
passphrase prompt). The gateway accepts 60 seconds to 7 days; the CLI and SDK refuse under 90 seconds
so request latency cannot push a deadline below the gateway minimum. If a required signature is still missing when it
passes, the intent ends `failed` with `reason_code: expired`: nothing executes, no fee or gas.
`certen tx status <id>` shows `expires_at`, and the reason once it has ended. Also on `tx create`.

### Extra header authorities: `--authority` (refused by default)

```bash
certen call … --authority acc://fictional-firm.acme/book --authority acc://fictional-bank.acme/book
```

Repeatable, up to 8 `acc://` key books, added to the Accumulate transaction header as authorities
that must also sign. **The gateway refuses this by default** with `HEADER_AUTHORITY_NOT_EXECUTABLE`
(HTTP 422, exit 1): CERTEN validators do not yet count a header authority's signature, so the intent
would collect every signature and still never execute. To require a co-signer, make its key book an
authority on the **account** (`certen governance add-authority`), or have it accept in a separate
transaction before the intent is opened. The flag exists for gateways configured to allow header
authorities, and for when validators support them.

### Why an intent failed: `reason_code`

`certen tx status <id>` (and `--json`) always includes `reason_code`, `completion_basis`,
`expires_at` and `additional_authorities` (null when unset). The reasons worth telling apart:

| `reason_code` | Meaning |
|---|---|
| `expired` | The deadline passed with signatures missing. Nothing executed. |
| `expectation_unmet` | The call executed, but its `expectedEvents` are not in the receipt. Not a success. |
| `target_reverted` | The contract rejected the call. Retrying the same call reverts again. |
| `policy_denied`, `network_failed`, `post_submission_timeout`, `pre_submission_error` | CERTEN did not complete. |

`completion_basis` says what a `completed` status rests on: `proof_artifact` or `execution_observed`.

## Transfers

```bash
certen tx create --identity <uuid> --to-chain ethereum-sepolia \
  --from 0xYourAbstractAccount --to 0xRecipient --amount 0.001 --sign-with dev --wait
```

**`--amount` is in WHOLE UNITS** of the chain's native token. `1` means one ETH (one TEL on Telcoin Adiri), `0.5` means half. This is the field most
worth reading twice: the gateway documented it as wei until 2026-08-11, and someone sending `1`
meaning one wei moves a whole ETH — which on a funded account succeeds silently.

`--from` is the identity's abstract account on the source chain; `certen portfolio` shows it.

If that account has no gas, the CLI refuses before submitting. That refusal is worth having: an
intent from an empty abstract account is accepted, signed and submitted — every step reports
success — and then parks at `anchoring` forever, because the execution leg cannot run on chain.
`--force` overrides it.

`certen send` is this transfer without the plumbing: it derives `--from`, checks readiness first and ends in a receipt. `tx create` stays for when you want the steps (it takes `--yes` too).

Or drive the steps yourself — useful when the signer is an HSM, another machine, or your own
policy engine:

```bash
certen tx create --identity <uuid> ...          # returns signing_data.hash_to_sign
certen tx inspect <intent-id>                   # rebuild it, check every hash, show what a signature authorises
certen keys sign --name dev --signing-data @sd.json   # or your HSM, after reading the same summary
certen tx sign <intent-id> --signature <sig> --public-key <pub>
```

`--signature`/`--public-key` remain first-class. `--sign-with` is a convenience, not a replacement.

## Proofs

```bash
certen proof get <intent-id>        # also accepts a proof id or a transaction hash
certen proof bundle <proof-id>      # the artifact to hand over
certen proof share <proof-id>       # a link a counterparty opens without a key of yours
certen proof verify <intent-id>     # verified layer by layer, locally; exit 0 only if every layer checks
certen receipt <intent-id>          # the same verdict, with the ids to keep and whether the value arrived
```

`proof verify` checks the proof itself, here, and prints one verdict per layer with the evidence it was
checked against (trust base, the validator quorum from genesis, the receipt to a certified Directory root,
the partition anchor, the governing pages, the validator set, govRoot v3, and the execution receipt). It
never reads a `verified` flag from a bundle and never counts the gateway's say-so: both are printed as what
they are. A layer it cannot establish is named, and the verdict is then `partial` (exit 4), not verified.
`failed` (exit 1) names the layer a tamper is in; `no_evidence` (exit 5, `PROOF_V2_EVIDENCE_NOT_SERVED`)
means the gateway serves no proof v2 document for this proof. Pass `--rpc` with your own node so the
execution receipt is compared with a block header you fetched; a node that has no such block is an error
(`EVM_RPC_NO_BLOCK`), never a pass. A valid proof of the WRONG call is still a
valid proof: compare the operation with your own record of what was agreed.

## What the CLI verifies here, and what it reports from the validators

**Checked here, from the proof's own bytes (`certen proof verify`):** the trust base (`trust_base`), the Directory anchors' validator quorum tracked from genesis (`L4`), the transaction receipt (`L1`), the partition anchor (`L2`), the certified root (`L3`), the governing pages (`G1`, `G1_chains`), the validator set in force (`L4_set`) and govRoot v3 (`govRootV3`). Exit `0` means every layer the document carries checked.

**Reported, never counted as a check:** the bundle's own `verified` flag and the gateway's receipt are printed as the validators' statements. The CLI cannot establish `G1b`, `G2` or `L5` from a portable document, and says so (`not_in_document`); the execution `outcome` is checked only when you pass a block header you fetched (`--rpc`).

Separately, `certen tx inspect` and the signing commands rebuild the transaction the gateway returned before you sign it; that is a check of the request, not of a proof.

`proof get` falls back to the Accumulate merkle receipt when the proof-service is unavailable or
when an intent has no `proof_id` — the normal case for governance and authorization transactions.
A 5xx from the proof-service means that service is down, **not** that your proof is missing.

## Multi-party approvals

```bash
certen pending list
certen pending sign <id> --identity <adi> --vote approve
certen pending sign <id> --identity <adi> --vote approve --sign-with dev   # rebuilds and shows the transaction first, then asks (at a terminal)
```

`--vote` takes `approve`, `reject`, or `abstain` — lowercase strings. Not `accept`, and not a
number.

## Everything else

```bash
certen chains                                    # what CERTEN is deployed on (no API key needed)
certen whoami                                    # which key, which gateway, what standing
certen identity get <id> | list | link-chain <id> --chain <chain> | retire <id> --yes
certen portfolio                                 # balances across every identity and chain
certen tx status <id> --wait | tx list
certen pricing                                   # everything CERTEN charges for, in one call
certen balance | quote --chain <chain> [--sku <sku>] | fund <amount> --chain <chain>
certen balance <address> [--chain <chain>]       # the native balance of ANY EVM address, as the gateway's node answers (a failed read is an error, never a 0)
certen quote <amount> <asset> --to <address>     # the gateway's ESTIMATE for a send: creates, charges and signs nothing; lists what it did not check
certen identity readiness [ref] [--chain <chain>]  # facts from ONE gateway read (key on its key page, credits, a chain's balance, the org's balance); no verdict
certen credits topup --credits <n>               # credits for a key page, paid by the platform (asks first; see above)
certen governance add-key | remove-key | set-threshold | add-authority | remove-authority | add-delegate | sign
                                                 # --sign-with <key> signs and submits in one step; add-authority is how
                                                 # a policy signer becomes a required co-signer on an agent;
                                                 # --account book puts it on the key book too, so seats and
                                                 # thresholds face the signer as well as spends
certen admin api-keys list | create | rotate | revoke
certen admin audit-log | usage
```

Run `certen <group> --help` for the flags on any of them, or `certen --help` for the whole tree
grouped by where you are in the journey.

## Chains

This CLI targets `ethereum-sepolia`, `base-sepolia` and `arbitrum-sepolia` (gas: ETH). A chain outside that
set is refused with the reason — and if the gateway genuinely serves it, the refusal says so
rather than claiming it does not exist. `CERTEN_ALLOW_ANY_CHAIN=1` lifts the restriction.

**Telcoin Adiri (`telcoin-adiri`, chain 2017) is a testnet whose gas is TEL**, not ETH. It is off by
default. To use it, enable it and confirm the gateway serves it:

```bash
export CERTEN_ENABLED_CHAINS=ethereum-sepolia,base-sepolia,arbitrum-sepolia,telcoin-adiri
certen chains --refresh   # records what the gateway serves; Adiri is accepted only if it is listed
```

`CERTEN_ENABLED_CHAINS` replaces the default set, and naming an unknown or retired chain in it is
an error. Every chain fact the CLI uses (ids, aliases, gas token, faucet, block time) comes from the
SDK's `CHAIN_CATALOGUE`. The funding guard reads each chain's own gas token: an account whose gas
it cannot identify is refused by name (`ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE`), never waved through.

## Scripting and AI agents: `--json`

`--json` turns the CLI into a machine interface. It is a contract, documented in full in
[docs/CLI-CONTRACT.md](../../docs/CLI-CONTRACT.md) and enforced by a conformance suite.

```bash
certen --json tx status <id>
# {"ok":true,"data":{"intent_id":"…","status":"completed"}}

certen --json portfolio
# {"ok":false,"error":{"code":"NETWORK_ERROR","message":"connect ECONNREFUSED","retryable":true,"next":"certen doctor","status":0}}
```

- **Exactly one JSON object on stdout**, nothing else. Every human-facing line goes to stderr.
- **Exit codes:** `0` ok · `1` operation failed · `2` usage error · `3` gateway unreachable. Branch on
  these instead of parsing text. `3` guarantees nothing was submitted, so a retry cannot
  double-execute (except `credits topup` and `gas --drip`, whose request may have left: repeat those with the same `--idempotency-key`). `4` and `5` are the verdicts of `proof verify`, `send`, `receipt` and `watch` (partial or
  pending; no evidence), and `130` is Ctrl-C while `setup`, `gas`, `send` or `watch` was waiting.
- **`error.retryable`** comes from the SDK's own `CertenError.isRetryable`, so the CLI and the SDK
  give an identical retry decision.
- **`error.next`** is on every failure: the one command to run, as a single `certen ...` line (angle brackets are placeholders you fill). Branch on the
  `code`, show a person the `next`. It is never built from gateway text.
- **`certen --help --json`** returns the entire command tree — every command, flag and exit code — in
  one call.

Without `--json`, output is the human table format as before. Do not parse it.

## Configuration

| | |
|---|---|
| `CERTEN_API_KEY` | API key. Always wins, so CI never touches the keyring or config file. |
| `CERTEN_API_URL` | Gateway base URL. Defaults to `https://gateway.kompendium.co`. |
| `CERTEN_KEY_PASSPHRASE` | Passphrase for local signing keys. |
| `CERTEN_EXPERIMENTAL_KEY_UNLOCK` | Set to `1` to enable `certen keys unlock` (experimental; ships behind a security review). Unset, it does nothing and nothing changes. |
| `CERTEN_RPC_URL` | A JSON-RPC node you trust on the execution chain, used by `send`, `receipt` and `watch` when `--rpc` is not given. Never printed or saved (it can carry a key). |

`certen auth login` stores the API key in your OS keyring by default (through the optional
`@napi-rs/keyring` dependency, which ships prebuilt binaries for Windows, macOS and Linux), or in
`~/.certen/config.json` at `0600` with `--no-keyring`. Where there is no usable keyring (a headless Linux box with no secret
service), the default login refuses with that reason and writes nothing; use `--no-keyring` or set `CERTEN_API_KEY`.

## Things that will bite you

**Identity creation is asynchronous.** `identity create` returns `202` and provisioning continues.
Poll until the status is terminal, and check `can_sign` — it derives from the on-chain key page, so
it can read `true` while the status is still `creating`.

**A proof cycle takes 60–110 seconds.** Real validator work, not a tunable delay. Do not wrap it in
a 30-second timeout.

**Sign the bytes, not the text.** If you are producing signatures outside this CLI: sign the raw
bytes of the hash, do not hash it again, and do not sign the ASCII of the hex string. All three
mistakes produce a well-formed 128-hex signature the gateway rejects. `certen keys sign` handles
this for you.

## Documentation

**<https://docs.kompendium.co>** — getting started, authentication, errors, idempotency, and
task-shaped guides: onboarding an identity, external signing, proof-gating a contract call, M-of-N
panels, and verifying a proof.

The [live API reference](https://gateway.kompendium.co/reference) is generated from the running
gateway and is authoritative — when a guide and the spec disagree, the spec is right.

## License

MIT
