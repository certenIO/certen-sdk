import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen proof verify`: one verdict per layer, computed here from the proof's own bytes.
 *
 * The cases pin what the command refuses to do as much as what it does: it never turns a flag in a bundle, or the gateway's
 * word, into a verdict; it names the layer a tamper fails at; and its exit code says verified (0), failed (1), partial (4)
 * or no evidence (5), with 3 left to mean only that the gateway was unreachable.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');
const run = promisify(execFile);
const confDir = join(HERE, '..', '..', 'verify', 'test', 'fixtures', 'proofv2');
const manifest = JSON.parse(readFileSync(join(confDir, 'manifest.json'), 'utf8'));
const portable = JSON.parse(gunzipSync(readFileSync(join(confDir, manifest.base))).toString('utf8'));
const execFixture = join(HERE, '..', '..', 'sdk', 'test', 'fixtures', 'execution-proof-base-46437431.json');
const execBundle = JSON.parse(readFileSync(execFixture, 'utf8'));
const LEDGER = '0x41bc4283624ff703a6e15b1c2aafae95a5eb335e';
const CLAIM_PAID = '0x81eb79acc6a0ef94dfb507ea35363f86d0d190b46f4d608dc4c1d7480a7c7cbc';
const INTENT = '396f863c-879c-4046-8591-3f0405c5f6bd';
const PROOF = '11111111-2222-4333-8444-555555555555';
const HASH = 'ab'.repeat(32);

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
async function stub(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => { try { handler(req, res); } catch { res.statusCode = 500; res.end('{}'); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };

interface Run { stdout: string; stderr: string; code: number; home: string }
async function certen(args: string[], apiUrl = 'http://127.0.0.1:1'): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'certen-pv-'));
  const env = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home, CERTEN_API_URL: apiUrl, CERTEN_API_KEY: 'ck_live_test' };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: home, timeout: 120000 });
    return { stdout, stderr, code: 0, home };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1, home };
  }
}
const data = (r: Run) => (JSON.parse(r.stdout.trim()) as { data: any }).data;
const fileOf = (o: unknown) => { const p = join(mkdtempSync(join(tmpdir(), 'certen-pvf-')), 'proof.json'); writeFileSync(p, JSON.stringify(o)); return p; };
const verdicts = (d: { layers: { id: string; verdict: string }[] }) => Object.fromEntries(d.layers.map((l) => [l.id, l.verdict]));

describe('proof verify from a portable document', () => {
  it('prints a verdict for every layer with the evidence it was checked against; exits 4 while a layer is not established', async () => {
    const r = await certen(['proof', 'verify', `@${fileOf(portable)}`]);
    expect(r.code).toBe(4);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/Verdict: PARTIAL/);
    for (const id of ['trust_base', 'L4', 'L1', 'L2', 'L3', 'G0', 'G1', 'L4_set', 'govRootV3']) expect(out).toMatch(new RegExp(`${id}\\s+verified`));
    expect(out).toMatch(/G1_chains\s+NOT CHECKED/);
    expect(out).toMatch(/G2\s+not carried/);
    expect(out).toMatch(/incarnation [0-9a-f]{12}…/);
    expect(out).toMatch(/This is not a verified proof/);
  }, 120000);

  it('--json carries the same layers, the statements covered and not, and independent:false', async () => {
    const r = await certen(['--json', 'proof', 'verify', `@${fileOf(portable)}`]);
    expect(r.code).toBe(4);
    const d = data(r);
    expect(d.overall).toBe('partial');
    expect(d.independent).toBe(false);
    expect(d.covers).toEqual([]);
    expect(d.notCovered).toEqual(expect.arrayContaining(['S1', 'S2', 'S3(b)', 'S4']));
    expect(verdicts(d)).toMatchObject({ trust_base: 'verified', L4: 'verified', L1: 'verified', govRootV3: 'verified', G1_chains: 'not_checked' });
    expect(d.layers.find((l: { id: string }) => l.id === 'L3').evidence.certifiedRoot).toMatch(/^[0-9a-f]{64}$/);
  }, 120000);

  it('a flag in the document is not a verdict: tampering one byte exits 1 at the layer it is in', async () => {
    const bad = JSON.parse(JSON.stringify(portable));
    bad.verified = true;
    bad.evidence.receipt.entries[0].hash = 'cd'.repeat(32);
    const r = await certen(['--json', 'proof', 'verify', `@${fileOf(bad)}`]);
    expect(r.code).toBe(1);
    const d = data(r);
    expect(d.overall).toBe('failed');
    expect(d.failure.layer).toBe('L1');
    expect(d.independent).toBe(false);
    const human = await certen(['proof', 'verify', `@${fileOf(bad)}`]);
    expect(human.stdout + human.stderr).toMatch(/FAILED at L1/);
    expect(human.stdout + human.stderr).toMatch(/Do not rely on this proof/);
  }, 240000);

  it('each of the conformance suite\'s attacks exits 1 through the CLI, naming a layer', async () => {
    const attacks = manifest.cases.filter((c: { expect: string }) => c.expect === 'refused').slice(0, 6);
    for (const c of attacks) {
      const doc = JSON.parse(JSON.stringify(portable));
      for (const op of c.patch ?? []) {
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
      const r = await certen(['--json', 'proof', 'verify', `@${fileOf(doc)}`]);
      expect(r.code, c.name).toBe(1);
      expect(data(r).failure.layer, c.name).toBeTruthy();
    }
  }, 600000);
});

describe('proof verify with the execution component', () => {
  const both = () => fileOf({ ...execBundle, proof_v2: portable });

  it('without --rpc the receipts root is the validators\' statement: the outcome is NOT CHECKED, naming why', async () => {
    const r = await certen(['--json', 'proof', 'verify', `@${both()}`, '--expect', `${LEDGER}:${CLAIM_PAID}`]);
    const d = data(r);
    const o = d.layers.find((l: { id: string }) => l.id === 'outcome');
    expect(o.verdict).toBe('not_checked');
    expect(o.reason).toMatch(/validators' statement/);
    expect(o.evidence).toMatchObject({ chainId: expect.anything(), status: 1, expectedEventFound: true });
    expect(r.code).toBe(4);
  }, 120000);

  it('--rpc compares the receipts root with the header from your node, and the outcome is verified', async () => {
    const c = execBundle.proof_components['5_execution_proof'];
    const node = await stub((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => json(res, 200, { jsonrpc: '2.0', id: 1, result: { number: '0x' + Number(c.block_number).toString(16), hash: c.block_hash, receiptsRoot: c.receipts_root } }));
    });
    try {
      const r = await certen(['--json', 'proof', 'verify', `@${both()}`, '--rpc', node.url, '--expect', `${LEDGER}:${CLAIM_PAID}`]);
      expect(verdicts(data(r)).outcome).toBe('verified');
      expect(data(r).execution.ok).toBe(true);
      expect(r.code).toBe(4); // still partial: the capture's page chains are unbound
    } finally { await node.close(); }
  }, 120000);

  it('a header that disagrees fails the outcome, exit 1', async () => {
    const node = await stub((_req, res) => json(res, 200, { jsonrpc: '2.0', id: 1, result: { number: '0x1', hash: '0x' + '00'.repeat(32), receiptsRoot: '0x' + '00'.repeat(32) } }));
    try {
      const r = await certen(['proof', 'verify', `@${both()}`, '--rpc', node.url]);
      expect(r.code).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/FAILED at outcome/);
    } finally { await node.close(); }
  }, 120000);

  it('an expected event that is not in the receipt fails the outcome', async () => {
    const r = await certen(['--json', 'proof', 'verify', `@${both()}`, '--expect', `${LEDGER}:${CLAIM_PAID}:0x${'ab'.repeat(32)}`]);
    expect(r.code).toBe(1);
    expect(data(r).failure.layer).toBe('outcome');
  }, 120000);

  it('a tampered receipt fails the outcome while the document still verifies', async () => {
    const bad = JSON.parse(JSON.stringify(execBundle));
    const c = bad.proof_components['5_execution_proof'];
    c.raw_receipt = c.raw_receipt.slice(0, -2) + (c.raw_receipt.endsWith('00') ? '01' : '00');
    const r = await certen(['--json', 'proof', 'verify', `@${fileOf({ ...bad, proof_v2: portable })}`]);
    const d = data(r);
    expect(d.failure.layer).toBe('outcome');
    expect(verdicts(d).L4).toBe('verified');
    expect(r.code).toBe(1);
  }, 120000);
});

describe('proof verify without evidence never reads a flag', () => {
  it('a bundle that only says verified:true is no evidence: exit 5, independent false, the claim shown as the validators\'', async () => {
    const r = await certen(['--json', 'proof', 'verify', `@${fileOf({ verified: true, proof_components: { '3_chained_proof': { verified: true } } })}`]);
    expect(r.code).toBe(5);
    const d = data(r);
    expect(d.overall).toBe('no_evidence');
    expect(d.independent).toBe(false);
    expect(d.covers).toEqual([]);
    expect(d.bundleStatements).toEqual({ verified: true, chainedProofVerified: true });
    const human = await certen(['proof', 'verify', `@${fileOf({ verified: true })}`]);
    expect(human.stdout + human.stderr).toMatch(/It was not used/);
  }, 120000);

  it('a live proof the gateway serves no proof v2 document for: PROOF_V2_EVIDENCE_NOT_SERVED, exit 5, and the gateway\'s own receipt is shown as not used', async () => {
    const gw = await stub((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url === `/v1/transaction/${INTENT}`) return json(res, 200, { intent_id: INTENT, status: 'completed', proof_id: PROOF, accum_tx_hash: `acc://${HASH}@x.acme/data` });
      if (url === `/v1/proof/${PROOF}/v2`) return json(res, 404, { code: 'NOT_FOUND', error: 'no route' });
      if (url === `/v1/proof/${PROOF}/bundle`) return json(res, 502, {});
      if (url === `/v1/proof/tx/${HASH}/receipt`) return json(res, 200, { tx_hash: HASH, anchored: true, status: 'delivered', receipt: { anchor: 'cd'.repeat(32) } });
      return json(res, 404, {});
    });
    try {
      const r = await certen(['--json', 'proof', 'verify', INTENT], gw.url);
      expect(r.code).toBe(5);
      const d = data(r);
      expect(d.overall).toBe('no_evidence');
      expect(d.evidence).toMatchObject({ found: false, code: 'PROOF_V2_EVIDENCE_NOT_SERVED' });
      expect(d.gateway).toMatchObject({ anchored: true, note: expect.stringMatching(/not used in the verdict/) });
      expect(verdicts(d).L4).toBe('not_checked');
      const human = await certen(['proof', 'verify', INTENT], gw.url);
      expect(human.stdout + human.stderr).toMatch(/PROOF_V2_EVIDENCE_NOT_SERVED/);
      expect(human.stdout + human.stderr).toMatch(/not verification, and it was not used/);
    } finally { await gw.close(); }
  }, 120000);

  it('a proof service that is down is reported as unavailable, not as there being no proof', async () => {
    const gw = await stub((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url === `/v1/transaction/${INTENT}`) return json(res, 200, { intent_id: INTENT, status: 'completed', proof_id: PROOF, accum_tx_hash: `acc://${HASH}@x.acme/data` });
      if (url.startsWith('/v1/proof/') && !url.includes('/tx/')) { res.statusCode = 502; res.setHeader('content-type', 'text/plain'); return void res.end('Bad Gateway'); }
      return json(res, 404, {});
    });
    try {
      const r = await certen(['--json', 'proof', 'verify', INTENT], gw.url);
      expect(r.code).toBe(5);
      expect(data(r).evidence.code).toBe('PROOF_SERVICE_UNAVAILABLE');
    } finally { await gw.close(); }
  }, 120000);

  it('serves the document when the gateway has it: the live leg runs the same engine', async () => {
    const gw = await stub((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url === `/v1/transaction/${INTENT}`) return json(res, 200, { intent_id: INTENT, status: 'completed', proof_id: PROOF });
      if (url === `/v1/proof/${PROOF}/v2`) return json(res, 200, portable);
      return json(res, 404, {});
    });
    try {
      const r = await certen(['--json', 'proof', 'verify', INTENT], gw.url);
      expect(verdicts(data(r))).toMatchObject({ L4: 'verified', L1: 'verified', govRootV3: 'verified' });
      expect(data(r).evidence.found).toBe(true);
      expect(r.code).toBe(4);
    } finally { await gw.close(); }
  }, 120000);

  it('is a usage error when the file cannot be read as JSON (exit 2), and exit 3 still means only an unreachable gateway', async () => {
    const r = await certen(['--json', 'proof', 'verify', '@nosuchfile.json']);
    expect(r.code).toBe(2);
    const unreachable = await certen(['--json', 'proof', 'verify', INTENT]);
    expect(unreachable.code).toBe(3);
  }, 120000);
});

describe('the exit codes are in the machine-readable contract', () => {
  it('lists 4 and 5 beside the existing four', async () => {
    const r = await certen(['--json', '--help']);
    expect((JSON.parse(r.stdout.trim()) as { data: { exitCodes: Record<string, string> } }).data.exitCodes).toMatchObject({
      0: 'ok', 1: 'operation failed', 2: 'usage error', 3: 'gateway unreachable',
      4: expect.stringMatching(/partial/), 5: expect.stringMatching(/no evidence/),
    });
  });
});
