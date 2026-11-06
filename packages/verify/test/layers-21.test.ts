import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { finality, verifyProofDocument, type Layer } from '../src/index.js';
import { judgeDocument, readS3Json } from './helpers/s3.js';

/**
 * The per-layer verification of a document of evidence 2.1 (src/layers.ts, verifyCore21).
 *
 * `verifyProofDocument` accepted evidence 2.0 only. The validators have emitted evidence 2.1 since the G1 activation, so `certen proof verify`, the SDK's `verifyEvidence`
 * and the MCP tool answered "failed at trust_base: not a v2 Accumulate proof" for every proof the live gateway served. The layer report for 2.1 is built from the same walk the
 * validator's verifier makes (portable21's trace), so it must reach the verdict that walk reaches, document by document, and name the layer a refusal belongs to.
 *
 *   1. Every document of the Go-written conformance corpus (135 in six suites): the layer report agrees with the verdict the walk itself gives.
 *   2. A real proof from the hosted gateway (fixtures/live21-base-sepolia, a contract call on Base Sepolia): verified layer by layer, the root it derives, the root you
 *      expect (right and wrong), a tampered transaction, and the finality layer judged against the Settlement in the bundle.
 */
const SUITES = ['xpartition2', 'xpartition2b', 'xpartition3', 'xpartition3b', 'xpartition4', 'xpartition5'];
interface Case { name: string; file: string; expect: 'verified' | 'refused'; state?: string }

const IN_DOCUMENT = ['trust_base', 'L4', 'L1', 'L2', 'L3', 'G0', 'G1', 'G1_chains', 'L4_set', 'govRootV4'];
const OUTSIDE = ['G1b', 'G2', 'L5', 'outcome'];
const byId = (layers: Layer[]): Record<string, Layer> => Object.fromEntries(layers.map((l) => [l.id, l]));

describe('evidence 2.1: the layer report agrees with the walk, on every document of the conformance corpus', () => {
  for (const suite of SUITES) {
    it(`${suite}`, () => {
      const manifest = readS3Json<{ cases: Case[] }>(`${suite}/manifest.json`);
      expect(manifest.cases.length).toBeGreaterThan(0);
      for (const c of manifest.cases) {
        const doc = readS3Json<Record<string, unknown>>(`${suite}/${c.file}`);
        const walk = judgeDocument(doc);
        const v = verifyProofDocument(doc);
        const L = byId(v.layers);
        const where = `${suite}/${c.name}`;

        // a document whose evidence is not 2.1 (the corpus holds one: 2.0 carrying 2.1 members) is the 2.0 verifier's, and says so with the 2.0 layers
        if ((doc.evidence as { version?: string } | undefined)?.version !== '2.1') {
          expect(c.expect, where).toBe('refused');
          expect(v.layers.map((l) => l.id), where).toContain('govRootV3');
          expect(v.layers.map((l) => l.id), where).not.toContain('govRootV4');
          continue;
        }

        // the same layers, in the same order, for every 2.1 document
        expect(v.layers.map((l) => l.id), where).toEqual([...IN_DOCUMENT, ...OUTSIDE]);
        expect(L.govRootV4!.statement, where).toBe('S3');
        expect(v.independent, where).toBe(v.overall === 'verified');
        expect(v.govRootV3, where).toBeUndefined();

        if (walk.verdict === 'verified') {
          expect(c.expect, where).toBe('verified');
          expect(v.layers.some((l) => l.verdict === 'failed'), where).toBe(false);
          expect(v.failure, where).toBeUndefined();
          for (const id of ['trust_base', 'L4', 'L1', 'L2', 'L3', 'G0']) expect(L[id]!.verdict, `${where} ${id}`).toBe('verified');
          const r = walk.report;
          // what was not established keeps its layer from reading verified
          expect(L.G1!.verdict, `${where} G1`).toBe(r.unproven.length === 0 && r.proven.length > 0 ? 'verified' : 'not_checked');
          expect(L.L4_set!.verdict, `${where} L4_set`).toBe(r.setVerdict === 'verified' ? 'verified' : 'not_checked');
          expect(L.G1_chains!.verdict, `${where} G1_chains`).toBe(r.pageChains.length > 0 && r.pageChains.every((p) => p.bound) ? 'verified' : 'not_checked');
          // the corpus documents carry no govRootV3Inputs: the root is not derived, and the layer says why instead of failing
          expect((doc as { govRootV3Inputs?: unknown }).govRootV3Inputs, where).toBeUndefined();
          expect(L.govRootV4!.verdict, `${where} govRootV4`).toBe('not_checked');
          expect(L.govRootV4!.reason, where).toMatch(/carries no govRootV3Inputs|not verified from genesis/);
          expect(v.overall, where).toBe('partial');
          expect((v.report as { txHash: string }).txHash, where).toBe(r.txHash);
        } else if (walk.verdict === 'named') {
          // a fact the verifier will not establish, named with where it was judged: not a tamper, so not `failed`, and never a pass
          expect(c.expect, where).toBe('refused');
          expect(v.layers.some((l) => l.verdict === 'failed'), where).toBe(false);
          expect(v.failure, where).toBeUndefined();
          const carrying = v.layers.filter((l) => l.reason === walk.message);
          expect(carrying, `${where}: exactly one layer carries the named state`).toHaveLength(1);
          expect(carrying[0]!.verdict, where).toBe('not_checked');
          expect(carrying[0]!.reason, where).toContain(walk.state.code);
          expect(v.overall, where).toBe('partial');
          expect(v.report, where).toBeUndefined();
          expect(L.govRootV4!.verdict, where).toBe('not_checked');
        } else {
          // a plain refusal: a layer fails with the walk's own message
          expect(c.expect, where).toBe('refused');
          expect(v.overall, where).toBe('failed');
          expect(v.failure?.message, where).toBe(walk.message);
          const failed = v.layers.filter((l) => l.verdict === 'failed');
          expect(failed, `${where}: exactly one layer failed`).toHaveLength(1);
          expect(failed[0]!.reason, where).toBe(walk.message);
          expect(v.failure?.layer, where).toBe(failed[0]!.id);
          expect(v.report, where).toBeUndefined();
          expect(L.govRootV4!.verdict, where).toBe('not_checked');
        }
      }
    }, 120_000);
  }
});

