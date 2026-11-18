/**
 * AGT-3: revoke (Grant superseded with an empty validity; the agent's key removed by the owner's page), cancel by reject vote, and replace.
 * Every signature is checked against what was asked before it exists; every revoke or cancel result carries the DEC-2 statement:
 * before final approval a reject vote or key removal stops the action; after certification exposure is limited to the exact approved
 * action inside its window; there is no on-chain cancel. FICTIONAL parties and throwaway keys.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { CertenClient, ed25519Signer, coreVerdict, cancelByRejectVote, replaceAgent, revocationOf, revokeAgentKey, revokeGrant, EXPOSURE_WINDOW_STATEMENT } from '../src/index.js';
import { hashGrant } from '../src/core/hashes.js';
import { honestCosign, honestGovernance } from './helpers/honest-gateway.js';
import golden from './fixtures/certen-vectors/principal-entries.golden.json' with { type: 'json' };

interface Req { method: string; path: string; body?: any }
async function gateway(handler: (e: Req) => { status?: number; body?: unknown }) {
  const seen: Req[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const e: Req = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0], body: raw ? JSON.parse(raw) : undefined };
    seen.push(e);
    const out = handler(e);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
const clientFor = (url: string) => new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });
const PRINCIPAL = 'acc://harbor-mfg.acme';
const PAGE = `${PRINCIPAL}/book/1`;
const AGENT = 'acc://agent-7.harbor-mfg.acme';
const AGENT_PAGE = `${AGENT}/book/1`;
const WHO = { seat: 'seat:harbor-supervisor', reason: 'Agent compromised in the lab drill; revoking it.' };
const grant = golden.cases.find((c: any) => c.kind === 'grant')!.document as Record<string, any>;
const registration = golden.cases.find((c: any) => c.kind === 'registration')!.document as Record<string, any>;
const signatures = (seen: Req[]) => seen.filter((e) => e.path.endsWith('/signature'));

describe('revoke: the Grant superseded with an empty validity', () => {
  it('revocationOf: version + 1, prior hash = the head\'s core hash, an empty validity; the core accepts it', () => {
    const r = revocationOf(grant, 1793060000) as any;
    expect([r.version, r.priorHash, r.validity.notAfter - r.validity.notBefore]).toEqual([grant.version + 1, hashGrant(grant), 0]);
    expect(coreVerdict('grant', r)).toBeNull();
  });
  it('revokeGrant writes it through issueGrant (exact bytes, the principal\'s page) and states the exposure window', async () => {
    const gw = await gateway((e) => e.path === '/v1/governance'
      ? (e.body.operations[0].type === 'create_data_account' ? { status: 409, body: { error: 'exists', code: 'DATA_ACCOUNT_EXISTS' } } : honestGovernance(e.body.operations[0], PRINCIPAL, { publicKey: e.body.signer_public_key, keyPage: e.body.signer_key_page }))
      : { body: { status: 'completed', tx_hash: 'tx-rev' } });
    try {
      const r = await revokeGrant(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, head: grant, issuedAt: 1793060000, signer: ed25519Signer(), ...WHO });
      expect(r).toMatchObject({ seat: WHO.seat, exposureWindow: EXPOSURE_WINDOW_STATEMENT });
      expect(JSON.parse(r.entry.texts[0]).validity).toEqual({ notBefore: grant.validity.notBefore, notAfter: grant.validity.notBefore });
      expect(signatures(gw.seen)).toHaveLength(1);
    } finally { gw.close(); }
  });
});

describe('revoke: the owner removes the agent\'s key (the existing governance remove_key, signed by the owner\'s page)', () => {
  it('the op is exactly remove_key on the agent\'s page, with the owner\'s page and key as signer; the rebuilt transaction is checked', async () => {
    const key = ed25519Signer();
    const gw = await gateway((e) => e.path === '/v1/governance'
      ? honestGovernance(e.body.operations[0], AGENT, { publicKey: e.body.signer_public_key, keyPage: e.body.signer_key_page })
      : { body: { status: 'pending_signatures', tx_hash: 'tx-rm' } });
    try {
      const r = await revokeAgentKey(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, agentPage: AGENT_PAGE, keyHash: 'c'.repeat(64), signer: key, ...WHO });
      const create = gw.seen.find((e) => e.path === '/v1/governance')!;
      expect(create.body).toEqual({ identity: PRINCIPAL, operations: [{ type: 'remove_key', public_key_hash: 'c'.repeat(64) }], key_page_url: AGENT_PAGE, signer_key_page: PAGE, signer_public_key: key.publicKey });
      expect(signatures(gw.seen)).toHaveLength(1);
      expect(r).toMatchObject({ agentPage: AGENT_PAGE, txHash: 'tx-rm', exposureWindow: EXPOSURE_WINDOW_STATEMENT });
    } finally { gw.close(); }
  });
  it('a gateway that returns another operation (an add) gets no signature', async () => {
    const gw = await gateway((e) => e.path === '/v1/governance'
      ? honestGovernance({ type: 'add_key', public_key_hash: 'd'.repeat(64) }, AGENT, { publicKey: e.body.signer_public_key, keyPage: e.body.signer_key_page })
      : { body: {} });
    try {
      await expect(revokeAgentKey(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, agentPage: AGENT_PAGE, keyHash: 'c'.repeat(64), signer: ed25519Signer(), ...WHO })).rejects.toMatchObject({ code: 'SIGNING_DATA_MISMATCH' });
      expect(signatures(gw.seen)).toHaveLength(0);
    } finally { gw.close(); }
  });
});

describe('cancel by reject vote', () => {
  const real = JSON.parse(readFileSync(new URL('../../verify/test/fixtures/signing-vectors.json', import.meta.url), 'utf8')).vectors.find((v: any) => v.label === 'four-leg');
  const officer = `${PRINCIPAL}/officers/1`;
  it('opens a REJECT sign request on the pending transaction, checks the rebuilt signing data (transaction, vote reject, signer), signs, and states the exposure window', async () => {
    const key = ed25519Signer();
    const gw = await gateway((e) => e.path === '/v1/sign' ? honestCosign(real, { publicKey: key.publicKey, signer: officer, vote: 'reject' }) : { body: { status: 'submitted' } });
    try {
      const r = await cancelByRejectVote(clientFor(gw.url), { identity: PRINCIPAL, txHash: real.txid, signerUrl: officer, signer: key, ...WHO });
      expect(gw.seen[0]!.body).toMatchObject({ type: 'pending_tx', vote: 'reject' });
      expect(JSON.stringify(gw.seen[0]!.body)).toContain(key.publicKey);
      expect(signatures(gw.seen)).toHaveLength(1);
      expect(r).toMatchObject({ vote: 'reject', txHash: String(real.txid).match(/[0-9a-f]{64}/)![0], exposureWindow: EXPOSURE_WINDOW_STATEMENT });
    } finally { gw.close(); }
  });
  it('signing data whose vote is accept (not reject) gets no signature', async () => {
    const key = ed25519Signer();
    const gw = await gateway((e) => e.path === '/v1/sign' ? honestCosign(real, { publicKey: key.publicKey, signer: officer }) : { body: {} });
    try {
      await expect(cancelByRejectVote(clientFor(gw.url), { identity: PRINCIPAL, txHash: real.txid, signerUrl: officer, signer: key, ...WHO })).rejects.toMatchObject({ code: 'SIGNING_DATA_MISMATCH' });
      expect(signatures(gw.seen)).toHaveLength(0);
    } finally { gw.close(); }
  });
});

describe('replace, and the person-held act', () => {
  it('replace retires the old registration, registers the new agent and issues its own Grant (three writes, each judged by the core)', async () => {
    const gw = await gateway((e) => e.path === '/v1/governance'
      ? (e.body.operations[0].type === 'create_data_account' ? { status: 409, body: { error: 'exists', code: 'DATA_ACCOUNT_EXISTS' } } : honestGovernance(e.body.operations[0], PRINCIPAL, { publicKey: e.body.signer_public_key, keyPage: e.body.signer_key_page }))
      : { body: { status: 'completed' } });
    const NEW = 'acc://agent-8.harbor-mfg.acme';
    try {
      const r = await replaceAgent(clientFor(gw.url), {
        principal: PRINCIPAL, page: PAGE, signer: ed25519Signer(), ...WHO,
        retiredRegistration: { ...registration, status: 'retired' },
        newRegistration: { ...registration, adi: NEW },
        newGrant: { ...grant, grantId: 'agent8-vendor-pay', subject: { type: 'agent', adi: NEW } },
      });
      expect([r.retired.entry.account, r.registered.entry.account, r.grant.entry.account]).toEqual([`${PRINCIPAL}/certen-subjects`, `${PRINCIPAL}/certen-subjects`, `${PRINCIPAL}/certen-grants`]);
      expect(r.exposureWindow).toBe(EXPOSURE_WINDOW_STATEMENT);
    } finally { gw.close(); }
  });
  it('no named seat or a short reason: refused before any request or key use', async () => {
    const gw = await gateway(() => ({ body: {} }));
    const noKey = { publicKey: '1f'.repeat(32), sign: () => { throw new Error('a key was used'); } };
    try {
      await expect(revokeAgentKey(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, agentPage: AGENT_PAGE, keyHash: 'c'.repeat(64), signer: noKey, seat: 'supervisor', reason: WHO.reason })).rejects.toMatchObject({ code: 'INTERVENTION_MALFORMED' });
      await expect(cancelByRejectVote(clientFor(gw.url), { identity: PRINCIPAL, txHash: 'ab'.repeat(32), signerUrl: PAGE, signer: noKey, seat: WHO.seat, reason: 'short' })).rejects.toMatchObject({ code: 'INTERVENTION_MALFORMED' });
      await expect(revokeGrant(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, head: grant, signer: noKey, seat: WHO.seat, reason: '' })).rejects.toMatchObject({ code: 'INTERVENTION_MALFORMED' });
      expect(gw.seen).toEqual([]);
    } finally { gw.close(); }
  });
});
