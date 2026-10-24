# pins_opssync_x: Go-judged supplement for the pins walk rules of RB12-OPS-A1 and the audit corners N-1, N-2, N-3

A TS-held supplement (not a Go-published set): the validator's tests for these rules are Go unit tests, and the TypeScript twins of those
unit tests are `test/finality/pins_opssync_rb12.test.ts` and the `units_*_opssync_rb12.test.ts` files beside the kinds. This set puts the
same rules, and the corners the TS audit found, under verdicts RECORDED FROM GO.

- Oracle: validator `pv2/rb12-ops-a1` at `4c6b8d263d9b37adaf9b346b36eca6bb2cd8ef03` (`pkg/finality` as of OPS-A1: walkKeys with the
  case-fold rule, the sorted loaders of arbfinal and baseposted, `RecordDigests` returning the table-index refusal), toolchain go1.25.1.
- Judge: a throwaway Go test (never committed) that feeds each vector's input to `finality.ParsePinsOverride`, `Pins.Extend` (against the embedded
  file and its embedded links), `arbfinal.LoadPins`, `baseposted.ParsePins`, `basefinal.ParsePins`, `adiri.ParsePins`, `CFA1.RecordDigests` and
  `adiri.VerifyCommitteeChain` (one-by-one) and writes the verdict text. The text format is the contract with `test/finality/opssync_judge.ts`.
- `vectors.json`: `{name, rule, kind, recipe, bytes_sha256, expect}` per vector. A recipe (see `test/finality/opssync_vectors_build.ts`) builds the
  input bytes; `bytes_sha256` is the digest of the bytes Go judged, so a recipe that builds anything else fails before a verdict is compared.
  `expect` is the verdict: `PIN|<canonical state>` when the pins file is refused, `ok|<sha256>|override:<sha256>` when it loads, `ARB|`/`BP|`/`BF|`/
  `AD|` plus a canonical state for a section loader's refusal, `E|` for an extension or a CFA1 refusal, `ok|...` summaries otherwise.
- `MANIFEST.json`: the digest of `vectors.json`, the count and the oracle commit; `MANIFEST.json.sha256`: the digest of the manifest. The test
  recomputes both.

Rule classes: `fold`/`fold_no` (two spellings of one name in an object that is not a struct, and spellings simple folding does NOT join),
`order` and `struct` (the order rule and the struct names, which the case rule must not change), `number_bad`/`number_ok`/`number_order`/
`number_ext` (a number token outside float64 is not_json where the walk reads it), `depth` (Go's 10,000 containers open at once), `logic_pins`/
`logic_pins_one` (arb_sepolia case variants, refused as duplicate_key by the walk), `sorted` and `rows` (the several-defects order of the arbfinal,
baseposted and basefinal loaders), `adiri_index`/`adiri_ok` (the table-index refusal of RecordDigests), `control` (the embedded file).

Published sets are never edited: a rule that changes gets a new set. This one is regenerated, never edited by hand, if the oracle moves.
