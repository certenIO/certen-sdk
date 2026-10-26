import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { BlockRef } from '../../../src/proof-v2/finality/evidence.js';
import { Level } from '../../../src/proof-v2/finality/level.js';
import { Registry, type Kind, type Verdict } from '../../../src/proof-v2/finality/registry.js';
import { ChainBaseSepolia } from '../../../src/proof-v2/finality/table.js';
import type { Pins } from '../../../src/proof-v2/finality/pins.js';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { publishedPins } from '../published_pins.js';
import { parseSettlementJSON } from '../../../src/proof-v2/finality/settlementjson.js';
import type { LegSettlement } from '../../../src/proof-v2/finality/docreport.js';
import { registerAllKinds } from '../../../src/proof-v2/finality/allkinds.js';

const here = dirname(fileURLToPath(import.meta.url));

/** test/fixtures/finality/doc_report1: the Go oracle's report of the finality section (cmd/proofverify at cbb6373); README.md says how it was made. */
export const SET = join(here, '..', '..', 'fixtures', 'finality', 'doc_report1');

export const readSet = (...parts: string[]): Buffer => readFileSync(join(SET, ...parts));
export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export interface GoRun {
  exit: number;
  text: string;
}
export interface GoCase {
  id: string;
  family: string;
  doc?: string;
  doc_file?: string;
  settlement: string;
  chain: string;
  registry: 'fake_base' | 'empty' | 'all';
  pins: string;
  kind: string;
  expect_all: GoRun;
  expect_without: GoRun;
}

export const cases = (): GoCase[] => JSON.parse(readSet('cases.json').toString('utf8')).cases as GoCase[];

export const docOf = (c: GoCase): string => (c.doc !== undefined ? c.doc : c.doc_file !== undefined ? gunzipSync(readSet(c.doc_file)).toString('utf8') : '');

/** finalitytest's fakeKind (cmd/proofverify/finality_test.go): accepts any container the dispatcher let through and answers its own level and name. */
class FakeKind implements Kind {
  constructor(
    private readonly c: bigint,
    private readonly n: string,
    private readonly l: Level,
  ) {}
  name(): string {
    return this.n;
  }
  chain(): bigint {
    return this.c;
  }
  level(): Level {
    return this.l;
  }
  verify(_p: Pins | null, _b: BlockRef, _evidence: Uint8Array): Verdict {
    return { level: this.l, kind: this.n, fields: {} };
  }
}

export function fakeBaseRegistry(): Registry {
  const reg = new Registry();
  reg.registerKind(new FakeKind(ChainBaseSepolia, 'base-sepolia/l1_posted/v1', Level.L1Posted));
  reg.registerKind(new FakeKind(ChainBaseSepolia, 'base-sepolia/finalized/v1', Level.Finalized));
  return reg;
}

let allRegistry: Promise<Registry> | undefined;
/** Every Kind this TypeScript verifier has (registerAllKinds under the embedded pins), registered once for the file. */
export function allKindsRegistry(): Promise<Registry> {
  allRegistry ??= (async () => {
    const reg = new Registry();
    await registerAllKinds(reg, publishedPins());
    return reg;
  })();
  return allRegistry;
}

export const pinsNamed = (name: string): Pins => (name === 'embedded' ? publishedPins() : parsePinsOverride(readSet('pins', `${name}.json`)));

/** A recorded Settlement of settlements/<name>.json ({name, chain, settlement}): the inner object read by the Go-faithful reader. */
export function legSettlement(name: string, chain: bigint, source = 'test'): LegSettlement {
  const file = JSON.parse(readSet('settlements', `${name}.json`).toString('utf8')) as { settlement: unknown };
  return { chain, settlement: parseSettlementJSON(JSON.stringify(file.settlement)), source };
}

/** What differs between Go's report text and this one by construction: how the caller is told to name a Settlement. */
export const goText = (t: string): string => t.replace('(name the Settlement: --outcome-file, or --proof-id with --db)', '(name the Settlement: FinalityOptions.settlement)');

/** The JSON error prose of encoding/json is Go's own; the class of the refusal and its place in the report are what is compared. */
export const withoutJsonProse = (t: string): string => t.replace(/(not a portable document: ).*\n/, '$1<json error>\n');

/**
 * finality_included_invalid is a go_operational state (states.json): its `cause` is the prose of Go's ethproof / go-ethereum errors, which carries values (hashes, rlp
 * error text) this verifier words its own way. The code and every other field are compared; the cause is compared as present.
 */
export const withoutCauseProse = (t: string): string => t.replace(/(finality_included_invalid\{cause=)"(?:[^"\\]|\\.)*"/g, '$1<prose>');

/** The label of the Settlement a Go case printed (the report echoes the caller's label: a file path in Go, whatever the caller passes here). */
export const sourceOf = (goReport: string): string => /^ {2}S7 {2}Settlement source: (.*)$/m.exec(goReport)?.[1] ?? 'test';

export const comparable = (t: string): string => withoutCauseProse(withoutJsonProse(t));
