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
import { CertenClient, ed25519Signer, coreVerdict, agentKeyRemoval, cancelByRejectVote, replaceAgent, revocationOf, revokeAgentKey, revokeGrant, revokeSeatRecord, EXPOSURE_WINDOW_STATEMENT, SEAT_RECORD_ROUTE, SEAT_RECORD_STATEMENT } from '../src/index.js';
import { hashGrant } from '../src/core/hashes.js';
import { honestCosign, honestGovernance } from './helpers/honest-gateway.js';
import { reconstructSigning } from '@certen.io/proof-verify';

/** An honest answer for an updateKeyPage on the agent's page carrying exactly `operation` (hashed honestly: only the content check can catch a change). */
function keyPageAnswer(e: { body: any }, operation: unknown[]) {
  const metadata = { type: 'ed25519', public_key: e.body.signer_public_key, signer: e.body.signer_key_page, signer_version: 1, timestamp_us: 1790000000000000 };
  const transaction = { header: { principal: e.body.key_page_url }, body: { type: 'updateKeyPage', operation } };
  const r = reconstructSigning(transaction, metadata);
  return { status: 201, body: { governance_op_id: 'gov-kp', status: 'pending_signature', signing_data: { transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: { ...transaction, header: { ...transaction.header, initiator: r.signatureMetadataHash } }, signature_metadata: metadata } } };
}

/**
 * A MODEL of Accumulate's readiness rule (v1.4.6 internal/core/execute/v2/block/transaction.go:207-224): a transaction is ready only when
 * every authority of its principal has voted, a DISABLED authority skipped unless the transaction type requires authorization
 * (protocol/access_control.go:10-16: UpdateAccountAuth). Not Accumulate itself: it shows what the source lines say for these cases.
 */
function ready(authorities: Array<{ url: string; disabled: boolean }>, voted: string[], txType: 'updateKeyPage' | 'updateAccountAuth'): boolean {
  const ignoreDisabled = txType === 'updateAccountAuth';
  return authorities.every((a) => (a.disabled && !ignoreDisabled) || voted.includes(a.url));
}
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
  it('AGT-F32: the op is exactly [add the owner-held revocation key, remove the agent key] on the agent\'s page, signed by the owner\'s page; the rebuilt transaction is checked', async () => {
    const key = ed25519Signer();
    const gw = await gateway((e) => e.path === '/v1/governance'
      ? keyPageAnswer(e, [{ type: 'add', entry: { keyHash: 'e'.repeat(64) } }, { type: 'remove', entry: { keyHash: 'c'.repeat(64) } }])
      : { body: { status: 'pending_signatures', tx_hash: 'tx-rm' } });
    try {
      const r = await revokeAgentKey(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, agentPage: AGENT_PAGE, keyHash: 'c'.repeat(64), revocationKeyHash: 'e'.repeat(64), signer: key, ...WHO });
      const create = gw.seen.find((e) => e.path === '/v1/governance')!;
      expect(create.body).toEqual({ identity: PRINCIPAL, operations: [{ type: 'add_key', public_key_hash: 'e'.repeat(64) }, { type: 'remove_key', public_key_hash: 'c'.repeat(64) }], key_page_url: AGENT_PAGE, signer_key_page: PAGE, signer_public_key: key.publicKey });
      expect(signatures(gw.seen)).toHaveLength(1);
      expect(r).toMatchObject({ agentPage: AGENT_PAGE, txHash: 'tx-rm', exposureWindow: EXPOSURE_WINDOW_STATEMENT });
    } finally { gw.close(); }
  });
  it('a gateway that returns the remove alone, or the two in the other order, gets no signature; the revocation key must differ from the agent key', async () => {
    for (const ops of [[{ type: 'remove', entry: { keyHash: 'c'.repeat(64) } }], [{ type: 'remove', entry: { keyHash: 'c'.repeat(64) } }, { type: 'add', entry: { keyHash: 'e'.repeat(64) } }]]) {
      const gw = await gateway((e) => e.path === '/v1/governance' ? keyPageAnswer(e, ops) : { body: {} });
      try {
        await expect(revokeAgentKey(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, agentPage: AGENT_PAGE, keyHash: 'c'.repeat(64), revocationKeyHash: 'e'.repeat(64), signer: ed25519Signer(), ...WHO })).rejects.toMatchObject({ code: 'SIGNING_DATA_MISMATCH' });
        expect(signatures(gw.seen)).toHaveLength(0);
      } finally { gw.close(); }
    }
    expect(() => agentKeyRemoval('c'.repeat(64), 'c'.repeat(64))).toThrow(expect.objectContaining({ code: 'INTERVENTION_MALFORMED' }));
    const gw = await gateway(() => ({ body: {} }));
    try {
      expect(signatures(gw.seen)).toHaveLength(0);
    } finally { gw.close(); }
  });
});

