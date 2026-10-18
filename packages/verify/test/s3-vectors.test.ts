import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { judgeDocument, readS3, readS3Json, sha256hex, type ReportSummary } from './helpers/s3.js';

/**
 * The evidence 2.1 conformance suites, against the validator's Go verifier (pkg/proof/v2: xverify.go, xtimeline.go, xdirectory.go,
 * xroles.go, xoverride.go, xexecutor_table.go).
 *
 * Go writes the vectors (cmd/proofv2conformance -xpartition2 ... -xpartition5, and the shipped xpartition2b/3/3b); the files here are
 * byte-identical copies, pinned by MANIFEST.json (written by tools/sync-s3-fixtures.mjs from the validator at the commit named there).
 * Every document is verified with the TypeScript verifier and must reach Go's verdict: the report a verified case produces (its pages with
 * their partition, block and roles, the unproven states, the disclosures, the authorization mode, the derived arrivals), or the named state
 * - with the partition and block it was judged at - a refusal carries, or a plain refusal where the manifest names no state. A difference
 * is a stop-the-line finding; it is never "fixed" by editing a vector.
 */
interface Mfile {
  name: string;
  sha256: string;
  bytes: number;
}
interface Suite {
  name: string;
  files: Mfile[];
  manifestSha256?: string;
}
interface Mfst {
  format: string;
  validatorCommit: string;
  suites: Suite[];
  goldens: { name: string; sha256: string }[];
  manifestHash: string;
}
const MANIFEST = readS3Json<Mfst>('MANIFEST.json');

/** The hash of the vectors this suite was written against (MANIFEST.json, written from the validator at 3419863). */
const MANIFEST_HASH = '3fb31e6dca788fec39f997b1c4bef75557f746e3776811f22c8efbe89a1fc522';
/** The manifest hash each Go suite states in its own MANIFEST.sha256. */
const GO_SUITE_MANIFEST_SHA256: Record<string, string> = {
  xpartition2: '5617294b7b61368d22b492dbc16da4ddd121498ac4b9e41ea4a80ab784cfbd93',
  xpartition2b: '1f5043b1e53d9a1c17d8e8f91e8f3b782bbf336d174c332e877a2ef631ea056b',
  xpartition3: '529892575924ce8a6a819a4251b1dcb9003d26bf651136642bfc1eb32bb953aa',
  xpartition3b: '5c2ad4af55e10a9ba485598b357fe4c56019a1a4e84b1c9bf2e646f076d04f98',
  xpartition4: '5cfda653c454b7e54e030bebe98e97799fd64737f7c72a3ea25424007e034ae1',
  xpartition5: 'dd8aa1b571bf8a49ca20cefab4d851437fd9c4eb49b421637eba90c4548b350a',
};

interface Case {
  name: string;
  description?: string;
  file: string;
  sha256: string;
  expect: 'verified' | 'refused';
  state?: string;
  partition?: string;
  block?: number;
  report?: {
    version: string;
    tag: string;
    partition: string;
    anchorBlock: number;
    certifiedRoot: string;
    checkBlock: number;
    setVerdict: string;
    routingHeight: number;
    pagesBound: number;
    unproven?: string[];
    disclosures?: string[];
    authorizationMode?: string;
    arrivals?: { kind: string; account: string; block: number }[];
    proven: { url: string; partition: string; block: number; roles: string[]; declared?: string[] }[];
  };
}
interface CaseFile {
  format: string;
  domain: string;
  portableFormat: string;
  cases: Case[];
}

const SUITES: { name: string; format: string; min: { verified: number; refused: number }; count: number }[] = [
  { name: 'xpartition2', format: 'certen-xpartition2-conformance/1', min: { verified: 4, refused: 15 }, count: 22 },
  { name: 'xpartition2b', format: 'certen-xpartition2b-conformance/1', min: { verified: 10, refused: 11 }, count: 24 },
  { name: 'xpartition3', format: 'certen-xpartition3-conformance/1', min: { verified: 3, refused: 8 }, count: 12 },
  { name: 'xpartition3b', format: 'certen-xpartition3b-conformance/1', min: { verified: 5, refused: 4 }, count: 12 },
  { name: 'xpartition4', format: 'certen-xpartition4-conformance/1', min: { verified: 11, refused: 11 }, count: 22 },
  { name: 'xpartition5', format: 'certen-xpartition5-conformance/1', min: { verified: 2, refused: 6 }, count: 8 },
];

