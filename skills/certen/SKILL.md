---
name: certen
description: Give this agent a CERTEN identity and let it execute proof-gated actions on any chain it is linked to. It never spends without the owner's explicit consent.
version: 0.2.0
metadata:
  openclaw:
    requires:
      bins: [node, certen]
    install:
      - kind: node
        package: "@certen.io/cli"
        bins: [certen]
---

# CERTEN for agents

CERTEN gives an agent an on-chain identity it does not custody a key for, accounts on any supported
chain that only execute what a validator quorum has proved, and a receipt a stranger can verify
without trusting the agent or its owner. Use it for anything where money is at stake and more than
one party has to agree: escrow legs, settlement, arbitration, insurance, a regulator's seat.

Do NOT use it for chat, discovery, or small per-message fees. A proof costs money (about $0.35 on
Base, about $1 to $4 on Ethereum) and takes 60 to 110 seconds. Putting that in front of a $3 fee
makes everything slow and proves nothing anyone needs proved.

Every command below prints JSON with `--json`, wrapped as `{"ok": true, "data": ...}` on success
and `{"ok": false, "error": {"code": ..., "message": ..., "retryable": ..., "next": ...}}` on failure. Read `data`, never the prose.

**The path is three commands: `certen setup`, `certen send`, `certen receipt`** (and `certen status` whenever you want to know what is in the way).
On a failure, branch on `error.code`, and read **`error.next`**: the one command that moves forward (`certen status`, `certen gas --chain base-sepolia --wait`,
`certen setup`, `certen watch <intent-id>`, `certen <command> --help`). It is a single `certen ...` line built by the CLI itself, never copied from the gateway,
and `<angle>` tokens are values for the owner to choose. It is a hint, not a licence: **a `next` that creates, spends or signs (`setup`, `fund`, `send`, `call`) still needs the
owner's yes, exactly as the consent rules below say**; one that only reads (`status`, `watch`, `receipt`, `errors <CODE>`, `--help`) you may run.

## Consent, before anything else

An identity costs money. Every proof-gated action costs money and moves the owner's funds. So:

1. Quote first: `certen quote --chain <chain> --json` and `certen balance --json`.
2. Show the owner the cost and the balance.
3. Ask, in plain words, whether to proceed. Do not proceed on silence.
4. Only then run the action. Never run `setup`, `send`, `identity create`, `call`, `tx create`, or `governance
   *` without an explicit yes for that specific action.

If the owner has not told you which chain, use `base-sepolia` on testnet. It is the cheapest
chain CERTEN runs and every command here works on it. `telcoin-adiri` (chain 2017) is Telcoin's
Adiri testnet, whose gas is TEL rather than ETH; use it only when the owner asks for it, has set
`CERTEN_ENABLED_CHAINS` to include it, and `certen chains --refresh` lists it.

## One-time setup (owner runs this, or you run it with consent)

```bash
certen setup --yes --json --new-account --org-name <owner>-<handle> --name <handle> --key agent --no-passphrase --no-keyring --chain base-sepolia
certen status --json      # is this identity, on this chain, with this key, ready? exit 0 only when it is
certen gas --json         # the abstract account's gas: address, what to send, an EIP-681 link; exit 0 only when enough
```

`setup` is one resumable command: the signing key first (an Ed25519 key that never leaves this machine), then an organization created **by that key** (`--new-account`: it
proves you hold the key, with a $10 trial; no browser, nothing to copy), then the identity, then the on-chain checks and the gas. Run the same line again and it continues. It
exits `0` only when the identity can act; otherwise the envelope carries `error.details.readiness` with the first blocker, and `error.next` is the command to run (`certen status`, or the
blocker's own fix; for missing gas that is `certen gas --chain base-sepolia --wait`, which needs testnet gas sent to the address it prints: the owner's step, or yours with consent). With `--json` it never waits for funds.
An owner who already has an organization uses `--existing-account` instead (a person approves this machine in the portal), or `--token <registration token>`.
`--no-passphrase` stores the key unencrypted (file permissions only), which an unattended agent needs; a person with a passphrase should say so instead. The API key is stored in
`~/.certen/config.json`, and only its prefix is printed. Nothing goes into this skill's environment, and nothing needs to.

The older steps are still there one at a time: `certen keys generate --name agent --no-passphrase`, `certen signup --with-key agent --org-name <owner>-<handle> --no-keyring`,
`certen init`, and `certen doctor --json` (names the one thing blocking you, across the whole setup).

