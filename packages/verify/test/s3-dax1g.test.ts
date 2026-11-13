import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NamedState, verifyPortableAnyBytes } from '../src/s3/index.js';
import { judgeDocument, sha256hex, summarize, type ReportSummary } from './helpers/s3.js';

/**
 * xpartition7 (DAX-1G, validator 54e82d20 on pl/dax-1-g42-validator): the documents on which the rules-v16 member `initiatingSignature` of evidence 2.1 -
 * the signature that initiated the transaction of a separate, NON-VOTING initiator (the tcl `*-erp` pattern) - is carried, proven or refused, against the
 * validator's Go verifier. The files are byte-identical copies written by Go (tools/sync-s3-fixtures.mjs --suites xpartition7 --out s3-dax1g), pinned by
 * MANIFEST.json and by the hashes below; each is verified with the TypeScript verifier and must reach Go's verdict: the report a verified case produces (what
 * is left unproven, every proven page with its proven and declared roles), or the named state with the partition and block it was judged at, or a plain
 * refusal. The expectation table below is written here from the semantics of the member (the same table the Go test xsuite7_test.go holds), not read from
 * the manifest; the test requires the manifest to agree with it.
 */
const dir = new URL('./fixtures/s3-dax1g/', import.meta.url);
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
  fields?: string[];
  report?: { version: string; tag: string; partition: string; anchorBlock: number; setVerdict: string; unproven?: string[]; proven: { url: string; partition: string; block: number; roles: string[] | null; declared?: string[] | null }[] };
}
const MANIFEST = JSON.parse(read('MANIFEST.json').toString('utf8')) as Mfst;
const suite = JSON.parse(read('xpartition7/manifest.json').toString('utf8')) as { format: string; domain: string; portableFormat: string; cases: Case[] };

const MANIFEST_HASH = '210e39e6349414f25dd96dfd397d24a302d1b8ef19cd98d75106bdb82b12ceee';
const SUITE_MANIFEST_SHA256 = '1df078894a4c61db0b4e134e8f315555099fcb41326c100d40c1d524b16b9dd8';
const VALIDATOR_COMMIT = '54e82d20b2abeeac3bc994641246b33312a05ce1';

// The blocks the pinned executor-activation table proves (xworld.ProvenBlockBVN1/2/3): the principal's partition, the authority's, the initiator's.
const BVN1 = 12_600_050;
const BVN2 = 12_600_070;
const BVN3 = 12_600_090;
const ERP = 'acc://pv2-erp-5.acme/book/1';
const DELE = 'acc://pv2-dele-5.acme/book/1';

const WANT: Record<string, { expect: 'verified' | 'refused'; state?: string; partition?: string; block?: number; unproven?: string[] }> = {
  'initiator-nonvoting-carried': { expect: 'verified' },
  'initiator-nonvoting-key-removed-after-arrival': { expect: 'verified' },
  'initiator-nonvoting-delegated-carried': { expect: 'verified' },
  'initiator-signature-tampered': { expect: 'refused', state: 'g1_signature_invalid', partition: 'BVN3', block: BVN3 },
  'initiator-signature-other-transaction': { expect: 'refused', state: 'g1_block_before_signature', partition: 'BVN3', block: BVN3 },
  'initiator-signature-signs-another-transaction': { expect: 'refused', state: 'g1_signature_invalid', partition: 'BVN3', block: BVN3 },
  'initiator-signature-other-page': { expect: 'refused', state: 'g1_block_before_signature', partition: 'BVN2', block: BVN2 },
  'initiator-signature-recorded-on-another-page': { expect: 'refused', state: 'g1_signature_invalid', partition: 'BVN2', block: BVN2 },
  'initiator-member-absent': { expect: 'verified', unproven: ['g1_initiator_signature_not_carried'] },
  'initiator-member-page-records-no-role': { expect: 'refused', state: 'g1_role_mismatch', partition: 'BVN3', block: BVN3 },
  'initiator-member-not-the-initiator': { expect: 'refused', state: 'g1_role_mismatch', partition: 'BVN3', block: BVN3 },
  'initiator-key-not-held': { expect: 'refused', state: 'g1_initiator_key_not_held', partition: 'BVN3', block: BVN3 },
  'initiator-member-no-history': { expect: 'refused', state: 'g1_history_unavailable', partition: 'BVN3', block: BVN3 },
  'initiator-member-arrival-altered': { expect: 'refused', state: 'g1_arrival_unproven', partition: 'BVN3', block: BVN3 },
  'initiator-member-receipt-altered': { expect: 'refused', state: 'g1_block_before_signature', partition: 'BVN3', block: BVN3 },
  'initiator-member-header-names-no-initiator': { expect: 'refused', state: 'g1_role_mismatch', partition: 'BVN3', block: BVN3 },
  'initiator-member-without-transaction': { expect: 'refused', state: 'g1_transaction_mismatch', partition: 'BVN1', block: BVN1 },
  'initiator-member-is-an-authority-signature': { expect: 'refused', state: 'g1_signature_invalid', partition: 'BVN3', block: BVN3 },
  'initiator-member-no-arrival-proof': { expect: 'refused', state: 'g1_arrival_unproven', partition: 'BVN3', block: BVN3 },
  'initiator-delegator-not-a-proven-page': { expect: 'refused', state: 'g1_initiator_page_unproven', partition: 'BVN1', block: BVN1 },
  'initiator-page-blacklists-the-transaction-type': { expect: 'refused', state: 'g1_initiator_key_not_held', partition: 'BVN3', block: BVN3 },
  'initiator-member-in-20-document': { expect: 'refused' },
};

