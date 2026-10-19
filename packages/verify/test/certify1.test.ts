import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_RESERVE,
  CERTIFICATE_RESERVE_20,
  CONSENSUS_TX_LIMIT,
  FIXED_EVIDENCE_BYTES,
  FIXED_EVIDENCE_BYTES_20,
  MAX_EVIDENCE_BYTES,
  MAX_EVIDENCE_BYTES_20,
  checkCertificateFits,
  checkClosureBudget,
  checkUpdateWindows,
  maxUpdateWindows,
  updateWindowsBytes,
} from '../src/s3/budget.js';
import {
  CERTIFY_DETAILS,
  CERTIFY_FIELDS,
  CERTIFY_NAMES_SHA256,
  CERTIFY_SIDE,
  CHECKPOINT_LAG,
  CertifyCode,
  CertifyState,
  checkCheckpointLag,
  receiptDecodes,
  rootChainLeafIndex,
} from '../src/s3/certify.js';
import { judgeCertify, read, sha256hex } from './helpers/certify1.js';

/**
 * certify1 (RB9-F5, validator pkg/proof/v2/testdata/certify1 at 31393e0): the anchored certify form of evidence 2.1 - links, the genesis link, the
 * accounting of the set check, the window of an update. The files are byte-identical copies written by Go (tools/sync-s3-fixtures.mjs --suites
 * certify1,certify1-live --out s3-f5), pinned here and by MANIFEST.json. Each document must reach the verdict Go's manifest records: verified with the
 * same report, or refused by the same plain wording prefix, or by the named state with the same fields.
 */
const NAMES_SHA256 = '2413c2baac002a4f5a0b34d1331d41079a1c50e8b4792e1263b690ed8df84878';
const SUITE_MANIFEST_SHA256 = 'bb200d6decb7a809ada325e376d2f95ea460b80a91b58ca021dc766cf032c312';
const LIVE_LINKS_SHA256 = '98ba7ccd2e71a7631f836ad597dcab25df1e908a82aa82443daa0d729ae7b70f';
const VECTORS = 46;

interface Case {
  name: string;
  file: string;
  sha256: string;
  expect: 'verified' | 'refused';
  sameReportAs?: string;
  state?: string;
  fields?: string[];
  wording?: string;
  prefix?: string;
  report?: {
    version: string;
    tag: string;
    partition: string;
    anchorBlock: number;
    certifiedRoot: string;
    checkBlock: number;
    setVerdict: string;
    routingHeight: number;
    proven: { url: string; partition: string; block: number; roles: string[] }[];
    pagesBound: number;
    unproven?: string[];
  };
}
interface Suite {
  format: string;
  domain: string;
  portableFormat: string;
  namesFile: string;
  namesSha256: string;
  cases: Case[];
}
interface Mfst {
  format: string;
  validatorCommit: string;
  suites: { name: string; files: { name: string; sha256: string; bytes: number }[]; manifestSha256?: string }[];
  goldens: unknown[];
  manifestHash: string;
}
const MANIFEST = JSON.parse(read('MANIFEST.json').toString('utf8')) as Mfst;
const suite = JSON.parse(read('certify1/manifest.json').toString('utf8')) as Suite;
const names = JSON.parse(read('certify1/names.json').toString('utf8')) as { names: { name: string; fields: string[]; side: string; detail: string }[] };

describe('certify1: the shared vectors are the ones Go wrote', () => {
  it('every file hashes to what the manifest pins', () => {
    expect(MANIFEST.format).toBe('certen:s3-vectors-manifest:v1');
    expect(MANIFEST.validatorCommit.startsWith('31393e0')).toBe(true);
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
    expect(MANIFEST.suites.map((s) => s.name)).toEqual(['certify1', 'certify1-live']);
  });

  it('pins names.json and manifest.json, and the hash Go states (MANIFEST.sha256)', () => {
    expect(sha256hex(read('certify1/names.json'))).toBe(NAMES_SHA256);
    expect(sha256hex(read('certify1/manifest.json'))).toBe(SUITE_MANIFEST_SHA256);
    expect(MANIFEST.suites[0]!.manifestSha256).toBe(SUITE_MANIFEST_SHA256);
    expect(read('certify1/MANIFEST.sha256').toString('utf8').startsWith(`${SUITE_MANIFEST_SHA256}  manifest.json`)).toBe(true);
    expect(suite.namesSha256).toBe(NAMES_SHA256);
    expect(read('certify1-live/MANIFEST.sha256').toString('utf8').startsWith(`${LIVE_LINKS_SHA256} *links.json`)).toBe(true);
    expect(sha256hex(read('certify1-live/links.json'))).toBe(LIVE_LINKS_SHA256);
  });

  it(`has the ${VECTORS} documents of the suite`, () => {
    expect(suite.format).toBe('certen-certify1-conformance/1');
    expect(suite.domain).toBe('certen:g1:v4');
    expect(suite.portableFormat).toBe('certen-proof-v2-accumulate-portable/1');
    expect(suite.namesFile).toBe('names.json');
    expect(suite.cases.length).toBe(VECTORS);
    expect(new Set(suite.cases.map((c) => c.file)).size).toBe(VECTORS);
    expect(new Set(suite.cases.map((c) => c.name)).size).toBe(VECTORS);
    expect(suite.cases.filter((c) => c.expect === 'verified').length).toBe(11);
  });
});

