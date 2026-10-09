import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { CertenClient, CertenAgent, ed25519Signer, CertenSigningDataError } from '../src/index.js';
import { honestIntent, honestGovernance, honestCosign } from './helpers/honest-gateway.js';

/**
 * No external-mode signature is made for a transaction that is not the one asked for.
 *
 * Before this check, `execute.open` signed whatever `signing_data.hash_to_sign` the gateway returned: a gateway (or anything between you
 * and it) that returned the hash of a different transaction got a valid signature on it. Each case here is a gateway that does that in
 * one way, and each must end with the signer never called and no signature posted.
 */
interface Req { method: string; path: string; body?: any }
async function gateway(handler: (e: Req) => Promise<{ status?: number; body?: unknown }> | { status?: number; body?: unknown }) {
  const seen: Req[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const entry: Req = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0], body: raw ? JSON.parse(raw) : undefined };
    seen.push(entry);
    const out = await handler(entry);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
const clientFor = (url: string) => new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });

const PUBKEY = '11'.repeat(32);
const TARGET = `0x${'22'.repeat(20)}`;
const EVIL = `0x${'dd'.repeat(20)}`;
const CALL = {
  identityId: 'id-1', adiUrl: 'acc://seller-bot.acme', fromAddress: `0x${'ab'.repeat(20)}`, chain: 'ethereum-sepolia', chainId: 11155111,
  contractCall: { target: TARGET, functionSignature: 'confirm(bytes32)', args: [`0x${'ab'.repeat(32)}`], value: '5' },
  publicKey: PUBKEY, skipFundingCheck: true,
};
/** Some requests cannot be given a meaning, so the gateway cannot build their transaction; it answers with an unrelated, well-formed one. */
const unrelated = () => honestIntent({ intent: { adiUrl: 'acc://seller-bot.acme', legs: [{ chainId: 11155111, toAddress: TARGET, amount: '0', contractCall: { target: TARGET } }] } }, { publicKey: PUBKEY });
const submitted = (g: { seen: Req[] }) => g.seen.filter((e) => e.path.endsWith('/signature') && e.method === 'POST');
const isOpen = (e: Req) => e.path === '/v1/transaction' && e.method === 'POST';

/** An honest gateway whose answer is then tampered with. */
const tampered = (tamper: (body: any, honest: any) => void) => async (e: Req) => {
  if (!isOpen(e)) return { body: { ok: true } };
  const h = await honestIntent(e.body, { publicKey: PUBKEY });
  tamper(e.body, h.body);
  return h;
};
const blobs = (tx: any) => tx.body.entry.data.map((h: string) => JSON.parse(Buffer.from(h, 'hex').toString()));
const setBlobs = (tx: any, b: unknown[]) => { tx.body.entry.data = b.map((x) => Buffer.from(JSON.stringify(x)).toString('hex')); };

async function expectRefused(handler: Parameters<typeof gateway>[0], code: string, field?: string) {
  const g = await gateway(handler);
  let signed = 0;
  try {
    const err = await clientFor(g.url).execute.contractCall({ ...CALL, sign: () => { signed++; return 'ff'.repeat(64); } }).catch((e) => e);
    expect(err).toBeInstanceOf(CertenSigningDataError);
    expect(err.code).toBe(code);
    if (field) expect(err.details).toMatchObject({ field });
    expect(signed, 'the signer must never be called').toBe(0);
    expect(submitted(g), 'no signature may be posted').toHaveLength(0);
    return err;
  } finally { g.close(); }
}

