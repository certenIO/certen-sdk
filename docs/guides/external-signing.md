# Guide — Signing when you hold the key

**The pattern almost every real integration uses.** The gateway computes what must be signed; you sign it;
you hand the signature back. Your private key never leaves your process, and the gateway can never act
without you.

This is called **external mode**. The alternative — provider mode, where the gateway holds a key and signs
for you — is fine for a demo and wrong for anything holding value.

```
  you                                gateway                      Accumulate / target chain
  ───                                ───────                      ─────────────────────────
  POST /v1/transaction ─────────────▶ builds the intent
                       ◀──────────── signing_data.hash_to_sign
  sign it locally
  POST …/signature ─────────────────▶ submits the envelope ──────▶ authorized, then executed
                       ◀──────────── tx_hash + proof_id
```

**Prerequisite:** an identity created with `public_key` (see [onboard-an-identity.md](onboard-an-identity.md)).
An identity registered with only a `public_key_hash` cannot sign — that combination used to be accepted at
create and rejected at sign time, so check `can_sign` on the identity before you build anything on it.

```bash
export CERTEN_API_URL="https://gateway.kompendium.co"
export API_KEY="ck_live_..."
```

---

## 1. Open the intent

```bash
curl -X POST $CERTEN_API_URL/v1/transaction \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "identity_id": "<uuid>",
    "intent": {
      "fromChain": "accumulate",
      "toChain": "base-sepolia",
      "fromAddress": "acc://your-org.acme",
      "toAddress": "0xBe00...9251",
      "amount": "4000",
      "tokenSymbol": "ETH"
    }
  }'
```

```jsonc
201 {
  "intent_id": "…",
  "status": "signing_required",
  "signing_mode": "external",
  "signing_data": {
    "request_id": "…",
    "transaction_hash": "…",
    "hash_to_sign": "9c2b…"      // 32 bytes of hex — THIS is what you sign
  },
  "submit_url": "/v1/transaction/<intent_id>/signature"
}
```

**Send an `Idempotency-Key`.** A network error on this call is otherwise indistinguishable from success, and
retrying without one can open a second intent. A replay returns the original with `"idempotent": true`.

## 2. Sign `hash_to_sign` locally

Ed25519 over the **raw bytes** of the hex string — do not hash it again, and do not sign the ASCII.

```js
import nacl from 'tweetnacl';
const sig = nacl.sign.detached(Buffer.from(hashToSign, 'hex'), secretKey);   // 64 bytes
const signature = Buffer.from(sig).toString('hex');                          // 128 hex chars
```

## 3. Hand the signature back

```bash
curl -X POST "$CERTEN_API_URL/v1/transaction/<intent_id>/signature" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"signature": "<128 hex>", "public_key": "<64 hex>"}'
```

The gateway verifies the signature against `public_key` **locally** before submitting, so a bad signature is
a `400` from the gateway rather than a confusing `502` from downstream. A transient downstream failure
releases the sign request so you can retry rather than stranding it.

## 4. Wait for the proof

Execution is not instant — a real cross-chain proof cycle runs **~60–110 seconds**. That is validator work,
not a configurable delay.

```bash
curl "$CERTEN_API_URL/v1/transaction/<intent_id>" -H "X-API-Key: $API_KEY"
```

Poll that, or subscribe to [webhooks](https://gateway.kompendium.co/reference) and stop polling. When it carries a `proof_id`, see
[verify-a-proof.md](verify-a-proof.md).

---

## Choosing which key signs

Two optional fields on `POST /v1/transaction` matter once more than one key is involved:

| Field | Use it to |
|---|---|
| `signer_public_key` (64 hex) | Nominate **which seat** on the key page signs. Defaults to the identity's bound key. On an M-of-N panel this is how any seat opens a transaction — an agent proposes, a human finalizes. |
| `signer_key_page` (`acc://org.acme/book/2`) | Nominate **which page** of the book signs. Must be in the same book. Lower index = higher priority, and Accumulate authorizes at *book* level, so a high-priority page can satisfy the book alone — that is how you separate routine work from escalation. |

`hash_to_sign` is bound to whichever key you nominate, so the signature you post must come from that key.
`signer_public_key` cannot be combined with a provider-signed identity.

## Voting on a transaction someone else opened

Everything above opens an intent of your own. Adding your vote to a transaction that already exists
goes through `POST /v1/sign`, and there are two ways to name what you are signing:

| You hold | Send | Extra fields |
|---|---|---|
| An inbox action id (UUID) from `GET /v1/pending` | `type: "pending_action"` | none — the inbox row carries them |
| An Accumulate transaction hash or TxID | `type: "pending_tx"` | `identity`, `signer_url`, `public_key` |

The by-hash route exists because the inbox is not universal. The pending poller enumerates the ADIs
registered to an organization, so an **external identity** — someone with their own ADI who is not
registered with you — is never polled and never gets an inbox row. There is no id to pass. Their
route is the hash, and it is also the route for a transaction that names your key book in
`header.authorities` without your ADI being an authority of the principal.

The clients infer which of the two you meant from the shape of the id, so neither takes a `type`:

```bash
certen pending sign f47ac10b-58cc-4372-a567-0e02b2c3d479          # inbox id
certen pending sign 2e3d512d…79fc6   --identity acc://you.acme --signer-url acc://you.acme/book/1 --public-key <64 hex>
```

`acc://<hash>@<account>` works wherever the bare hash does — that is the form the explorer and
`queryTx` hand you, and stripping it by hand is a step nobody should have to remember.

The bytes to sign come back as `signing_data.data_for_signature` (not `hash_to_sign` — that name
belongs to the intent flow above), and the vote is folded into them, so it is fixed when the sign
request is created and cannot be changed at submit time.

## Failure modes worth handling

| Symptom | Cause |
|---|---|
| `400` "Identity has no public key configured" | The identity was created with only `public_key_hash`. `PATCH /v1/identity/:id` can repair it if the hash matches. |
| `400` on `/signature` | Signature does not verify against `public_key`. Usually the ASCII of the hex was signed instead of its bytes. |
| `409` on `/signature` | Already signed. Treat as success and read the intent. |
| Second intent appeared after a retry | No `Idempotency-Key` on step 1. |

Full request and response schemas: **<https://gateway.kompendium.co/reference>**.