describe('certify1: the names are generated from names.json and cannot drift', () => {
  it('the generated constants are the names file (codes, fields, sides, detail text, hash)', () => {
    expect(CERTIFY_NAMES_SHA256).toBe(NAMES_SHA256);
    expect(names.names.length).toBe(12);
    expect(Object.keys(CERTIFY_FIELDS)).toEqual(names.names.map((n) => n.name));
    expect(Object.values(CertifyCode)).toEqual(names.names.map((n) => n.name));
    for (const n of names.names) {
      expect(CERTIFY_FIELDS[n.name], n.name).toEqual(n.fields);
      expect(CERTIFY_SIDE[n.name], n.name).toBe(n.side);
      expect(CERTIFY_DETAILS[n.name], n.name).toBe(n.detail);
    }
  });

  it('a CertifyState renders as Go does: code{field,field}: detail', () => {
    const s = new CertifyState(CertifyCode.CertifyItemWithoutEffect, ['0', '110']);
    expect(s.message).toBe("certify_item_without_effect{0,110}: an anchored item that is not the last of its sequence applies no update");
    expect(s.code).toBe('certify_item_without_effect');
    expect(s.fields).toEqual(['0', '110']);
  });

  it('every manifest wording is the rendering of its state and fields', () => {
    for (const c of suite.cases) {
      if (!c.state) continue;
      expect(new CertifyState(c.state, c.fields!).message, c.name).toBe(c.wording);
    }
  });
});

const judged = new Map<string, ReturnType<typeof judgeCertify>>();

describe("certify1: every document reaches Go's verdict", () => {
  for (const c of suite.cases) {
    it(c.name, () => {
      const raw = read(`certify1/${c.file}`);
      expect(sha256hex(raw), `${c.file} does not hash to the manifest's`).toBe(c.sha256);
      const got = judgeCertify(JSON.parse(raw.toString('utf8')));
      judged.set(c.name, got);
      expect(got.v, got.v === 'fault' ? got.message : '').not.toBe('fault');
      if (c.expect === 'verified') {
        expect(got.v, got.v === 'verified' ? '' : `refused: ${(got as { message: string }).message}`).toBe('verified');
        if (got.v !== 'verified') return;
        const r = c.report!;
        expect(got.summary.version).toBe(r.version);
        expect(got.summary.tag).toBe(r.tag);
        expect(got.summary.partition).toBe(r.partition);
        expect(got.summary.anchorBlock).toBe(r.anchorBlock);
        expect(got.summary.certifiedRoot).toBe(r.certifiedRoot);
        expect(got.summary.checkBlock).toBe(r.checkBlock);
        expect(got.summary.setVerdict).toBe(r.setVerdict);
        expect(got.summary.routingHeight).toBe(r.routingHeight);
        expect(got.summary.pagesBound).toBe(r.pagesBound);
        expect(got.summary.unproven).toEqual(r.unproven ?? []);
        expect(got.summary.proven.map((p) => ({ url: p.url, partition: p.partition, block: p.block, roles: p.roles }))).toEqual(r.proven ?? []);
        return;
      }
      if (c.state) {
        expect(got.v, `want ${c.wording}`).toBe('certify');
        if (got.v !== 'certify') return;
        expect({ code: got.code, fields: got.fields }).toEqual({ code: c.state, fields: c.fields });
        expect(got.message.startsWith(c.prefix!), `${got.message} does not start with ${c.prefix}`).toBe(true);
        return;
      }
      expect(got.v, `want a plain refusal ${c.prefix}`).toBe('plain');
      expect((got as { message: string }).message.startsWith(c.prefix!), `${(got as { message: string }).message} does not start with ${c.prefix}`).toBe(true);
    });
  }

  it('a document that names its sameReportAs is verified with exactly that vector\'s report', () => {
    const pairs = suite.cases.filter((c) => c.sameReportAs);
    expect(pairs.length).toBeGreaterThan(0);
    for (const c of pairs) {
      const a = judged.get(c.name) ?? judgeCertify(JSON.parse(read(`certify1/${c.file}`).toString('utf8')));
      const other = suite.cases.find((x) => x.name === c.sameReportAs)!;
      const b = judged.get(other.name) ?? judgeCertify(JSON.parse(read(`certify1/${other.file}`).toString('utf8')));
      expect(a.v, c.name).toBe('verified');
      expect(b.v, other.name).toBe('verified');
      if (a.v === 'verified' && b.v === 'verified') {
        expect(a.summary, `${c.name} vs ${other.name}`).toEqual(b.summary);
        expect(a.full, `${c.name} vs ${other.name}`).toEqual(b.full);
      }
    }
  });
});

