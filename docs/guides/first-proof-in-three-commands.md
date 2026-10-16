# Guide — Your first transaction, in three commands

From `npm install` to a transfer you can prove. No API key is copied by hand, no JSON is written
by hand, no id is copied between commands, and nothing waits on you to notice it finished.

```bash
npm install -g @certen.io/cli

certen setup                              # signing key, account, identity, on-chain checks and gas, until it says "Ready"

certen send 0.0001 ETH --to 0xRecipient   # preview, confirm, sign, wait, verify the proof here, keep a receipt

certen receipt                            # the record again, whenever you want it
```

That is the whole path: **install, `setup`, `send`.** `receipt` shows what `send` ended with, again. If a step
stops, the command says why and ends with one line, `next: <command>`, the thing to type. The rest of this page
is what each command does, what to do when something is in the way, and, at the end, the one-step-at-a-time
route (`login`, `init`, `call`, `tx create`, `proof get`) that the three commands are built from. All of it still works.

Everything here runs on a **testnet** (`base-sepolia` unless you choose another). A chain that is not a known testnet
is never taken from a default by a command that moves value: you spell it out with `--chain`.

---

## 1. `certen setup`

```bash
certen setup
```

One resumable command. It checks the gateway (and that it serves your chain), makes or reuses your signing key
**first** (a new account can be created *by* that key, with no browser), then gets you an account, then an identity,
waits until the identity can actually sign, reads your key page **from Accumulate itself**, checks the key page's
credits, the gateway balance and the gas on your abstract account, and saves identity, key and chain as your context,
which is why the next command needs none of them. It exits `0` only when you can act. Run it again and it
continues instead of repeating.

With no API key configured you say which kind of account you want (at a terminal it asks, with no default):

```bash
certen setup --new-account       # none yet: creates an organization with your signing key (no browser, nothing to copy)
certen setup --existing-account  # you have one: approve this machine in the portal (the key arrives over its own channel)
certen setup --token crt_…       # CI: redeem a registration token
```

