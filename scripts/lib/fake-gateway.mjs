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
 *   - a new account can be made with a key: `POST /v1/signup` VERIFIES the Ed25519 signature over the nonce BYTES, so a CLI that signed
 *     the wrong thing is refused rather than waved through;
 *   - gas can arrive while someone waits (`fundAfterMoreReads(n)`), which is what a faucet does while `setup` polls;
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
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
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

/**
 * The ways this fake can be made to misbehave, for proving the harness goes red.
 *
 * The last four are about the outcome of a `send`: the intent ends `failed`; the proof service answers 503 for the bundle and the portable
 * document; the caller's node says it is a different chain; the recipient's balance does not rise when the value is "delivered".
 */
export const FAULTS = Object.freeze([
  'cannot-sign', 'key-page-lacks-key', 'funds-never-arrive', 'intent-fails', 'proof-service-down', 'rpc-wrong-chain', 'value-never-arrives',
  'swapped-recipient',
]);

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
 * @param {string} [options.fault] A way for the gateway to be wrong, so a test can prove the
 *   harness goes red when a step does not behave as declared. `cannot-sign`: the gateway says the identity cannot sign.
 *   `key-page-lacks-key`: the Accumulate node lists a different key than the one the identity was created with.
 *   `funds-never-arrive`: gas that is supposed to arrive while `setup` waits never does.
 *   `intent-fails`: the intent ends `failed` (`target_reverted`). `proof-service-down`: the bundle and the portable document answer 503.
 *   `rpc-wrong-chain`: the caller's node reports another chain id. `value-never-arrives`: the recipient's balance does not rise.
 * @param {string[]} [options.statuses] The statuses successive reads of the intent report; the last repeats. Default: `completed` at once.
 * @param {boolean} [options.debitSender] The abstract account's balance falls by the amount when the intent completes. Default off, so the
 *   measured journeys keep the numbers they were pinned at.
 * @param {boolean} [options.accumulateDown] The Accumulate node answers 503, so the independent key page read is `unknown`, not a failure.
 * @param {number} [options.portableStatus] The proof's portable document is refused with this HTTP status (a 403, say): the evidence cannot be fetched.
 */
