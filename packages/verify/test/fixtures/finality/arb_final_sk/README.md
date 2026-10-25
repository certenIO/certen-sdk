# arb_final_sk - TS-held supplement for arb-sepolia/finalized/v1 (RB12-TS-FIX-ARBSEP), NOT a Go-published set

Sixteen synthetic worlds that finality_arb_final1/2/3 cannot carry because Go's synthworld builds the Rollup storage at S and at K from one
Parts value: here the Rollup storage at S DIFFERS from the storage at K. The verifier reads the assertion node and the parent's ConfigData under
S's Rollup storage root and the anyTrustFastConfirmer slot (wallet route only) under K's; the worlds pin each read from both sides (a value right
at S and wrong at K, wrong at S and right at K, absent at one, a fast confirmer at one, at both, a pending node together with a fast confirmer).

Provenance: built by a throwaway Go test (never committed) in a detached checkout of validator pv2/rb11-e1-raise@cbb6373 with a throwaway hook in
synthworld (FastS/FastK, StatusS/StatusK, CfgS/CfgK: the fast confirmer address, the node status and the ConfigData word of the Rollup storage at
S and at K when they differ); every `expect` literal is the canonical verdict of arbfinal.New().Verify at cbb6373 on the written bytes
(vectors.json is the format of the published sets; `pins/synth.json` is the pins file of the worlds, byte-identical to arb_final_x's, and carries
the wallet pins). MANIFEST.json lists the sha256 of every file; it is computed here, not by Go. The Go owner should publish these worlds (and add the
S != K capability to synthworld) as a new set, and this directory then becomes a byte-identical copy of it. The hand-built TS twins of the same
scenarios are test/finality/arbfinal/units_sk.test.ts.

## Re-judged at validator origin/main e9aefbf5 (RB12-TS-OPSSYNC-2)

All 16 worlds were judged again by the Go verifier at origin/main (a throwaway Go test over these bytes): every verdict equals its recorded literal. Nothing in this set has an odd
header at K, so finality_block_header_unreadable does not reach it. The set is unchanged.