describe('the shared vectors are the ones Go wrote', () => {
  it('every file hashes to what the manifest pins, and the manifest to the hash this suite was written against', () => {
    expect(MANIFEST.format).toBe('certen:s3-vectors-manifest:v1');
    expect(MANIFEST.validatorCommit).toBe('341986373dbee1fdc37b05051668d12892c2ea87');
    let files = 0;
    const h = createHash('sha256');
    for (const s of MANIFEST.suites) {
      for (const f of s.files) {
        const bytes = readS3(`${s.name}/${f.name}`);
        expect(sha256hex(bytes), `${s.name}/${f.name}`).toBe(f.sha256);
        expect(bytes.length, `${s.name}/${f.name}`).toBe(f.bytes);
        h.update(`${s.name}/${f.name}:${f.sha256}\n`);
        files++;
      }
    }
    for (const g of MANIFEST.goldens) {
      expect(sha256hex(readS3(g.name)), g.name).toBe(g.sha256);
      h.update(`${g.name}:${g.sha256}\n`);
    }
    expect(h.digest('hex')).toBe(MANIFEST.manifestHash);
    expect(MANIFEST.manifestHash).toBe(MANIFEST_HASH);
    expect(files).toBe(MANIFEST.suites.reduce((n, s) => n + s.files.length, 0));
  });

  it('each suite carries the hash its Go manifest states (MANIFEST.sha256), and the Go manifests I was written against', () => {
    for (const s of MANIFEST.suites) {
      if (!s.files.some((f) => f.name === 'MANIFEST.sha256')) continue;
      const stated = readS3(`${s.name}/MANIFEST.sha256`).toString('utf8');
      expect(stated.startsWith(`${sha256hex(readS3(`${s.name}/manifest.json`))}  manifest.json`), s.name).toBe(true);
      expect(s.manifestSha256, s.name).toBe(sha256hex(readS3(`${s.name}/manifest.json`)));
      expect(s.manifestSha256, s.name).toBe(GO_SUITE_MANIFEST_SHA256[s.name]);
    }
  });

  it('has the documents the suites count: 100 in six suites', () => {
    let n = 0;
    for (const s of SUITES) {
      const m = readS3Json<CaseFile>(`${s.name}/manifest.json`);
      expect(m.format).toBe(s.format);
      expect(m.domain).toBe('certen:g1:v4');
      expect(m.portableFormat).toBe('certen-proof-v2-accumulate-portable/1');
      expect(m.cases.length, s.name).toBe(s.count);
      expect(new Set(m.cases.map((c) => c.file)).size, s.name).toBe(m.cases.length);
      n += m.cases.length;
    }
    expect(n).toBe(100);
  });
});

/** What one verified case must show, field by field, as the Go suites compare it. */
/**
 * The disclosures are compared where the Go suite compares them (xpartition4 and xpartition5, whose manifests record them); the older
 * manifests predate disclosures and the Go-written corpus (s3-mutations) pins them for those documents.
 */
function expectReport(c: Case, got: ReportSummary, disclosures: boolean): void {
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
  if (disclosures) expect(got.disclosures.map((u) => u.code)).toEqual(r.disclosures ?? []);
  expect(got.authorizationMode).toBe(r.authorizationMode ?? '');
  expect(got.arrivals.map((a) => ({ kind: a.kind, account: a.account, block: a.block }))).toEqual(r.arrivals ?? []);
  expect(got.proven).toEqual(r.proven.map((p) => ({ url: p.url, partition: p.partition, block: p.block, roles: p.roles, declared: p.declared ?? [] })));
}

for (const s of SUITES) {
  const m = readS3Json<CaseFile>(`${s.name}/manifest.json`);
  describe(`${s.name}: every document reaches Go's verdict`, () => {
    for (const c of m.cases) {
      it(c.name, () => {
        const raw = readS3(`${s.name}/${c.file}`);
        expect(sha256hex(raw), `${c.file} does not hash to the manifest's`).toBe(c.sha256);
        const got = judgeDocument(JSON.parse(raw.toString('utf8')));
        if (c.expect === 'verified') {
          expect(got.verdict, got.verdict === 'verified' ? '' : `refused: ${got.verdict === 'named' ? got.message : got.message}`).toBe('verified');
          if (got.verdict === 'verified') expectReport(c, got.summary, s.name === 'xpartition4' || s.name === 'xpartition5');
          return;
        }
        if (c.state) {
          expect(got.verdict, `want ${c.state}{${c.partition},${c.block}}`).toBe('named');
          if (got.verdict === 'named') expect(got.state).toEqual({ code: c.state, partition: c.partition ?? '', block: c.block ?? 0 });
        } else {
          // The manifest names no state: Go refuses with a plain error, never a named state.
          expect(got.verdict, got.verdict === 'named' ? got.message : '').toBe('plain');
        }
      });
    }
  });

  it(`${s.name} covers both outcomes in the measure the Go suite requires`, () => {
    const verified = m.cases.filter((c) => c.expect === 'verified').length;
    const refused = m.cases.filter((c) => c.expect === 'refused').length;
    expect(verified).toBeGreaterThanOrEqual(s.min.verified);
    expect(refused).toBeGreaterThanOrEqual(s.min.refused);
  });
}
