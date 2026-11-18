/**
 * AGT-2 (AGT-F20): the principal registers its agent, issues the Grant and signs the mandate through the gateway's two-phase governance
 * route. Each entry's account is created when absent (authority: the principal's own book alone), the entry bytes are exactly what the
 * SDK built (and the tcl encoders build: principal-entries.vectors.test.ts), and every signature is the principal's key on the principal's
 * page. The signing data is checked against the request before anything is signed. FICTIONAL parties and a throwaway key.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createPublicKey, verify } from 'node:crypto';
import { CertenClient, ed25519Signer, buildPrincipalEntry, envelopeDigestHex, issueMandate, issueGrant, registerAgent } from '../src/index.js';
import { honestGovernance } from './helpers/honest-gateway.js';
import golden from './fixtures/certen-vectors/principal-entries.golden.json' with { type: 'json' };

interface Req { method: string; path: string; body?: any }
async function gateway(handler: (e: Req, n: number) => { status?: number; body?: unknown }) {
  const seen: Req[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const entry: Req = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0], body: raw ? JSON.parse(raw) : undefined };
    seen.push(entry);
    const out = handler(entry, seen.length);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
const clientFor = (url: string) => new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });

const PRINCIPAL = 'acc://harbor-mfg.acme';
const PAGE = `${PRINCIPAL}/book/1`;
const mandate = (golden.cases.find((c) => c.kind === 'mandate')!.document) as Record<string, unknown>;
const grant = (golden.cases.find((c) => c.kind === 'grant')!.document) as Record<string, unknown>;
const registration = (golden.cases.find((c) => c.kind === 'registration')!.document) as Record<string, unknown>;

/** An honest gateway: create answers with signing data for exactly the operation asked; submit answers with a tx hash. */
function honest(exists = false) {
  return (e: Req) => {
    if (e.path === '/v1/governance') {
      const op = e.body.operations[0];
      if (op.type === 'create_data_account' && exists) return { status: 409, body: { error: `${op.account_url} already exists`, code: 'DATA_ACCOUNT_EXISTS' } };
      return honestGovernance(op, PRINCIPAL, { id: op.type === 'write_data' ? 'gov-write' : 'gov-create', publicKey: e.body.signer_public_key, keyPage: e.body.signer_key_page });
    }
    if (e.path.endsWith('/signature')) return { body: { status: 'completed', tx_hash: e.path.includes('gov-write') ? 'tx-write' : 'tx-create' } };
    return { status: 404, body: {} };
  };
}

describe('issueMandate: account created when absent, the entry written byte for byte, every signature the principal\'s', () => {
  it('creates <principal>/certen-mandates held by the principal\'s book alone, then writes the canonical mandate and its signed envelope', async () => {
    const key = ed25519Signer();
    const gw = await gateway(honest());
    try {
      const r = await issueMandate(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, mandate, signer: key });
      const creates = gw.seen.filter((e) => e.path === '/v1/governance');
      expect(creates.map((e) => e.body.operations[0])).toEqual([
        { type: 'create_data_account', account_url: `${PRINCIPAL}/certen-mandates` },
        { type: 'write_data', account_url: `${PRINCIPAL}/certen-mandates`, entries: r.entry.elements },
      ]);
      expect(creates.every((e) => e.body.signer_key_page === PAGE && e.body.signer_public_key === key.publicKey)).toBe(true);
      expect(r).toMatchObject({ accountCreated: true, createTx: 'tx-create', writeTx: 'tx-write' });
      // element 0 is the canonical mandate; element 1 the envelope over its hash, signed by the principal's key for the principal's page
      expect(Buffer.from(r.entry.elements[0], 'hex').toString('utf8')).toBe(r.entry.texts[0]);
      const env = JSON.parse(Buffer.from(r.entry.elements[1], 'hex').toString('utf8'));
      expect(env).toMatchObject({ payloadTag: 'certen:mandate:v1', payloadHash: golden.cases[0]!.hash, signatures: [{ alg: 'ed25519', page: PAGE, publicKey: key.publicKey }] });
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key.publicKey, 'hex')]);
      expect(verify(null, Buffer.from(envelopeDigestHex('certen:mandate:v1', env.payloadHash, PAGE), 'hex'), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(env.signatures[0].signature, 'hex'))).toBe(true);
      // the Accumulate signatures are over the hash the gateway returned, checked first
      const sigs = gw.seen.filter((e) => e.path.endsWith('/signature'));
      expect(sigs).toHaveLength(2);
      expect(sigs.every((e) => e.body.public_key === key.publicKey)).toBe(true);
    } finally { gw.close(); }
  });
  it('an existing account (DATA_ACCOUNT_EXISTS) is written to as it is, not created again', async () => {
    const gw = await gateway(honest(true));
    try {
      const r = await issueMandate(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, mandate, signer: ed25519Signer() });
      expect(r.accountCreated).toBe(false);
      expect(gw.seen.filter((e) => e.path.endsWith('/signature'))).toHaveLength(1);
    } finally { gw.close(); }
  });
  it('a gateway that returns another transaction than the one asked for gets no signature', async () => {
    const key = ed25519Signer();
    const gw = await gateway((e) => {
      if (e.path === '/v1/governance') {
        const op = e.body.operations[0];
        // the account would also be held by the bridge's book
        if (op.type === 'create_data_account') {
          const out = honestGovernance({ type: 'create_data_account', account_url: op.account_url }, PRINCIPAL, { publicKey: e.body.signer_public_key, keyPage: e.body.signer_key_page });
          return honestTampered(out, op.account_url, e);
        }
      }
      return { status: 500, body: {} };
    });
    try {
      await expect(issueMandate(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, mandate, signer: key })).rejects.toMatchObject({ code: 'SIGNING_DATA_MISMATCH' });
      expect(gw.seen.filter((e) => e.path.endsWith('/signature'))).toHaveLength(0);
    } finally { gw.close(); }
  });
  it('a write whose bytes differ from the entry built gets no signature', async () => {
    const gw = await gateway((e) => {
      if (e.path === '/v1/governance') {
        const op = e.body.operations[0];
        if (op.type === 'create_data_account') return { status: 409, body: { error: 'exists', code: 'DATA_ACCOUNT_EXISTS' } };
        return honestGovernance({ ...op, entries: [op.entries[0], op.entries[1].slice(0, -2) + '20'] }, PRINCIPAL, { publicKey: e.body.signer_public_key, keyPage: e.body.signer_key_page });
      }
      return { status: 500, body: {} };
    });
    try {
      await expect(issueMandate(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, mandate, signer: ed25519Signer() })).rejects.toMatchObject({ code: 'SIGNING_DATA_MISMATCH' });
      expect(gw.seen.filter((e) => e.path.endsWith('/signature'))).toHaveLength(0);
    } finally { gw.close(); }
  });
});

