# Guide — Your first proof, in three commands

From `npm install` to a transfer you can prove. No API key is copied by hand, no JSON is written
by hand, no id is copied between commands, and nothing waits on you to notice it finished.

```bash
npm install -g @certen.io/cli

certen setup                              # signing key, account, identity, on-chain checks and gas, until it says "Ready"

certen send 0.0001 ETH --to 0xRecipient   # preview, confirm, sign, wait, verify the proof here, keep a receipt

certen receipt                            # the record again, whenever you want it
```

`certen setup` is the whole front of this guide in one resumable command: sections 1 and 2 below (`login`, `init`) are what it does, in a
different order (the signing key first, because a new account can be created *by* that key, with no browser) and with one addition: when the
abstract account has no gas it shows the address, a faucet and a wallet link, and **waits for the funds to arrive** instead of ending on a URL.
Run it again and it continues; it exits `0` only when you can act. `certen login` and `certen init` still work exactly as before.

`certen send` is the transfer. The other route, a proof-gated **contract call**, is section 3 below: it is the same machinery with a contract
in the middle, and it is still how you authorise anything that is not a plain transfer of the chain's native token.

If anything below goes wrong, `certen doctor` names the one thing blocking you and the command that
fixes it. It is worth running once before you start, just to see what a clean report looks like.
And before you send, `certen status` asks the narrower question: is *this* identity, on *this* chain,
with *this* key, able to act? It reads your key page from Accumulate itself (the check this walkthrough
used to ask you to do with a hand-written `curl`) and says what it could not confirm. `send` runs the same
checks for you, before it asks for your passphrase.

## What just happened