describe('AGT-F28: the owner alone completes the revocation once the agent\'s book is disabled (a model of transaction.go:207-224)', () => {
  const OWNER_BOOK = `${PRINCIPAL}/book`;
  const AGENT_BOOK = `${AGENT}/book`;
  it('before the disable the owner\'s updateKeyPage waits for the agent; after it the owner alone is enough; the agent alone never is; changing the authority set needs both', () => {
    const before = [{ url: AGENT_BOOK, disabled: false }, { url: OWNER_BOOK, disabled: false }];
    const after = [{ url: AGENT_BOOK, disabled: true }, { url: OWNER_BOOK, disabled: false }];
    expect(ready(before, [OWNER_BOOK], 'updateKeyPage')).toBe(false); // the agent could block its own revocation
    expect(ready(after, [OWNER_BOOK], 'updateKeyPage')).toBe(true);
    expect(ready(after, [AGENT_BOOK], 'updateKeyPage')).toBe(false);
    expect(ready(after, [OWNER_BOOK], 'updateAccountAuth')).toBe(false); // re-enabling, or any authority change, needs both books
    expect(ready(after, [OWNER_BOOK, AGENT_BOOK], 'updateAccountAuth')).toBe(true);
  });
});

describe('cancel by reject vote', () => {
  const real = JSON.parse(readFileSync(new URL('../../verify/test/fixtures/signing-vectors.json', import.meta.url), 'utf8')).vectors.find((v: any) => v.label === 'four-leg');
  const officer = `${PRINCIPAL}/officers/1`;
  it('opens a REJECT sign request on the pending transaction, checks the rebuilt signing data (transaction, vote reject, signer), signs, and states the exposure window', async () => {
    const key = ed25519Signer();
    const gw = await gateway((e) => e.path === '/v1/sign' ? honestCosign(real, { publicKey: key.publicKey, signer: officer, vote: 'reject' }) : { body: { status: 'submitted' } });
    try {
      const r = await cancelByRejectVote(clientFor(gw.url), { identity: PRINCIPAL, subject: AGENT, txHash: real.txid, signerUrl: officer, signer: key, ...WHO });
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
      await expect(cancelByRejectVote(clientFor(gw.url), { identity: PRINCIPAL, subject: AGENT, txHash: real.txid, signerUrl: officer, signer: key, ...WHO })).rejects.toMatchObject({ code: 'SIGNING_DATA_MISMATCH' });
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
      await expect(revokeAgentKey(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, agentPage: AGENT_PAGE, keyHash: 'c'.repeat(64), revocationKeyHash: 'e'.repeat(64), signer: noKey, seat: 'supervisor', reason: WHO.reason })).rejects.toMatchObject({ code: 'INTERVENTION_MALFORMED' });
      await expect(cancelByRejectVote(clientFor(gw.url), { identity: PRINCIPAL, subject: AGENT, txHash: 'ab'.repeat(32), signerUrl: PAGE, signer: noKey, seat: WHO.seat, reason: 'short' })).rejects.toMatchObject({ code: 'INTERVENTION_MALFORMED' });
      await expect(revokeGrant(clientFor(gw.url), { principal: PRINCIPAL, page: PAGE, head: grant, signer: noKey, seat: WHO.seat, reason: '' })).rejects.toMatchObject({ code: 'INTERVENTION_MALFORMED' });
      expect(gw.seen).toEqual([]);
    } finally { gw.close(); }
  });
});