/** The honest create answer, rebuilt with an extra authority (and hashed honestly, so only the content check can catch it). */
function honestTampered(_out: unknown, account: string, e: Req) {
  return honestGovernanceWith({ type: 'createDataAccount', url: account, authorities: [`${PRINCIPAL}/book`, 'acc://bridge.acme/book'] }, PRINCIPAL, e);
}
import { reconstructSigning } from '@certen.io/proof-verify';
function honestGovernanceWith(body: Record<string, unknown>, principal: string, e: Req) {
  const metadata = { type: 'ed25519', public_key: e.body.signer_public_key, signer: e.body.signer_key_page, signer_version: 1, timestamp_us: 1790000000000000 };
  const transaction = { header: { principal }, body };
  const r = reconstructSigning(transaction, metadata);
  return { status: 201, body: { governance_op_id: 'gov-bad', status: 'pending_signature', signing_data: { transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: { ...transaction, header: { ...transaction.header, initiator: r.signatureMetadataHash } }, signature_metadata: metadata } } };
}

describe('registerAgent and issueGrant: the same path, their own accounts', () => {
  it('the registration goes to certen-subjects and the Grant to certen-grants', async () => {
    const gw = await gateway(honest());
    try {
      const a = await registerAgent(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, registration, signer: ed25519Signer() });
      const b = await issueGrant(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, grant, signer: ed25519Signer() });
      expect([a.entry.account, a.entry.tag, b.entry.account, b.entry.tag]).toEqual([`${PRINCIPAL}/certen-subjects`, 'certen:subject:v2', `${PRINCIPAL}/certen-grants`, 'certen:grant:v1']);
    } finally { gw.close(); }
  });
});

describe('refused before anything is sent or signed', () => {
  const signer = { publicKey: '1f'.repeat(32), sign: () => { throw new Error('must not sign'); } };
  it('a document that is not the principal\'s, a page outside its ADI, an unknown schema, a registration that is not an agent, a float', () => {
    expect(() => buildPrincipalEntry({ kind: 'mandate', principal: PRINCIPAL, page: 'acc://other.acme/book/1', document: mandate, signer })).toThrow(expect.objectContaining({ code: 'PRINCIPAL_PAGE_INVALID' }));
    expect(() => buildPrincipalEntry({ kind: 'mandate', principal: PRINCIPAL, page: `${PRINCIPAL}/clerks/1`, document: mandate, signer })).toThrow(expect.objectContaining({ code: 'PRINCIPAL_ENTRY_NOT_PRINCIPALS' }));
    expect(() => buildPrincipalEntry({ kind: 'grant', principal: PRINCIPAL, page: PAGE, document: { ...grant, schema: 'certen.grant/v9' }, signer })).toThrow(expect.objectContaining({ code: 'PRINCIPAL_ENTRY_MALFORMED' }));
    expect(() => buildPrincipalEntry({ kind: 'registration', principal: PRINCIPAL, page: PAGE, document: { ...registration, type: 'person' }, signer })).toThrow(expect.objectContaining({ code: 'PRINCIPAL_ENTRY_MALFORMED' }));
    expect(() => buildPrincipalEntry({ kind: 'mandate', principal: PRINCIPAL, page: PAGE, document: { ...mandate, issuedAt: 1.5 }, signer })).toThrow(expect.objectContaining({ code: 'PRINCIPAL_ENTRY_MALFORMED' }));
  });
});
