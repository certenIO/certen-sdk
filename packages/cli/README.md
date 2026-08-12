# `@certen.io/cli`

The `certen` command line for the [CERTEN Gateway](https://gateway.kompendium.co/reference) —
proof-gated cross-chain execution on Accumulate.

**Docs: <https://docs.kompendium.co>** · **Portal: <https://gateway.kompendium.co/portal>**

```bash
npm install -g @certen.io/cli
```

## From nothing to a proof

```bash
certen login          # approve this machine once in the portal; the key arrives here
certen init           # signing key, identity, funding — created and checked

certen call --identity <id> --chain base-sepolia --to 0xYourContract \
    --fn 'confirm(bytes32)' --arg 0x… --sign-with dev --wait

certen proof get <intent-id>   # the evidence, to hand to a counterparty
```

**You never copy an API key.** `certen login` uses the device authorization grant: it prints a
short code, you approve that code in a portal session you already trust, and the CLI collects the
key over its own channel. The secret is never displayed here and never passes through your
clipboard or your shell history.

`certen init` is idempotent. It creates only what is missing, records the identity id so a later
run reuses it, waits until the identity can actually sign, and tells you if an abstract account
needs gas before it can execute anything.

Stuck at any point:

```bash
certen doctor         # names the one thing blocking you, and the command that fixes it
```

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
certen keys sign --name dev --hash <hex> # print a signature, send nothing
certen keys delete dev --yes
certen keys path
```

Set `CERTEN_KEY_PASSPHRASE` to skip the prompt in CI. When it is set and there is no TTY, the CLI
uses it; when neither is available it fails with an explanation rather than hanging on a prompt
nobody can see.

**`certen keys sign` sends nothing anywhere.** It is the air-gapped path: generate on one machine,
carry the hash to it, carry the signature back.

## Proof-gated contract calls

```bash
certen call --identity <uuid> --chain base-sepolia --to 0xTarget \
    --fn 'confirm(bytes32)' --arg 0x… --sign-with dev --wait
```

`--fn` takes a Solidity signature and `--arg` repeats positionally. Arguments are checked against
the signature **before** anything is sent — on a proof-gated call, a valid proof of the *wrong*
call is still a valid proof, so a mis-encoded argument is worse than an error.

The ADI URL, the abstract account (`msg.sender` on chain) and the numeric chain id are all derived
from the identity. You do not supply them, and you should not need to know that omitting them
produces a bodyless 502.

`--dry-run` prints the intent that would be sent without sending it — also the starting point if
you need a multi-leg intent, which you then pass to `tx create --intent @file.json`.

## Transfers

```bash
certen tx create --identity <uuid> --to-chain ethereum-sepolia \
  --from 0xYourAbstractAccount --to 0xRecipient --amount 0.001 --sign-with dev --wait
```

**`--amount` is in WHOLE UNITS.** `1` means one ETH, `0.5` means half. This is the field most
worth reading twice: the gateway documented it as wei until 2026-08-11, and someone sending `1`
meaning one wei moves a whole ETH — which on a funded account succeeds silently.

`--from` is the identity's abstract account on the source chain; `certen portfolio` shows it.

If that account has no gas, the CLI refuses before submitting. That refusal is worth having: an
intent from an empty abstract account is accepted, signed and submitted — every step reports
success — and then parks at `anchoring` forever, because the execution leg cannot run on chain.
`--force` overrides it.

Or drive the steps yourself — useful when the signer is an HSM, another machine, or your own
policy engine:

```bash
certen tx create --identity <uuid> ...          # returns signing_data.hash_to_sign
certen keys sign --name dev --hash <hash>       # or your HSM
certen tx sign <intent-id> --signature <sig> --public-key <pub>
```

`--signature`/`--public-key` remain first-class. `--sign-with` is a convenience, not a replacement.

## Proofs

```bash
certen proof get <intent-id>        # also accepts a proof id or a transaction hash
certen proof bundle <proof-id>      # the artifact to hand over
certen proof share <proof-id>       # a link a counterparty opens without a key of yours
certen proof verify <intent-id>     # what was, and was NOT, verified
```

`proof verify` reports three separate judgements — inclusion, authorization, outcome — and it can
establish only the first, and only as something the gateway asserted. It says so. Asking the
gateway is not independent verification; to verify without trusting CERTEN, query an Accumulate
node for the receipt and read the execution on the destination chain.

`proof get` falls back to the Accumulate merkle receipt when the proof-service is unavailable or
when an intent has no `proof_id` — the normal case for governance and authorization transactions.
A 5xx from the proof-service means that service is down, **not** that your proof is missing.

## Multi-party approvals

```bash
certen pending list
certen pending sign <id> --identity <adi> --vote approve
certen pending submit <request-id> --sign-with dev --hash <hash>
```

`--vote` takes `approve`, `reject`, or `abstain` — lowercase strings. Not `accept`, and not a
number.

## Everything else

```bash
certen chains                                    # what CERTEN is deployed on (no API key needed)
certen whoami                                    # which key, which gateway, what standing
certen identity get <id> | list | link-chain <id> --chain <chain>
certen portfolio                                 # balances across every identity and chain
certen tx status <id> --wait | tx list
certen balance | quote --chain <chain> | fund <amount> --chain <chain>
certen governance add-delegate | set-threshold
certen admin api-keys list | create | rotate | revoke
certen admin audit-log | usage
```

Run `certen <group> --help` for the flags on any of them, or `certen --help` for the whole tree
grouped by where you are in the journey.

## Chains

This CLI targets `ethereum-sepolia`, `base-sepolia` and `arbitrum-sepolia`. A chain outside that
set is refused with the reason — and if the gateway genuinely serves it, the refusal says so
rather than claiming it does not exist. `CERTEN_ALLOW_ANY_CHAIN=1` lifts the restriction.

## Scripting and AI agents: `--json`

`--json` turns the CLI into a machine interface. It is a contract, documented in full in
[docs/CLI-CONTRACT.md](../../docs/CLI-CONTRACT.md) and enforced by a conformance suite.

```bash
certen --json tx status <id>
# {"ok":true,"data":{"intent_id":"…","status":"completed"}}

certen --json portfolio
# {"ok":false,"error":{"code":"NETWORK_ERROR","message":"connect ECONNREFUSED","retryable":true,"status":0}}
```

- **Exactly one JSON object on stdout**, nothing else. Every human-facing line goes to stderr.
- **Exit codes:** `0` ok · `1` operation failed · `2` usage error · `3` gateway unreachable. Branch on
  these instead of parsing text. `3` guarantees nothing was submitted, so a retry cannot
  double-execute.
- **`error.retryable`** comes from the SDK's own `CertenError.isRetryable`, so the CLI and the SDK
  give an identical retry decision.
- **`certen --help --json`** returns the entire command tree — every command, flag and exit code — in
  one call.

Without `--json`, output is the human table format as before. Do not parse it.

## Configuration

| | |
|---|---|
| `CERTEN_API_KEY` | API key. Always wins, so CI never touches the keyring or config file. |
| `CERTEN_API_URL` | Gateway base URL. Defaults to `https://gateway.kompendium.co`. |
| `CERTEN_KEY_PASSPHRASE` | Passphrase for local signing keys. |

`certen auth login` stores the API key in your OS keyring by default, or in
`~/.certen/config.json` at `0600` with `--no-keyring`.

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
