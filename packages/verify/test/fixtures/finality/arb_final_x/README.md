# arb_final_x - TS-held supplement for arb-sepolia/finalized/v1 (RB12-TS-ARBFINAL), NOT a Go-published set

Eight synthetic worlds that finality_arb_final1/2/3 do not carry: L1 headers that the light-client spine reader (it reads parent, state root,
number and timestamp) accepts but the framework's positional header reader (parent, state root, transactions root, receipts root, number,
timestamp and, from 17 items, the withdrawals root) refuses. The verifier applies the framework reader to K's header ONLY (headerNumbered skips
a header it cannot read and then does not find K): an odd header at the finalized head, at S, or anywhere else but K is judged, an odd header at K
is finality_block_not_covered{block_number: K, finalized_exec_number: F}.

Provenance: built by a throwaway Go test (never committed) in a detached checkout of validator pv2/rb11-e1-raise@cbb6373 with a six-line hook in
synthworld.header that edits the items of an L1 header before it is encoded; every `expect` literal is the canonical verdict of
arbfinal.New().Verify at cbb6373 on the written bytes (vectors.json is the format of the published sets; `pins/synth.json` is the pins file of the
world, which carries the wallet pins). MANIFEST.json lists the sha256 of every file; it is computed here, not by Go. The Go owner should publish
these worlds as a new set (finality_arb_final4) and this directory then becomes a byte-identical copy of it.