describe('certify1: a link must decode as a receipt does (merkle.Receipt.UnmarshalBinary)', () => {
  const receiptBin = (extra: number[]): Uint8Array => {
    // start (field 1) = 2 bytes, anchor (field 5) = 2 bytes, one entry (field 6): right (1) = 1, hash (2) = 2 bytes
    const entry = [1, 1, 2, 2, 0xaa, 0xbb];
    return Uint8Array.from([1, 2, 1, 2, 5, 2, 3, 4, 6, entry.length, ...entry, ...extra]);
  };
  it('accepts the receipt as written and an unknown trailing field above the receipt\'s own (7..32)', () => {
    expect(receiptDecodes(receiptBin([]))).toBe(true);
    expect(receiptDecodes(receiptBin([7, 1, 0x0a]))).toBe(true);
    expect(receiptDecodes(receiptBin([32, 1, 0x0a]))).toBe(true);
    expect(receiptDecodes(receiptBin([0x00]))).toBe(true); // a zero field number is the empty-object extension
  });
  it('refuses a trailing field the reader cannot place after the entries (1..6), one above 32, and truncated fields', () => {
    expect(receiptDecodes(receiptBin([5, 1, 0x0a]))).toBe(false); // the vectors' $epilogue (05010a)
    expect(receiptDecodes(receiptBin([1, 1, 1]))).toBe(false);
    expect(receiptDecodes(receiptBin([33, 1, 0x0a]))).toBe(false);
    expect(receiptDecodes(Uint8Array.from([1, 5, 1, 2]))).toBe(false); // a start field longer than the data
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the window of an update: the root chain position is fixed by the Right flags of the END of the receipt and the signed tree size

const windowEntries = (n: number): Uint8Array[] =>
  Array.from({ length: n }, (_, i) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(i));
    return new Uint8Array(createHash('sha256').update(Buffer.concat([Buffer.from('window'), b])).digest());
  });

const comb = (l: Uint8Array, r: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(l).update(r).digest());

/** trackedReceipt (xposition_test.go): the receipt Accumulate's algorithm builds for entry p of a chain of the given entries. */
function trackedReceipt(entries: Uint8Array[], p: number): { right: boolean; hash: Uint8Array }[] {
  type Node = { hash: Uint8Array; has: boolean };
  const pending: (Node | null)[] = [];
  const out: { right: boolean; hash: Uint8Array }[] = [];
  entries.forEach((e, i) => {
    let cur: Node = { hash: e, has: i === p };
    for (let lvl = 0; ; lvl++) {
      if (lvl === pending.length) pending.push(null);
      if (pending[lvl] === null) {
        pending[lvl] = cur;
        break;
      }
      const left = pending[lvl]!;
      if (left.has) out.push({ right: true, hash: cur.hash });
      if (cur.has) out.push({ right: false, hash: left.hash });
      cur = { hash: comb(left.hash, cur.hash), has: left.has || cur.has };
      pending[lvl] = null;
    }
  });
  let acc: Node | null = null;
  for (const v of pending) {
    if (!v) continue;
    if (!acc) {
      acc = v;
      continue;
    }
    if (acc.has) out.push({ right: false, hash: v.hash });
    if (v.has) out.push({ right: true, hash: acc.hash });
    acc = { hash: comb(v.hash, acc.hash), has: acc.has || v.has };
  }
  return out;
}

/** windowPrefixes: main-chain stretches a combined update receipt can carry before its root-chain part, every shape of flags up to three steps. */
function windowPrefixes(): { right: boolean; hash: Uint8Array }[][] {
  const out: { right: boolean; hash: Uint8Array }[][] = [];
  for (let l = 0; l <= 3; l++) {
    for (let m = 0; m < 1 << l; m++) {
      const p: { right: boolean; hash: Uint8Array }[] = [];
      for (let i = 0; i < l; i++) p.push({ right: ((m >> i) & 1) === 1, hash: windowEntries(8)[i + l]! });
      out.push(p);
    }
  }
  return out;
}

describe('certify1: the root chain position of an update is fixed by the receipt tail (TestRootChainLeafIndexIsFixedByTheReceiptTail)', () => {
  it('for every tree size up to 70, every leaf and every prefix shape, the position decodes to exactly the leaf\'s', () => {
    const prefixes = windowPrefixes();
    let cases = 0;
    for (let n = 1; n <= 70; n++) {
      const entries = windowEntries(n);
      for (let p = 0; p < n; p++) {
        const r = trackedReceipt(entries, p);
        for (const pre of prefixes) {
          const got = rootChainLeafIndex([...pre, ...r], BigInt(n));
          if (got !== BigInt(p)) throw new Error(`n=${n} p=${p} prefix=${pre.length} steps: decoded ${String(got)}`);
          cases++;
        }
      }
    }
    expect(cases).toBe(15 * (70 * 71 / 2));
  });

  it('a path that is the root-chain path of no leaf of a tree of that size does not decompose', () => {
    const right = (k: number) => Array.from({ length: k }, () => ({ right: true }));
    expect(rootChainLeafIndex([], 7n)).toBeUndefined();
    expect(rootChainLeafIndex(right(1), 7n)).toBeUndefined();
    expect(rootChainLeafIndex(right(2), 7n)).toBeUndefined();
    expect(rootChainLeafIndex(right(3), 0n)).toBeUndefined();
    const entries = windowEntries(200);
    let bad = 0;
    for (let p = 0; p < 200; p++) if (rootChainLeafIndex(trackedReceipt(entries, p), 70n) !== BigInt(p)) bad++;
    expect(bad).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the consensus-facing checkpoint lag and the budget constants

describe('certify1: checkpoint_stale and the budget constants', () => {
  it('CheckpointLag is 2 and a 2.1 document that builds on a checkpoint more than the lag behind the newest is refused by name', () => {
    expect(CHECKPOINT_LAG).toBe(2);
    expect(() => checkCheckpointLag('2.1', 3, 5)).not.toThrow(); // 3 + 2 is not below 5
    expect(() => checkCheckpointLag('2.1', 5, 5)).not.toThrow();
    let thrown: unknown;
    try {
      checkCheckpointLag('2.1', 2, 5);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CertifyState);
    expect((thrown as CertifyState).code).toBe('checkpoint_stale');
    expect((thrown as CertifyState).fields).toEqual(['2', '5', '2']);
    expect((thrown as CertifyState).message).toBe('checkpoint_stale{2,5,2}: the evidence builds on a major block older than the newest verified one by more than the allowed lag');
    expect(() => checkCheckpointLag('2.0', 1, 50)).not.toThrow(); // evidence 2.0 is judged as ever
  });

  it('the evidence 2.1 budget is 40,000 / 720,896 / 320 KiB and the 2.0 values stay named constants', () => {
    expect(CONSENSUS_TX_LIMIT).toBe(1 << 20);
    expect(CERTIFICATE_RESERVE).toBe(320 * 1024);
    expect(MAX_EVIDENCE_BYTES).toBe(720_896);
    expect(FIXED_EVIDENCE_BYTES).toBe(40_000);
    expect(CERTIFICATE_RESERVE_20).toBe(96 * 1024);
    expect(MAX_EVIDENCE_BYTES_20).toBe(950_272);
    expect(FIXED_EVIDENCE_BYTES_20).toBe(760_000);
  });

  it('the whole certificate is judged: certificate_budget{size,limit} over the path limit, version-dispatched closure budget, the k x V bound', () => {
    expect(() => checkCertificateFits(100_000, 3, 'acc://bvn-BVN1.acme block 5')).not.toThrow();
    let thrown: unknown;
    try {
      checkCertificateFits(MAX_EVIDENCE_BYTES, 45, 'acc://bvn-BVN1.acme block 5');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CertifyState);
    expect((thrown as CertifyState).code).toBe('certificate_budget');
    expect((thrown as CertifyState).fields).toEqual([String(MAX_EVIDENCE_BYTES + 260_000 + 7_600 * 45), String(CONSENSUS_TX_LIMIT)]);
    expect((thrown as CertifyState).message).toContain('tx_too_large');
    expect(() => checkClosureBudget('2.0', [], [], 'acc://bvn-BVN1.acme', 5)).not.toThrow();
    expect(() => checkClosureBudget('2.1', [], [], 'acc://bvn-BVN1.acme', 5)).not.toThrow();
    expect(() => checkClosureBudget('3.0', [], [], 'acc://bvn-BVN1.acme', 5)).toThrow(/unknown evidence version/);
    // k x V: the signatures of k update windows at V validators
    expect(updateWindowsBytes(4, 16)).toBe(4 * 16 * 165);
    const maxK = maxUpdateWindows(16, 0);
    expect(maxK).toBeGreaterThan(0);
    expect(() => checkUpdateWindows(maxK, 16, 0)).not.toThrow();
    let over: unknown;
    try {
      checkUpdateWindows(maxK + 1, 16, 0);
    } catch (e) {
      over = e;
    }
    expect((over as CertifyState).code).toBe('certificate_budget');
    expect(maxUpdateWindows(0, 0)).toBe(0);
  });
});
