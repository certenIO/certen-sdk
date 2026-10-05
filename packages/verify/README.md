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
   derived.

## How it stays independent

The proof travels as Accumulate's own JSON. This verifier rebuilds each object with
[`accumulate-sdk-opendlt`](https://www.npmjs.com/package/accumulate-sdk-opendlt) and re-encodes it with its own encoder,
so every hash and signature is computed over bytes produced here; a decoding handed in is never trusted, only
reproduced. Where the SDK's encoding departs from the network's, this package applies the network's rule and a test
pins it to bytes the Go implementation produced:

- an empty struct is written as `0x80` (Go `encoding.EmptyObject`);
- a key page's transaction blacklist is Go's bitmask, not a list;
- a zero time in Go's JSON is omitted, as Go omits it from the binary;
- a message nested in a `SequencedMessage` is built through the message union factory.

The first three would make the SDK's encoding hash differently from the network's. They are SDK defects worth fixing
upstream.

## Scope and refusals

- Only ed25519 signatures are verified; any other type is refused by name.
- A spine containing a proven write to `acc://dn.acme/network` or `acc://dn.acme/globals` is refused by name
  (`network_update_unsupported`), because the written record is binary. The Go verifier applies such writes. No Kermit
  major block carries one.

## Conformance

`test/fixtures/proofv2` holds the conformance suite certen-validator generates (`cmd/proofv2conformance`): a live Kermit
proof and 21 tamper patches. This package and the Go verifier must reach the same verdict on every case, and the same
report on the valid one. Refresh the fixtures only by copying that generator's output; never edit them by hand.
