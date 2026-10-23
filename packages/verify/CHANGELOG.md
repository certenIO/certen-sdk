# Changelog — @certen.io/proof-verify

## Unreleased — RB12 TS arbfinal: `arb-sepolia/finalized/v1`, with the proven wallet route (2026-10-24)

### Added
- The TypeScript `arb-sepolia/finalized/v1` verifier (`src/proof-v2/finality/arbfinal`, exported as the `arbfinal` namespace, registered by `registerAllKinds` in the validator's order after
  `arb-sepolia/l1_posted/v1`): the body codec, the Rollup identity under S and under K, the assertion node and its parent's ConfigData under S, the L2 header spine, the node-size split
  (`max_node_bytes` off the transaction and receipt proof paths), and the confirmation-path classifier. `UNPORTED_KIND_ROWS` now names one row, `eth-sepolia/finalized/v1`.
- The wallet route is proven, not read from calldata: `proveWallet` is true only if, under K's state root, the callee is an existing account with the pinned `validator_wallet_proxy` code hash, its
  EIP-1967 implementation slot holds exactly the pinned implementation address, and that implementation is an existing account with the pinned `validator_wallet_logic` code hash. Any error is
  false, never a throw. A callee that is not proven is `confirmation_path_unproven{indirect}`.
- go-ethereum semantics where Go uses go-ethereum: `Receipt.UnmarshalBinary` (legacy and typed 1-4 receipts, status or post-state, logs), the ValidatorWallet ABI decode of the four entry points
  with the canonical re-pack rule (unpack, then pack, must equal the input: dirty address bits, offset gaps, trailing words, padding garbage and unequal batch arrays are refused), `tx.Hash()` (the
  sidecar of a network-form blob transaction stays out of the hash) and the pins loader in Go's order (`proxy_slots.wallet_impl`, `confirm_path.validator_wallet_impl`, the two wallet roles in
  `logic_pins`; nothing defaulted; a pins override file without the four wallet pins is `pin_mismatch{field}`).
