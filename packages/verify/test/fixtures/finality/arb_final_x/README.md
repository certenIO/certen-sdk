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

## Re-judged at validator origin/main e9aefbf5 (RB12-TS-OPSSYNC-2)

The three worlds whose odd header is at K were finality_block_not_covered at cbb6373. Since RB12-ARBFINAL-FIX an odd header at K, a block that IS on the covered spine,
is finality_block_header_unreadable{block_number K, finalized_exec_number F, reason, index}; the three `expect` literals of vectors.json are now the verdicts of the Go
verifier at origin/main (index 4 / header_item_not_32_bytes, index 5 / header_item_not_32_bytes, index 16 / header_item_is_list), judged by a throwaway Go test over these
bytes. The other five worlds are unchanged. The evidence and the pins file are byte-identical to the Go-published set finality_arb_final4 (same names), which now carries the
published twins of all eight worlds; this directory is kept as the TS-held record of the supplement. MANIFEST.json was recomputed here.
