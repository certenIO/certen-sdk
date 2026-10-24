# base_zlib_fdict1 - Go-judged zlib channels for the Base l1_posted channel reader

`vectors.json` (SHA-256 `132734bd333f83912286356fe17782f4cbbb20965597018cc4d91db357de255f`, asserted by `test/finality/baseposted/vectors_zlibfdict.test.ts`) holds 294 zlib
channels and the answer of the validator's `pkg/finality/baseposted` `decompress` (the function `baseposted.Kind.Verify` reads a channel with) at
`origin/pv2/rb11-e1-raise` @cbb6373, for a cap in the case. `go` is `err` (Go refused the channel, whichever way) or `ok:<output length>:<first 8 bytes of
sha256(output), hex>`. The TypeScript reader (`src/proof-v2/finality/baseposted/channel.ts`) must give the identical answer on every case.

What the set pins: the header of a zlib channel as Go's `zlib.NewReader` (and so op-node) reads it. With FDICT set, the 4-byte dictionary id must be 00000001 (adler32 of the
empty dictionary): every other id, a wrong FCHECK, a cut inside the id, a wrong window or method are refused; FLEVEL carries no meaning; bytes after the stream are ignored. The set
is Go-written data: it is not the Go vector set of the validator and it never replaces one. It is new evidence (TS-FIX-POSTED, audit defect D2), so nothing published moved.

Classes (24 cases each unless stated): `plain`, `fdict1` (FDICT, id 1, FCHECK fixed), `fdict_other_id`, `fdict_id_off_by_one`, `fdict_bad_fcheck`, `fdict_trunc_id`,
`fdict_trunc_any`, `fdict_cmf_window`, `fdict_flevel`, `fdict_flip_after`, `fdict_trailing`, `fdict_id_flip`; `audit_fdict_abc` (2) and `audit_fdict_abc_cap` (4) are the
audit's 15-byte input `7820000000014b4c4a0600024d0127` (Go output "abc"), its id-2 twin, and the cap boundary 0, 2, 3, 4.

Regenerate: copy `GENERATOR.go.txt` to `pkg/finality/baseposted/zz_fixposted_vectors_test.go` in a detached checkout of the validator at cbb6373 and run
`FP_VEC_OUT=<file> go test ./pkg/finality/baseposted -run TestFixPostedVectorGen -count=1` (through tools\pv2gt.ps1 -NoTrimpath). The generator is deterministic (seed 1).
