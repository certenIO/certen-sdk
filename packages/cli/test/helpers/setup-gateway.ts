import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

/**
 * A stateful stand-in for the CERTEN gateway and an Accumulate node, for driving `certen setup` and `certen gas` end to end.
 *
 * It models what those commands depend on, the way the live gateway behaves where the CLI has been bitten by the difference:
 *
 *   - `POST /v1/signup` VERIFIES the Ed25519 signature over the nonce BYTES with the public key it was sent. A client that signed the hex text,
 *     or hashed first, is refused, so a test that passes proves the signature is the right one rather than that something was signed;
 *   - an organisation made with a key is capped at ONE identity until approved: a second `POST /v1/identity` is refused (409). That is the
 *     failure `setup` must never walk into by creating a second identity on a rerun;
 *   - `POST /v1/identity` answers 202 `provisioning`, and the identity becomes `active` only after N reads (or ends in `error`);
 *   - a new abstract account holds no gas until it is funded, which can be after N reads of the identity (what a faucet does mid-wait);
 *   - the Accumulate node lists the key the identity was created with, which is what a real provisioning does, so the independent key page
 *     read in `readiness` has something true to find.
 *
 * Every request is recorded, so a test can assert what was NOT sent as well as what was.
 */

export interface Call { method: string; path: string; status: number; body?: unknown; key?: string }

export interface SetupGatewayOptions {
  /** API keys the gateway accepts to begin with. Default none: a fresh machine. */
  acceptedKeys?: string[];
  /** Self-service (keypair signup, device flow) is on. Default true. */
  selfService?: boolean;
  /** The device flow answers `pending` this many polls before approving. Default 1. */
  devicePendingPolls?: number;
  /** The device flow ends denied instead of approved. */
  deviceDenied?: boolean;
  /** `GET /v1/portal/device` answers 404, as a gateway from before the feature does. */
  deviceUnsupported?: boolean;
  /** Registration tokens this gateway will redeem. */
  registrationTokens?: string[];
  /** Reads of the identity that answer `provisioning` before it settles. Default 1. */
  provisioningReads?: number;
  /** How provisioning ends. Default `active`. */
  finalStatus?: 'active' | 'error';
  /** The identity can sign according to the gateway. Default true. */
  gatewayCanSign?: boolean;
  /** An organisation made with a key may hold one identity. Default true. */
  capOneIdentity?: boolean;
  /** Reads of the identity after which the abstract account is funded. Default: never. */
  fundAfterReads?: number;
  /** The balance the account holds once funded, whole units. Default `0.001`. */
  fundedBalance?: string;
  /** The Accumulate node lists a different key from the one the identity was created with. */
  keyPageLacksKey?: boolean;
  /** The key page's credit balance. Default 500. */
  credits?: number;
  /** The gateway's balance in USD. Default `5.000000`. */
  spendableUsd?: string;
  /** What `polling` the create response carries. Default none. */
  polling?: { first_poll_after_seconds: number; interval_seconds: number; estimated_ready_in_seconds: number; terminal_states: string[] };
  /** The Accumulate node is unreachable (it answers 503). */
  accumulateDown?: boolean;
  /** An identity that already exists in the organisation (preseeded), by the id the test records locally. */
  existing?: { id: string; name: string; adi: string; status?: string; canSign?: boolean; funded?: boolean; keyHash?: string };
}

export interface SetupGateway {
  url: string;
  calls: Call[];
  /** Requests whose `METHOD /path` equals `what`. */
  count(what: string): number;
  /** The paths hit, in order, as `METHOD /path`. */
  paths(): string[];
  /** Somebody pays the abstract account now. */
  fund(): void;
  /** Change how many reads of the identity answer `provisioning` before it settles (a gateway that finishes at last). */
  setProvisioningReads(n: number): void;
  /** How the NEXT identity ends (a gateway that recovers after a failure). */
  setFinalStatus(status: 'active' | 'error'): void;
  /** The account is funded after this many MORE reads of the identity (what a faucet does while someone waits). */
  fundAfterMoreReads(n: number): void;
  state: {
    identities: Array<{ id: string; name: string; adi: string; keyHash: string; status: string; reads: number }>;
    funded: boolean;
    signups: number;
    acceptedKeys: Set<string>;
    retired: string[];
    lastCreateBody?: Record<string, unknown>;
  };
  close(): Promise<void>;
}

