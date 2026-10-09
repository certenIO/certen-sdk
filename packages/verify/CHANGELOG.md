# Changelog — @certen.io/proof-verify

## Unreleased — sign what you see (RB7b Phase F)

### Added
- `verifySigningData(signing_data, expectation)`: rebuilds the unsigned transaction a gateway asks to be signed, recomputes the transaction hash, the signature
  metadata hash and the signing hash, requires them to equal what the gateway sent, decodes what the transaction authorises (CERTEN intent legs; key-page, account-authority
  and key-page-creation changes) and requires it to match the request. `SigningDataMismatch` (`SIGNING_DATA_MISMATCH`, with the field) and `SigningDataAbsent`
  (`SIGNING_DATA_ABSENT`); no switch skips the check. Co-signatures keep the original initiator (`{ existing: true }`).
- `reconstructSigning`, `encodeCall` (a small Solidity ABI encoder for building the calldata a request means), `AbiUnsupported`.
- Proved on seven transactions CERTEN put on the Kermit testnet: each rebuilt transaction hash is its id on chain, and the signature each carries verifies over the recomputed signing hash.
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
