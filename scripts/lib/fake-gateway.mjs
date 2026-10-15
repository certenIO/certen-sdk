/**
 * An in-process fake of the CERTEN gateway, for measuring the CLI offline.
 *
 * `measure-onboarding --journey` drives the REAL built CLI through a documented journey. The CLI is the
 * thing being measured, so it is the one real part: this stands in for everything it talks to, so the run
 * needs no network, no API key and no funds, and gives the same numbers every time.
 *
 * What it models is only what the journeys need, and it models it the way the live gateway behaves where
 * the CLI has been bitten by the difference (each is pinned by a test in packages/cli/test):
 *
 *   - `POST /v1/identity` answers 202 and provisioning finishes later; here the first poll already says
 *     `active`, so no run waits. That does not shorten any wait the CLI makes: the budgets in wait.ts are
 *     untouched, the fake simply has nothing left to wait for.
 *   - the abstract account's `chain_id` is numeric on the identity and a slug in the portfolio;
 *   - a new abstract account holds no gas until something pays it (`fundAbstractAccount()`), and the
 *     funding guard reads that;
 *   - `/v1/portfolio` carries no identity UUIDs;
 *   - the intent response carries real signing data, built the way the bridge builds it, because
 *     `checkIntentSigning` rebuilds and matches it before the CLI will sign: a stub that returned a bare
 *     hash would make `tx create --sign-with` refuse, correctly.
 *
 * The proof endpoints serve the repo's own conformance fixtures, so `proof verify` produces a real
 * verdict (an honest PARTIAL) rather than a canned one.
 *
 * Every request is recorded (method, path, status) and drained with `take()`, which is how a step's
 * round trips are counted: what actually arrived, not what the SDK says it sent.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legsFromIntent } from '@certen.io/sdk';
import { reconstructSigning } from '@certen.io/proof-verify';
// Not part of the SDK's public surface; the same helpers the SDK's own test double uses.
import { keccak256, toHex } from '../../packages/sdk/dist/execution-proof.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROOF_FIXTURES = join(ROOT, 'packages', 'verify', 'test', 'fixtures', 'proofv2');
const EXEC_FIXTURE = join(ROOT, 'packages', 'sdk', 'test', 'fixtures', 'execution-proof-base-46437431.json');

/** The ways this fake can be made to misbehave, for proving the harness goes red. */
export const FAULTS = Object.freeze(['cannot-sign', 'key-page-lacks-key']);

/** Fixed, so two runs of the same journey print the same transcript. */
export const IDS = Object.freeze({
  identity: '396f863c-879c-4046-8591-3f0405c5f6bd',
  intent: '7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13',
  proof: '11111111-2222-4333-8444-555555555555',
  accumTx: 'ab'.repeat(32),
  abstractAccount: '0xe293e95Ec1471155d977448B99B0922C2828cAcB',
  adi: 'acc://journey-probe.acme',
});
const KEY_PAGE = `${IDS.adi}/book/1`;
const BASE_SEPOLIA = 84532;

const hexOf = (o) => Buffer.from(JSON.stringify(o)).toString('hex');

/**
 * What an honest gateway returns for an intent: the transaction a CERTEN bridge builds for the request,
 * its signature metadata, and the hashes computed from both. Mirrors packages/sdk/test/helpers/
 * honest-gateway.ts, which this script cannot import (it is TypeScript test code). If this drifts from
 * what the SDK checks, the failure is loud and local: `checkIntentSigning` refuses to sign, and the
 * step reports as not behaving as declared.
 */
