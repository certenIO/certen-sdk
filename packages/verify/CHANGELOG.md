# Changelog — @certen.io/proof-verify

## Unreleased — RB9 Phase D: cross-identity and delegated approvals in TypeScript (2026-10-18)

### Added
- `verifyPortable21` / `verifyPortableAny`: the validator's evidence 2.1 verifier (pages on every partition at their own block, roles, the certified timeline, the routing proof, the
  executor-version table, delegation to depth 20) with its report and its named states (`NamedState`, `State`); reaches the validator's verdict on all 100 documents of its seven
  `xpartition` suites, the real Kermit document and 1,257 Go-judged mutations of them.
- `bindProofV21`, `bindProofV2`, `governingFactsFromVoteEvidence`, `govRootV4FromPortable`, `govRootV4FromHashes`, `encodeVoteV4`, `proofV2Root`, `judgeProofV2`,
  `unmarshalCertifiedEvidence`, `evidence20View`: the consensus-side binding, the cross-partition govRoot (reproducing the committed golden), and the decode and gating of a certificate's
  proof v2, each checked against corpora the validator wrote.

### Changed
- `verifyPortable` (evidence 2.0) refuses a document that carries evidence 2.1 members (anchors, votes, a routing proof, a page's partition or roles), as the validator's does; before, they
  were ignored.

## Unreleased — RB8 Phase C: every key-signature type Accumulate accepts (2026-10-17)

### Added
- `verifyKeySignature`, `decodeSignature`, `decodeTransaction`, `unwrap`, `publicKeyHash`, `eip712Hash`, `transactionHash`, `checkExecutorGate` and the typed refusals: verification of
  `ed25519`, `legacyED25519`, `rcd1`, `btc`, `btclegacy`, `eth`, `rsaSha256`, `ecdsaSha256` and `typedData` key signatures, directly or delegated, from Accumulate's binary encoding,
  reaching the verdict, key hash and digest form of the validator's Go `govsig` package on its 154 shared vectors (G-42). Until now the only key-signature verifier here was the
  Directory spine's, which refused every type but `ed25519`, `rcd1` and `legacyED25519` by name.
- Accumulate's binary reader and writer (`decodeObject`, `encodeNode`) over the SDK's field metadata, its URL parser and writer, and the executor-version gate with Kermit's
  activation table - each checked against Accumulate's own output (EIP-712 digests over all 23 user transaction bodies that reach EIP-712; 3,077 URL strings; byte-level mutations of
  the 154 vectors' signatures and of the EIP-712 corpus's transactions, 5,891 in all).
- Direct dependencies `@noble/curves` 1.9.7 and `@noble/hashes` 1.8.0, pinned exactly (both already in the lockfile through `accumulate-sdk-opendlt`).

### Not changed
- The spine's `verifySignature` and every existing verdict, hash and golden.

## 0.1.0 — RB7b: verify what you trust, sign what you see (2026-10-09)

The offline verifier for Certen proofs: a proof v2 portable document (`certen-proof-v2-accumulate-portable/1`) or a proof bundle, checked layer by layer with no network and no gateway, and the signing check a client runs before it signs.
Node 22 or 24, and browsers (Web Crypto). It verifies the 22 cross-language conformance cases the Go verifier produced, with the same verdicts and the same govRoot v3 (`0477ea2c…`).

- Per-layer verdicts (`verified`, `failed`, `not_checked`, `not_in_document`); the overall result is `verified` only when every layer the document carries was checked here. `G1b`, `G2` and `L5` are `not_in_document`, and the execution outcome needs the target chain's block header from the caller.
- Applies a proven write to the network or globals account in the spine as Go does, and accepts the `rcd1` and legacy ed25519 key signatures Go accepts.
- A validator set that changed after genesis is reported as not established (`L4_set` and `govRootV3` are `not_checked`, the overall result `partial`), never `failed`: govRoot v3 commits a set proven from genesis and fails closed on anything weaker, as Go does, but that is a limit of the evidence, not a tamper. Shown on a synthetic whole document with a network update in its spine (conformance `network-update`, with 17 tampered twins), which Go and this verifier both run.
- Encodes with `accumulate-sdk-opendlt` 2.5.2 exactly; none of the four earlier workarounds remain.

### Included — sign what you see (RB7b Phase F)

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
