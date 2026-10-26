/**
 * The parity oracle of finality_base_posted5 (validator pv2/rb12-eps-denim@c05fe30d, RB11-D-POST): real post-Denim Base Sepolia legs whose five-block
 * timestamp seconds the timestamp-keyed lookup could not tell apart. The directory is a byte-identical copy of the Go set; every one of its 14 cases is
 * judged by the TypeScript kind under the pins file the case names (as given, nothing supplied) and compared with the Go-written expectation byte for
 * byte. The pre-Denim set 1 is judged once more here under pins that carry the post_denim row.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BasePostedKind } from '../../../src/proof-v2/finality/baseposted/index.js';
import { PINS_SHA256, embeddedPinsBytes, parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { applySplice, bytesOfHex, canonicalOutcome, expectedOf, readPins, read as readSet1, loadCase as loadSet1Case, sha256Hex, type Case } from './vectorset.js';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', '..', 'fixtures', 'finality', 'base_posted5');
const rd = (name: string): Buffer => readFileSync(join(DIR, ...name.split('/')));
const MANIFEST_SHA256 = '92af277000027f20d936ff265b8a849c43efd707c1c8c95d89cfe0e69fe04d47';
const GO_PINS_SHA256 = '9f4fc10feca95909272c9f6eaef1a38d7a06110cfead0a88cb79e8ffd7a3d1cf';

const manifest = JSON.parse(rd('manifest.json').toString('utf8')) as { set: string; format: string; pins_sha256_embedded: string; cases: string[]; files: Record<string, string> };

/** The pins loader requires keys sorted at every depth (Go's json.MarshalIndent of a map gives that). */
const sorted = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sorted)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
      : v;

function judge(c: Case, pinsBytes: Uint8Array, base: (name: string) => Buffer): string {
  return canonicalOutcome(() => {
    const leg = JSON.parse(base(c.leg).toString('utf8')) as { chain: string; number: string; hash: string; header: string };
    const ev = applySplice(base(c.evidence), c.splice);
    return new BasePostedKind().verify(parsePinsOverride(pinsBytes), { chain: BigInt(leg.chain), number: BigInt(leg.number), hash: bytesOfHex(leg.hash), headerRlp: bytesOfHex(leg.header) }, ev);
  });
}

describe('finality_base_posted5 identity', () => {
  it('manifest.json is the Go-written one, hashes every file, and the set directory holds nothing else', () => {
    expect(sha256Hex(rd('manifest.json'))).toBe(MANIFEST_SHA256);
    expect(rd('MANIFEST.sha256').toString('utf8').trim()).toBe(MANIFEST_SHA256);
    expect(manifest.set).toBe('finality_base_posted5');
    expect(manifest.format).toBe('certen-base-posted-vectors/1');
    expect(manifest.cases.length).toBe(14);
    for (const [f, want] of Object.entries(manifest.files)) expect(sha256Hex(rd(f)), f).toBe(want);
    const onDisk: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), rel === '' ? e.name : `${rel}/${e.name}`);
        else onDisk.push(rel === '' ? e.name : `${rel}/${e.name}`);
      }
    };
    walk(DIR, '');
    expect(onDisk.sort()).toEqual([...Object.keys(manifest.files), '.gitattributes', 'MANIFEST.sha256', 'manifest.json'].sort());
  });
  it('was judged under the pins this verifier embeds, and pins/main.json carries its base_sepolia section in value', () => {
    expect(manifest.pins_sha256_embedded).toBe(GO_PINS_SHA256);
    expect(PINS_SHA256).toBe(GO_PINS_SHA256);
    const emb = JSON.parse(Buffer.from(embeddedPinsBytes()).toString('utf8')) as { base_sepolia: Record<string, unknown> };
    const set = JSON.parse(rd('pins/main.json').toString('utf8')) as { base_sepolia: Record<string, unknown> };
    expect(set.base_sepolia).toEqual(emb.base_sepolia);
    expect(emb.base_sepolia.post_denim).toBeDefined();
  });
});

describe('finality_base_posted5 cases: Go and TypeScript agree on every verdict', () => {
  let ok = 0;
  let refused = 0;
  for (const id of manifest.cases) {
    it(id, () => {
      const c = JSON.parse(rd(`cases/${id}.json`).toString('utf8')) as Case;
      expect(c.id).toBe(id);
      expect(judge(c, rd(c.pins), rd)).toBe(expectedOf(c));
      if (c.expect.result === 'ok') ok++;
      else refused++;
    }, 300_000);
  }
  it('covers six accepted and eight refused cases', () => {
    expect([ok, refused]).toEqual([6, 8]);
  });
});

describe('finality_base_posted1 (pre-Denim) is judged as published under pins that carry the post_denim row', () => {
  const row = (JSON.parse(Buffer.from(embeddedPinsBytes()).toString('utf8')) as { base_sepolia: { post_denim: unknown } }).base_sepolia.post_denim;
  for (const id of ['valid_a', 'valid_b', 'valid_a_denim_after_block', 'batch_not_found_for_timestamp', 'leg_parent_hash_altered', 'deposit_epoch_number_altered']) {
    it(id, () => {
      const c = loadSet1Case(id);
      const pins = JSON.parse(readPins(c.pins).toString('utf8')) as { base_sepolia: Record<string, unknown> };
      pins.base_sepolia.post_denim = row;
      const bytes = new TextEncoder().encode(JSON.stringify(sorted(pins), null, 2));
      expect(judge(c, bytes, readSet1)).toBe(expectedOf(c));
    }, 300_000);
  }
});
