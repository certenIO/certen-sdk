# Guide — Proof-gating an arbitrary contract call

Most bridges move tokens. Certen executes **any function on any contract**, gated on a validator quorum
having attested that this exact call was authorized. A wrong call does not execute and get reverted — it
never executes.

That property is what makes it usable for escrow, arbitration, settlement, or any contract where "the agent
promised it called the right thing" is not good enough. The concept is in
[proof-gated-enforcement.md](https://gateway.kompendium.co/reference); this is the wire format.

**Prerequisites:** an identity with a deployed chain account (its abstract account is `msg.sender`), and the
[external signing flow](external-signing.md) — a contract call uses the same two steps, only the intent
differs.

---

## The multi-leg intent

A plain transfer uses the single-transfer shape. A contract call uses the **multi-leg** shape, with a
`contractCall` on the leg:

```bash
curl -X POST $CERTEN_API_URL/v1/transaction \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "identity_id": "<uuid>",
    "contract_addresses": ["0x9F452b98e33fF3F973a12ee9333B33082D824816"],
    "intent": {
      "adiUrl": "acc://buyer-bot.acme",
      "legs": [{
        "legId": "buy-1",
        "chain": "base-sepolia",
        "fromAddress": "0x<the identity abstract account>",
        "toAddress": "0x9F452b98e33fF3F973a12ee9333B33082D824816",
        "amount": "1500000000000000",
        "contractCall": {
          "target": "0x9F452b98e33fF3F973a12ee9333B33082D824816",
          "value": "1500000000000000",
          "functionSignature": "buy(bytes32)",
          "args": ["0xabc...def"]
        }
      }]
    }
  }'
```

The bridge ABI-encodes `functionSignature` + `args`; validators execute `target.call{value}(data)`,
proof-gated to that exact `(target, value, calldata)` triple.

| Field | Notes |
|---|---|
| `functionSignature` | Human-readable, e.g. `buy(bytes32)`, `note(bytes32,string)`. Not a selector. |
| `args` | In signature order. `bytes`/`bytes32` as `0x`-hex; ints as string or number — **use strings past 2^53**, where JSON numbers silently lose precision. |
| `value` | Native wei forwarded with the call. `"0"` for a pure call. |
| `amount` (leg) | The leg's native value. Set it to the same figure as `contractCall.value` for a payable call. |

From here the flow is identical to [external-signing.md](external-signing.md): sign `hash_to_sign`, POST it
to `submit_url`, wait ~60–110s, read the proof.

---

## Proof of effect, not just proof of non-revert

A call that does not revert has not necessarily done anything. `expectedEvents` makes the validators require
specific events before they will attest success:

```jsonc
"contractCall": {
  "target": "0x9F45...4816",
  "functionSignature": "buy(bytes32)",
  "args": ["0xabc...def"],
  "value": "1500000000000000",
  "expectedEvents": [{
    "contract": "0x9F45...4816",
    "topic0": "<keccak256(\"Paid(bytes32,address)\")>",
    "dataHash": "<keccak256 of expected non-indexed data>"   // optional, binds the payload too
  }]
}
```

Without it you get "the transaction succeeded". With it you get "the transaction did the thing" — a
meaningfully stronger claim, and the one an escrow counterparty actually needs. `dataHash` is optional; add
it when the event's non-indexed data is what matters (an amount, a recipient), not just that it fired.

---

## Getting the calldata right

The failure that costs the most time is a silently mis-encoded argument, because the proof cycle faithfully
proves the wrong call. Two habits:

- **Confirm the signature against the deployed ABI**, not the source you have locally. `note(bytes32,string)`
  and `note(string,bytes32)` are different functions with the same name.
- **Simulate first.** `cast call` against the same target and args tells you in a second what the proof cycle
  would tell you in two minutes.

```bash
cast call 0x9F45...4816 "buy(bytes32)" 0xabc...def --value 1500000000000000 --rpc-url $SEPOLIA_RPC
```

## Multi-leg atomicity

`legs` is an array, and several legs are authorized under one intent — one signature, one proof cycle. Legs
execute per chain; do not assume cross-chain atomicity. If leg B must not happen unless leg A did, express
that in the contract, not in the intent.

Full schema, including every leg field: **<https://gateway.kompendium.co/reference>**.
