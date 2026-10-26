/**
 * The package entry gains exactly one name, `finality`, and a document with no finality member and no option is verified byte for byte as it was at the base
 * commit (the stored-proof rule): test/fixtures/finality/surface_base/captured_at_d7ca45b.json holds the export list of the entry and the SHA-256 of what
 * verifyProofDocument and verifyPortable returned for the conformance document and every tampered case, captured at d7ca45b before any change of this branch.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as entry from '../../../src/index.js';
import * as barrel from '../../../src/proof-v2/finality/index.js';

const captured = JSON.parse(readFileSync(new URL('../../fixtures/finality/surface_base/captured_at_d7ca45b.json', import.meta.url), 'utf8')) as {
  rows: { name: string; verification: string; portable: string }[];
  exports: string[];
};
const dir = new URL('../../fixtures/proofv2/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
const base = gunzipSync(readFileSync(new URL(manifest.base, dir))).toString('utf8');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function applyPatch(doc: any, ops: any[]): void {
  for (const op of ops ?? []) {
    let cur = doc;
    op.path.forEach((k: string | number, i: number) => {
      if (i === op.path.length - 1) {
        if (op.delete) delete cur[k];
        else if (op.truncate !== undefined) cur[k] = cur[k].slice(0, op.truncate);
        else cur[k] = op.set;
      }
      cur = cur[k];
    });
  }
}
const docFor = (name: string): unknown => {
  const doc = JSON.parse(base);
  if (name !== 'valid') applyPatch(doc, manifest.cases.find((c: { name: string }) => c.name === name).patch);
  return doc;
};

describe('the public entry', () => {
  it('adds exactly the names `finality` and `identity` (the S8 contract-identity namespace) to the 171 names it exported at the base commit', () => {
    expect(captured.exports.length).toBe(171);
    expect(captured.exports).not.toContain('finality');
    expect(captured.exports).not.toContain('identity');
    expect(Object.keys(entry).sort()).toEqual([...captured.exports, 'finality', 'identity'].sort());
  });

  it('exposes the finality barrel as one namespace, with registerAllKinds and embeddedPins reachable through it', () => {
    expect(Object.keys(entry.finality).sort()).toEqual(Object.keys(barrel).sort());
    expect(typeof entry.finality.registerAllKinds).toBe('function');
    expect(typeof entry.finality.embeddedPins).toBe('function');
    expect(entry.finality.registerAllKinds).toBe(barrel.registerAllKinds);
    for (const ns of ['adiri', 'arbposted', 'basefinal', 'baseposted', 'ethl1']) expect(typeof (entry.finality as Record<string, unknown>)[ns], ns).toBe('object');
    for (const name of ['judgeFinalityText', 'judgeFinalityDocument', 'renderReport', 'parseSettlementJSON', 'registerKinds', 'verifyProofDocumentWithKinds', 'verifyPortableWithKinds']) {
      expect(typeof (entry.finality as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('keeps every name the entry exported before, with the value the base commit gave it', () => {
    for (const name of captured.exports) expect(name in entry, name).toBe(true);
    expect(entry.PORTABLE_FORMAT).toBe('certen-proof-v2-accumulate-portable/1');
    expect(typeof entry.verifyPortable).toBe('function');
    expect(typeof entry.verifyProofDocument).toBe('function');
  });
});

describe('a document with no finality member and no option is verified as it was at the base commit', () => {
  it('verifyProofDocument and verifyPortable return byte-identical results for the conformance document and every tampered case', () => {
    expect(captured.rows.length).toBe(22);
    for (const row of captured.rows) {
      const doc = docFor(row.name);
      const v = entry.verifyProofDocument(doc);
      expect(v.finality, row.name).toBeUndefined();
      expect(v.layers.some((l) => l.id === 'S7'), row.name).toBe(false);
      expect(sha(JSON.stringify(v)), row.name).toBe(row.verification);
      let portable: string;
      try {
        const r = entry.verifyPortable(doc);
        expect(r.finality, row.name).toBeUndefined();
        portable = `REPORT:${sha(JSON.stringify(r))}`;
      } catch (e) {
        portable = `THROWS:${(e as Error).message}`;
      }
      expect(portable, row.name).toBe(row.portable);
    }
  }, 300_000);

  it('the asynchronous entries do not change them either', async () => {
    for (const row of captured.rows.filter((r) => ['valid', 'tx-swap', 'pin-other'].includes(r.name))) {
      const v = await entry.finality.verifyProofDocumentWithKinds(docFor(row.name));
      expect(sha(JSON.stringify(v)), row.name).toBe(row.verification);
    }
    const valid = captured.rows.find((r) => r.name === 'valid')!;
    expect(`REPORT:${sha(JSON.stringify(await entry.finality.verifyPortableWithKinds(docFor('valid'))))}`).toBe(valid.portable);
  }, 300_000);
});