async function honestIntent(body, { adiUrl, keyPage, intentId }) {
  const publicKey = body.signer_public_key ?? '11'.repeat(32);
  const intent = body.intent ?? {};
  const legs = await legsFromIntent({ ...intent, adiUrl });
  const blobs = [
    { kind: 'CERTEN_INTENT', version: '2.0', intent_id: intentId, leg_count: legs.length },
    {
      protocol: 'CERTEN',
      version: '2.0',
      operationGroupId: intentId,
      legs: legs.map((l, i) => {
        const callData = (l.callData ?? '0x').toLowerCase();
        return {
          legId: `leg-${i + 1}`, role: 'payment', chain: String(l.chainId), chainId: l.chainId,
          executionPayload: {
            target: l.target, value: String(l.value), callData,
            dataHash: `0x${toHex(keccak256(Buffer.from(callData.slice(2), 'hex'))).replace(/^0x/, '')}`,
            chainId: l.chainId,
            ...(l.expectedEvents ? { expectedEvents: l.expectedEvents } : {}),
          },
        };
      }),
    },
    { organizationAdi: adiUrl },
    { nonce: 'n', created_at: 1 },
  ];
  const header = { principal: `${adiUrl}/data`, memo: 'CERTEN_INTENT' };
  if (body.expires_at) header.expire = { atTime: new Date(body.expires_at).toISOString() };
  if (body.additional_authorities?.length) header.authorities = body.additional_authorities;
  const transaction = { header, body: { type: 'writeData', entry: { type: 'doubleHash', data: blobs.map(hexOf) } } };
  const metadata = { type: 'ed25519', public_key: publicKey, signer: keyPage, signer_version: 1, timestamp_us: 1790000000000000 };
  const r = reconstructSigning(transaction, metadata);
  const withInitiator = { ...transaction, header: { ...header, initiator: r.signatureMetadataHash } };
  return {
    intent_id: intentId,
    signing_mode: 'external',
    signing_data: { transaction_hash: r.transactionHash, hash_to_sign: r.hashToSign, transaction: withInitiator, signature_metadata: metadata },
    submit_url: `/v1/transaction/${intentId}/signature`,
  };
}

/**
 * @param {string} accumulateApi The Accumulate API endpoint the registry advertises. It is this fake's own `/acc/v3`, never the real
 *   one: a CLI that reads the key page from Accumulate (`status`, `doctor`) must reach a stand-in here, because a measurement that
 *   touched kermit would need the network and would not give the same numbers twice.
 */
function chainRegistry(accumulateApi) {
  const chain = (id, chainId, displayName, explorer) => ({
    id, chainId, family: 'evm', displayName, environment: 'testnet', status: 'live', explorer, enabled: true,
    contracts: { ledger: { address: `0x${'41'.repeat(20)}`, verified: true } },
  });
  return {
    version: '2026-10-15',
    last_updated: '2026-10-15T00:00:00Z',
    accumulate: { network: 'kermit', environment: 'testnet', api: accumulateApi, explorer: 'https://explorer.accumulatenetwork.io' },
    count: 3,
    chains: [
      chain('ethereum-sepolia', 11155111, 'Ethereum Sepolia', 'https://sepolia.etherscan.io'),
      chain('base-sepolia', BASE_SEPOLIA, 'Base Sepolia', 'https://sepolia.basescan.org'),
      chain('arbitrum-sepolia', 421614, 'Arbitrum Sepolia', 'https://sepolia.arbiscan.io'),
    ],
  };
}

/**
 * @param {object} [options]
 * @param {'cannot-sign'|'key-page-lacks-key'} [options.fault] A way for the gateway to be wrong, so a test can prove the
 *   harness goes red when a step does not behave as declared. `cannot-sign`: the gateway says the identity cannot sign.
 *   `key-page-lacks-key`: the Accumulate node lists a different key than the one the identity was created with.
 */
