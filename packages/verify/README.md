# @certen.io/proof-verify

An independent verifier for CERTEN proof v2 (the Accumulate side): it checks a proof offline, with no network, no
database and no CERTEN code in the trust path. It is the second implementation the proof v2 design requires
(certen-validator `docs/proof/PROOF_V2.md` §9); the first is the Go verifier in certen-validator `pkg/proof/v2`.

```ts
import { verifyPortable } from '@certen.io/proof-verify';

const report = verifyPortable(JSON.parse(portableProofJson)); // throws VerifyError on anything that does not check
// report.certifiedBlock, report.anchorBlock, report.pages, report.setVerdict, ...
```

## What it checks

1. **The trust base.** The genesis network definition and globals are bound to the pinned incarnation identity:
   `keccak256("certen:incarnation:v1" || ... || sha256(network record) || sha256(globals record))` must equal the pin.
2. **The validator-set spine** from major block 1: every Directory self-anchor's ed25519 signatures, by active
   Directory validators, meeting the threshold the globals set; every network update proven into its anchor's root.
3. **The transaction.** One continuous receipt from the transaction hash to a Directory root that the spine certifies.
4. **The partition anchor** the Directory executed for the transaction's block, proven into the same root; it names
   the block and the partition's state root.
5. **The governing pages** as of that block, each proven into that state root.
6. **The validator set in force**, proven at a certified state root, its chain heights bound, equal to the set the walk
   derived, at the certified block itself or at a later one reached by its own runs.
7. **The Accumulate set root.** `report.accumulateSetRoot` is the `certen:accval:v1` root of the set the spine derived,
   with its accept threshold, under the pin: the value a V8.2 anchor must have committed for the proof to be about this
   set. Each page's chains are reported in `report.pageChains`: bound (with the main chain's height at the anchor's
   block) when captured roots prove against the page's receipt, otherwise named unbound with the capture's reason. Roots
   that are captured but do not bind are refused.

## govRoot v3

govRoot v3 (certen-validator `docs/proof/GOVROOT_V3.md`) is the per-intent commitment every validator signs, built from
a verified report. The facts come from the report; the inputs that are not proof facts (sha256 of each governance
level's canonical v2 JSON, the key page, key book and operation id) travel in the portable proof's `govRootV3Inputs`
block.

```ts
import { verifyPortable, govRootV3FromPortable, govRootV3 } from '@certen.io/proof-verify';

const report = verifyPortable(doc);
const { root, pagesRoot, slots } = govRootV3FromPortable(report, doc); // inputs from doc.govRootV3Inputs
// or, with the inputs supplied separately:
govRootV3(report, doc.evidence.pages, { g0Hash, g1Hash, g2Hash, keyPageUrl, keyBookUrl, operationId });
```

- Ten slots, each `keccak256(tag || ":" || payload)` under `certen:l1:v3` ... `certen:g2:v3`, folded under the 32-byte
  domain `certen:govroot:v3` (`computeGovRootV3`, `govRootV3SlotHash`, `GOVROOT_V3_TAGS`).
- `pagesRoot` commits the proven pages sorted by canonical URL, each with its bound byte and main chain height
  (`pagesRootV3`). The key page and book are committed as `keccak256` of their canonical spelling (`canonicalAccSpelling`,
  `hashUrlString`), Go's exactly: trimmed as `strings.TrimSpace`, lowered one code point at a time as `unicode.ToLower`.
- `accumulateSetRoot(validators, threshold, incarnation)` is the `certen:accval:v1` reduction on its own.

Every refusal is Go's and throws `VerifyError`: a missing or malformed input, any zero slot (the first missing one is
named), a set verdict weaker than `verified`, evidence pages that disagree with the report, a page captured twice, and
no pages at all (`g1_historical_unavailable`).

## How it stays independent

The proof travels as Accumulate's own JSON. This verifier rebuilds each object with
[`accumulate-sdk-opendlt`](https://www.npmjs.com/package/accumulate-sdk-opendlt) and re-encodes it with its own encoder,
so every hash and signature is computed over bytes produced here; a decoding handed in is never trusted, only
reproduced.

The SDK is pinned to exactly **2.5.2**. Its encoder matches the network's in the four places where 2.4.0 did not
(fixed upstream in 2.5.0): an empty struct is written as `0x80` (Go `encoding.EmptyObject`), a key page's transaction
blacklist is Go's bitmask, a zero time is omitted as Go omits it, and a message nested in a `SequencedMessage` is built as its
real class. `test/upstream-encoder.test.ts` asserts each against bytes the Go implementation produced and fails on 2.4.0,
and the conformance suite and the govRoot v3 goldens pin every hash. An encoder change is consensus-critical, so the pin
moves only as a deliberate bump with the conformance suite re-run, never through a range.

## Scope and refusals

- Spine signatures: `ed25519`, `rcd1` and `legacyED25519` are verified, which are the key signatures Go's `KeySignature.Verify` accepts
  for a 32-byte validator key. Any other type is refused by name (`signature_type_unsupported`).
- A proven write to `acc://dn.acme/network` or `acc://dn.acme/globals` is **applied**, as Go's `applyProvenUpdate` does: the
  record is decoded (`src/proof-v2/netrecord.ts`), the set and thresholds the spine tracks change, a definition whose version is
  not above the current one is a counted no-op, and the next anchor is held to the new set (an anchor in the update's own block
  may be signed by the set before it). The binary decoder is checked against vectors Go produced
  (`test/fixtures/netrecords.json`, from certen-validator `cmd/netrecordvectors`) and proves every decode by re-encoding it with
  the SDK's encoder: a record that does not encode back to the written bytes is refused (`network_update_undecodable`).

## Conformance

`test/fixtures/proofv2` holds the conformance suite certen-validator generates (`cmd/proofv2conformance`): a live Kermit
proof and 21 tamper patches. This package and the Go verifier must reach the same verdict on every case, and the same
report on the valid one, govRoot v3 included; the suite also pins the valid case's Accumulate set root to Go's golden. Refresh the fixtures only by copying that generator's output; never edit them by hand.
