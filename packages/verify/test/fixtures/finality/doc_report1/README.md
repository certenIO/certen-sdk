# doc_report1 - the Go report of a portable document's finality section (RB12-TS-SURFACE)

What `cmd/proofverify` of the validator (`origin/pv2/rb11-e1-raise` @ cbb6373) prints for `reportFinalityFile` (the `--finality-file` path) and for
`printReport`, recorded so that the TypeScript twin (`src/proof-v2/finality/docreport.ts`) can be held to the same text, headline and exit code on every case.
The Go tests that judge a document build their inputs in code (`cmd/proofverify/finality_test.go`) or read recorded Settlements
(`cmd/proofverify/testdata/finality_e2e_pos1`, the leg blocks of the published vector sets); this set is the output of running those same builders and recording
what the report said. It is TEST DATA, not a golden: no hashed input of any proof depends on it.

| file | content |
|---|---|
| `cases.json` | 51 cases: `doc` (the document text, or `doc_file` a gzip of it), `settlement` (name of `settlements/<name>.json`, "" = none), `chain`, `registry`, `pins`, `kind`, and Go's `exit` and `text` |
| `synthetic.json` | 19 `finality.Report` values (the ten classes of `finality_pins_class_test.go` and every other branch of `printReport`) with Go's exit and text |
| `settlements/` | the recorded `ethproof.Settlement` of each leg (9 byte-identical copies of `finality_e2e_pos1` files, the Base and Adiri fixtures of `finalitytest`, the Settlement the outcome-evidence reader derives, and two derived variants: chain 1, a flipped tx hash) |
| `pins/` | the pins file each real leg is judged under, byte for byte as Go parsed it (the Base posted files carry the Granite pair the harness supplies) |
| `docs/` | the large documents (real evidence), gzipped without a name or time |
| `generator.go.txt` | the Go test that produced this directory (it lives uncommitted in a detached validator worktree; run `SURFACE_OUT=<dir> pv2gt.ps1 -Pkg ./cmd/proofverify -Run '^TestZZSurfaceGen$' -NoTrimpath`) |

Registries: `fake_base` = the fake kinds of `finality_test.go` (base-sepolia l1_posted and finalized accept any container the dispatcher lets through),
`empty` = no kind, `all` = `allkinds.Register`. For a real leg `expect_all` is the report of a registry holding every Go kind and `expect_without` the report of a
registry that lacks `arb-sepolia/finalized/v1` and `eth-sepolia/finalized/v1`: the two kinds the TypeScript verifier has no port of at this base.

Two lines of text differ from Go's by construction, both about HOW a caller names the Settlement (a command line flag there, an option here): the hint at the end of
the "no Settlement" report, and (not present in any case here) the note that a call registered no Kind. The `not a portable document: <json error>` prose is encoding/json's
own and is compared by class only.

## The Settlement reader probe

`settlement_probe.json` is 261 hand-made Settlement JSON texts (`probe_cases.mjs.txt` builds them from `settlements/base_sepolia_47368146.json`) with what `json.Unmarshal` into
`*ethproof.Settlement` and `finality.DeriveIncluded` made of each in Go (`probe_generator.go.txt`, a detached validator worktree at cbb6373): whether it decoded, whether the result is nil,
whether the Settlement verifies, and the named state when it does not. `src/proof-v2/finality/settlementjson.ts` must reach the same four answers for every text.