**Sandboxed hosts:** if this agent runs in a container whose home directory is wiped between
sessions, `~/.certen` vanishes with it. Persist `~/.certen/keys/agent.json` and
`~/.certen/config.json` in the workspace and restore them at session start, or the identity you
created cannot be signed for.

## Where am I

Run `scripts/where-am-i.sh` (bundled) or the three commands inside it:

```bash
certen whoami --json          # org, key prefix, gateway, standing
certen identity list --json   # identities and their accounts per chain
certen balance --json         # spendable, held, and whether a shortfall is refused or only recorded
certen status --json          # ready to act on this chain with this key? the first thing in the way, and its fix (exit 0 only when ready)
```

`balance.enforcing` is the fact that matters: `false` means the gateway meters and records
shortfalls but refuses nothing (testnet today); `true` means a run short of funds stops with a 402.

## Get an identity

```bash
certen identity create --name <handle> --sign-with agent --chains base-sepolia --wait --json
```

The result carries `id` (a uuid: use it in every later command), `adi_url` (the identity itself,
`acc://<handle>.acme`), and `chain_accounts[]` with an `address` per chain. That address is this
agent's `msg.sender` on that chain.

One identity, many chains — no new identity, no new key:

```bash
certen identity link-chain <id> --chain arbitrum-sepolia --json
```

## Send value, and keep the receipt

A plain transfer of the chain's native token (ETH on Base Sepolia) is one command, and it ends in a receipt:

```bash
certen send 0.0001 ETH --to <0xRecipient> --dry-run --json     # every check, nothing signed or sent. Look at it first
certen send 0.0001 ETH --to <0xRecipient> --yes --wait --json  # after the owner's consent: sign, wait, verify the proof, write the receipt
certen receipt <intent_id> --json                              # the same record, any time, re-verified here
certen watch <intent_id> --json                                # pick a wait back up (the intent keeps running if you stop)
```

- **`--yes` is required when no one is at a terminal**, and it is your consent made in advance: pass it only after the consent steps above. Without it, `send` exits `2`
  (`CONFIRMATION_REQUIRED`) before it reads a passphrase. `--yes` skips the question, never the check that the transaction the gateway returned is the one you asked for;
  the same `--yes` exists on `call`, `tx create`, `governance` and `pending sign`, which print what the signature authorises and then sign.
- The amount is **whole units** (`0.0001` is a ten-thousandth of an ETH, never wei). `send` moves the chain's **native** token only and refuses any other asset by name; for a token use `certen call` with
  `transfer(address,uint256)`. A recipient with a bad EIP-55 checksum is refused (`INVALID_ADDRESS`): fix the address, do not retry.
- It checks readiness before it unlocks anything. `NOT_READY` carries `error.details.readiness`: read `first_blocker` and its `fix`. Gas missing is `certen gas --json`; do not use `--force` to get past it
  unless the owner asks, and do not treat `unknown` as ready.
- **Report the receipt's `verdict`, never "it went through".** Exit `0` means **verified** (the proof checked here, and the value arrived); `4` means **partial** or still pending, and `data.receipt.gaps` says what is not
  established; `5` means no proof evidence is served yet; `1` means failed (`TX_FAILED`, or a proof layer that does not hold); `130` means the wait was stopped and the intent is still running (`error.details.resume`).
  Never describe a `partial` receipt as verified. If the owner gave you a node they trust on the chain, pass `--rpc <url>` (or set `CERTEN_RPC_URL`): without one the proof's execution layer is the validators' own
  statement, and the verdict stays `partial` naming it. That is the honest answer, not an error to work around.
- `--wait` is off by default with `--json`: pass it, or the command returns once the signature is in (`send` exits `0`, the receipt reads `pending`) and you follow with `certen watch <intent_id> --json`.
  The proof cycle is 60 to 110 seconds of real work; do not shorten the wait.
- The receipt is saved to `~/.certen/receipts/<intent_id>.json` (no secret in it). `certen receipt --share` makes a link a counterparty can verify with no key.

## Execute something, proof-gated

Any contract call from the agent's account. The validators execute exactly this target, value and
calldata, after a quorum has proved it, or nothing.