**`setup`** made your signing key on this machine, then the account that key creates, then an identity, which is *asynchronous*:
`POST /v1/identity` answers `202` and provisioning continues for a minute or two, so it waited until the identity could actually sign (`can_sign`, below).
It read your key page from Accumulate (not only from the gateway's word), checked the credits and the gateway balance, checked the gas on your abstract
account, and saved identity, key and chain as your context, which is why the next command needed none of them.

**`send`** did, in this order:

1. checked what you typed with no network: the amount is whole units (`0.0001` ETH, never wei), the recipient is an address whose checksum holds, the asset is the chain's native token;
2. checked readiness *before* asking for your passphrase, so a passphrase is never asked for in order to fail;
3. showed the **confirmation card** and asked. The card says what the signature will authorise, *rebuilt from the gateway's bytes and matched to your request*; if the gateway had returned anything else, nothing would have been signed. `--yes` skips the question, never that check;
4. signed, then waited for the **proof cycle**: 60–110 seconds of real validator work, not a hang and not a tunable delay (Ctrl-C stops the wait, not the intent; `certen watch <intent-id>` picks it back up);
5. verified the proof **here**, from the proof's own bytes, and checked whether the value arrived;
6. wrote the receipt to `~/.certen/receipts/<intent-id>.json` and printed it.

**The receipt is the product.** It holds the ids you used to copy by hand (the intent, the Accumulate transaction, the destination transaction, the proof), the proof layer by layer, and one verdict:

| Receipt | Meaning | Exit |
|---|---|:--:|
| `VERIFIED` | The action completed, every layer the proof carries checked here, and the value arrived. | `0` |
| `PARTIAL` | It completed, and something is not established. The receipt names each thing (`Not established:`). | `4` |
| `FAILED` | The intent failed, or a layer of the proof was checked and does not hold. Do not rely on it. | `1` |

**Why exit `0` is not "everything verified" elsewhere, and is here.** `certen call --wait` and `tx create --wait` exit `0` when the intent completes, whether or not you have looked at its proof, so a
script has to run `proof verify` too. `send` folds the check in: it exits `0` only for a VERIFIED receipt, and `4` for a PARTIAL one, so a script that reads `0` as verified is right.

**Expect PARTIAL until you give it a node.** The proof's last layer, the execution on the destination chain, is the validators' own statement of the block until its receipts root is compared with a block header
from **a node you trust**. Pass one and it is closed, and the recipient's balance is read from it too:

```bash
certen send 0.0001 ETH --to 0xRecipient --rpc https://sepolia.base.org     # or set CERTEN_RPC_URL
certen receipt --rpc https://sepolia.base.org                               # add it afterwards
```

(Use a node you trust on that chain. Its URL is never printed or saved, since hosted nodes put a key in it.) A proof whose Accumulate page chains were not captured is PARTIAL too (`G1_chains`), so an
honest PARTIAL naming those layers is a good result today, not a malfunction; a fully VERIFIED receipt end to end has not been run live. `certen receipt --explain` prints every layer with what it was checked
against, and `certen receipt --share` makes a link a counterparty opens to verify the proof themselves.

---

> **Doing it one step at a time.** The next two sections are what `certen setup` does for you. Use them to understand it, or if you want `login`
> and `init` separately.

## 1. `certen login`

Prints a short code and waits. You open the portal, sign in, and type that code under **Authorize a
device**. The CLI collects the API key over its own channel.

```
  Your code:  WDJB-MJHT

  Open https://gateway.kompendium.co/portal and enter it.

  Nothing is granted until you approve it there. Ctrl-C is safe.
```

**The key is never displayed here and never passes through your clipboard or your shell history.**
That is the point of the device authorization grant: the secret travels from the gateway to this
machine, and a human only ever handles the eight-character code.

Two things worth knowing:

- **Only approve a code you are reading off your own screen.** Approving mints a key for your
  organization and hands it to whoever started that request. The portal says so before you click,
  and offers **I didn't start this** for a code someone sent you.
- **Ctrl-C is safe.** The code stays valid for ten minutes; run the command again for a fresh one.

If your gateway predates this feature, `certen login` says so and points at the portal. Mint a key
there and pipe it in — `certen auth login --api-key -` reads stdin, so it stays out of your history.

## 2. `certen init`

Creates what is missing and checks what already exists:

1. a signing key, generated and encrypted on this machine;
2. an identity, **waited on until it can actually sign**;
3. the abstract account per linked chain, with a faucet link if it has no gas;
4. your balance, and whether anything is left to commit.

It is idempotent. It records the identity id, so a second run reuses that identity rather than
minting another against your org quota — which matters, because the gateway has no identity list
endpoint and `/v1/portfolio` does not return UUIDs. An id that is not written down when it is
created is unrecoverable.

**Why it waits.** `POST /v1/identity` returns `202` and provisioning continues in the background, so
the response says nothing about whether the identity works. The field that decides that is
`can_sign`, and it has three values, not two:

| `can_sign` | Meaning |
|---|---|
| `true` | Your key is on the on-chain key page. Usable. |
| `false` | Provisioning finished; the key page is **not** yours. It will fail at the signing step of every flow. |
| `null` | The key page could not be **read**. Unknown — never treat this as a soft yes. |

`init` returns only on `true`, and reports the other two as failures with different messages.

## 3. The contract-call route: `certen call`

`certen send` moves the chain's native token. To authorise a call to a contract instead, this is the route (it also shows the confirmation card, and without `--json` ends with the same receipt):

```bash
certen call --identity <id> --chain base-sepolia --to 0xYourContract \
    --fn 'confirm(bytes32)' --arg 0x… --sign-with dev --wait
```

`--fn` takes a Solidity signature; `--arg` repeats positionally and is **type-checked before
anything is sent**. On a proof-gated call this matters more than usual: a valid proof of the *wrong*
call is still a valid proof, so a silently mis-encoded argument is worse than an error.

Once `init` has recorded your identity and you have one key and one chain, `--identity`, `--chain` and
`--sign-with` can be left out too: `certen call --to 0xYourContract --fn 'confirm(bytes32)' --arg 0x… --wait`.
Each value taken from context is echoed on stderr, `certen context` shows what the next command will use and why,
and `certen use identity|key|chain` chooses them when there is more than one. `--identity` takes a UUID, an
`acc://` ADI URL or the name you gave the identity.

You do not supply the ADI URL, the abstract account, or the numeric chain id — all three are derived
from the identity. (Omitting them upstream produces a bodyless `502`, which reads as "the gateway is
down" rather than "you left out a field". You should never have to know that.)

`--wait` polls to a terminal state. **A proof cycle is 60–110 seconds of real validator work** — not
a tunable delay, and not a hang. Drop `--wait` to return immediately and follow it later with
`certen tx status <id> --wait`.

`--dry-run` prints the intent without sending it, which is also the starting point if you need a
multi-leg intent: edit it and pass it to `certen tx create --intent @file.json`.

## 4. `certen proof get`

(After `send`, `certen receipt` is this and more. `proof get` is for when you want the proof document itself.)

```bash
certen proof get <intent-id>       # also accepts a proof id or a transaction hash
```

Take whichever id your last command printed; it works out which kind it is.

Most completed intents carry **no `proof_id`** — that is normal, not a failure, and it is always the
case for governance and key-page authorizations, which the proof-service does not index. The command
falls back to the Accumulate merkle receipt, read from the network directly, and tells you which
source answered.

The same fallback covers a proof-service outage. **A 5xx there means that service is down, not that
your proof is missing** — and the receipt keeps working, because it never touched the proof-service.

To hand the result to someone else:

```bash
certen proof bundle <proof-id>     # the artifact
certen proof share <proof-id>      # a link they open without a key of yours
```

---

## What a proof does and does not establish

`certen proof verify` reports three separate judgements, and is honest that it can establish only
the first:

1. **Inclusion** — the authorizing transaction really is in Accumulate's state. Asserted by the
   merkle receipt.
2. **Authorization** — *not checked.* Compare the operation against your own record of what was
   agreed: recipient, amount, target, calldata.
3. **Outcome** — *not checked.* Read the destination chain for the execution and its events.

And the part that matters most: **asking the gateway is not independent verification.** A verifier
who does not trust CERTEN should query an Accumulate node for the receipt and check it against roots
they fetched themselves, then read the execution on the destination chain. CERTEN's value is that
both of those checks are *possible* — not that its API asserts the answer.

Full detail: [verify-a-proof.md](verify-a-proof.md).

`certen receipt` applies the same honesty to the whole transfer: its verdict is the weakest honest reading of the proof **and** of whether the value arrived, it never shows PARTIAL or NO EVIDENCE as verified, and
it names what is not established instead of leaving you to notice. The recipient's balance is only ever read from a node you give it; the gateway cannot read another address.

---

## When an intent stalls at `anchoring`

`anchoring` means the authorization is done — written to Accumulate and anchored — and the
execution leg on the destination chain has not completed. There are **two** reasons it can sit
there, and they need different responses.

**1. The abstract account has no gas.** The intent is accepted, signed and submitted — every step
reports success — and then parks forever, because the execution cannot pay for itself. Nothing in
any API response says so.

The CLI and the SDK both refuse before submitting, and name the faucet (`certen send` does it as part of its readiness check, before your passphrase). They refuse a balance that is zero,
and one that is positive but cannot cover the amount you are sending plus an *estimate* of the gas to send
it (the gateway publishes no per-execution gas figure, so the gas half is a per-chain planning figure, and
the message says it is an estimate). `--force` (CLI) and `skipFundingCheck: true` (SDK) override it.
`certen doctor` reports an empty account as a warning rather than a failure, because a call forwarding no
value is unaffected, and `certen status --amount <n>` shows the same comparison before you send.

**2. Nothing is executing.** The authorization anchored correctly and no executor picked it up.
Observed in practice on a deployment where the gateway was healthy and the cross-chain executor was
not running at all.

Tell them apart without guessing:

```bash
certen proof get <intent-id>     # anchored: true  → the authorization is fine
```

Then read the destination chain. If the receipt is anchored and the funded account shows no
execution and no state change, the authorization half succeeded and the execution half never ran —
which is an infrastructure question, not something to fix in your integration.

This is exactly the split `certen proof verify` reports, and why it refuses to call a fetched proof
"verified": inclusion can be established from the receipt, **outcome cannot**.

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

Your key never reaches the SDK. You pass a `sign` function; it receives bytes and returns a
signature. Sign the **raw bytes** of the hex string — do not hash it again, and do not sign the
ASCII of the hex.

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
[proof-gated-contract-call.md](proof-gated-contract-call.md) for the full flow.