// The pages a verified member-carried document proves initiator-signer on: the payer, and the delegator of a delegated signature.
const INITIATORS: Record<string, string[]> = {
  'initiator-nonvoting-carried': [ERP],
  'initiator-nonvoting-key-removed-after-arrival': [ERP],
  'initiator-nonvoting-delegated-carried': [ERP, DELE],
};

describe('xpartition7: the shared vectors are the ones Go wrote', () => {
  it('every file hashes to what the manifest pins, and the manifest to the hash this suite was written against', () => {
    expect(MANIFEST.format).toBe('certen:s3-vectors-manifest:v1');
    expect(MANIFEST.validatorCommit).toBe(VALIDATOR_COMMIT);
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
    expect(files).toBe(25);
    expect(MANIFEST.suites.map((s) => s.name)).toEqual(['xpartition7']);
  });

  it("carries the hash Go's own MANIFEST.sha256 states", () => {
    const manifest = read('xpartition7/manifest.json');
    expect(read('xpartition7/MANIFEST.sha256').toString('utf8')).toBe(`${sha256hex(manifest)}  manifest.json\n`);
    expect(sha256hex(manifest)).toBe(SUITE_MANIFEST_SHA256);
    expect(MANIFEST.suites[0]!.manifestSha256).toBe(SUITE_MANIFEST_SHA256);
  });

  it('has the 22 documents of the suite, 4 verified and 18 refused, and the manifest agrees with the expectation table written here', () => {
    expect(suite.format).toBe('certen-xpartition7-conformance/1');
    expect(suite.domain).toBe('certen:g1:v4');
    expect(suite.portableFormat).toBe('certen-proof-v2-accumulate-portable/1');
    expect(suite.cases.length).toBe(22);
    expect(Object.keys(WANT).length).toBe(22);
    expect(new Set(suite.cases.map((c) => c.file)).size).toBe(22);
    expect(suite.cases.filter((c) => c.expect === 'verified').length).toBe(4);
    expect(suite.cases.filter((c) => c.expect === 'refused').length).toBe(18);
    for (const c of suite.cases) {
      const w = WANT[c.name];
      expect(w, `${c.name} is not in the table`).toBeDefined();
      expect({ expect: c.expect, state: c.state, partition: c.partition, block: c.block }, c.name).toEqual({ expect: w!.expect, state: w!.state, partition: w!.partition, block: w!.block });
      expect(c.fields, c.name).toBeUndefined();
      expect(c.report?.unproven ?? [], c.name).toEqual(w!.unproven ?? []);
    }
    // the document that claims 2.0 carries the member and no named state: it is a plain refusal in Go
    expect(suite.cases.find((c) => c.name === 'initiator-member-in-20-document')!.state).toBeUndefined();
  });
});