- Byte-identical copies of the validator's `finality_arb_final1` (125), `finality_arb_final2` (15), `finality_arb_final3` (86, the wallet-proof set) and `finality_arb_force1` (the real owner
  force-confirmation) at `cbb6373`, the two real wallet runtime codes, and a harness that adds the four wallet pins to the stored pins files of sets 1 and 2 re-serialized with sorted keys. The 13
  superseded verdicts of sets 1 and 2 are judged by the verdict now (`SUPERSEDED.md`), each carried again in set 3. `test/fixtures/finality/arb_final_x` is a TS-held supplement (8 worlds judged
  by the Go verifier; the framework header reader is applied to K's header only), not a Go-published set.

### Verification
- Every one of the 226 Go vectors and the force fixture is judged with the Go-recorded canonical verdict; the fixtures were run against the base commit in a detached worktree (516 of 551 new
  tests fail there; the 35 that pass need no kind).
- Two-seed differential against the Go verifier (throwaway generator over `synthworld` worlds and byte, structure, pins and leg mutations plus receipt, transaction, ABI and pins decoder corpora):
  16,773 inputs, 0 verdict differences; the same kind corpus through the registry at the base commit differs on 2,644 of 2,804 and 2,647 of 2,801 inputs.
- A 279-mutant hand-mutation gate over the eight files (266 killed, 12 equivalent with reasons in `test/finality/arbfinal/mutation_equivalents_rb12.json`, 1 no-op control).

### Two places where Go depends on its random map order, made deterministic here
- Case-variant duplicate `logic_pins` keys naming different roles are `pin_mismatch{logic_pins}` (Go keeps whichever its map visits last); with several bad selectors or topics the first in sorted name
  order is named (Go names a random one). A file with one defect answers identically in Go and here.

## Unreleased — RB12 TS base: the Base finalized and Base l1_posted verifiers follow the Go review fixes (2026-10-23)

### Fixed (false accepts, `base-sepolia/finalized/v1`)
- A header without a withdrawals root is `output_root_mismatch{computed: 0x00..00}` whatever the claim (a zero claim used to match the absent root); the header must be the block the game implies
  (`header.number == outBlock`).
- The pinned game build's `asr` is required and must be the AnchorStateRegistry proven at Portal slot 62, and its optional `dgf` the factory proven at ASR slot 1; otherwise
  `contract_identity_unproven{role: game_impl}`.
- A zero code-hash key in `impl_pins` / `proxy_pins` is `finality_pins_corrupt`; `ImplRow` completeness compares `args_len` without int64 wrap (`n_intermediate = 2^59 + 20` is no longer complete).

### Fixed (`base-sepolia/l1_posted/v1`)
- Every deposit transaction is type `0x7e` and no batch transaction is one or empty (`batch_binding_mismatch{field: deposit_txs | batch_txs}`).
- The channel timeout is chosen per frame by the timestamp of the L1 block that holds it (50 from `granite_time`, the Bedrock 300 before); `granite_time` and `channel_timeout_granite` are required
  pins; the KZG pin is read from the `shared` section (the embedded pins did not load for this kind before: it failed closed on the moved KZG pin).
- The OP Brotli channel is read strictly (empty stream, early end, a byte after the stream); caps up to 2^64-1 neither wrap nor refuse; `frame - first` and `l - epoch` are compared without wrap.

### Changed
- `state.ts`: `EvidenceReason` +29 members, `IncludedReason.NoBlockHeader`, typed `LedgerReason` and `PinMismatchField` (the current registry's closed sets); `conformance.test.ts` is green again and covers the four
  codes whose entry grew since the per-port registries.

### Added (tests)
- Byte-identical copies of the validator's `finality_base_final2`, `finality_base_posted2` and `finality_base_posted3` and their parity tests.
- Two-seed differential against the Go verifiers (3,220 mutated Base inputs, 0 verdict differences; run against the base commit it shows 232) and a 210-mutant hand-mutation gate over the changed files
  (199 killed, 11 equivalent with reasons in `mutation_equivalents_rb12.json` beside each kind's tests).

## Unreleased — RB12 TS integration: the staged-finality (S7) verifiers in one branch (2026-10-23)

### Added
- The S7 finality verifiers of the RB11 TypeScript stack, integrated on one linear branch (`src/proof-v2/finality`): the framework core (container, addendum, pins, registry, the level-1
  derivation, the report; judges the validator's `finality_chain1` and `finality_chain2` sets), the Sepolia beacon light-client verifier (`ethl1`; the 143 `finality_ethl1_v2` cases and the
  official `single_merkle_proof` subset), `base-sepolia/l1_posted/v1` (28 Go vectors), `base-sepolia/finalized/v1` (23 live and 73 judge-level `finality_base_final1` vectors),
  `arb-sepolia/l1_posted/v1` (63 Go vectors) and `adiri/finalized/v1` (`finality_adiri3` and `finality_adiri4`, with the genesis link checked at load).
- `registerAllKinds(reg, pins)` (`finality/allkinds.ts`), the twin of the validator's `allkinds.Register`: wires the four ported Kinds in the validator's order; the Adiri registration is
  asynchronous and fails closed (a genesis link the pins do not vouch for rejects with `finality_pins_corrupt` and nothing is registered). `UNPORTED_KIND_ROWS` names the two table rows
  that have no TypeScript Kind yet (`arb-sepolia/finalized/v1`, `eth-sepolia/finalized/v1`); judging evidence of those rows answers `finality_evidence_unrecognised`.
- The finality barrel exports every chain package under its own namespace (`adiri`, `arbposted`, `basefinal`, `baseposted`, `ethl1`; their names collide, so no `export *`).

### Changed
- The embedded finality pins and `PINS_SHA256` are the validator's `pv2/rb11-e1-raise` file (`fdba733e...5440`; before: the framework's Sepolia-only `507d72b3...`): they now carry the
  Adiri, Arbitrum, Base and shared (KZG) sections and the Sepolia root anchor (period 1378).
- The current state registry (`test/fixtures/finality/finality/states.json`) is the validator's `pv2/rb11-e1-raise` registry; the registry that `finality_chain2`'s manifest pins moved,
  byte for byte, to `test/fixtures/finality/finality_chain2_registry/states.json`.

### Not changed
- No verdict of `verifyPortable`, `verifyPortable21` or any earlier layer; the finality barrel is not exported from the package entry point yet.
- Not yet in TypeScript (see the RB12-TS-INT check-in gap table): the two missing Kinds, the Go fixes made after each port's base commit, and the registry changes they carry.

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
