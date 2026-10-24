/**
 * The pinned identity of the copied eth-sepolia vector sets (RB12-TS-FIX-ARBSEP, audit N-4; the twin of test/finality/arbfinal/vectors_meta): the
 * three manifests recompute to the Go-written MANIFEST.json.sha256 and the pinned values, every file the manifest lists is byte-identical to its
 * recorded sha256, no file of the set directory is outside the manifest except the three that Go keeps outside it, every case the manifest names has
 * its case file, and the counts are the published ones (set 1: 37 verification + 9 Pins.Extend cases, set 2: 9, set 3: 16 ledger + 5 lcssz). The
 * embedded root-pin bootstrap is byte-identical to the pins-links fixture.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMBEDDED_LINKS_BASE64 } from '../../../src/proof-v2/finality/pins-links-embedded.js';
import { FIXTURES, MANIFEST_SHA256, extendIds, manifest, read, sha256Hex, verifyIds, type SetName } from './vectorset.js';

const SETS = Object.keys(MANIFEST_SHA256) as SetName[];
const COUNTS: Record<SetName, { verify: number; extend: number; ledger: number; lcssz: number; files: number; cases: number }> = {
  eth_sepolia1: { verify: 37, extend: 9, ledger: 0, lcssz: 0, files: 89, cases: 46 },
  eth_sepolia2: { verify: 9, extend: 0, ledger: 0, lcssz: 0, files: 35, cases: 9 },
  eth_sepolia3: { verify: 0, extend: 0, ledger: 16, lcssz: 5, files: 39, cases: 21 },
};
const OUTSIDE_MANIFEST = ['MANIFEST.json', 'MANIFEST.json.sha256', 'README.md'];

const filesOnDisk = (set: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(FIXTURES, set, rel), { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk('');
  return out.sort();
};

describe.each(SETS)('%s identity', (set) => {
  it('MANIFEST.json hashes to the Go-written MANIFEST.json.sha256 and the pinned value', () => {
    expect(sha256Hex(read(set, 'MANIFEST.json'))).toBe(MANIFEST_SHA256[set]);
    expect(read(set, 'MANIFEST.json.sha256').toString('utf8').trim()).toBe(MANIFEST_SHA256[set]);
  });

  it('every file the manifest lists exists and hashes to its recorded sha256; the manifest lists exactly the files of the directory but the three Go keeps outside it', () => {
    const m = manifest(set);
    const listed = Object.keys(m.files);
    expect(listed.length).toBe(COUNTS[set].files);
    for (const f of listed) expect(sha256Hex(read(set, f)), `${set}/${f}`).toBe(m.files[f]);
    const disk = filesOnDisk(set);
    expect(disk.filter((f) => !(f in m.files)).sort()).toEqual(OUTSIDE_MANIFEST);
    expect(listed.filter((f) => !disk.includes(f))).toEqual([]);
    for (const h of Object.values(m.files)) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names its format and set, lists each case once, and every case has its case file in the manifest', () => {
    const m = manifest(set);
    expect(m.format).toBe('certen-finality-manifest/1');
    expect(m.set).toBe(`finality_${set}`);
    expect(m.cases.length).toBe(COUNTS[set].cases);
    expect(new Set(m.cases).size).toBe(m.cases.length);
    for (const id of m.cases) {
      const owners = ['cases', 'extend', 'ledger', 'lcssz'].filter((d) => `${d}/${id}.json` in m.files);
      expect(owners.length, `${set} case ${id}`).toBe(1);
    }
  });

  it(`holds the published case counts`, () => {
    const c = COUNTS[set];
    const files = Object.keys(manifest(set).files);
    expect(verifyIds(set).length).toBe(c.verify);
    expect(extendIds(set).length).toBe(c.extend);
    expect(files.filter((f) => f.startsWith('ledger/')).length).toBe(c.ledger);
    expect(files.filter((f) => f.startsWith('lcssz/')).length).toBe(c.lcssz);
    expect(files.filter((f) => f.startsWith('cases/')).length).toBe(c.verify);
  });
});

describe('the pins-links fixture and the embedded root-pin bootstrap', () => {
  it('eth_sepolia_pins_links/1378.ssz is the root anchor link (sha256 e55bc5ef...c81d, 25,679 bytes) and is byte-identical to the embedded copy', () => {
    const f = readFileSync(join(FIXTURES, 'eth_sepolia_pins_links', '1378.ssz'));
    expect(f.length).toBe(25679);
    expect(sha256Hex(f)).toBe('e55bc5ef6ede9cf7b1f09ba302d1723001bd03268672f2dd4875c8c38889c81d');
    expect(filesOnDisk('eth_sepolia_pins_links')).toEqual(['1378.ssz']);
    expect(Object.keys(EMBEDDED_LINKS_BASE64)).toEqual(['1378']);
    expect(Buffer.from(EMBEDDED_LINKS_BASE64['1378']!, 'base64').equals(f)).toBe(true);
  });
});