**When gas is the only thing in the way, it does not stop at a URL.** It shows the abstract account's address, what to
send, a faucet and a wallet link (EIP-681), then **waits for the funds to arrive**. Ctrl-C is safe (your key, account
and identity are saved); run `certen setup` again to continue. `certen gas` is the same on its own: what the account
holds, what to send where, and `--wait` for it. It is **not** `certen fund`, which tops up the organization's gateway
balance (the stablecoin that pays CERTEN's fees). The amounts are planning figures, not a quote: the gateway publishes
no per-execution gas cost.

Some faucets refuse a contract address, and the abstract account is one. If yours does, `certen gas --from-wallet`
prints the two-step route (a wallet you control, then the transfer from it) and signs nothing.

## 2. `certen send`

```bash
certen send 0.0001 ETH --to 0xRecipient
```

Identity, chain and key come from the context `setup` saved; each one that you did not type is printed on stderr
before anything is signed. `send` moves the chain's **native** token, in whole units (`0.0001` ETH, never wei). Another
asset is refused by name; for a token, [`certen call`](#a-contract-call-certen-call) shows exactly what it will call.

It does these things, in this order, so that the unsafe ones cannot happen first:

1. checks what you typed, with no network: the amount, the recipient (a mixed-case address whose EIP-55 checksum fails is a mistyped one and is refused), the asset;
2. checks readiness **before it asks for your passphrase** (the same checks as `certen status`), so a passphrase is never asked for in order to fail;
3. shows the **confirmation card** and asks. The card says what the signature will authorise, *rebuilt from the gateway's bytes and matched to your request*; if the gateway had returned anything else, nothing would be signed. `--yes` skips the question, never that check;
4. signs, then waits for the **proof cycle**: 60–110 seconds of real validator work, not a hang and not a tunable delay. Ctrl-C stops the wait, not the intent; `certen watch <intent-id>` picks it back up;
5. verifies the proof **here**, from the proof's own bytes, and checks whether the value arrived;
6. writes the receipt to `~/.certen/receipts/<intent-id>.json` and prints it.

At a terminal it asks `Sign with "dev"?` (the default answer is yes on a known testnet, **no on anything else**). With
no terminal, no `--yes` and no `--json` it refuses (`CONFIRMATION_REQUIRED`) before it reads a passphrase: a script says
`--yes` once, on purpose. `--dry-run` runs every check and prints what would be sent.

## 3. `certen receipt`

What `send` ends with (illustrative; ids shortened):

```
  [done] signed  [done] anchored on Accumulate  [done] executed on base-sepolia  [done] proof verified locally

  Receipt   intent          7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13
            accumulate tx   3b9a…
            base-sepolia tx 0x51d…   (from the verified proof)
            proof           9f2c…
  Sent      0.0001 ETH on base-sepolia: 0x7a3…c91 -> 0xRecipient
  Effect    recipient balance rose by 0.0001 ETH (block 1834412)
  Proof     VERIFIED: 5 of 5 layers carried, checked here   (certen receipt 7c1e… --explain)
  Saved     ~/.certen/receipts/7c1e3b0a-….json
```

**The receipt is the product.** It holds the ids you used to copy by hand (the intent, the Accumulate transaction, the
destination transaction, the proof), the proof layer by layer, and one verdict:

| Receipt | Meaning | Exit |
|---|---|:--:|
| `VERIFIED` | The action completed, every layer the proof carries checked here, and the value arrived. | `0` |
| `PARTIAL` | It completed, and something is not established. The receipt names each thing (`Not established:`). | `4` |
| `FAILED` | The intent failed, or a layer of the proof was checked and does not hold. Do not rely on it. | `1` |

`send`, `receipt` and `watch` exit `0` only for a verified receipt (or an action that executed and whose proof can never
exist, which says so), `4` for partial or still pending, `5` for no evidence, `130` for Ctrl-C. A script that reads `0` as
"done and checked" is right, which is *not* true of `call --wait` and `tx create --wait` (below).

```bash
certen receipt                    # the most recent; refreshes whatever was pending
certen receipt 7c1e3b0a-…         # any intent, not only one this machine sent
certen receipt --explain          # every proof layer, and what it was checked against
certen receipt --share            # a link a counterparty opens to verify the proof themselves, with no CERTEN account
certen receipt --list             # the ones saved on this machine
certen watch 7c1e3b0a-…           # pick a wait back up after Ctrl-C, then show the receipt
```

**Expect PARTIAL until you give it a node.** The proof's last layer, the execution on the destination chain, is the
validators' own statement of the block until its receipts root is compared with a block header from **a node you trust**.
Pass one and that layer is closed, and the recipient's balance is read from it too:

```bash
certen send 0.0001 ETH --to 0xRecipient --rpc https://sepolia.base.org     # or set CERTEN_RPC_URL
certen receipt --rpc https://sepolia.base.org                               # add it afterwards
```

(Use a node you trust on that chain. Its URL is never printed or saved, since hosted nodes put a key in it.) A proof whose
Accumulate page chains were not captured is PARTIAL too (`G1_chains`), so an honest PARTIAL naming those layers is a good result
today, not a malfunction. A fully VERIFIED receipt end to end has not been run live. A saved receipt is never silently made weaker:
a later `receipt` without your node is shown, and does not replace the one that was checked against it.

---

## When something is in the way

```bash
certen status                  # is THIS identity, on THIS chain, with THIS key, able to act? names the first thing in the way
certen status --amount 0.001   # ...and is there enough gas to send that much
certen doctor                  # the same idea across your whole setup
```

`status` reads your key page from Accumulate itself (the check this walkthrough used to ask you to do with a hand-written
`curl`) and says what it could not confirm, as *unconfirmed*, never as ready. It exits `0` only when everything is ready.
`send` runs the same checks for you before it asks for your passphrase.

**Every failure ends with exactly one `next:` line**, the command to run. In `--json` it is `error.next`.

```
Error [ABSTRACT_ACCOUNT_UNFUNDED]: The abstract account 0x7a3…c91 on base-sepolia holds no testnet gas. …
  next: certen gas --chain base-sepolia --wait
```

| After… | `next:` |
|---|---|
| no API key configured | `certen setup` |
| the identity cannot sign (its key page is not held by your key) | `certen status` |
| the abstract account has no gas | `certen gas --chain <chain> --wait` |
| a wait for an intent ran out (`TX_WAIT_TIMEOUT`), or Ctrl-C while waiting for one | `certen watch <intent-id>` |
| Ctrl-C while `setup` or `gas` waited for funds | `certen setup`, or `certen gas --wait` |
| a wrong flag or value | `certen <command> --help` |
| the gateway could not be reached | `certen doctor` |
| a rate limit, or any other code the gateway publishes | `certen errors <CODE>` (what it means, and whether retrying can help) |

`next` is a hint to run, not a promise it fixes the cause. Angle brackets (`<chain>`, `<intent-id>`) are for you to fill.
The line is built by the CLI, never copied from the gateway. See [`docs/CLI-CONTRACT.md`](../CLI-CONTRACT.md) section 11.

### When an intent stalls at `anchoring`

`anchoring` means the authorization is done (written to Accumulate and anchored) and the execution leg on the
destination chain has not completed. There are **two** reasons it can sit there, and they need different responses.

**1. The abstract account has no gas.** The intent is accepted, signed and submitted (every step reports success) and then
parks forever, because the execution cannot pay for itself. Nothing in any API response says so.

The CLI and the SDK both refuse before submitting, and name the faucet (`certen send` does it as part of its readiness check,
before your passphrase). They refuse a balance that is zero, and one that is positive but cannot cover the amount you are
sending plus an *estimate* of the gas to send it (the gateway publishes no per-execution gas figure, so the gas half is a
per-chain planning figure, and the message says it is an estimate). `--force` (CLI) and `skipFundingCheck: true` (SDK)
override it. `certen doctor` reports an empty account as a warning rather than a failure, because a call forwarding no
value is unaffected, and `certen status --amount <n>` shows the same comparison before you send. The fix is
`certen gas --wait`.

**2. Nothing is executing.** The authorization anchored correctly and no executor picked it up. Observed in practice on a
deployment where the gateway was healthy and the cross-chain executor was not running at all.

Tell them apart without guessing:

```bash
certen proof get <intent-id>     # anchored: true  → the authorization is fine
```

Then read the destination chain. If the receipt is anchored and the funded account shows no execution and no state change, the
authorization half succeeded and the execution half never ran, which is an infrastructure question, not something to fix in your
integration. This is exactly the split `certen proof verify` reports, and why it refuses to call a fetched proof "verified":
inclusion can be established from the receipt, **outcome cannot** (without a node of yours).

---

## What just happened

**`setup`** made your signing key on this machine, then the account that key creates, then an identity, which is
*asynchronous*: `POST /v1/identity` answers `202` and provisioning continues for a minute or two, so it waited until the
identity could actually sign. Three resources came out of that, and it helps to keep them apart:

- the **identity**, an Accumulate ADI (`acc://you.acme`) with a key book and a key page. It is what signs and what is named as an authority;
- the **key page**, on Accumulate, which lists the public keys allowed to sign for the identity. `can_sign` is derived from it, and it is the one thing `setup` and `status` read from Accumulate itself instead of taking the gateway's word;
- the **abstract account**, a deterministic contract address on each chain you linked. It is `msg.sender` for whatever the identity executes, so it is what your contracts are told about, and what must **hold gas** (and the value, for a transfer) before anything can run. A fresh one holds nothing, which is why `setup` waits for funds, and why `gas` exists.

`can_sign` has three values, not two, and `setup` returns only on the first:

| `can_sign` | Meaning |
|---|---|
| `true` | Your key is on the on-chain key page. Usable. |
| `false` | Provisioning finished; the key page is **not** yours. It will fail at the signing step of every flow. |
| `null` | The key page could not be **read**. Unknown — never treat this as a soft yes. |

It is also **idempotent about identities**: it records the identity id the moment the gateway returns it, so a second run reuses
that identity rather than minting another against your organization's quota (an organization made with a key may hold one identity until
it is approved). An id that is not written down when it is created is unrecoverable.

**`send`** is the numbered list above. Two things in it deserve a sentence each. The *card* exists because a valid signature on the
wrong transaction is still a valid signature: the CLI rebuilds the transaction from the gateway's bytes, checks it against what you
asked for, and shows you that. And the *proof cycle* is real validator work: do not wrap it in a 30-second timeout.

**What a proof does and does not establish.** `certen proof verify` (which `send` and `receipt` run for you) reports separate judgements,
and is honest about the ones it cannot make:

1. **Inclusion**: the authorizing transaction really is in Accumulate's state, checked from the proof's own bytes layer by layer (`certen receipt --explain` lists them).
2. **Authorization**: *not checked by any tool.* Compare the operation against your own record of what was agreed: recipient, amount, target, calldata. A valid proof of the *wrong* call is still a valid proof.
3. **Outcome**: the execution on the destination chain. It is checked only when you give a block header from a node you trust (`--rpc`); until then it rests on the validators' statement.

And the part that matters most: **asking the gateway is not independent verification.** A verifier who does not trust CERTEN
should check the proof's own bytes and a node of their own. CERTEN's value is that those checks are *possible*, not that its API
asserts the answer. Full detail: [verify-a-proof.md](verify-a-proof.md).

**Why exit `0` means different things.** `certen call --wait` and `tx create --wait` exit `0` when the intent completes, whether or not
you have looked at its proof, so a script has to run `proof verify` too. `send` folds the check in: it exits `0` only for a VERIFIED
receipt, and `4` for a PARTIAL one, which is an *honest* partial: the proof did not fail, something is simply not established yet, and
the receipt names it.

## The passphrase

Your signing key is encrypted on disk (scrypt + AES-256-GCM) and **never leaves this machine**. Each command that signs asks for the
passphrase **once** (after the readiness checks, so never in order to fail), unlocks the key, and holds it only for that command. A wrong
passphrase ends the command at that moment (`WRONG_PASSPHRASE`), before any intent exists. In CI, set `CERTEN_KEY_PASSPHRASE`; with no
terminal and no variable it fails with an explanation instead of hanging on a prompt nobody can see.

There is an **experimental** way to type it less: `certen keys unlock <key> --for 15m` keeps the decrypted key in your OS keyring for a
while, so the commands in that window do not ask, and `certen keys lock` wipes it. It is **off unless you set
`CERTEN_EXPERIMENTAL_KEY_UNLOCK=1`** and ships behind a written security review
([docs/security/keys-unlock-review.md](../security/keys-unlock-review.md)); read that before you turn it on. It replaces the passphrase and
nothing else: the card, the check of what is signed and the confirmation all still run.

---

## Doing it by hand

`setup` and `send` are built from the commands below, and every one of them still works exactly as before. Use them to understand the
steps, to script a piece of the path, or when you want one thing without the rest. The machine-readable form of all of it is in
[docs/CLI-CONTRACT.md](../CLI-CONTRACT.md).

### `certen login`

Prints a short code and waits. You open the portal, sign in, and type that code under **Authorize a device**. The CLI collects the API key
over its own channel (this is what `setup --existing-account` does).

```
  Your code:  WDJB-MJHT

  Open https://gateway.kompendium.co/portal and enter it.

  Nothing is granted until you approve it there. Ctrl-C is safe.
```

**The key is never displayed here and never passes through your clipboard or your shell history.** That is the point of the device
authorization grant: the secret travels from the gateway to this machine, and a human only ever handles the eight-character code.

- **Only approve a code you are reading off your own screen.** Approving mints a key for your organization and hands it to whoever started that request. The portal says so before you click, and offers **I didn't start this** for a code someone sent you.
- **Ctrl-C is safe.** The code stays valid for ten minutes; run the command again for a fresh one.

If your gateway predates this feature, `certen login` says so and points at the portal. Mint a key there and pipe it in:
`certen auth login --api-key -` reads stdin, so it stays out of your history.

### `certen init`

Creates what is missing and checks what already exists: a signing key (generated and encrypted on this machine), an identity (**waited on
until it can actually sign**), the abstract account per linked chain (with a faucet link if it has no gas), and your balance. It is
idempotent and records the identity id. Unlike `setup` it exits `0` once its steps are done, whether or not the account can act yet. It
returns on `can_sign: true` only, and reports `false` and `null` as failures with different messages.

### `certen keys`, `identity`, `chains`

```bash
certen keys generate --name dev          # prompts for a passphrase (confirmed); --no-passphrase stores it unencrypted
certen keys list | show dev | verify dev # metadata only; verify proves the key decrypts and signs correctly
certen identity create --name buyer-bot --sign-with dev --chains base-sepolia --wait
certen identity get <id> | list | link-chain <id> --chain base-sepolia | retire <id> --yes
certen chains                            # what CERTEN is deployed on (no API key needed)
```

### A contract call: `certen call`

`certen send` moves the chain's native token. To authorise a call to a contract instead (it also shows the confirmation card, and
without `--json` ends with the same receipt):

