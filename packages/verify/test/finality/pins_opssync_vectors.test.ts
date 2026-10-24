/**
 * RB12-TS-OPSSYNC: the supplement set test/fixtures/finality/pins_opssync_x. Every vector's input was judged by the Go code at validator
 * origin/pv2/rb12-ops-a1 @4c6b8d26 (the verdict text is recorded in `expect`); this test builds the same input bytes from the vector's recipe,
 * checks them against the recorded SHA-256, and requires the TypeScript judge's verdict to be identical, text for text. The set is a TS-held
 * supplement, not a Go-published vector set: Go's own tests for these rules (pins_det_rb12_test.go and the others) are unit tests, ported in
 * pins_opssync_rb12.test.ts and the units_*_opssync_rb12.test.ts files; the vectors here put the same rules, and the corners the audit found,
 * under verdicts recorded from Go rather than stated by the TS tests.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { judge } from './opssync_judge.js';
import { buildBytes, type Recipe } from './opssync_vectors_build.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'finality', 'pins_opssync_x');
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
interface Vector {
  name: string;
  rule: string;
  kind: string;
  recipe: Recipe;
  bytes_sha256?: string;
  expect: string;
}
const text = readFileSync(join(dir, 'vectors.json'), 'utf8');
const doc = JSON.parse(text) as { format: string; oracle: { commit: string; toolchain: string }; vectors: Vector[] };
const manifestText = readFileSync(join(dir, 'MANIFEST.json'), 'utf8');
const manifest = JSON.parse(manifestText) as { count: number; vectors_sha256: string; oracle_commit: string };

describe('pins_opssync_x: the manifest', () => {
  it('names the digest of vectors.json, the count and the Go commit the verdicts were recorded at; the manifest has its own digest file', () => {
    expect(sha(text)).toBe(manifest.vectors_sha256);
    expect(manifest.count).toBe(doc.vectors.length);
    expect(manifest.oracle_commit).toBe('4c6b8d263d9b37adaf9b346b36eca6bb2cd8ef03');
    expect(doc.oracle.commit).toBe(manifest.oracle_commit);
    expect(doc.format).toBe('certen-pins-opssync-x/1');
    expect(readFileSync(join(dir, 'MANIFEST.json.sha256'), 'utf8').trim()).toBe(sha(manifestText));
  });

  it('is large enough to reach every rule: names are unique and every rule class and kind is present', () => {
    expect(new Set(doc.vectors.map((v) => v.name)).size).toBe(doc.vectors.length);
    expect(doc.vectors.length).toBeGreaterThanOrEqual(200);
    const rules = new Set(doc.vectors.map((v) => v.rule));
    for (const r of ['fold', 'fold_no', 'order', 'struct', 'number_bad', 'number_ok', 'number_order', 'number_ext', 'depth', 'logic_pins', 'logic_pins_one', 'sorted', 'rows', 'adiri_index', 'adiri_ok', 'control']) {
      expect(rules.has(r), r).toBe(true);
    }
    const kinds = new Set(doc.vectors.map((v) => v.kind));
    for (const k of ['pins', 'ext', 'arb', 'bp', 'bf', 'ad', 'adig', 'advcc']) expect(kinds.has(k), k).toBe(true);
    // the verdicts are not all one answer
    expect(new Set(doc.vectors.map((v) => v.expect.replace(/[0-9a-f]{40,}/g, '<hex>'))).size).toBeGreaterThan(80);
  });
});

describe('pins_opssync_x: the TypeScript verdict of every vector is the verdict Go recorded', () => {
  doc.vectors.forEach((v, i) => {
    it(`${String(i).padStart(3, '0')} ${v.name}`, () => {
      const bytes = buildBytes(v.recipe);
      if (v.bytes_sha256 !== undefined) {
        // the recipe must build the bytes Go judged
        expect(bytes, 'recipe').toBeDefined();
        expect(sha(bytes!)).toBe(v.bytes_sha256);
      }
      const got =
        'chain' in v.recipe
          ? judge({ id: v.name, kind: v.kind, tables: v.recipe.chain.tables, records: v.recipe.chain.records })
          : judge({ id: v.name, kind: v.kind, b64: Buffer.from(bytes!).toString('base64') });
      expect(got).toBe(v.expect);
    });
  });
});
