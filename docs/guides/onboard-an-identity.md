# Guide — Onboarding an identity

An **identity** is an Accumulate ADI (`acc://your-org.acme`) with a key book, a key page, and optionally a
deployed abstract account on each chain you name. It is the thing that signs, holds, and is named as an
authority.

**Creation is asynchronous.** `POST /v1/identity` returns `202` and provisioning continues in the background.
Code that assumes a synchronous `201` will race.

```bash
export CERTEN_API_URL="https://gateway.kompendium.co"
export API_KEY="ck_live_..."
```

---

## 1. Generate a key — locally, and keep it

```js
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';

const kp = nacl.sign.keyPair();
const publicKey = Buffer.from(kp.publicKey).toString('hex');                  // 64 hex
const publicKeyHash = createHash('sha256').update(kp.publicKey).digest('hex'); // 64 hex
// kp.secretKey never leaves your process.
```

## 2. Create the identity

**Send `public_key`, not just `public_key_hash`.** An identity registered with only the hash cannot sign —
that combination was once accepted here and then rejected at signing time, leaving an identity that consumed
quota and could never be used. `PATCH /v1/identity/:id` can repair one if the hash matches, but supplying the
key up front is the path that works.

```bash
curl -X POST $CERTEN_API_URL/v1/identity \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "name": "buyer-bot",
    "public_key": "<64 hex>",
    "public_key_hash": "<64 hex>",
    "chains": ["ethereum-sepolia"],
    "credits": 50000
  }'
# → 202 { "identity": { "id": "<uuid>", "status": "provisioning", ... } }
```

`credits` funds Accumulate operations for the identity. Without credits its votes and transactions fail to
submit — and that failure looks like an unrelated network problem, so fund at create time.

## 3. Wait for provisioning, then check `can_sign`

```bash
curl "$CERTEN_API_URL/v1/identity/<uuid>" -H "X-API-Key: $API_KEY"
```

Poll until `status` is terminal, then **verify `can_sign` is true before building anything on it**. That one
field is the difference between an identity that works and one that will fail at the last step of every
flow. If provisioning failed, `error_message` says why; provisioning retries on transient faults.

Subscribe to [webhooks](https://gateway.kompendium.co/reference) instead of polling if you are onboarding more than a handful.

## 4. Note the abstract account address

For each chain you named, the identity gets a deterministic abstract account — the same address on every EVM
chain, derived from the identity. That address is `msg.sender` for anything the identity executes, so it is
what your contracts should be told about, and what needs funding if a call forwards value.

It appears on the identity as its chain accounts. (There are two historical stores for this; see
[internal note](https://gateway.kompendium.co/reference) if you see both `chain_accounts` and
`linked_chains` and wonder which is authoritative.)

---

## Quota, and cleaning up

Organizations have an identity cap. Test identities count against it, and a failed one used to count too.

```bash
curl -X DELETE "$CERTEN_API_URL/v1/identity/<uuid>" -H "X-API-Key: $API_KEY"
```

That **retires** the identity and frees the slot. It is a soft delete inside Certen only — the on-chain ADI,
its key book, and its key page are untouched and keep existing on Accumulate. So it releases quota; it does
not destroy anything, and it is not a way to revoke a key. If you are iterating in a test org, retire as you
go — hitting the cap mid-integration is avoidable and confusing when it happens.

## Checklist

1. Key generated locally; secret key never sent anywhere.
2. `public_key` **and** `public_key_hash` both sent at create.
3. `Idempotency-Key` sent — a retried create otherwise burns quota on a duplicate.
4. Waited for a terminal status; **`can_sign` is true**.
5. `credits` funded.
6. Abstract account address recorded.

Next: [external-signing.md](external-signing.md) — the flow every integration uses.

Full schema: **<https://gateway.kompendium.co/reference>**.