```bash
certen call --identity <id> --chain base-sepolia --to 0xYourContract \
    --fn 'confirm(bytes32)' --arg 0x… --sign-with dev --wait
```

`--fn` takes a Solidity signature; `--arg` repeats positionally and is **type-checked before anything is sent**. On a proof-gated call this
matters more than usual: a valid proof of the *wrong* call is still a valid proof, so a silently mis-encoded argument is worse than an error.

Once `setup` has recorded your identity and you have one key and one chain, `--identity`, `--chain` and `--sign-with` can be left out too:
`certen call --to 0xYourContract --fn 'confirm(bytes32)' --arg 0x… --wait`. Each value taken from context is echoed on stderr,
`certen context` shows what the next command will use and why, and `certen use identity|key|chain` chooses them when there is more than one.
`--identity` takes a UUID, an `acc://` ADI URL or the name you gave the identity. `--expect <address:topic0>` additionally checks that an event
is in the execution receipt.

You do not supply the ADI URL, the abstract account, or the numeric chain id — all three are derived from the identity. (Omitting them
upstream produces a bodyless `502`, which reads as "the gateway is down" rather than "you left out a field". You should never have to know that.)

`--wait` polls to a terminal state. **A proof cycle is 60–110 seconds of real validator work** — not a tunable delay, and not a hang. Drop
`--wait` to return immediately and follow it later with `certen watch <intent-id>` (or `certen tx status <id> --wait`). `--dry-run` prints the
intent without sending it, which is also the starting point if you need a multi-leg intent: edit it and pass it to
`certen tx create --intent @file.json`.

