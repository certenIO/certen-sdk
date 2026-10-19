import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readCorpus } from './helpers/s3-corpus.js';
import { canonical, type RootOut } from './helpers/s3-intent.js';
import { readS3 } from './helpers/s3.js';
import { importEvidence } from '../src/s3/evidence.js';
import { pageCounts, pagesRootInputs, voteWire } from '../src/s3/govroot-v4.js';
import { proofV2Root } from '../src/s3/proofroot.js';
import { verifyPortable21 } from '../src/s3/portable21.js';

/**
 * The real stored 2.1 document (a live Kermit transaction on certen-protocol.acme/billing-receipts, BVN1) end to end in TypeScript: this
 * verifier establishes its report from the portable document, and that report - not the validator's - is bound to the intent's vote
 * evidence and committed by govRoot v4. The root, the pages root, the votes root and all ten slots are the ones the validator computes over
 * its own report of the same document (the intent corpus's real-root base).
 */
const HASH = '0a195731e5eb0a1f6796c65d7d439415be970e8414c532683e15dec3d53f7d67';

interface File {
  bases: Record<string, unknown>[];
  baseNames: string[];
  baseExpect: RootOut[];
}
const intent = readCorpus<File>('go-written/intent-cases.json.gz', HASH);

describe('the real stored 2.1 document: verified here, bound and committed here', () => {
  const doc = JSON.parse(gunzipSync(readS3('go-written/real-bvn1-billing-receipts.portable.json.gz')).toString('utf8')) as Record<string, unknown>;
  const at = intent.baseNames.indexOf('real-root');
  const base = intent.bases[at]! as Record<string, any>;
  const want = intent.baseExpect[at]!;

  it('commits the validator\'s govRoot v4, pages root, votes root and slots', () => {
    const rep = verifyPortable21(doc);
    expect(rep.unproven).toEqual([]);
    const ev = importEvidence(doc);
    const slotNames: Record<string, string> = { l1: 'L1', l2: 'L2', l3: 'L3', l4: 'L4', g0: 'G0', g1: 'G1', g2: 'G2', keyPage: 'keyPage', keyBook: 'keyBook', operationId: 'operationId' };
    const r = proofV2Root({
      report: rep,
      version: ev.version,
      pages: pagesRootInputs(rep, ev),
      counts: pageCounts(rep, ev),
      votes: ev.votes.map(voteWire),
      g0: base.g0,
      g1: { authoritySnapshotPage: base.g1Page },
      keyPageUrl: base.keyPage,
      keyBookUrl: base.keyBook,
      voteEvidence: JSON.stringify(base.voteEvidence),
      inputs: { ...base.hashes, keyPageUrl: base.keyPage, keyBookUrl: base.keyBook },
    });
    expect(want.v).toBe('ok');
    expect(r.v4).toBe(true);
    if (!r.v4) return;
    expect(r.root).toBe(want.root);
    expect(r.pagesRoot).toBe(want.pagesRoot);
    expect(r.votesRoot).toBe(want.votesRoot);
    expect(canonical(Object.fromEntries(Object.entries(r.slots).map(([k, v]) => [slotNames[k], v])))).toBe(canonical(want.slots));
  });

  it('sees the report the validator saw: the same pages, chains, partitions, blocks and roles', () => {
    const rep = verifyPortable21(doc);
    const report = base.report as Record<string, any>;
    expect(rep.partition).toBe(report.partition);
    expect(rep.anchorBlock).toBe(report.anchorBlock);
    expect(rep.certifiedBlock).toBe(report.certifiedBlock);
    for (const k of ['incarnation', 'certifiedRoot', 'txHash', 'anchorTxHash', 'anchorStateRoot', 'anchorRootChainAnchor', 'accumulateSetRoot'] as const) expect(rep[k], k).toBe(report[k]);
    expect(rep.proven.map((p) => ({ ...p }))).toEqual(report.proven);
    expect(rep.pageChains.map((c) => ({ url: c.url, bound: c.bound, mainHeight: c.mainHeight }))).toEqual(report.pageChains);
    expect(rep.pages.map((p) => Buffer.from(p.state).toString('hex'))).toEqual(report.pages);
  });
});