const liveDir = new URL('./fixtures/live21-base-sepolia/', import.meta.url);
const liveDoc = (): Record<string, any> => JSON.parse(gunzipSync(readFileSync(new URL('portable.json.gz', liveDir))).toString('utf8'));
const liveBundle = (): Record<string, any> => JSON.parse(readFileSync(new URL('bundle.json', liveDir), 'utf8'));
const GOVROOT_V4 = 'fcf46aa282d2ab79cc9f8b305cd87075745e3d31e48ce5e8077d3a166a3afe17';

describe('evidence 2.1: a real proof from the hosted gateway', () => {
  it('verifies layer by layer, derives govRoot v4, and leaves finality not checked until a Settlement is named', () => {
    const v = verifyProofDocument(liveDoc());
    const L = byId(v.layers);
    for (const id of IN_DOCUMENT) expect(L[id]!.verdict, id).toBe('verified');
    expect(L.govRootV4!.evidence).toEqual({ root: GOVROOT_V4, comparedWith: null });
    expect(v.govRootV4).toBe(GOVROOT_V4);
    // the document carries a finality section; with no Settlement named, nothing of it can be judged, and the verdict says so
    expect(L.S7!.verdict).toBe('not_checked');
    expect(v.overall).toBe('partial');
    expect(v.failure).toBeUndefined();
    expect(L.G1!.evidence.authorizationMode).toBeDefined();
  }, 120_000);

  it('compares the root you expect with the one it derives: right (with or without 0x, any case) verifies, wrong fails at govRootV4', () => {
    const doc = liveDoc();
    for (const expectGovRoot of [GOVROOT_V4, `0x${GOVROOT_V4}`, GOVROOT_V4.toUpperCase()]) {
      const v = verifyProofDocument(doc, { expectGovRoot });
      expect(byId(v.layers).govRootV4!.verdict, expectGovRoot).toBe('verified');
      expect(byId(v.layers).govRootV4!.evidence.comparedWith).toBe(GOVROOT_V4);
    }
    const wrong = verifyProofDocument(doc, { expectGovRoot: `0x${'00'.repeat(32)}` });
    expect(wrong.overall).toBe('failed');
    expect(wrong.failure?.layer).toBe('govRootV4');
    expect(wrong.failure?.message).toContain(GOVROOT_V4);
    expect(byId(wrong.layers).govRootV4!.evidence).toEqual({ computed: GOVROOT_V4, expected: '00'.repeat(32) });
    // a govRoot v3 (the 2.0 value) is not the 2.1 root: it does not verify
    expect(verifyProofDocument(doc, { expectGovRoot: 'bb216d1456595e7c343fc4ceaf641bb2cc4007977d294ee672da9353969f879e' }).overall).toBe('failed');
  }, 120_000);

  it('a tampered transaction hash fails at L1, and everything after it is not reached', () => {
    const doc = liveDoc();
    const last = doc.evidence.txHash.slice(-1);
    doc.evidence.txHash = doc.evidence.txHash.slice(0, -1) + (last === '0' ? '1' : '0');
    const v = verifyProofDocument(doc);
    const L = byId(v.layers);
    expect(v.overall).toBe('failed');
    expect(v.failure?.layer).toBe('L1');
    expect(L.trust_base!.verdict).toBe('verified');
    expect(L.L4!.verdict).toBe('verified');
    expect(L.L1!.verdict).toBe('failed');
    expect(L.L1!.reason).toMatch(/receipt starts at/);
    for (const id of ['L2', 'L3', 'G0', 'G1', 'G1_chains', 'L4_set', 'govRootV4']) {
      expect(L[id]!.verdict, id).toBe('not_checked');
      expect(L[id]!.reason, id).toMatch(/not reached/);
    }
    expect(v.govRootV4).toBeUndefined();
    expect(v.report).toBeUndefined();
  }, 120_000);

  it('a different pin fails at trust_base: the document is not the incarnation it claims', () => {
    const doc = liveDoc();
    doc.pin = (doc.pin.slice(0, -1) + (doc.pin.slice(-1) === '0' ? '1' : '0')) as string;
    const v = verifyProofDocument(doc);
    expect(v.overall).toBe('failed');
    expect(v.failure?.layer).toBe('trust_base');
    expect(v.failure?.message).toMatch(/incarnation evidence is for/);
  }, 120_000);

  it('verified with the Settlement of the bundle\'s execution component, the finality layer is judged and the whole proof verifies', async () => {
    const component = liveBundle().proof_components['5_execution_proof'];
    const settlement = { chain: BigInt(component.chain_id), settlement: finality.parseSettlementJSON(JSON.stringify(component)), source: 'bundle execution component' };
    const v = await finality.verifyProofDocumentWithKinds(liveDoc(), { finality: { settlement } });
    const s7 = byId(v.layers).S7!;
    expect(s7.verdict).toBe('verified');
    expect(s7.evidence.headline).toBe('l1_posted');
    expect(s7.evidence.levels).toMatchObject({ included: { status: 'verified' }, l1_posted: { status: 'verified' }, finalized: { status: 'pending' } });
    expect(v.overall).toBe('verified');
    expect(v.independent).toBe(true);
    expect(v.covers).toContain('S7(l1_posted)');
    expect(v.govRootV4).toBe(GOVROOT_V4);
  }, 120_000);

  it('a Settlement of another chain does not verify: a supported chain other than the one the leg settled on fails the finality layer and the proof; an unsupported one is not checked, never verified', async () => {
    const component = liveBundle().proof_components['5_execution_proof'];
    const on = async (chain: bigint) =>
      finality.verifyProofDocumentWithKinds(liveDoc(), { finality: { settlement: { chain, settlement: finality.parseSettlementJSON(JSON.stringify(component)), source: 'bundle execution component' } } });
    const other = await on(421614n); // Arbitrum Sepolia: a chain the verifier supports, not the one the leg settled on
    expect(byId(other.layers).S7!.verdict).toBe('failed');
    expect(byId(other.layers).S7!.reason).toMatch(/finality_chain_broken{check="leg_binding"/);
    expect(other.overall).toBe('failed');
    const unsupported = await on(1n);
    expect(byId(unsupported.layers).S7!.verdict).toBe('not_checked');
    expect(byId(unsupported.layers).S7!.reason).toMatch(/finality_chain_unsupported/);
    expect(unsupported.overall).toBe('partial');
    expect(unsupported.independent).toBe(false);
  }, 120_000);
});