function expectReport(c: Case, got: ReportSummary): void {
  const r = c.report!;
  expect(got.version).toBe(r.version);
  expect(got.tag).toBe(r.tag);
  expect(got.partition).toBe(r.partition);
  expect(got.anchorBlock).toBe(r.anchorBlock);
  expect(got.setVerdict).toBe(r.setVerdict);
  expect(got.unproven.map((u) => u.code)).toEqual(r.unproven ?? []);
  // Go writes a nil slice (a page with no proven role, only declared ones) as null; the report here holds an empty list
  expect(got.proven).toEqual(r.proven.map((p) => ({ url: p.url, partition: p.partition, block: p.block, roles: p.roles ?? [], declared: p.declared ?? [] })));
  // The report is judged at the principal's partition and the block the executor-activation table proves.
  expect(got.anchorBlock).toBe(BVN1);
  expect(got.partition).toBe('acc://bvn-BVN1.acme');
  // initiator-signer: PROVEN on exactly the pages the member makes initiator-signers, DECLARED (and unproven) where the member is absent.
  const want = (INITIATORS[c.name] ?? []).map((u) => u.toLowerCase());
  const w = WANT[c.name]!;
  for (const p of got.proven) {
    const isWant = want.includes(p.url.toLowerCase());
    const proven = p.roles.includes('initiator-signer');
    const declared = p.declared.includes('initiator-signer');
    if (isWant) {
      expect(proven, `${p.url} must have initiator-signer proven`).toBe(true);
      expect(declared, `${p.url} must not have initiator-signer declared`).toBe(false);
    } else {
      expect(proven, `${p.url}: initiator-signer proven on a page the member does not make an initiator-signer`).toBe(false);
    }
    if (!isWant && w.unproven && p.url.toLowerCase() === ERP.toLowerCase()) {
      expect(proven, `${p.url}: with no member the role is not proven`).toBe(false);
      expect(declared, `${p.url}: with no member the role is declared`).toBe(true);
    }
  }
}

describe("xpartition7: every document reaches Go's verdict", () => {
  for (const c of suite.cases) {
    it(c.name, () => {
      const raw = read(`xpartition7/${c.file}`);
      expect(sha256hex(raw), `${c.file} does not hash to the manifest's`).toBe(c.sha256);
      // The bytes entry reproduces Go's json.Unmarshal of the file; the tree entry is the same verdict for a document that was parsed first.
      const verdict = (): { ok: true; summary: ReportSummary } | { ok: false; named?: NamedState; message: string } => {
        try {
          const out = verifyPortableAnyBytes(raw);
          if (out.version !== '2.1') return { ok: false, message: 'not evidence 2.1' };
          return { ok: true, summary: summarize(out.report) };
        } catch (e) {
          return { ok: false, named: e instanceof NamedState ? e : undefined, message: e instanceof Error ? e.message : String(e) };
        }
      };
      const got = verdict();
      const viaTree = judgeDocument(JSON.parse(raw.toString('utf8')));
      if (c.expect === 'verified') {
        expect(got.ok, got.ok ? '' : `refused: ${got.message}`).toBe(true);
        if (got.ok) expectReport(c, got.summary);
        expect(viaTree.verdict, viaTree.verdict === 'verified' ? '' : `refused: ${'message' in viaTree ? viaTree.message : ''}`).toBe('verified');
        if (viaTree.verdict === 'verified' && got.ok) expect(viaTree.summary).toEqual(got.summary);
        return;
      }
      expect(got.ok, `${c.name} must be refused`).toBe(false);
      if (got.ok) return;
      if (c.state) {
        expect(got.named, `want ${c.state}{${c.partition},${c.block}}, got: ${got.message}`).toBeDefined();
        expect({ code: got.named!.code, partition: got.named!.partition, block: got.named!.block }).toEqual({ code: c.state, partition: c.partition ?? '', block: c.block ?? 0 });
        expect(viaTree.verdict).toBe('named');
        if (viaTree.verdict === 'named') expect(viaTree.state).toEqual({ code: c.state, partition: c.partition ?? '', block: c.block ?? 0 });
      } else {
        expect(got.named, `want a refusal with no named state, got: ${got.message}`).toBeUndefined();
        expect(viaTree.verdict).toBe('plain');
      }
    });
  }
});