### The plumbing: `certen tx`

`tx create` is the command `send` and `call` are built on. It opens an intent, and either signs it or hands you the signing data:

```bash
# the transfer, the long way (identity, --to-chain and --from come from your context when left out)
certen tx create --to 0xRecipient --amount 0.0001 --sign-with dev --wait --timeout 6m

# open it and sign somewhere else (an HSM, an air-gapped machine, someone else's policy signer)
certen tx create --to-chain base-sepolia --to 0xRecipient --amount 0.0001      # returns signing_data, signs nothing
certen tx inspect <intent-id>                                                  # rebuilds it and shows what a signature would authorise
certen tx sign <intent-id> --signature <hex> --public-key <hex>                # submit a signature made elsewhere
certen tx status <intent-id> --wait                                            # follow it
```

`tx create --help` lists the flags a transfer needs first, and the plumbing ones (`--from-chain`, `--contract-address`, `--signer-key-page`,
`--signer-public-key`) under their own heading. They all work. A bare hash is never signed blind (`BLIND_SIGNING_REFUSED`).
See [external-signing.md](external-signing.md).

### `certen proof get`, `verify`, `bundle`, `share`

(After `send`, `certen receipt` is this and more. `proof` is for when you want the proof document itself.)

```bash
certen proof get <intent-id>       # also accepts a proof id or a transaction hash
certen proof verify <intent-id> [--rpc <node you trust>]
certen proof bundle <proof-id>     # the artifact
certen proof share <proof-id>      # a link they open without a key of yours
```

