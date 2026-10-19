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

/**
 * The hash of the vectors this suite was written against (MANIFEST.json, written from the validator at d1bbe40: RB9-F6, F-VE-2 (b) - the document files
 * are byte-identical to the 3419863 ones, the manifests gain the moved entries' words and the appended '-g' siblings).
 */
const MANIFEST_HASH = '7f2a5f8fad6a5a9280228440607e79ca44c8967a2957ae24b8c6044e61813ed8';
/** The manifest hash each Go suite states in its own MANIFEST.sha256. */
const GO_SUITE_MANIFEST_SHA256: Record<string, string> = {
  xpartition2: '92670fb0f7fef66d826973e43b613ae3b56b806e80ed1ae228353c20a63c0e2b',
  xpartition2b: '5d258989fce7cbe23ba8aee9886ec03d59d80fa0a7329503ae839374d13be02d',
  xpartition3: '512b6a4bf20e9a980eabce5d77afbba914652b87f55204441eacc0bdf8ff5402',
  xpartition3b: '61f18014084d3850ce32e66f3dd914e3949a4a0650bdabf11830424ac7d763bb',
  xpartition4: 'a9000df52fd51df19c473ec294c7d8072d4d11cea1a354c91b4f7c01df06989b',
  xpartition5: 'bfea86bf28bfecaca5c05c8853dce3d9a58739fa8cedd7042fe303756e3d3368',
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
  /** The fields of a certify state (certify_link_missing{genesis}); present with `note` on an entry the F-VE-2 (b) requirement moved. */
  fields?: string[];
  note?: string;
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

const SUITES: { name: string; format: string; min: { verified: number; refused: number }; count: number; moved: number }[] = [
  { name: 'xpartition2', format: 'certen-xpartition2-conformance/1', min: { verified: 4, refused: 15 }, count: 26, moved: 4 },
  { name: 'xpartition2b', format: 'certen-xpartition2b-conformance/1', min: { verified: 10, refused: 11 }, count: 34, moved: 10 },
  { name: 'xpartition3', format: 'certen-xpartition3-conformance/1', min: { verified: 3, refused: 8 }, count: 15, moved: 3 },
  { name: 'xpartition3b', format: 'certen-xpartition3b-conformance/1', min: { verified: 5, refused: 4 }, count: 17, moved: 5 },
  { name: 'xpartition4', format: 'certen-xpartition4-conformance/1', min: { verified: 11, refused: 11 }, count: 33, moved: 11 },
  { name: 'xpartition5', format: 'certen-xpartition5-conformance/1', min: { verified: 2, refused: 6 }, count: 10, moved: 2 },
];

describe('the shared vectors are the ones Go wrote', () => {
  it('every file hashes to what the manifest pins, and the manifest to the hash this suite was written against', () => {
    expect(MANIFEST.format).toBe('certen:s3-vectors-manifest:v1');
    expect(MANIFEST.validatorCommit).toBe('d1bbe407d6cabb20cc10708378ad7d98ebc68732');
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

  it('has the documents the suites count: 135 in six suites (100 frozen documents and the 35 linked siblings of the ones that verified)', () => {
    let n = 0;
    for (const s of SUITES) {
      const m = readS3Json<CaseFile>(`${s.name}/manifest.json`);
      expect(m.format).toBe(s.format);
      expect(m.domain).toBe('certen:g1:v4');
      expect(m.portableFormat).toBe('certen-proof-v2-accumulate-portable/1');
      expect(m.cases.length, s.name).toBe(s.count);
      expect(new Set(m.cases.map((c) => c.file)).size, s.name).toBe(m.cases.length);
      // F-VE-2 (b): every entry that verified is frozen as certify_link_missing{genesis} (note + fields), and its '-g' sibling carries the link
      const moved = m.cases.filter((c) => c.note !== undefined);
      expect(moved.length, s.name).toBe(s.moved);
      for (const c of moved) {
        expect(c.expect, c.name).toBe('refused');
        expect(c.state, c.name).toBe('certify_link_missing');
        expect(c.fields, c.name).toEqual(['genesis']);
        const sib = m.cases.find((x) => x.name === `${c.name}-g`);
        expect(sib?.expect, `${c.name}-g`).toBe('verified');
      }
      n += m.cases.length;
    }
    expect(n).toBe(135);
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
        if (c.fields) {
          // a certify state (certify_link_missing{genesis}: a frozen document F-VE-2 (b) moved): a plain refusal that carries the state's name and fields
          expect(got.verdict, `want ${c.state}{${c.fields.join(',')}}`).toBe('plain');
          if (got.verdict === 'plain') expect(got.message.startsWith(`${c.state}{${c.fields.join(',')}}`), got.message).toBe(true);
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
