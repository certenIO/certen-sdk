# Changelog — @certen.io/proof-verify

## 0.1.0 — first release

An independent verifier for CERTEN proof v2 (the Accumulate side), published so the CLI, the MCP server and the SDK's
`@certen.io/sdk/verify` can check a proof instead of trusting a flag in it.

- `verifyPortable` / `verifyProofDocument`: the portable document, verified offline from the incarnation pin: the validator-set spine
  (ed25519, rcd1 and legacy ed25519 key signatures; a proven write to the network or globals account is applied as Go does),
  the transaction receipt to a certified Directory root, the partition anchor, the governing pages and the validator set in force.
- `verifyProofDocument` reports one verdict per layer (`trust_base`, `L1`-`L4`, `G0`, `G1`, `G1_chains`, `L4_set`, `govRootV3`) and
  names what the document does not carry (`G1b`, `G2`, `L5`, `outcome`); a tamper fails at the layer it is in.
- `govRootV3` / `govRootV3FromPortable`: the per-intent commitment every validator signs, derived from the verified facts.
- Every field of a document is read through a typed reader that names what is missing or malformed; no `any` in the verifier.
- Runs against the cross-language conformance suite certen-validator generates, and against Go-produced binary vectors for the
  network and globals records.
- Requires Node >= 22. Depends on `accumulate-sdk-opendlt` 2.5.2, pinned exactly: its encoder is consensus-critical here.