Take whichever id your last command printed; it works out which kind it is. Most completed intents carry **no `proof_id`** — that is
normal, not a failure, and it is always the case for governance and key-page authorizations, which the proof-service does not index. The
command falls back to the Accumulate merkle receipt, read from the network directly, and tells you which source answered. The same
fallback covers a proof-service outage: **a 5xx there means that service is down, not that your proof is missing**.

### The key page, without `status`

`certen status` does this for you. By hand it is a JSON-RPC `query` to the Accumulate API your gateway advertises (`GET /v1/chains` →
`accumulate.api`; `status --accumulate-rpc <url>` overrides it), and a comparison of your key's hash with the page:

```bash
certen keys show dev                      # public_key_hash
curl -s "$ACCUMULATE_API" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"scope":"acc://you.acme/book/1"}}'
# result.account.keys[].publicKeyHash must contain it
```

---

## Doing the same thing in code

```ts
import { CertenClient } from '@certen.io/sdk';

const certen = new CertenClient({ apiKey: process.env.CERTEN_API_KEY! });

const report = await certen.doctor();          // same checks as `certen doctor`
const ready = await certen.readiness({ identityId, chain: 'base-sepolia', keyHash });   // same checks as `certen status`
if (!report.ok) throw new Error(JSON.stringify(report.checks.filter((c) => c.status === 'fail')));

const identity = await certen.identity.createAndWait(   // waits for can_sign === true
  { name: 'buyer-bot', publicKey, publicKeyHash, chains: ['base-sepolia'] },
);

const { intentId } = await certen.execute.contractCall({
  identityId: identity.id,
  adiUrl: identity.adi_url,
  fromAddress: identity.chain_accounts[0].address,
  chain: 'base-sepolia',
  contractCall: { target, functionSignature: 'confirm(bytes32)', args: [orderId] },
  publicKey,
  sign: (hashHex) => ed25519Sign(hashHex),     // YOU hold the key
});

await certen.execute.wait(intentId);
const proof = await certen.execute.proof(intentId);
```

