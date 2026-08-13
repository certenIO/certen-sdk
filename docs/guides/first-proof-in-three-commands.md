# Guide — Your first proof, in three commands

From `npm install` to a proof you can hand someone. No API key is copied by hand, no JSON is written
by hand, and nothing waits on you to notice it finished.

```bash
npm install -g @certen.io/cli

certen login          # approve this machine once, in the portal
certen init           # signing key, identity, chains — created and checked

certen call --identity <id> --chain base-sepolia --to 0xYourContract \
    --fn 'confirm(bytes32)' --arg 0x… --sign-with dev --wait

certen proof get <intent-id>
```

If anything below goes wrong, `certen doctor` names the one thing blocking you and the command that
fixes it. It is worth running once before you start, just to see what a clean report looks like.

---

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

## 3. `certen call`

```bash
certen call --identity <id> --chain base-sepolia --to 0xYourContract \
    --fn 'confirm(bytes32)' --arg 0x… --sign-with dev --wait
```

`--fn` takes a Solidity signature; `--arg` repeats positionally and is **type-checked before
anything is sent**. On a proof-gated call this matters more than usual: a valid proof of the *wrong*
call is still a valid proof, so a silently mis-encoded argument is worse than an error.

You do not supply the ADI URL, the abstract account, or the numeric chain id — all three are derived
from the identity. (Omitting them upstream produces a bodyless `502`, which reads as "the gateway is
down" rather than "you left out a field". You should never have to know that.)

`--wait` polls to a terminal state. **A proof cycle is 60–110 seconds of real validator work** — not
a tunable delay, and not a hang. Drop `--wait` to return immediately and follow it later with
`certen tx status <id> --wait`.

`--dry-run` prints the intent without sending it, which is also the starting point if you need a
multi-leg intent: edit it and pass it to `certen tx create --intent @file.json`.

## 4. `certen proof get`

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

---

## The one silent failure to know about

An abstract account with no gas.

A value transfer from an empty abstract account is accepted, signed and submitted — every step
reports success — and then parks at `anchoring` forever, because the execution leg cannot run on
chain. Nothing in any API response says so.

The CLI and the SDK both refuse before submitting, and name the faucet. `--force` (CLI) and
`skipFundingCheck: true` (SDK) override it. `certen doctor` reports it as a warning rather than a
failure, because a contract call that forwards no value is unaffected.

---

## Doing the same thing in code

```ts
import { CertenClient } from '@certen.io/sdk';

const certen = new CertenClient({ apiKey: process.env.CERTEN_API_KEY! });

const report = await certen.doctor();          // same checks as `certen doctor`
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

Next: [onboard-an-identity.md](onboard-an-identity.md) for the raw API path ·
[external-signing.md](external-signing.md) for HSMs and air-gapped signers ·
[proof-gated-contract-call.md](proof-gated-contract-call.md) for the full flow.