describe('execute.contractCall refuses to sign what it did not ask for', () => {
  it('signs when the transaction is exactly what was asked for, and shows what it authorised', async () => {
    const g = await gateway(async (e) => (isOpen(e) ? honestIntent(e.body, { publicKey: PUBKEY }) : { body: { ok: true } }));
    try {
      const seen: string[] = [];
      const out = await clientFor(g.url).execute.contractCall({ ...CALL, sign: (h) => `sig:${h}`, beforeSign: (s) => { seen.push(...s.text); } });
      expect(submitted(g)).toHaveLength(1);
      expect(submitted(g)[0].body.signature).toBe(`sig:${out.signing!.hashes.toSign}`);
      expect(out.signing!.legs[0]).toMatchObject({ target: TARGET, valueWei: '5', chainId: 11155111 });
      expect(seen.join('\n')).toMatch(/value 5 wei/);
    } finally { g.close(); }
  });

  it('a hash_to_sign that belongs to a different transaction (fail-before: this was signed)', async () => {
    await expectRefused(tampered((_b, h) => { h.signing_data.hash_to_sign = 'ab'.repeat(32); }), 'SIGNING_DATA_MISMATCH', 'hash_to_sign');
  });

  it('only a hash, as every gateway returned before: nothing to check, nothing signed', async () => {
    await expectRefused(async (e) => (isOpen(e)
      ? { status: 201, body: { intent_id: 'intent-1', signing_mode: 'external', signing_data: { hash_to_sign: 'ab'.repeat(32), transaction_hash: 'cd'.repeat(32) }, submit_url: '/v1/transaction/intent-1/signature' } }
      : { body: {} }), 'SIGNING_DATA_ABSENT');
  });

  it('a recipient swapped in a body whose hash was recomputed to match (every hash agrees; only the request disagrees)', async () => {
    const { reconstructSigning } = await import('@certen.io/proof-verify');
    await expectRefused(tampered((_b, h) => {
      const tx = h.signing_data.transaction;
      const b = blobs(tx);
      b[1].legs[0].executionPayload.target = EVIL;
      setBlobs(tx, b);
      const { initiator, ...header } = tx.header;
      const r = reconstructSigning({ header, body: tx.body }, h.signing_data.signature_metadata);
      tx.header = { ...header, initiator: r.signatureMetadataHash };
      h.signing_data.transaction_hash = r.transactionHash;
      h.signing_data.hash_to_sign = r.hashToSign;
    }), 'SIGNING_DATA_MISMATCH', 'legs[0].target');
  });

  it('the right hash but a body whose value was altered', async () => {
    await expectRefused(tampered((_b, h) => {
      const tx = h.signing_data.transaction;
      const b = blobs(tx);
      b[1].legs[0].executionPayload.value = '5000000000000000000';
      setBlobs(tx, b);
    }), 'SIGNING_DATA_MISMATCH');
  });

  it('a key other than the one that will sign, an unrequested extra authority, and a different intent', async () => {
    const { reconstructSigning } = await import('@certen.io/proof-verify');
    const rehash = (h: any) => {
      const tx = h.signing_data.transaction;
      const { initiator, ...header } = tx.header;
      const r = reconstructSigning({ header, body: tx.body }, h.signing_data.signature_metadata);
      tx.header = { ...header, initiator: r.signatureMetadataHash };
      h.signing_data.transaction_hash = r.transactionHash;
      h.signing_data.hash_to_sign = r.hashToSign;
    };
    await expectRefused(tampered((_b, h) => { h.signing_data.signature_metadata.public_key = '99'.repeat(32); rehash(h); }), 'SIGNING_DATA_MISMATCH', 'signature_metadata.public_key');
    await expectRefused(tampered((_b, h) => { h.signing_data.transaction.header.authorities = ['acc://attacker.acme/book']; rehash(h); }), 'SIGNING_DATA_MISMATCH', 'transaction.header.authorities');
    await expectRefused(tampered((_b, h) => { const b = blobs(h.signing_data.transaction); b[0].intent_id = 'someone-elses'; setBlobs(h.signing_data.transaction, b); rehash(h); }), 'SIGNING_DATA_MISMATCH', 'transaction.body.entry.data[0].intent_id');
  });

  it('a caller that declines after reading the summary: nothing is signed', async () => {
    const g = await gateway(async (e) => (isOpen(e) ? honestIntent(e.body, { publicKey: PUBKEY }) : { body: { ok: true } }));
    let signed = 0;
    try {
      const err = await clientFor(g.url).execute.contractCall({ ...CALL, sign: () => { signed++; return 'ff'.repeat(64); }, beforeSign: () => false }).catch((e) => e);
      expect(err).toMatchObject({ code: 'SIGNING_DECLINED' });
      expect(signed).toBe(0);
      expect(submitted(g)).toHaveLength(0);
    } finally { g.close(); }
  });

  it('a call the SDK cannot state the meaning of is refused, not skipped (a tuple argument, an unknown chain)', async () => {
    const g = await gateway(async (e) => (isOpen(e) ? unrelated() : { body: { ok: true } }));
    try {
      const run = (over: object) => clientFor(g.url).execute.contractCall({ ...CALL, sign: () => 'ff'.repeat(64), ...over } as never).catch((e) => e);
      expect(await run({ contractCall: { ...CALL.contractCall, functionSignature: 'f((uint256,uint256))', args: [] } })).toMatchObject({ code: 'SIGNING_EXPECTATION_UNAVAILABLE' });
      expect(await run({ chain: 'nowhere-chain', chainId: undefined })).toMatchObject({ code: 'SIGNING_EXPECTATION_UNAVAILABLE' });
    } finally { g.close(); }
  });
});