```bash
certen call --identity <id> --chain base-sepolia --to <contract> \
  --fn "ship(bytes32,string)" --arg 0x<orderId> --arg "TRACK-1" \
  --sign-with agent --wait --json
```

- Once the agent's identity, key and chain are chosen (`certen use identity|key|chain`, shown by `certen context`), `--identity`, `--chain` and
  `--sign-with` can be left out; each value taken from context is echoed on stderr, and an ambiguous or mainnet default is refused, not guessed.
- `--value <wei>` forwards native value with the call. Wei, as a string.
- An ERC-20 move is a call on the token contract: `--to <token> --fn "transfer(address,uint256)"
  --arg <to> --arg <amount in the token's base units>`. USDC has 6 decimals.
- `--proof-class on_cadence` batches the proof (cheaper, default in most kits); `on_demand` is
  immediate and costs more on Ethereum.

- `--expires-in 30m` (s, m, h, d) sets a deadline. Unsigned past it, the intent ends failed.
- `--authority acc://…` (header authority) is REFUSED by the gateway by default
  (`HEADER_AUTHORITY_NOT_EXECUTABLE`): validators do not yet execute such intents. Do not retry it;
  the owner makes a required co-signer an authority on the account instead.

Wait for the outcome with `certen tx status <intent_id> --wait --json`. Failures mean different
things — read `reason_code`:

- `target_reverted` — CERTEN did its whole job and the contract said no. A business outcome.
  Retrying the identical call reverts again.
- `expired` — the deadline passed before every required signature arrived. Nothing executed, no fee
  or gas. Open a new intent if it should still happen.
- `expectation_unmet` — the call ran but the events it committed to are missing from the receipt.
  It is NOT a success; do not report it as one.
- anything else — CERTEN did not complete. Infrastructure or funding. Read `certen errors --json`
  for the code you got.

## Hand the counterparty a proof, not a promise

```bash
certen proof get <intent_id> --json                 # the proof artifact, once it has anchored
certen proof share <proof_id> --hours 72 --json     # a link that resolves with NO API key
```

The artifact anchors 60 to 120 seconds after the leg completes. If `proof get` says there is none
yet, wait and retry; do not send the counterparty a bare transaction hash instead. They open the
link with `certen proof open <link>` and verify it against CERTEN, not against you.

`certen proof verify <intent_id> --json` checks the proof here, layer by layer, and exits `0` only when every layer
the proof carries checked; `4` means a named layer is not established, `5` that no proof document is served yet.
Never report a proof as verified because a bundle says `verified`; report the verdict this command prints.

Every command that signs with `--sign-with` rebuilds the transaction the gateway returned and shows what the
signature authorises first (the confirmation card: a person at a terminal is asked; where no one can be, `send` requires `--yes`, which is the consent you give in advance, and the older commands go ahead). If it refuses
(`SIGNING_DATA_MISMATCH`, `SIGNING_DATA_ABSENT`), do not sign by another
route and do not retry with a bare hash: tell the owner. The consent rules above are unchanged.

## Being regulated

The owner can make their policy signer a required co-signer on this identity. From then on every
transaction this agent submits waits until the owner's rules approve it, and the agent cannot opt
out. The owner runs:

```bash
certen governance add-authority --identity acc://<handle>.acme \
  --authority acc://<owner-policy>.acme/book --sign-with agent --json
```

Once that is in place, a `call` or `tx create` returns with the transaction pending; the policy
signer decides and the transaction proceeds or is rejected. Treat `pending` as normal, not as an
error. `certen pending list --json` shows what is waiting.

## When something refuses you

- `CHAIN_NOT_PRICEABLE`: CERTEN's price book will not sell on that chain right now. That is on
  CERTEN's side; tell the owner and try another chain.
- `CHAIN_SUSPENDED`: the chain is paused while costs are investigated. Wait `retry_after_sec`.
- `402` / `INSUFFICIENT_BALANCE`: only when `enforcing` is true. `certen fund <usd> --chain
  <chain> --json` prints where to send testnet USDC.
- `no proof artifact yet`: normal for about two minutes after a leg completes. Wait.
- Anything else: read `error.code`, then `error.next` (for a code the gateway publishes it is `certen errors <CODE>`, which says whose side it is and whether retrying can help).
  Retry only when `error.retryable` is true.

Never work around a refusal by changing amounts, retrying in a loop, or using another identity.
Report it to the owner with the code and the exact message.
