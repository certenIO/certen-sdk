# Guide — M-of-N panels and co-signing

A panel is a key page with a threshold: 2 of `{operator, agent, regulator}`. No single seat can act. The
transaction sits **PENDING** on Accumulate until the threshold is met, and then executes automatically —
Accumulate enforces that, not the gateway and not your application.

This is the shape behind arbitration, dual control, break-glass, and any "two people must agree" rule.

**Prerequisites:** the [external signing flow](external-signing.md), and a key page whose threshold is > 1.

---

## The lifecycle

```
  seat A: POST /v1/transaction (signer_public_key = A) ──▶ intent opened, 1 of 2
  seat A: POST …/signature
                                                          tx is PENDING on Accumulate
  seat B: GET /v1/pending                               ──▶ discovers it
  seat B: POST /v1/sign  { type: "pending_action" }      ──▶ signing_data for B's key
  seat B: POST /v1/sign/{id}/signature                   ──▶ 2 of 2 → Accumulate EXECUTES
```

Nothing tells Accumulate "now execute". Reaching the threshold *is* execution.

## 1. A seat opens the transaction

Any current member of the page can open it — not only the identity's bound key. Nominate the seat:

```bash
curl -X POST $CERTEN_API_URL/v1/transaction \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "identity_id": "<panel identity uuid>",
    "signer_public_key": "<seat A public key, 64 hex>",
    "intent": { ... }
  }'
```

Then sign and post as in [external-signing.md](external-signing.md). This is how an agent proposes a
resolution that a human later finalizes.

## 2. Other seats discover the work

```bash
curl "$CERTEN_API_URL/v1/pending?identity=acc://panel.acme&limit=20" -H "X-API-Key: $API_KEY"
```

Returns `actions[]` plus `stats{}` and `pagination{}`. Each action carries `required_signatures` and how many
have arrived, so a seat can tell "waiting on me" from "waiting on someone else".

Prefer the [`inbox.action_pending` webhook](https://gateway.kompendium.co/reference) over polling in production.

## 3. A co-signer votes

```bash
# ask for signing data bound to THIS seat's key
curl -X POST $CERTEN_API_URL/v1/sign \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "type": "pending_action",
    "target_id": "<pending action id from /v1/pending>",
    "identity": "acc://panel.acme",
    "signer_url": "acc://panel.acme/book/1",
    "public_key": "<seat B public key>",
    "vote": "approve"
  }'
# → { sign_request_id, signing_data: { data_for_signature, … }, submit_url }

curl -X POST "$CERTEN_API_URL/v1/sign/<sign_request_id>/signature" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"signature": "<128 hex>", "public_key": "<64 hex>"}'
# → { status, tx_hash, signature_count, is_ready, awaiting_authorities }
```

The signing data is computed for the **actual** signer's key, so any seat on the page can vote.
`awaiting_authorities` tells you who is still outstanding.

Signing by hash instead of by inbox id — for a seat adding a vote without waiting for discovery — is
`type: "pending_tx"` with `target_id` = the pending transaction hash, plus `identity`, `signer_url`, and
`public_key`.

---

## Four things that surprise people

**`vote` is a lowercase string enum**, not a number: `approve`, `reject`, `abstain` (default `approve`). A
numeric vote is rejected — and note the value is `approve`, not `accept`.

**A reject is a signature, and it can kill the transaction.** On a panel, "no" and "abstain" are different
acts. If a seat means "not me, ask someone else", it should withhold — not vote reject.

**The vote is fixed when the signing data is created.** Accumulate folds the vote into the signature metadata
hash, so accept and reject are different preimages. You cannot request signing data and decide the vote
afterwards; ask for fresh data if you change your mind.

**Do not resubmit a signature to a spent `sign_request_id`** — it 404s. Request fresh signing data instead.

## Rotating a seat

Membership changes are governance operations, not transactions. Note `identity` (the ADI, not a uuid) and
`operations` — an **array**, so several changes go in one authorization:

```bash
curl -X POST $CERTEN_API_URL/v1/governance \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "identity": "acc://panel.acme",
    "operations": [
      { "type": "remove_key", "public_key_hash": "<compromised seat hash>" },
      { "type": "add_key",    "public_key_hash": "<replacement seat hash>" }
    ]
  }'
# then POST /v1/governance/<id>/signature — threshold rules apply here too
```

Three kinds of operation exist and **cannot be mixed in one request**: key-page operations (`add_key`,
`remove_key`, `set_threshold` for the M-of-N acceptThreshold, `add_delegate`, `remove_delegate`), authority
operations (`add_authority`, `remove_authority`), and `create_key_page`. Removing and adding a key together
is fine — both are key-page operations.

A compromised seat can be removed without redeploying anything that depends on the panel: the panel's
identity and its on-chain address are unchanged. Governance is itself threshold-gated, so removing a seat
needs the same quorum as spending — which is the property you want, and also the reason a panel that has lost
quorum cannot repair itself.

Exact per-operation fields: **<https://gateway.kompendium.co/reference>**.

## Automating a seat

A seat does not have to be a human with a browser. The
[headless policy-engine signer](https://github.com/certen/certen-policy-signer) is a service that watches
Accumulate for transactions naming its page, asks a policy engine of yours, and votes only on an explicit
approval — fail-closed, so an outage delays a decision but never grants one. Point its `vote` backend at this
gateway and it becomes an automated panel seat with an auditable reason attached to every vote.
