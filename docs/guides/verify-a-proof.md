# Guide — Verifying a proof

The point of a proof is that your counterparty does not have to trust you, or Certen. A transaction hash is a
claim; a proof is evidence. This is how you hand one over and how the other side checks it.

**Prerequisite:** a completed intent carrying a `proof_id` (see [external-signing.md](external-signing.md)).

---

## The reads

| Endpoint | What it gives you | Scope |
|---|---|---|
| `GET /v1/proof/{id}` | The proof artifact for a proof id | `proof:read` |
| `GET /v1/proof/{id}/bundle` | The full bundle — JSON, or a binary attachment | `proof:read` |
| `GET /v1/proof/{id}/custody` | The custody chain | `proof:read` |
| `GET /v1/proof/{id}/contract-identity` | The contract-identity state the validators recorded (`recorded`, `absent`, `malformed` or `too_large`); their record, not verified by the gateway | `proof:read` |
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

## Verify it yourself: `certen proof verify`

`certen proof verify <intent id | share link | @bundle.json>` (and the MCP tool `certen_proof_verify`, and `@certen.io/sdk/verify`) checks the proof here,
from its own bytes, and prints one verdict per layer with the evidence each was checked against. It never counts a `verified` flag in the bundle or the
gateway's own receipt; both are printed as what they are. Exit `0` means every layer the proof carries checked; `4` means a named layer is not established;
`1` names the layer a tamper is in; `5` means the gateway serves no proof v2 document for this proof. Add `--rpc` with your own node to compare the
execution receipt with a block header you fetched. See [CLI-CONTRACT](../CLI-CONTRACT.md) for the output.

An AI agent asks the MCP server instead: `certen_receipt { intentId }` does the whole of this in one call (the ids, the layers, whether the value arrived) and returns the same record
`certen receipt` prints. The server never calls a node you name, so the comparison with the execution chain is made by passing it the block header you fetched yourself
(`header: { receiptsRoot, hash, number }`); a header with no `receiptsRoot` compares nothing, and is refused rather than counted. If whoever runs the server configured a node for the chain
(`CERTEN_RPC_URL_<CHAIN>`), it reads the recipient's balance and compares the header itself, and a transfer can come back confirmed. A proof *share link* given to `certen_proof_verify` is opened
only on the server's own gateway or an origin its operator allows (`CERTEN_SHARE_ORIGINS`). `certen_readiness` is the question before it: can this identity, on this chain, act right now?

## What `verified` rests on

A proof the validators emit today is **evidence 2.1**; the verifier reads 2.0 and 2.1. The layers of a 2.1 proof, in the order `certen proof verify` prints them:

| Layer | What it establishes |
|---|---|
| `trust_base` | the document's genesis hashes to the incarnation pin the verifier ships with. This is the only trust input: nothing else needs supplying |
| `L4`, `L4_set` | the validator set, walked from genesis, and the set in force when the proof was made |
| `L1`, `L2`, `L3`, `G0` | the transaction's receipt chain into a Directory root the validators certified |
| `G1`, `G1_chains` | every page that decides who may approve the intent, on every partition, at its own block: which are authority books, which pages voted, which signed first (`G1.evidence.pages`, each with its `roles`) |
| `govRootV4` | the governance root derived from those facts (`govRootV3` for a 2.0 proof) |
| `S7` | staged finality of the settlement, judged against the Settlement (block header and inclusion proofs) in the bundle's own execution component. `l1_posted` today; `finalized` waits for the chain's own finality and is reported as pending, which does not stop `verified` |
| `outcome` | the execution receipt on the destination chain, against a block header **from your own node** (`--rpc`) and, if you pass it, the event it must contain (`--expect <address:topic0>`) |

Exit `0` (`overall: verified`) needs every one of them. Without `--rpc`, `outcome` is `not_checked` and the verdict is `partial` (exit `4`): the receipts root would otherwise be the validators' word about themselves.

A layer says `not_checked` when the verifier will not establish a fact, and names it (`g1_authority_not_ready{...}`): not a tamper, and not a pass. Anything that is wrong is `failed`, at the layer it is in, and the layers after it say `not reached`. `@certen.io/proof-verify` alone (`verifyPortableAny`) gives the report for either version; `certen proof verify`, the SDK's `verifyEvidence` and the MCP `certen_proof_verify` add the layers, the finality judgement and the outcome check.

A transaction that a separate identity signed first and paid for, one that is no authority of the account and casts no vote (the `*-erp` pattern), is proven only when the document carries that signature (the member `initiatingSignature`, which validators attach once their rules v16 are active). Without it `G1` is `not_checked` with `g1_initiator_signature_not_carried`: the page records the role, nothing proves it. With it the signature is proven completely or the document is refused by name: `g1_signature_invalid`, `g1_arrival_unproven`, `g1_block_before_signature`, `g1_executor_version_unproven`, `g1_delegation_depth_exceeded`, `g1_history_unavailable` (the page's history is not carried) or `g1_initiator_key_not_held` (no state of the page held the key, or the page blacklisted the transaction's type). Needs `@certen.io/proof-verify` 0.3.1 or later; 0.3.0 ignores the member.

### The root you expect

`--govroot <hex>` (`expectGovRoot` in the SDK) compares the root derived from the proof with a value you hold from your own record. It is optional: without it the layer still verifies, against the pinned incarnation alone, and a mismatch fails `govRootV4`. **There is no on-chain value to read it from.** The anchors the validators post are root-only, and `getAnchor(...).governanceRoot` is zero for them (read on Base Sepolia for two anchors a month apart), so do not look for one there.

### Reading who approved

`G1.evidence.pages` is how a counterparty sees that a second party approved. An intent governed by two books, because the intent account has both as authorities, lists both books as `authority-book` and both pages as `voter`, with `authorizationMode: authorities_required`. The intent also declares them (`authorization.authorities` in its governance section). Accumulate keeps a write to such an account `pending` until every required authority has signed, so a delivered intent carries every vote. See [co-authority-approval.md](co-authority-approval.md).

### How long it takes

A proof cycle takes minutes, not seconds: measured on the hosted gateway, recent `on_demand` intents took a median of about 26 minutes and a p90 of about an hour. `certen send`, `call` and `tx create --wait` wait up to 90 minutes and can be resumed with `certen watch <intent-id>`; a script should poll `GET /v1/transaction/{id}` (or take the `transaction.completed` webhook) and treat a wait that ran out as "not finished", never as a failure to retry.

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
