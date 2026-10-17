import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { judge, manifest as manifestV1, readFixture, type Manifest, type Vector } from './helpers/sigtypes.js';

/**
 * The live Kermit-delivered vectors (RB8-D): ten real intents signed with each accepted key type plus a delegated ECDSA case,
 * and their wrong-page and before-activation twins. Go wrote them (validator govsig/testdata/sigtypes/kermit2.json, manifest2.json);
 * these are byte-identical copies and every vector must reach Go's verdict, key hash and digest form.
 */
const MANIFEST2_HASH = '46cce1d927632dc06d11e0288c3a3c74e981bc2834e0ed70f1b62be3b4d94866';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const manifest2 = JSON.parse(readFixture('manifest2.json').toString('utf8')) as Manifest;

describe('manifest2 (live vectors) extends manifest 1 without moving it', () => {
  it('pins every file and the manifest hash this suite was written against', () => {
    for (const f of manifest2.files) expect(sha(readFixture(f.name)), f.name).toBe(f.sha256);
    const h = createHash('sha256');
    for (const f of manifest2.files) h.update(`${f.name}:${f.sha256}\n`);
    expect(h.digest('hex')).toBe(manifest2.manifestHash);
    expect(manifest2.manifestHash).toBe(MANIFEST2_HASH);
  });

  it('carries every manifest-1 file with the same hash and adds only kermit2.json', () => {
    const v1 = new Map(manifestV1.files.map((f) => [f.name, f.sha256]));
    for (const [name, h] of v1) expect(manifest2.files.find((f) => f.name === name)?.sha256, name).toBe(h);
    expect(manifest2.files.map((f) => f.name).filter((n) => !v1.has(n))).toEqual(['kermit2.json']);
    expect(manifest2.vectors).toBe(manifestV1.vectors + 25);
  });
});

const live = (JSON.parse(readFixture('kermit2.json').toString('utf8')) as { vectors: Vector[] }).vectors;

describe('every live vector reaches Go\'s verdict, key hash and digest form', () => {
  it('has the 25 vectors the manifest counts', () => {
    expect(live.length).toBe(25);
    expect(new Set(live.map((v) => v.id)).size).toBe(25);
  });
  for (const v of live) {
    it(`${v.id} -> ${v.expect.verdict}`, () => {
      const got = judge(v);
      expect(got.verdict, `${v.description}${got.error instanceof Error ? ` :: ${got.error.message}` : ''}`).toBe(v.expect.verdict);
      if (v.expect.verdict === 'accepted') {
        expect(got.keyHash).toBe(v.expect.keyHash!.toLowerCase());
        expect(got.form).toBe(v.expect.form);
        expect(got.ethRule).toBe(v.expect.ethRule ?? '');
        expect(got.innerType).toBe(v.expect.innerType ?? v.type);
        expect(got.delegators).toEqual(v.expect.delegators ?? []);
      }
    });
  }
});