export async function startFakeGateway(options = {}) {
  const exec = JSON.parse(readFileSync(EXEC_FIXTURE, 'utf8'));
  const manifest = JSON.parse(readFileSync(join(PROOF_FIXTURES, 'manifest.json'), 'utf8'));
  const portable = JSON.parse(gunzipSync(readFileSync(join(PROOF_FIXTURES, manifest.base))).toString('utf8'));
  const execution = exec.proof_components['5_execution_proof'];

  const state = {
    identityCreated: false,
    funded: false,
    /** Reads of the identity so far, and the read count at which gas arrives (null: only when funded by hand). */
    identityReads: 0,
    fundAtRead: null,
    nonces: new Map(),
    intentOpened: false,
    publicKey: null,
    /** SHA-256 of the key the identity was created with, as the key page on Accumulate lists it. */
    keyHash: null,
    /** Reads of the intent so far: which of `options.statuses` the next one reports. */
    intentReads: 0,
    /** The last body `POST /v1/transaction` received, and the transfer it asked for (recipient, wei), so a test can assert what was sent. */
    lastIntentBody: null,
    transfer: null,
    /** The transfer has been delivered: the recipient is credited and, with `debitSender`, the abstract account is debited. */
    credited: false,
    /** Native balances on the caller's node, in wei, by lower-case address. */
    nodeBalances: new Map(),
    /** What the caller's node was asked, oldest first. */
    nodeCalls: [],
    /** Share links asked for (`POST /v1/proof/:id/share`), oldest first. */
    shares: [],
  };
  /** Filled in once the server is listening: the registry advertises this fake's own Accumulate endpoint. */
  const self = { url: '' };

  const isFunded = () => state.funded || (state.fundAtRead !== null && state.identityReads >= state.fundAtRead);

  const WEI = 10n ** 18n;
  /** "0.0001" -> wei, exactly. */
  const toWei = (text) => {
    const [whole, frac = ''] = String(text).split('.');
    return BigInt(whole || '0') * WEI + BigInt(frac.padEnd(18, '0').slice(0, 18) || '0');
  };
  /** wei -> "0.0009", no trailing zeros. */
  const fromWei = (wei) => {
    const digits = wei.toString().padStart(19, '0');
    const frac = digits.slice(-18).replace(/0+$/, '');
    return `${digits.slice(0, -18)}${frac ? `.${frac}` : ''}`;
  };
  /** The abstract account's native balance as the gateway reports it (whole units). */
  const senderBalance = () => {
    if (!isFunded()) return '0';
    return options.debitSender && state.credited && state.transfer ? fromWei(toWei('0.001') - state.transfer.wei) : '0.001';
  };

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
    balances: [{ chain_id: 'base-sepolia', address: IDS.abstractAccount, token: 'ETH', balance: senderBalance() }],
    created_at: '2026-10-15T00:00:00Z',
  });

  const portfolioBody = () => ({
    identities: state.identityCreated
      ? [{
        adi_url: IDS.adi, status: 'active', credit_balance: 500, pending_actions: 0,
        chains: [{
          chain_id: 'base-sepolia', address: IDS.abstractAccount, deployed: true,
          balances: [{ token: 'ETH', balance: senderBalance() }],
        }],
      }]
      : [],
    total_chains: state.identityCreated ? 1 : 0,
  });

  const balanceBody = () => ({
    currency: 'USD', available_usd: '5.000000', held_usd: '0.000000', credit_limit_usd: '0.000000',
    spendable_usd: '5.000000', remaining_usd: '5.000000', pending_intents: 0, status: 'active',
  });

  /**
   * The intent as the gateway reports it. Each read reports the next of `options.statuses` (the last repeats); by default the first read is
   * already `completed`, which is what the measured journeys have always seen. A completed read delivers the transfer: the recipient is
   * credited on the caller's node (unless `value-never-arrives`) and, with `debitSender`, the abstract account is debited.
   */
  const transactionBody = () => {
    const statuses = options.statuses ?? ['completed'];
    const index = Math.min(state.intentReads, statuses.length - 1);
    state.intentReads += 1;
    const last = index === statuses.length - 1;
    const status = options.fault === 'intent-fails' && last ? 'failed' : statuses[index];
    // The live shape: `acc://<64 hex>@<adi>/data`, where the ADI is written without its own scheme.
    const accumTx = `acc://${IDS.accumTx}@${IDS.adi.replace(/^acc:\/\//, '')}/data`;
    const member = (extra) => ({ chain_id: BASE_SEPOLIA, recorded: true, settlement: 'settled', settlement_tx: execution.tx_hash, ...extra });
    const base = {
      intent_id: IDS.intent, identity_id: IDS.identity, status, intent_type: 'transfer', created_at: '2026-10-15T00:00:00Z',
      reason_code: null, proof_id: null, accum_tx_hash: ['created', 'signing_required'].includes(status) ? null : accumTx,
    };
    if (status === 'completed' || status === 'proven' || status === 'delivered') {
      if (!state.credited && state.transfer) {
        state.credited = true;
        if (options.fault !== 'value-never-arrives') {
          const key = state.transfer.to.toLowerCase();
          state.nodeBalances.set(key, (state.nodeBalances.get(key) ?? 0n) + state.transfer.wei);
        }
      }
      return {
        ...base, proof_id: IDS.proof, completion_basis: 'proof_artifact', completed_at: '2026-10-15T00:02:00Z',
        validator: { state: 'settled', members: [member({ proof_cycle: 'written', proof_id: IDS.proof })] },
      };
    }
    if (status === 'executed') {
      return { ...base, validator: { state: 'executed_proof_pending', members: [member({ proof_cycle: 'proof_pending' })] } };
    }
    if (status === 'failed') {
      return { ...base, reason_code: 'target_reverted', error_message: 'the call reverted on the destination chain' };
    }
    return base;
  };

  /** [method, path pattern, handler(match, body) -> [status, body, extra headers?]] */
  const routes = [
    ['GET', /^\/v1\/chains$/, () => [200, chainRegistry(`${self.url}/acc/v3`)]],
    ['GET', /^\/v1\/health\/ready$/, () => [200, { status: 'ready', reasons: [] }]],
    ['GET', /^\/v1\/errors$/, () => [200, { errors: [] }]],
    ['GET', /^\/v1\/billing\/balance$/, () => [200, balanceBody()]],
    // The estimate `send` shows on its confirmation card. It answers the same for any intent: what the CLI does with an estimate is what is under
    // test, not the gateway's pricing, and it is shaped as the real route answers (`estimate: true`, the gates it checked and the ones it did not).
    ['POST', /^\/v1\/transaction\/quote$/, () => [200, {
      estimate: true, evaluated_at: '2026-10-15T00:00:00Z',
      request: { chains: ['base-sepolia'], chain: 'base-sepolia', leg_count: 1, proof_class: null },
      checked: ['chain_enabled', 'price_book', 'organization_funds'],
      not_checked: ['the identity and its key page', 'destination-chain gas', 'quota', 'the bridge\'s own validation'],
      billing: {
        state: 'priced', enforcing: false,
        price: { sku: 'proof.execute', total_usd: '0.150000', platform_fee_usd: '0.150000', gas_usd: '0.000000', max_total_usd: '0.150000', gas_basis: 'flat_priced', price_book_version: 'fake-1' },
        funds: { state: 'ok', spendable_usd: '5.000000', remaining_usd: '5.000000', shortfall_usd: '0.000000', covered: true, gate: 'passes' },
      },
    }]],
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
    ['GET', /^\/v1\/identity\/([^/]+)$/, (m) => {
      if (m[1] !== IDS.identity || !state.identityCreated) return [404, { message: 'identity not found' }];
      state.identityReads += 1;
      return [200, identityBody()];
    }],
    // A new account made with a key, as `certen setup --new-account` does it. The nonce is signed as BYTES with the key it was issued for.
    ['POST', /^\/v1\/signup\/challenge$/, (_m, body) => {
      const nonce = randomBytes(32).toString('hex');
      state.nonces.set(nonce, String(JSON.parse(body || '{}').public_key ?? ''));
      return [200, { nonce, expires_in: 300, algorithm: 'ed25519', instructions: 'sign the nonce bytes' }];
    }],
    ['POST', /^\/v1\/signup$/, (_m, body) => {
      const b = JSON.parse(body || '{}');
      const issuedFor = state.nonces.get(b.nonce);
      state.nonces.delete(b.nonce);
      if (issuedFor === undefined || issuedFor !== b.public_key) return [400, { message: 'unknown or mismatched nonce', code: 'SIGNUP_FAILED' }];
      let ok = false;
      try {
        const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b.public_key, 'hex')]), format: 'der', type: 'spki' });
        ok = verify(null, Buffer.from(b.nonce, 'hex'), pub, Buffer.from(b.signature ?? '', 'hex'));
      } catch { ok = false; }
      if (!ok) return [400, { message: 'signature does not verify over the nonce bytes', code: 'SIGNUP_FAILED' }];
      return [201, { org: { id: 'org-journey', name: b.org_name ?? 'journey', plan: 'trial' }, api_key: 'ck_live_journey_signup_not_a_real_key', key_prefix: 'ck_live_jour', permissions: ['*'] }];
    }],
    ['POST', /^\/v1\/transaction$/, async (_m, body) => {
      state.intentOpened = true;
      const opened = JSON.parse(body);
      state.lastIntentBody = opened;
      const intent = opened.intent ?? {};
      state.transfer = typeof intent.toAddress === 'string' && intent.amount !== undefined ? { to: intent.toAddress, wei: toWei(intent.amount) } : null;
      state.credited = false;
      state.intentReads = 0;
      // `swapped-recipient`: the gateway builds an internally consistent transaction (every hash recomputes) for a recipient nobody named. Only
      // matching what would be signed to the request catches it.
      const built = options.fault === 'swapped-recipient' && typeof intent.toAddress === 'string'
        ? { ...opened, intent: { ...intent, toAddress: `0x${'dd'.repeat(20)}` } }
        : opened;
      return [201, await honestIntent(built, { adiUrl: IDS.adi, keyPage: KEY_PAGE, intentId: IDS.intent })];
    }],
    // The price book. `proof.execute` on base-sepolia is `quoted`, as the live gateway has it: the platform fee is fixed and gas is priced when it runs.
    ['GET', /^\/v1\/pricing$/, () => [200, {
      price_book_version: '2026-10-15', price_book_hash: 'ab'.repeat(16), currency: 'USD',
      items: [
        { sku: 'identity.provision', chain: '*', mode: 'flat', platform_fee_usd: '1.000000', gas_buffer_bps: 0, min_charge_usd: '1.000000', max_charge_usd: null },
        { sku: 'proof.execute', chain: 'base-sepolia', mode: 'quoted', platform_fee_usd: '0.040000', gas_buffer_bps: 1000, min_charge_usd: '0.040000', max_charge_usd: '0.500000' },
        { sku: 'proof.execute', chain: '*', mode: 'flat', platform_fee_usd: '0.100000', gas_buffer_bps: 0, min_charge_usd: '0.100000', max_charge_usd: null },
      ],
    }]],
    ['POST', /^\/v1\/transaction\/([^/]+)\/signature$/, () => [200, { ok: true }]],
    ['GET', /^\/v1\/transaction\/([^/]+)$/, (m) => (state.intentOpened && m[1] === IDS.intent ? [200, transactionBody()] : [404, { message: 'intent not found' }])],
    ['GET', /^\/v1\/proof\/tx\/([^/]+)\/receipt$/, (m) => [200, {
      tx_hash: m[1], status: 'delivered', anchored: true, tx_type: 'writeData', principal: `${IDS.adi}/data`,
      block_time: '2026-10-15T00:00:00Z', receipt: { anchor: 'ab'.repeat(32) },
    }]],
    ['GET', /^\/v1\/proof\/([^/]+)\/bundle$/, () => (options.fault === 'proof-service-down'
      ? [503, { message: 'the proof service is unavailable' }]
      : [200, exec, { 'content-type': 'application/octet-stream' }])],
    ['GET', /^\/v1\/proof\/([^/]+)\/v2$/, () => (options.fault === 'proof-service-down'
      ? [503, { message: 'the proof service is unavailable' }]
      // `portableStatus`: the document is refused with this status (403, say). Not a 5xx and not a 404, so it is neither "the proof service is
      // down" nor "the gateway serves no document": the evidence could not be fetched at all, which a receipt reports as unavailable.
      : options.portableStatus ? [options.portableStatus, { message: `the proof document was refused (${options.portableStatus})` }]
        : [200, portable])],
    // A share link for a proof: what `certen receipt --share` asks for. The token is made up; the URL points back at this fake.
    ['POST', /^\/v1\/proof\/([^/]+)\/share$/, (m, body) => {
      const b = JSON.parse(body || '{}');
      state.shares.push({ proofId: m[1], label: b.label ?? null });
      return [201, {
        id: `share-${state.shares.length}`, proof_id: m[1], token: 'cps_test_not_a_real_token', url: `${self.url}/shared/cps_test_not_a_real_token`,
        label: b.label ?? null, expires_at: '2026-10-23T00:00:00Z',
      }];
    }],
    ['GET', /^\/v1\/proof\/([^/]+)$/, (m) => [200, { proof_id: m[1], status: 'completed', anchored: true }]],
    // The Accumulate node, for the key page read (`status`, `doctor`): the one account it knows, listing the key the identity was created with.
    ['POST', /^\/acc\/v3$/, (_m, body) => {
      // `accumulateDown`: the node cannot be asked, so the key page is `unknown` (and nothing else is wrong).
      if (options.accumulateDown) return [503, { message: 'the Accumulate node is unavailable' }];
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
    // The execution chain's own node: `proof verify --rpc` and `send --rpc`. It answers what a node answers: the header the bundle's receipts
    // root is compared to, the chain id, and the balance of any address (by default none; credited when the intent delivers a transfer).
    // A balance at a block before the execution block is the balance before that delivery.
    ['POST', /^\/rpc$/, (_m, body) => {
      const call = JSON.parse(body || '{}');
      const params = call.params ?? [];
      state.nodeCalls.push({ method: call.method, params });
      if (call.method === 'eth_chainId') return [200, { jsonrpc: '2.0', id: 1, result: options.fault === 'rpc-wrong-chain' ? '0x1' : `0x${BASE_SEPOLIA.toString(16)}` }];
      if (call.method === 'eth_getBalance') {
        const address = String(params[0] ?? '').toLowerCase();
        const tag = params[1];
        let wei = state.nodeBalances.get(address) ?? 0n;
        const delivered = state.credited && state.transfer && state.transfer.to.toLowerCase() === address && options.fault !== 'value-never-arrives';
        if (delivered && typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag) && BigInt(tag) < BigInt(execution.block_number)) wei -= state.transfer.wei;
        return [200, { jsonrpc: '2.0', id: 1, result: `0x${wei.toString(16)}` }];
      }
      return [200, {
        jsonrpc: '2.0', id: 1,
        result: { number: `0x${Number(execution.block_number).toString(16)}`, hash: execution.block_hash, receiptsRoot: execution.receipts_root },
      }];
    }],
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
    /** What the caller's node was asked since the last call, oldest first. */
    takeNodeCalls: () => state.nodeCalls.splice(0, state.nodeCalls.length),
    /** The last body `POST /v1/transaction` received, and the transfer it asked for. */
    lastIntent: () => ({ body: state.lastIntentBody, transfer: state.transfer }),
    /** The share links asked for so far: the proof each was for and the label sent. */
    shares: () => [...state.shares],
    /** Reads of the intent so far. */
    intentReads: () => state.intentReads,
    /** Give an address a native balance on the caller's node, in wei. */
    setNodeBalance: (address, wei) => { state.nodeBalances.set(String(address).toLowerCase(), BigInt(wei)); },
    /** The block the proof says the action executed in, and its transaction. */
    execution: { blockNumber: Number(execution.block_number), txHash: execution.tx_hash, chainId: BASE_SEPOLIA },
    /** The identity already exists and its key page lists this key (SHA-256 of the public key, hex): a machine that has been through `setup`. */
    adoptIdentity: (keyHash) => { state.identityCreated = true; state.keyHash = keyHash; },
    /** Somebody pays the abstract account: what the faucet and the wallet transfer do on a real chain. */
    fundAbstractAccount: () => { state.funded = true; },
    /** Gas arrives after this many MORE reads of the identity: what a faucet does while `setup` polls. Never, under the `funds-never-arrive` fault. */
    fundAfterMoreReads: (n) => { if (options.fault !== 'funds-never-arrive') state.fundAtRead = state.identityReads + n; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
