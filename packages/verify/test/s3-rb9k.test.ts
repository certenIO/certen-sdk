import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judgeDocument, sha256hex, type ReportSummary } from './helpers/s3.js';

/**
 * xpartition6 (RB9-K, validator 92d9a9b): the 17 documents on which the authorization of an account-authority operation is decided, against
 * the validator's Go verifier. The files are byte-identical copies written by Go (tools/sync-s3-fixtures.mjs), pinned by MANIFEST.json; each
 * is verified with the TypeScript verifier and must reach Go's verdict - the report a verified case produces, or the named state (with the
 * partition and block it was judged at) a refusal carries. disable-op-voter-outside-the-list-every-authority-disabled is the RB9-K-F4
 * carve-out: a RequireAuthorization signer is not disabled, so a vote by an authority that is not on the list is refused by name.
 */
const dir = new URL('./fixtures/s3-rb9k/', import.meta.url);
const read = (name: string): Buffer => readFileSync(new URL(name, dir));
interface Mfile {
  name: string;
  sha256: string;
  bytes: number;
}
interface Mfst {
  format: string;
  validatorCommit: string;
  suites: { name: string; files: Mfile[]; manifestSha256: string }[];
  goldens: unknown[];
  manifestHash: string;
}
interface Case {
  name: string;
  file: string;
  sha256: string;
  expect: 'verified' | 'refused';
  state?: string;
  partition?: string;
  block?: number;
  report?: Omit<ReportSummary, 'tag'> & { tag: string; proven: { url: string; partition: string; block: number; roles: string[]; declared?: string[] }[] };
}
const MANIFEST = JSON.parse(read('MANIFEST.json').toString('utf8')) as Mfst;
const suite = JSON.parse(read('xpartition6/manifest.json').toString('utf8')) as { format: string; domain: string; portableFormat: string; cases: Case[] };

const MANIFEST_HASH = '6be370f8dbb9dfb258f6f81b83d189b524815c6e1582a6dcf18033f92a49c5b9';
const SUITE_MANIFEST_SHA256 = 'aaa46baffca8969bbbd8ec40bb1bc622f6fbd1c9d9779c48d1d9849d16f27685';

describe('xpartition6: the shared vectors are the ones Go wrote', () => {
  it('every file hashes to what the manifest pins, and the manifest to the hash this suite was written against', () => {
    expect(MANIFEST.format).toBe('certen:s3-vectors-manifest:v1');
    expect(MANIFEST.validatorCommit).toBe('92d9a9b0907baaef6ff749e96d079e67f76d4bfa');
    const h = createHash('sha256');
    let files = 0;
    for (const s of MANIFEST.suites) {
      for (const f of s.files) {
        const bytes = read(`${s.name}/${f.name}`);
        expect(sha256hex(bytes), `${s.name}/${f.name}`).toBe(f.sha256);
        expect(bytes.length, `${s.name}/${f.name}`).toBe(f.bytes);
        h.update(`${s.name}/${f.name}:${f.sha256}\n`);
        files++;
      }
    }
    expect(MANIFEST.goldens).toEqual([]);
    expect(h.digest('hex')).toBe(MANIFEST.manifestHash);
    expect(MANIFEST.manifestHash).toBe(MANIFEST_HASH);
    expect(files).toBe(20);
    expect(MANIFEST.suites.map((s) => s.name)).toEqual(['xpartition6']);
  });

  it("carries the hash Go's own MANIFEST.sha256 states", () => {
    const manifest = read('xpartition6/manifest.json');
    expect(read('xpartition6/MANIFEST.sha256').toString('utf8').startsWith(`${sha256hex(manifest)}  manifest.json`)).toBe(true);
    expect(sha256hex(manifest)).toBe(SUITE_MANIFEST_SHA256);
    expect(MANIFEST.suites[0]!.manifestSha256).toBe(SUITE_MANIFEST_SHA256);
  });

  it('has the 17 documents of the suite, 6 verified and 11 refused, and the RB9-K-F4 carve-out vector among them', () => {
    expect(suite.format).toBe('certen-xpartition6-conformance/1');
    expect(suite.domain).toBe('certen:g1:v4');
    expect(suite.portableFormat).toBe('certen-proof-v2-accumulate-portable/1');
    expect(suite.cases.length).toBe(17);
    expect(new Set(suite.cases.map((c) => c.file)).size).toBe(17);
    expect(suite.cases.filter((c) => c.expect === 'verified').length).toBe(6);
    expect(suite.cases.filter((c) => c.expect === 'refused').length).toBe(11);
    expect(suite.cases.map((c) => c.name)).toContain('disable-op-voter-outside-the-list-every-authority-disabled');
  });
});

function expectReport(c: Case, got: ReportSummary): void {
  const r = c.report!;
  expect(got.version).toBe(r.version);
  expect(got.tag).toBe(r.tag);
  expect(got.partition).toBe(r.partition);
  expect(got.anchorBlock).toBe(r.anchorBlock);
  expect(got.certifiedRoot).toBe(r.certifiedRoot);
  expect(got.checkBlock).toBe(r.checkBlock);
  expect(got.setVerdict).toBe(r.setVerdict);
  expect(got.routingHeight).toBe(r.routingHeight);
  expect(got.pagesBound).toBe(r.pagesBound);
  expect(got.unproven.map((u) => u.code)).toEqual(r.unproven ?? []);
  expect(got.disclosures.map((u) => u.code)).toEqual(r.disclosures ?? []);
  expect(got.authorizationMode).toBe(r.authorizationMode ?? '');
  expect(got.arrivals.map((a) => ({ kind: a.kind, account: a.account, block: a.block }))).toEqual(r.arrivals ?? []);
  expect(got.proven).toEqual(r.proven.map((p) => ({ url: p.url, partition: p.partition, block: p.block, roles: p.roles, declared: p.declared ?? [] })));
}

describe("xpartition6: every document reaches Go's verdict", () => {
  for (const c of suite.cases) {
    it(c.name, () => {
      const raw = read(`xpartition6/${c.file}`);
      expect(sha256hex(raw), `${c.file} does not hash to the manifest's`).toBe(c.sha256);
      const got = judgeDocument(JSON.parse(raw.toString('utf8')));
      if (c.expect === 'verified') {
        expect(got.verdict, got.verdict === 'verified' ? '' : `refused: ${got.message}`).toBe('verified');
        if (got.verdict === 'verified') expectReport(c, got.summary);
        return;
      }
      if (c.state) {
        expect(got.verdict, `want ${c.state}{${c.partition},${c.block}}`).toBe('named');
        if (got.verdict === 'named') expect(got.state).toEqual({ code: c.state, partition: c.partition ?? '', block: c.block ?? 0 });
      } else {
        expect(got.verdict, got.verdict === 'named' ? got.message : '').toBe('plain');
      }
    });
  }
});