/**
 * AGT-F135 (design section 5): every intervention result carries `seatRecord`, exactly the form the Console's POST /agents/interventions
 * takes (act, subject, seat, reason, txHash, keyTxHash on a revoke, replacedBy on a replace), with `recordedAtSeat: false` and the sentence
 * that the act is in the seat's decision log only once the named person submits it there. A hash the result does not have is ABSENT with a
 * named reason, never invented.
 */
describe('AGT-F135: the seat record each intervention hands to the named person', () => {
  const H = (c: string) => c.repeat(64);
  const writeGateway = (writeTx: string | undefined, provider = false) => gateway((e) => {
    if (e.path === '/v1/governance') {
      if (e.body.operations[0].type === 'create_data_account') return { status: 409, body: { error: 'exists', code: 'DATA_ACCOUNT_EXISTS' } };
      if (provider) return { status: 201, body: { governance_op_id: 'gov-p', status: 'submitted', signing_mode: 'provider', ...(writeTx ? { tx_hash: writeTx } : {}) } };
      return honestGovernance(e.body.operations[0], PRINCIPAL, { publicKey: e.body.signer_public_key, keyPage: e.body.signer_key_page });
    }
    return { body: { status: 'completed', ...(writeTx ? { tx_hash: writeTx } : {}) } };
  });
  const keyGateway = (txHash: string | undefined) => gateway((e) => e.path === '/v1/governance'
    ? keyPageAnswer(e, [{ type: 'add', entry: { keyHash: H('e') } }, { type: 'remove', entry: { keyHash: H('c') } }])
    : { body: { status: 'delivered', ...(txHash ? { tx_hash: txHash } : {}) } });
  const keyArgs = (signer = ed25519Signer()) => ({ principal: PRINCIPAL, page: PAGE, agentPage: AGENT_PAGE, keyHash: H('c'), revocationKeyHash: H('e'), signer, ...WHO });
  const revokeArgs = () => ({ principal: PRINCIPAL, page: PAGE, head: grant, issuedAt: 1793060000, signer: ed25519Signer(), ...WHO });

  it('the statement names the route and the person, and says the SDK has not recorded the act', () => {
    expect(SEAT_RECORD_ROUTE).toBe('POST /agents/interventions');
    expect(SEAT_RECORD_STATEMENT).toContain('only when the named person submits seatRecord at the seat (POST /agents/interventions)');
  });

  it('revokeGrant: act revoke, subject = the Grant\'s agent, txHash = the Grant write (64 hex, lower case, no 0x); not recorded at the seat', async () => {
    const gw = await writeGateway('0x' + H('A'));
    try {
      const r = await revokeGrant(clientFor(gw.url), revokeArgs());
      expect(r.seatRecord).toEqual({ act: 'revoke', subject: AGENT, seat: WHO.seat, reason: WHO.reason, txHash: H('a') });
      expect(r.recordedAtSeat).toBe(false);
      expect(r.seatRecordStatement).toBe(SEAT_RECORD_STATEMENT);
    } finally { gw.close(); }
  });

  it('revokeGrant in provider signing mode with no hash yet: txHash ABSENT, named provider_signing_pending (never a placeholder)', async () => {
    const gw = await writeGateway(undefined, true);
    try {
      const r = await revokeGrant(clientFor(gw.url), revokeArgs());
      expect(r.writeSignedBy).toBe('provider');
      expect('txHash' in r.seatRecord).toBe(false);
      expect(r.seatRecord.absent).toEqual([{ field: 'txHash', code: 'provider_signing_pending', detail: expect.stringContaining('gov-p') }]);
    } finally { gw.close(); }
  });

  it('a gateway hash that is not a transaction hash is ABSENT as tx_hash_unreadable, the value named; none returned is gateway_returned_none', async () => {
    for (const [tx, code] of [['tx-rev', 'tx_hash_unreadable'], [undefined, 'gateway_returned_none']] as const) {
      const gw = await writeGateway(tx);
      try {
        const r = await revokeGrant(clientFor(gw.url), revokeArgs());
        expect(r.writeSignedBy).toBe('principal');
        expect('txHash' in r.seatRecord).toBe(false);
        expect(r.seatRecord.absent).toEqual([{ field: 'txHash', code, detail: tx ? expect.stringContaining(tx) : expect.any(String) }]);
      } finally { gw.close(); }
    }
  });

  it('revokeAgentKey: act revoke, subject = the agent page\'s ADI, keyTxHash = the key operation (a TxID read to its hash); txHash ABSENT: the Grant write is not in this call', async () => {
    const gw = await keyGateway(`acc://${H('b')}@agent-7.harbor-mfg.acme/book/1`);
    try {
      const r = await revokeAgentKey(clientFor(gw.url), keyArgs());
      expect(r.seatRecord).toEqual({ act: 'revoke', subject: AGENT, seat: WHO.seat, reason: WHO.reason, keyTxHash: H('b'), absent: [{ field: 'txHash', code: 'grant_write_not_in_this_call', detail: expect.stringContaining('revokeSeatRecord') }] });
      expect([r.recordedAtSeat, r.seatRecordStatement]).toEqual([false, SEAT_RECORD_STATEMENT]);
    } finally { gw.close(); }
  });

  it('revokeAgentKey with no key hash returned: keyTxHash ABSENT too, by name', async () => {
    const gw = await keyGateway(undefined);
    try {
      const r = await revokeAgentKey(clientFor(gw.url), keyArgs());
      expect('keyTxHash' in r.seatRecord).toBe(false);
      expect(r.seatRecord.absent!.map((x) => [x.field, x.code])).toEqual([['txHash', 'grant_write_not_in_this_call'], ['keyTxHash', 'gateway_returned_none']]);
    } finally { gw.close(); }
  });

  it('revokeSeatRecord joins the Grant write and the key operation into ONE record (txHash + keyTxHash), the form the Console takes', async () => {
    const g = await writeGateway(H('a'));
    const k = await keyGateway(H('b'));
    try {
      const grantResult = await revokeGrant(clientFor(g.url), revokeArgs());
      const keyResult = await revokeAgentKey(clientFor(k.url), keyArgs());
      expect(revokeSeatRecord(grantResult, keyResult)).toEqual({ seatRecord: { act: 'revoke', subject: AGENT, seat: WHO.seat, reason: WHO.reason, txHash: H('a'), keyTxHash: H('b') }, recordedAtSeat: false, seatRecordStatement: SEAT_RECORD_STATEMENT });
    } finally { g.close(); k.close(); }
  });

  it('revokeSeatRecord carries each half\'s absence, and refuses halves of another agent, seat or reason, or swapped halves', async () => {
    const g = await writeGateway(undefined, true);
    const k = await keyGateway(H('b'));
    try {
      const grantResult = await revokeGrant(clientFor(g.url), revokeArgs());
      const keyResult = await revokeAgentKey(clientFor(k.url), keyArgs());
      expect(revokeSeatRecord(grantResult, keyResult).seatRecord).toEqual({ act: 'revoke', subject: AGENT, seat: WHO.seat, reason: WHO.reason, keyTxHash: H('b'), absent: [{ field: 'txHash', code: 'provider_signing_pending', detail: expect.any(String) }] });
      for (const change of [{ subject: 'acc://agent-8.harbor-mfg.acme' }, { seat: 'seat:other' }, { reason: 'Another reason entirely, not this one.' }]) {
        expect(() => revokeSeatRecord(grantResult, { ...keyResult, seatRecord: { ...keyResult.seatRecord, ...change } })).toThrow(expect.objectContaining({ code: 'INTERVENTION_MALFORMED' }));
      }
      expect(() => revokeSeatRecord(keyResult as never, grantResult as never)).toThrow(expect.objectContaining({ code: 'INTERVENTION_MALFORMED' }));
    } finally { g.close(); k.close(); }
  });

  it('cancelByRejectVote: act reject, subject = the named agent ADI (required), txHash = the pending transaction', async () => {
    const real = JSON.parse(readFileSync(new URL('../../verify/test/fixtures/signing-vectors.json', import.meta.url), 'utf8')).vectors.find((v: any) => v.label === 'four-leg');
    const officer = `${PRINCIPAL}/officers/1`;
    const key = ed25519Signer();
    const gw = await gateway((e) => e.path === '/v1/sign' ? honestCosign(real, { publicKey: key.publicKey, signer: officer, vote: 'reject' }) : { body: { status: 'submitted' } });
    try {
      const r = await cancelByRejectVote(clientFor(gw.url), { identity: PRINCIPAL, subject: 'acc://Agent-7.Harbor-Mfg.acme', txHash: real.txid, signerUrl: officer, signer: key, ...WHO });
      expect(r.seatRecord).toEqual({ act: 'reject', subject: AGENT, seat: WHO.seat, reason: WHO.reason, txHash: String(real.txid).match(/[0-9a-f]{64}/)![0] });
      expect([r.recordedAtSeat, r.seatRecordStatement]).toEqual([false, SEAT_RECORD_STATEMENT]);
      const before = gw.seen.length;
      await expect(cancelByRejectVote(clientFor(gw.url), { identity: PRINCIPAL, txHash: real.txid, signerUrl: officer, signer: key, ...WHO } as never)).rejects.toMatchObject({ code: 'INTERVENTION_MALFORMED' });
      await expect(cancelByRejectVote(clientFor(gw.url), { identity: PRINCIPAL, subject: `${AGENT}/book/1`, txHash: real.txid, signerUrl: officer, signer: key, ...WHO })).rejects.toMatchObject({ code: 'INTERVENTION_MALFORMED' });
      expect(gw.seen.length).toBe(before);
    } finally { gw.close(); }
  });

  it('replaceAgent: act replace, subject = the retired agent, txHash = the retirement\'s write, replacedBy = the new agent', async () => {
    const NEW = 'acc://agent-8.harbor-mfg.acme';
    let n = 0;
    const gw = await gateway((e) => e.path === '/v1/governance'
      ? (e.body.operations[0].type === 'create_data_account' ? { status: 409, body: { error: 'exists', code: 'DATA_ACCOUNT_EXISTS' } } : honestGovernance(e.body.operations[0], PRINCIPAL, { publicKey: e.body.signer_public_key, keyPage: e.body.signer_key_page }))
      : { body: { status: 'completed', tx_hash: H(['d', 'e', 'f'][n++]!) } });
    try {
      const r = await replaceAgent(clientFor(gw.url), {
        principal: PRINCIPAL, page: PAGE, signer: ed25519Signer(), ...WHO,
        retiredRegistration: { ...registration, status: 'retired' },
        newRegistration: { ...registration, adi: NEW },
        newGrant: { ...grant, grantId: 'agent8-vendor-pay', subject: { type: 'agent', adi: NEW } },
      });
      expect(r.seatRecord).toEqual({ act: 'replace', subject: AGENT, seat: WHO.seat, reason: WHO.reason, txHash: H('d'), replacedBy: NEW });
      expect([r.recordedAtSeat, r.seatRecordStatement]).toEqual([false, SEAT_RECORD_STATEMENT]);
    } finally { gw.close(); }
  });
});