export async function startFakeGateway(options = {}) {
  const exec = JSON.parse(readFileSync(EXEC_FIXTURE, 'utf8'));
  const manifest = JSON.parse(readFileSync(join(PROOF_FIXTURES, 'manifest.json'), 'utf8'));
  const portable = JSON.parse(gunzipSync(readFileSync(join(PROOF_FIXTURES, manifest.base))).toString('utf8'));
  const execution = exec.proof_components['5_execution_proof'];

  const state = {
    identityCreated: false,
    funded: false,
    intentOpened: false,
    publicKey: null,
    /** SHA-256 of the key the identity was created with, as the key page on Accumulate lists it. */
    keyHash: null,
  };
  /** Filled in once the server is listening: the registry advertises this fake's own Accumulate endpoint. */
  const self = { url: '' };

  const identityBody = () => ({
    id: IDS.identity,
    name: 'journey-probe',
    adi_url: IDS.adi,
    book_url: `${IDS.adi}/book`,
    key_page_url: KEY_PAGE,
    status: 'active',
    can_sign: options.fault === 'cannot-sign' ? false : true,
    credit_balance: 500,
    // Numeric here, a slug in the portfolio: the live gateway does both.
    chain_accounts: [{ chain_id: String(BASE_SEPOLIA), address: IDS.abstractAccount, status: 'deployed' }],
    // Whole units, as the live gateway reports them (it formats the balance with ethers.formatEther).
    balances: [{ chain_id: 'base-sepolia', address: IDS.abstractAccount, token: 'ETH', balance: state.funded ? '0.001' : '0' }],
    created_at: '2026-10-15T00:00:00Z',
  });

  const portfolioBody = () => ({
    identities: state.identityCreated
      ? [{
        adi_url: IDS.adi, status: 'active', credit_balance: 500, pending_actions: 0,
        chains: [{
          chain_id: 'base-sepolia', address: IDS.abstractAccount, deployed: true,
          balances: [{ token: 'ETH', balance: state.funded ? '0.001' : '0' }],
        }],
      }]
      : [],
    total_chains: state.identityCreated ? 1 : 0,
  });

  const balanceBody = () => ({
    currency: 'USD', available_usd: '5.000000', held_usd: '0.000000', credit_limit_usd: '0.000000',
    spendable_usd: '5.000000', remaining_usd: '5.000000', pending_intents: 0, status: 'active',
  });

  const transactionBody = () => ({
    intent_id: IDS.intent,
    status: 'completed',
    proof_id: IDS.proof,
    accum_tx_hash: `acc://${IDS.accumTx}@${IDS.adi}/data`,
    reason_code: null,
  });

  /** [method, path pattern, handler(match, body) -> [status, body, extra headers?]] */
  const routes = [
    ['GET', /^\/v1\/chains$/, () => [200, chainRegistry(`${self.url}/acc/v3`)]],
    ['GET', /^\/v1\/health\/ready$/, () => [200, { status: 'ready', reasons: [] }]],
    ['GET', /^\/v1\/errors$/, () => [200, { errors: [] }]],
    ['GET', /^\/v1\/billing\/balance$/, () => [200, balanceBody()]],
    ['GET', /^\/v1\/me$/, () => [200, {
      auth_method: 'api_key', org: { id: 'org-journey', name: 'journey' }, scopes: ['*'],
      key: { id: 'key-journey', rate_limit_rpm: 600 }, user: null, active_org_id: null, role: null, orgs: [],
    }]],
    ['GET', /^\/v1\/portfolio$/, () => [200, portfolioBody()]],
    ['GET', /^\/v1\/transactions$/, () => [200, { transactions: [], total: 0 }]],
    ['POST', /^\/v1\/identity$/, (_m, body) => {
      // The key page on Accumulate lists the key the identity was created with, which is what a real provisioning does.
      const b = JSON.parse(body || '{}');
      state.keyHash = b.public_key_hash
        ?? (b.public_key ? createHash('sha256').update(Buffer.from(b.public_key, 'hex')).digest('hex') : null);
      state.identityCreated = true;
      return [202, { ...identityBody(), status: 'provisioning', can_sign: null }];
    }],
    ['GET', /^\/v1\/identity\/([^/]+)$/, (m) => (m[1] === IDS.identity && state.identityCreated ? [200, identityBody()] : [404, { message: 'identity not found' }])],
    ['POST', /^\/v1\/transaction$/, async (_m, body) => {
      state.intentOpened = true;
      return [201, await honestIntent(JSON.parse(body), { adiUrl: IDS.adi, keyPage: KEY_PAGE, intentId: IDS.intent })];
    }],
    ['POST', /^\/v1\/transaction\/([^/]+)\/signature$/, () => [200, { ok: true }]],
    ['GET', /^\/v1\/transaction\/([^/]+)$/, (m) => (state.intentOpened && m[1] === IDS.intent ? [200, transactionBody()] : [404, { message: 'intent not found' }])],
    ['GET', /^\/v1\/proof\/tx\/([^/]+)\/receipt$/, (m) => [200, {
      tx_hash: m[1], status: 'delivered', anchored: true, tx_type: 'writeData', principal: `${IDS.adi}/data`,
      block_time: '2026-10-15T00:00:00Z', receipt: { anchor: 'ab'.repeat(32) },
    }]],
    ['GET', /^\/v1\/proof\/([^/]+)\/bundle$/, () => [200, exec, { 'content-type': 'application/octet-stream' }]],
    ['GET', /^\/v1\/proof\/([^/]+)\/v2$/, () => [200, portable]],
    ['GET', /^\/v1\/proof\/([^/]+)$/, (m) => [200, { proof_id: m[1], status: 'completed', anchored: true }]],
    // The Accumulate node, for the key page read (`status`, `doctor`): the one account it knows, listing the key the identity was created with.
    ['POST', /^\/acc\/v3$/, (_m, body) => {
      const q = JSON.parse(body || '{}');
      if (!state.identityCreated || q.params?.scope !== KEY_PAGE) {
        return [200, { jsonrpc: '2.0', id: q.id ?? 1, error: { code: -33001, message: `${q.params?.scope ?? 'account'} not found` } }];
      }
      const keyHash = options.fault === 'key-page-lacks-key' ? 'ff'.repeat(32) : state.keyHash;
      return [200, {
        jsonrpc: '2.0', id: q.id ?? 1,
        result: { recordType: 'account', account: { type: 'keyPage', url: KEY_PAGE, keys: [{ publicKeyHash: keyHash }], creditBalance: 500, version: 2, acceptThreshold: 1 } },
      }];
    }],
    // The execution chain's own node, for `proof verify --rpc`: answers with the header the bundle's receipts root is compared to.
    ['POST', /^\/rpc$/, () => [200, {
      jsonrpc: '2.0', id: 1,
      result: { number: `0x${Number(execution.block_number).toString(16)}`, hash: execution.block_hash, receiptsRoot: execution.receipts_root },
    }]],
  ];

  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const path = (req.url ?? '').split('?')[0];

    let status = 404;
    let payload = { message: `no route for ${req.method} ${path} in the fake gateway`, error: 'Not Found' };
    let headers = {};
    // A request nothing here answers is a gap in this fake, not a fact about the gateway. It is marked so
    // the runner can fail the step instead of counting a 404 that only exists because the fake is short.
    let unrouted = true;
    for (const [method, pattern, handler] of routes) {
      const m = method === req.method ? pattern.exec(path) : null;
      if (!m) continue;
      unrouted = false;
      try {
        [status, payload, headers = {}] = await handler(m, body);
      } catch (err) {
        status = 500;
        payload = { message: `the fake gateway failed building ${path}: ${err instanceof Error ? err.message : String(err)}` };
      }
      break;
    }
    seen.push({ method: req.method, path, status, unrouted });
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  self.url = url;

  return {
    url,
    /** The execution chain's JSON-RPC endpoint, for `proof verify --rpc`. */
    rpcUrl: `${url}/rpc`,
    /** Requests since the last call, oldest first. */
    take: () => seen.splice(0, seen.length),
    /** Somebody pays the abstract account: what the faucet and the wallet transfer do on a real chain. */
    fundAbstractAccount: () => { state.funded = true; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
