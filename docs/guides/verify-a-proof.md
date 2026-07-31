# Guide — Verifying a proof

The point of a proof is that your counterparty does not have to trust you, or Certen. A transaction hash is a
claim; a proof is evidence. This is how you hand one over and how the other side checks it.

**Prerequisite:** a completed intent carrying a `proof_id` (see [external-signing.md](external-signing.md)).

---

## The four reads

| Endpoint | What it gives you | Scope |
|---|---|---|
| `GET /v1/proof/{id}` | The proof artifact for a proof id | `proof:read` |
| `GET /v1/proof/{id}/bundle` | The full bundle — JSON, or a binary attachment | `proof:read` |
| `GET /v1/proof/{id}/custody` | The custody chain | `proof:read` |
| `GET /v1/proof/tx/{txHash}/receipt` | An Accumulate-native merkle inclusion receipt, read from the network | `proof:read` |

```bash
curl "$CERTEN_API_URL/v1/proof/<proof_id>" -H "X-API-Key: $API_KEY"
curl "$CERTEN_API_URL/v1/proof/<proof_id>/bundle" -H "X-API-Key: $API_KEY" -o proof-bundle.bin
```

The bundle streams as `application/octet-stream` when the downstream returns binary, and as JSON otherwise —
so write it to a file rather than assuming a shape.

## The receipt is the one that works everywhere

`GET /v1/proof/tx/{txHash}/receipt` reads a merkle inclusion proof **directly from Accumulate**, which means
it works for *any* delivered transaction — including key-page and governance authorization transactions that
the proof-service does not index.

That is the endpoint to reach for when a `proof_id` lookup comes back empty for something you know executed.
Governance is the common case: the authorization happened on Accumulate, so it has a receipt, but it is not a
cross-chain proof cycle and has no `proof_id`.

```bash
curl "$CERTEN_API_URL/v1/proof/tx/<accumulate_tx_hash>/receipt" -H "X-API-Key: $API_KEY"
```

---

## What a verifier should actually check

Handing over a bundle is not verification. A counterparty checking it should satisfy themselves of three
separate things, and it is worth being explicit because checking only the first is common and nearly useless:

1. **Inclusion** — the authorizing transaction really is in Accumulate's state. That is the merkle receipt,
   verified against a block root they obtained independently, not one you sent them.
2. **Authorization** — the intent that was authorized is the operation they care about. Compare the
   operation's identity against their own record of what was agreed: recipient, amount, target contract,
   calldata. A valid proof of the *wrong* call is still a valid proof.
3. **Outcome** — the call executed and had the expected effect on the destination chain. If the intent
   declared `expectedEvents`, the validators already required those events before attesting; otherwise
   "executed without reverting" is all that is being claimed.

Steps 1 and 3 are separate attestations by design — one before execution, one after — so that an attestation
about an outcome cannot be replayed as an authorization.

## Independent verification, without this API

A verifier who does not trust the gateway should not be asking the gateway. Two routes:

- **Read Accumulate directly.** The authorization is a public transaction; anyone can query a node for it and
  verify the receipt against the network's own roots.
- **Read the destination chain.** The execution is a public transaction on Ethereum (or wherever it settled).
  The events are on chain.

Certen's value is that both of those checks are *possible*, not that its API asserts the answer.

## Proof completeness

Fresh identities get the full governance proof chain — inclusion, governance correctness, and
governance-plus-outcome binding. Some very old accounts fall back to a partial middle stage for liveness,
because computing receipts across long anchor spans can hang the underlying node. Either way an intent always
completes and never drops to inclusion-only. If you are handing proofs to a counterparty who audits them,
create the identity fresh rather than reusing one from an early pilot.

Response shapes are defined by the proof-service and documented at
**<https://gateway.kompendium.co/reference>**.