export const FAKE = Object.freeze({
  chain: 'base-sepolia',
  chainId: 84532,
  abstractAccount: '0xe293e95Ec1471155d977448B99B0922C2828cAcB',
});

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function startSetupGateway(options: SetupGatewayOptions = {}): Promise<SetupGateway> {
  const o = {
    selfService: true, devicePendingPolls: 1, provisioningReads: 1, finalStatus: 'active' as const, gatewayCanSign: true, capOneIdentity: true,
    fundedBalance: '0.001', credits: 500, spendableUsd: '5.000000', ...options,
  };
  const calls: Call[] = [];
  const state: SetupGateway['state'] = {
    identities: [], funded: false, signups: 0, acceptedKeys: new Set(o.acceptedKeys ?? []), retired: [],
  };
  const nonces = new Map<string, string>(); // nonce -> public key it was issued for
  const devices = new Map<string, { polls: number; claimed: boolean }>();
  let counter = 0;
  let selfUrl = '';

  if (o.existing) {
    state.identities.push({
      id: o.existing.id, name: o.existing.name, adi: o.existing.adi, keyHash: o.existing.keyHash ?? 'ee'.repeat(32), status: o.existing.status ?? 'active', reads: 99,
    });
    state.funded = o.existing.funded ?? false;
  }
  if (o.existing && o.existing.canSign === false) o.gatewayCanSign = false;

  const mintKey = (): string => {
    counter += 1;
    const key = `ck_live_${randomBytes(12).toString('hex')}${counter}`;
    state.acceptedKeys.add(key);
    return key;
  };

  const identityOf = (i: SetupGateway['state']['identities'][number], withBalances: boolean) => {
    const settled = i.status === 'provisioning' ? 'provisioning' : i.status;
    return {
      id: i.id, name: i.name, adi_url: i.adi, book_url: `${i.adi}/book`, key_page_url: `${i.adi}/book/1`, status: settled,
      can_sign: settled === 'provisioning' ? null : settled === 'active' ? o.gatewayCanSign : null,
      credit_balance: o.credits,
      ...(settled === 'error' ? { error_message: 'the key page could not be created' } : {}),
      chain_accounts: settled === 'provisioning' ? [] : [{ chain_id: String(FAKE.chainId), address: FAKE.abstractAccount, status: 'deployed' }],
      ...(withBalances && settled === 'active'
        ? { balances: [{ chain_id: FAKE.chain, address: FAKE.abstractAccount, token: 'ETH', balance: state.funded ? o.fundedBalance : '0' }] }
        : {}),
      created_at: '2026-10-15T00:00:00Z',
    };
  };

  const authed = (req: http.IncomingMessage): string | undefined => {
    const key = req.headers['x-api-key'];
    return typeof key === 'string' && state.acceptedKeys.has(key) ? key : undefined;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<{ status: number; body?: unknown; key?: string }> => {
    const path = (req.url ?? '').split('?')[0]!;
    const method = req.method ?? 'GET';
    const body = raw ? (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; } })() : {};
    const send = (status: number, payload: unknown): { status: number; body?: unknown } => { json(res, status, payload); return { status, body }; };
    const key = authed(req);
    const needKey = (): boolean => {
      if (key) return true;
      send(401, { message: 'invalid or missing API key', code: 'UNAUTHORIZED' });
      return false;
    };

    // ── public ──
    if (method === 'GET' && path === '/v1/chains') {
      const entry = (id: string, chainId: number) => ({ id, chainId, family: 'evm', displayName: id, environment: 'testnet', status: 'live', explorer: 'https://x', contracts: {}, enabled: true });
      return send(200, {
        version: '2026-10-15', last_updated: '2026-10-15T00:00:00Z',
        accumulate: { network: 'kermit', environment: 'testnet', api: `${selfUrl}/acc/v3`, explorer: 'https://explorer.example' },
        count: 3, chains: [entry('ethereum-sepolia', 11155111), entry(FAKE.chain, FAKE.chainId), entry('arbitrum-sepolia', 421614)],
      });
    }

    // ── sign-up with a key ──
    if (method === 'POST' && path === '/v1/signup/challenge') {
      if (!o.selfService) return send(403, { message: 'self-service is not enabled', code: 'SELF_SERVICE_DISABLED' });
      const nonce = randomBytes(32).toString('hex');
      nonces.set(nonce, String((body as { public_key?: string }).public_key ?? ''));
      return send(200, { nonce, expires_in: 300, algorithm: 'ed25519', instructions: 'sign the nonce bytes' });
    }
    if (method === 'POST' && path === '/v1/signup') {
      if (!o.selfService) return send(403, { message: 'self-service is not enabled', code: 'SELF_SERVICE_DISABLED' });
      const b = body as { public_key?: string; nonce?: string; signature?: string; org_name?: string };
      const issuedFor = b.nonce ? nonces.get(b.nonce) : undefined;
      nonces.delete(b.nonce ?? ''); // spent whether or not it worked
      if (issuedFor === undefined || issuedFor !== b.public_key) return send(400, { message: 'unknown or mismatched nonce', code: 'SIGNUP_FAILED' });
      let ok = false;
      try {
        const pub = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(b.public_key!, 'hex')]), format: 'der', type: 'spki' });
        ok = verify(null, Buffer.from(b.nonce!, 'hex'), pub, Buffer.from(b.signature ?? '', 'hex'));
      } catch { ok = false; }
      if (!ok) return send(400, { message: 'signature does not verify over the nonce bytes', code: 'SIGNUP_FAILED' });
      state.signups += 1;
      return send(201, {
        org: { id: 'org-1', name: b.org_name ?? 'self-service-org', plan: 'trial' }, api_key: mintKey(), key_prefix: 'ck_live_new', permissions: ['*'],
      });
    }
    if (method === 'POST' && path === '/v1/registration-tokens/redeem') {
      const b = body as { token?: string; org_name?: string };
      if (!b.token || !(o.registrationTokens ?? []).includes(b.token)) return send(404, { message: 'token not found, expired or already used' });
      o.registrationTokens = (o.registrationTokens ?? []).filter((t) => t !== b.token);
      return send(201, { org: { id: 'org-2', name: b.org_name ?? 'from-token', plan: 'trial' }, api_key: mintKey(), key_prefix: 'ck_live_tok', permissions: ['*'] });
    }

    // ── the device flow ──
    if (method === 'POST' && path === '/v1/portal/device') {
      if (o.deviceUnsupported) return send(404, { message: 'not found' });
      if (!o.selfService) return send(403, { message: 'self-service is not enabled' });
      const code = randomBytes(16).toString('hex');
      devices.set(code, { polls: 0, claimed: false });
      return send(200, { device_code: code, user_code: 'ABCD-EFGH', verification_uri: `${selfUrl}/portal/device`, verification_uri_complete: `${selfUrl}/portal/device?code=ABCD-EFGH`, expires_in: 600, interval: 1 });
    }
    const poll = /^\/v1\/portal\/device\/([^/]+)$/.exec(path);
    if (method === 'GET' && poll) {
      const d = devices.get(poll[1]!);
      if (!d) return send(404, { message: 'unknown device code' });
      d.polls += 1;
      if (o.deviceDenied) return send(200, { status: 'denied' });
      if (d.polls <= o.devicePendingPolls) return send(200, { status: 'pending', interval: 1 });
      if (d.claimed) return send(200, { status: 'claimed' });
      d.claimed = true;
      return send(200, { status: 'approved', api_key: mintKey(), key_prefix: 'ck_live_dev', org_id: 'org-3', permissions: ['*'] });
    }

    // ── the Accumulate node ──
    if (method === 'POST' && path === '/acc/v3') {
      if (o.accumulateDown) return send(503, { message: 'unavailable' });
      const q = body as { id?: number; params?: { scope?: string } };
      const identity = state.identities.find((i) => `${i.adi}/book/1` === q.params?.scope);
      if (!identity || identity.status !== 'active') {
        return send(200, { jsonrpc: '2.0', id: q.id ?? 1, error: { code: -33001, message: `${q.params?.scope ?? 'account'} not found` } });
      }
      return send(200, {
        jsonrpc: '2.0', id: q.id ?? 1,
        result: { recordType: 'account', account: { type: 'keyPage', url: `${identity.adi}/book/1`, keys: [{ publicKeyHash: o.keyPageLacksKey ? 'ff'.repeat(32) : identity.keyHash }], creditBalance: o.credits, version: 2, acceptThreshold: 1 } },
      });
    }

    // ── authenticated ──
    if (!needKey()) return { status: 401, body };

    if (method === 'GET' && path === '/v1/billing/balance') {
      return send(200, {
        currency: 'USD', available_usd: o.spendableUsd, held_usd: '0.000000', credit_limit_usd: '0.000000', spendable_usd: o.spendableUsd,
        remaining_usd: o.spendableUsd, pending_intents: 0, status: 'active',
      });
    }
    if (method === 'POST' && path === '/v1/identity') {
      if (o.capOneIdentity && state.identities.filter((i) => i.status !== 'retired').length >= 1) {
        return send(409, { message: 'this organization may hold one identity until it is approved', code: 'IDENTITY_LIMIT_REACHED' });
      }
      const b = body as Record<string, unknown>;
      state.lastCreateBody = b;
      const keyHash = String(b.public_key_hash ?? (b.public_key ? createHash('sha256').update(Buffer.from(String(b.public_key), 'hex')).digest('hex') : ''));
      const id = `00000000-0000-4000-8000-${String(state.identities.length + 1).padStart(12, '0')}`;
      const name = String(b.name);
      const record = { id, name, adi: `acc://${name}.acme`, keyHash, status: 'provisioning', reads: 0 };
      state.identities.push(record);
      return send(202, { ...identityOf(record, false), status: 'provisioning', ...(o.polling ? { polling: o.polling } : {}) });
    }
    const one = /^\/v1\/identity\/([^/]+)$/.exec(path);
    if (method === 'GET' && one) {
      const record = state.identities.find((i) => i.id === one[1]);
      if (!record) return send(404, { message: 'identity not found' });
      record.reads += 1;
      if (record.status === 'provisioning' && record.reads > o.provisioningReads) record.status = o.finalStatus;
      if (o.fundAfterReads !== undefined && record.reads >= o.fundAfterReads) state.funded = true;
      return send(200, identityOf(record, true));
    }
    if (method === 'DELETE' && one) {
      const record = state.identities.find((i) => i.id === one[1]);
      if (!record) return send(404, { message: 'identity not found' });
      record.status = 'retired';
      state.retired.push(record.id);
      return send(200, { success: true });
    }
    if (method === 'GET' && path === '/v1/portfolio') {
      return send(200, { identities: [], total_chains: 0 });
    }
    return send(404, { message: `no route for ${method} ${path} in the setup gateway`, error: 'Not Found' });
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      handle(req, res, Buffer.concat(chunks).toString('utf8')).then((r) => {
        calls.push({ method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0]!, status: r.status, body: r.body, key: req.headers['x-api-key'] as string | undefined });
      }).catch((err: unknown) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  selfUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: selfUrl,
    calls,
    count: (what) => calls.filter((c) => `${c.method} ${c.path}` === what).length,
    paths: () => calls.map((c) => `${c.method} ${c.path}`),
    fund: () => { state.funded = true; },
    setProvisioningReads: (n) => { o.provisioningReads = n; },
    setFinalStatus: (status) => { o.finalStatus = status; },
    fundAfterMoreReads: (n) => {
      const reads = state.identities.reduce((m, i) => Math.max(m, i.reads), 0);
      o.fundAfterReads = reads + n;
    },
    state,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