Your key never reaches the SDK. You pass a `sign` function; it receives bytes and returns a signature. Sign the **raw bytes** of the hex
string — do not hash it again, and do not sign the ASCII of the hex.

And the transfer `certen send` makes, with its receipt (`buildReceipt` is in `@certen.io/sdk/verify`, where the verifier is):

```ts
import { buildReceipt } from '@certen.io/sdk/verify';

const sent = await certen.execute.send({          // derives the ADI and the abstract account from the identity
  identityId, chain: 'base-sepolia', toAddress: '0x…', amount: '0.0001', asset: 'ETH',   // whole units, the chain's native token
  publicKey, sign: (hashHex) => ed25519Sign(hashHex),
  beforeSign: (summary) => confirm(summary.text.join('\n')),   // what the signature authorises; return false to decline
});

await certen.execute.wait(sent.intentId);
const receipt = await buildReceipt(certen, sent.intentId, { rpc: process.env.CERTEN_RPC_URL });
// receipt.verdict: 'verified' | 'partial' | 'failed' | 'pending' | 'unproven'; receipt.gaps names what is not established
```

Next: [onboard-an-identity.md](onboard-an-identity.md) for the raw API path ·
[external-signing.md](external-signing.md) for HSMs and air-gapped signers ·
[proof-gated-contract-call.md](proof-gated-contract-call.md) for the full flow ·
[verify-a-proof.md](verify-a-proof.md) for handing evidence to someone who should not have to trust you.