describe('execute.transfer', () => {
  const T = { identityId: 'id-1', adiUrl: 'acc://org.acme', fromChain: 'accumulate', toChain: 'ethereum-sepolia', fromAddress: 'acc://org.acme', toAddress: `0x${'be'.repeat(20)}`, amount: '0.001', publicKey: PUBKEY, skipFundingCheck: true };

  it('checks the amount in whole units against the wei the transaction commits to', async () => {
    const g = await gateway(async (e) => (isOpen(e) ? honestIntent(e.body, { publicKey: PUBKEY }) : { body: { ok: true } }));
    try {
      const out = await clientFor(g.url).execute.transfer({ ...T, sign: (h) => `sig:${h}` });
      expect(out.signing!.legs[0].valueWei).toBe('1000000000000000');
    } finally { g.close(); }
  });

  it('refuses a transaction that moves 1000 times what was asked', async () => {
    const g = await gateway(tampered((_b, h) => {
      const tx = h.signing_data.transaction;
      const b = blobs(tx);
      b[1].legs[0].executionPayload.value = '1000000000000000000';
      setBlobs(tx, b);
    }));
    let signed = 0;
    try {
      const err = await clientFor(g.url).execute.transfer({ ...T, sign: () => { signed++; return 'ff'; } }).catch((e) => e);
      expect(err).toBeInstanceOf(CertenSigningDataError);
      expect(signed).toBe(0);
    } finally { g.close(); }
  });

  it('refuses to sign a token transfer it cannot state the meaning of', async () => {
    const g = await gateway(async (e) => (isOpen(e) ? unrelated() : { body: { ok: true } }));
    try {
      const err = await clientFor(g.url).execute.transfer({ ...T, tokenSymbol: 'USDC', sign: () => 'ff' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'SIGNING_EXPECTATION_UNAVAILABLE' });
    } finally { g.close(); }
  });
});

describe('execute.cosign', () => {
  const real = JSON.parse(readFileSync(new URL('../../verify/test/fixtures/signing-vectors.json', import.meta.url), 'utf8')).vectors.find((v: any) => v.label === 'four-leg');
  const TXID = real.txid.match(/[0-9a-f]{64}/)![0];
  const P = { identity: 'acc://panel.acme', signerUrl: 'acc://panel.acme/book/1', publicKey: PUBKEY };

  it('signs a co-signature for exactly the transaction it was asked for, with the vote it was asked for', async () => {
    const g = await gateway((e) => (e.path === '/v1/sign' ? honestCosign(real, { publicKey: PUBKEY, signer: P.signerUrl }) : { body: { ok: true } }));
    try {
      await clientFor(g.url).execute.cosign({ ...P, accumTxHash: TXID, sign: (h) => `sig:${h}` });
      expect(submitted(g)).toHaveLength(1);
    } finally { g.close(); }
  });

  it('refuses when the gateway returns a different transaction than the one named (fail-before: signed)', async () => {
    const other = JSON.parse(readFileSync(new URL('../../verify/test/fixtures/signing-vectors.json', import.meta.url), 'utf8')).vectors.find((v: any) => v.label === 'two-leg');
    const g = await gateway((e) => (e.path === '/v1/sign' ? honestCosign(other, { publicKey: PUBKEY, signer: P.signerUrl }) : { body: { ok: true } }));
    let signed = 0;
    try {
      const err = await clientFor(g.url).execute.cosign({ ...P, accumTxHash: TXID, sign: () => { signed++; return 'ff'; } }).catch((e) => e);
      expect(err).toMatchObject({ code: 'SIGNING_DATA_MISMATCH', details: { field: 'transaction_hash' } });
      expect(signed).toBe(0);
      expect(submitted(g)).toHaveLength(0);
    } finally { g.close(); }
  });

  it('refuses when the vote returned is not the vote asked for', async () => {
    const g = await gateway((e) => (e.path === '/v1/sign' ? honestCosign(real, { publicKey: PUBKEY, signer: P.signerUrl, vote: 'reject' }) : { body: { ok: true } }));
    try {
      const err = await clientFor(g.url).execute.cosign({ ...P, accumTxHash: TXID, sign: () => 'ff' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'SIGNING_DATA_MISMATCH', details: { field: 'signature_metadata.vote' } });
    } finally { g.close(); }
  });
});

describe('CertenAgent governance', () => {
  const signer = ed25519Signer('22'.repeat(32));
  const STATE = { identityId: 'id-1', adiUrl: 'acc://bot.acme', keyPageUrl: 'acc://bot.acme/book/1', accounts: {} };

  it('signs the key change it asked for', async () => {
    const g = await gateway((e) => (e.path === '/v1/governance' && e.method === 'POST' ? honestGovernance(e.body.operations[0], 'acc://bot.acme', { publicKey: signer.publicKey }) : { body: {} }));
    try {
      await new CertenAgent(clientFor(g.url), signer, STATE).governance.addSeat('cc'.repeat(32));
      expect(submitted(g)).toHaveLength(1);
    } finally { g.close(); }
  });

  it('refuses a transaction that adds a different key than the one asked for (fail-before: signed)', async () => {
    const g = await gateway((e) => (e.path === '/v1/governance' && e.method === 'POST'
      ? honestGovernance({ type: 'add_key', public_key_hash: 'ee'.repeat(32) }, 'acc://bot.acme', { publicKey: signer.publicKey }) : { body: {} }));
    try {
      const err = await new CertenAgent(clientFor(g.url), signer, STATE).governance.addSeat('cc'.repeat(32)).catch((e) => e);
      expect(err).toMatchObject({ code: 'SIGNING_DATA_MISMATCH', details: { field: 'transaction.body.operation' } });
      expect(submitted(g)).toHaveLength(0);
    } finally { g.close(); }
  });
});
