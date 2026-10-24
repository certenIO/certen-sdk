# strictbrotli_double_fault1 - the inputs on which the TypeScript strict Brotli reader and the validator's differ (owner decision OQ-R12-BETA-1)

Provenance: the streams `streams/s_<length>.br` are the saved disagreement inputs of the independent audit V-RB12-TS-AUDIT-POSTED (defect D1): raw Brotli streams
that decode for a while and then fail. They are carried byte for byte (sha256 in `test/finality/strictbrotli_double_fault.test.ts`); nothing here was produced by the
TypeScript code. `cases_in.json` lists (id, stream, cap). `cases.json` holds the answers of the Go oracle, the validator at `origin/pv2/rb11-e1-raise` @cbb6373, joined by id from
two generators (`GENERATOR_arbposted.go.txt`, `GENERATOR_baseposted.go.txt`):

- `go.strictbrotli`: `pkg/finality/strictbrotli` `Decompress(stream, cap)`: `exceeded` or `decode` (every stream here fails to decode after a while; none is accepted);
- `go.payload`, `go.payload_exceeded_uncompressed`: `pkg/finality/arbposted` `decodePayload(0x00 || stream, cap, 1<<20)`: `too_large` (the batch bound, `finality_evidence_too_large{uncompressed_batch}`) or `undecodable` (`l1_posted_content_not_found{payload_undecodable}`);
- `go.channel`: `pkg/finality/baseposted` `decompress(0x01 || stream, cap)`: always `err` (`channel_malformed`).

Regenerate (each against a detached checkout of the validator at cbb6373, through tools\pv2gt.ps1 -NoTrimpath): copy `streams/*.br` and `cases_in.json` into a directory D, copy `GENERATOR_arbposted.go.txt`
to `pkg/finality/arbposted/zz_fixposted_doublefault_test.go` and `GENERATOR_baseposted.go.txt` to `pkg/finality/baseposted/zz_fixposted_doublefault_base_test.go`, run
`FP_DF_DIR=D go test ./pkg/finality/arbposted -run TestFixPostedDoubleFault$ -count=1` and `FP_DF_DIR=D go test ./pkg/finality/baseposted -run TestFixPostedDoubleFaultBase$ -count=1`, then join `cases_go.json` and
`cases_go_base.json` by id into the shape of `cases.json`. The 2026-10-24 regeneration reproduced this file byte for byte.

The TypeScript answers are NOT in the fixture: the test asserts them as the current behaviour, titled DOCUMENTED DIVERGENCE, so that a future exact reader or a respec of both verifiers flips them deliberately.
