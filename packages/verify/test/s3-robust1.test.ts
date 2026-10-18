import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NamedState, verifyPortableAny } from '../src/s3/index.js';
import { sha256hex } from './helpers/s3.js';

/**
 * robust1 (RB9-L, validator a5499e2, pkg/proof/v2/testdata/robust1): 18 documents each built to make a verifier that trusts its input fail
 * with a panic (Go) or a TypeError (a port) instead of a refusal - a null account, a null member of a record Accumulate's codec decodes,
 * a major-block count of zero, a null receipt step, two defective anchors in key order. The files are byte-identical copies written by Go
 * (tools/sync-s3-fixtures.mjs), pinned by MANIFEST.json. Each must be refused as Go refuses it - plain, or by the state Go names with the
 * partition and block it was judged at (the wording is Go's and is not compared, as in every other shared-vector suite); and the TypeScript verifier must never answer with a TypeError, RangeError or any
 * other fault that is not one of its own refusals.
 */
const dir = new URL('./fixtures/s3-rb9l/', import.meta.url);
const read = (name: string): Buffer => readFileSync(new URL(name, dir));
interface Case {
  name: string;
  file: string;
  sha256: string;
  expect: 'refused' | 'verified';
  state?: string;
  partition?: string;
  block?: number;
  prefix?: string;
}
interface Mfst {
  format: string;
  validatorCommit?: string;
  suites: { name: string; files: { name: string; sha256: string; bytes: number }[]; manifestSha256: string }[];
  goldens: unknown[];
  manifestHash: string;
}
const MANIFEST = JSON.parse(read('MANIFEST.json').toString('utf8')) as Mfst;
const suite = JSON.parse(read('robust1/manifest.json').toString('utf8')) as { format: string; domain: string; portableFormat: string; cases: Case[] };
const SUITE_MANIFEST_SHA256 = '758ca82a4069ddb3c09206259fd3683f0da170cb462ae7a56f0dfc50663fa4aa';

describe('robust1: the shared vectors are the ones Go wrote', () => {
  it('every file hashes to what the manifest pins and the suite to the hash Go states (MANIFEST.sha256)', () => {
    expect(MANIFEST.format).toBe('certen:s3-vectors-manifest:v1');
    const h = createHash('sha256');
    for (const s of MANIFEST.suites) {
      for (const f of s.files) {
        const bytes = read(`${s.name}/${f.name}`);
        expect(sha256hex(bytes), f.name).toBe(f.sha256);
        expect(bytes.length, f.name).toBe(f.bytes);
        h.update(`${s.name}/${f.name}:${f.sha256}\n`);
      }
    }
    expect(h.digest('hex')).toBe(MANIFEST.manifestHash);
    expect(MANIFEST.suites.map((s) => s.name)).toEqual(['robust1']);
    expect(MANIFEST.suites[0]!.manifestSha256).toBe(SUITE_MANIFEST_SHA256);
    const manifest = read('robust1/manifest.json');
    expect(sha256hex(manifest)).toBe(SUITE_MANIFEST_SHA256);
    expect(read('robust1/MANIFEST.sha256').toString('utf8').startsWith(`${SUITE_MANIFEST_SHA256}  manifest.json`)).toBe(true);
  });

  it('has the 18 documents of the suite, every one a refusal', () => {
    expect(suite.format).toBe('certen-robust1-conformance/1');
    expect(suite.domain).toBe('certen:g1:v4');
    expect(suite.portableFormat).toBe('certen-proof-v2-accumulate-portable/1');
    expect(suite.cases.length).toBe(18);
    expect(new Set(suite.cases.map((c) => c.file)).size).toBe(18);
    expect(suite.cases.every((c) => c.expect === 'refused')).toBe(true);
  });
});

describe("robust1: every document is refused as Go refuses it, and never by a fault", () => {
  for (const c of suite.cases) {
    it(c.name, () => {
      const raw = read(`robust1/${c.file}`);
      expect(sha256hex(raw), `${c.file} does not hash to the manifest's`).toBe(c.sha256);
      let thrown: unknown;
      try {
        verifyPortableAny(JSON.parse(raw.toString('utf8')));
      } catch (e) {
        thrown = e;
      }
      expect(thrown, 'the document was verified').toBeDefined();
      // a port's own fault (reading a member of null, a missing function) is a defect, never a refusal
      expect(thrown instanceof TypeError || thrown instanceof RangeError || thrown instanceof ReferenceError, `a fault, not a refusal: ${String(thrown)}`).toBe(false);
      if (c.state) {
        expect(thrown).toBeInstanceOf(NamedState);
        const s = thrown as NamedState;
        expect({ code: s.code, partition: s.partition, block: s.block }).toEqual({ code: c.state, partition: c.partition ?? '', block: c.block ?? 0 });
      } else {
        expect(thrown instanceof NamedState ? `named ${(thrown as NamedState).code}` : '', 'Go refuses with a plain error').toBe('');
      }
    });
  }
});
