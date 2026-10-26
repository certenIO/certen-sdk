/**
 * The recipes of the Go-judged supplement set test/fixtures/finality/pins_opssync_x: how a vector's input bytes are built. A recipe is
 * data (JSON); the recorded `bytes_sha256` of the bytes it builds is what Go judged, so a recipe this file reads differently, or a nesting
 * of another depth, fails on the hash before any verdict is compared.
 *
 *   doc    the text of a whole pins file, as written
 *   mini   the smallest file around one section: {section, body}
 *   edits  the embedded pins file with edits applied to its parsed tree and re-serialized (sorted keys at every depth, two-space indent, LF)
 *   nest   the embedded file with a value nested `total` containers deep (total = containers open at the deepest point, Go's json.Valid limit
 *          is 10,000) as the first member of a section, or as the value at `where`
 *   root   a document that is nothing but `total` nested arrays
 *   chain  adig / advcc: the tables (keys per table) and records (committee, next table index) of a hand-built CFA1
 */
import { cmpUtf8 } from '../../src/proof-v2/finality/state.js';
import { publishedPinsBytes as embeddedPinsBytes } from './published_pins.js';

export type Recipe =
  | { doc: string }
  | { mini: { section: string; body: string } }
  | { edits: { path: string[]; set?: unknown; delete?: boolean }[] }
  | { nest: { section: string; kind: 'a' | 'o'; total: number } }
  | { root: number }
  | { chain: { tables: number[]; records: [number, number][] } };

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort(cmpUtf8)
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : v;

export const miniDoc = (section: string, body: string): string =>
  `{\n  "${section}": ${body},\n  "format": "certen-finality-pins/1",\n  "published_utc": "2026-10-23T00:00:00Z"\n}\n`;

export const nested = (kind: 'a' | 'o', depth: number): string => (kind === 'a' ? '['.repeat(depth) + ']'.repeat(depth) : '{"a":'.repeat(depth) + '1' + '}'.repeat(depth));

/** The bytes of a pins document recipe; undefined for a chain recipe. */
export function buildBytes(r: Recipe): Uint8Array | undefined {
  if ('doc' in r) return enc(r.doc);
  if ('mini' in r) return enc(miniDoc(r.mini.section, r.mini.body));
  if ('edits' in r) {
    const doc = JSON.parse(new TextDecoder().decode(embeddedPinsBytes()));
    for (const e of r.edits) {
      let cur = doc;
      for (const k of e.path.slice(0, -1)) cur = cur[k];
      const last = e.path[e.path.length - 1]!;
      if (e.delete) delete cur[last];
      else cur[last] = e.set;
    }
    return enc(`${JSON.stringify(sortKeys(doc), null, 2)}\n`);
  }
  if ('nest' in r) {
    const text = new TextDecoder().decode(embeddedPinsBytes());
    return enc(text.replace(`"${r.nest.section}": {`, `"${r.nest.section}": {\n    "0aaa": ${nested(r.nest.kind, r.nest.total - 2)},`));
  }
  if ('root' in r) return enc(nested('a', r.root));
  return undefined;
}
