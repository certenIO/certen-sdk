import http from 'node:http';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { CertenClient } from '@certen.io/sdk';
import { dispatch } from '../src/protocol.js';
import { createHandlers } from '../src/server.js';

/**
 * A small, real world for the two agent tools: a localhost gateway that serves an identity, a balance, the chain registry and the repo's
 * real proof fixtures, a localhost stand-in for the Accumulate node, and a caller that goes through the real server (`createHandlers` and
 * the JSON-RPC dispatcher), so what a test sees is what a client would.
 *
 * Nothing is mocked: what is pinned is what the tools do with what each party actually returns. Shared by `readiness-tool.test.ts`,
 * `receipt-tool.test.ts` and `proof-verify-header.test.ts`.
 */

export const ID = '396f863c-879c-4046-8591-3f0405c5f6bd';
export const ADI = 'acc://probe.acme';
export const PAGE = `${ADI}/book/1`;
export const ACCOUNT = '0xe293e95Ec1471155d977448B99B0922C2828cAcB';
export const KEY = 'a'.repeat(64);
export const OTHER_KEY = 'b'.repeat(64);

export const INTENT = '99999999-2222-4333-8444-555555555555';
export const PROOF = '11111111-2222-4333-8444-555555555555';
export const ACCUM = 'ab'.repeat(32);
export const RECIPIENT = `0x${'cd'.repeat(20)}`;

const confDir = new URL('../../verify/test/fixtures/proofv2/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', confDir), 'utf8'));
const portable = JSON.parse(gunzipSync(readFileSync(new URL(manifest.base, confDir))).toString('utf8'));
const execBundle = JSON.parse(readFileSync(new URL('../../sdk/test/fixtures/execution-proof-base-46437431.json', import.meta.url), 'utf8'));
/** The proof's execution component: the block the fixture's transfer ran in. */
export const component = (execBundle.proof_components ?? execBundle.bundle.proof_components)['5_execution_proof'] as {
  tx_hash: string; block_number: string | number; block_hash: string; receipts_root: string; logs: Array<{ address: string; topics: string[] }>;
};
export const BLOCK = Number(component.block_number);

/** The header a node returns for the proof's block: what an agent passes as `header`. */
export const GOOD_HEADER = { number: `0x${BLOCK.toString(16)}`, hash: component.block_hash, receiptsRoot: component.receipts_root };
export const WRONG_ROOT_HEADER = { ...GOOD_HEADER, receiptsRoot: `0x${'00'.repeat(32)}` };

/** An event the fixture's own execution receipt carries, for the contract-call effect. */
export const EVENT = { address: component.logs[0]!.address, topic0: component.logs[0]!.topics[0]! };

export const completedTx = {
  intent_id: INTENT, identity_id: ID, status: 'completed', proof_id: PROOF, accum_tx_hash: `acc://${ACCUM}@probe.acme/data`, created_at: '2026-10-15T00:00:00Z',
};

export interface Stub { url: string; hits: string[]; close: () => Promise<void> }

export async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Stub> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
      res.setHeader('content-type', 'application/json');
      handler(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    hits,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const send = (res: http.ServerResponse, status: number, body: unknown): void => { res.statusCode = status; res.end(JSON.stringify(body)); };
const chainEntry = (id: string, chainId: number) => ({
  id, chainId, family: 'evm', displayName: id, environment: 'testnet', explorer: 'https://sepolia.basescan.org', status: 'live', contracts: {}, enabled: true,
});

export const goodIdentity = (over: Record<string, unknown> = {}) => ({
  id: ID, adi_url: ADI, book_url: `${ADI}/book`, key_page_url: PAGE, status: 'active', can_sign: true, credit_balance: 500,
  chain_accounts: [{ chain_id: '84532', address: ACCOUNT, status: 'deployed' }],
  balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: 'ETH', balance: '0.0021' }],
  created_at: '2026-10-15T00:00:00Z',
  ...over,
});
export const goodBalance = { currency: 'USD', available_usd: '5.000000', held_usd: '0', credit_limit_usd: '0', spendable_usd: '5.000000', remaining_usd: '5.000000', pending_intents: 0, status: 'active' };
export const keyPageReply = (res: http.ServerResponse, account: Record<string, unknown> = {}): void => {
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { account: { type: 'keyPage', url: PAGE, keys: [{ publicKeyHash: KEY }], creditBalance: 1240, version: 2, acceptThreshold: 1, ...account } } }));
};

/** What a gateway answers for a redeemed share link: the repo's real execution bundle, as the gateway stores it. */
export const sharedProof = () => ({ proof_id: PROOF, shared: true, expires_at: '2026-12-01T00:00:00Z', view_count: 1, bundle: execBundle });

export interface World {
  /** `/v1/proof/shared/redirect-out` answers 302 to this URL. */
  redirectShareTo?: string;
  /** Status and body for GET /v1/identity/:id. */
  identity?: [number, unknown];
  /** Status and body for GET /v1/billing/balance. */
  balance?: [number, unknown];
  /** The registry advertises no Accumulate endpoint at all. */
  noAccumulateEndpoint?: boolean;
  /** How the Accumulate node answers. */
  accumulate?: (res: http.ServerResponse) => void;
  /** The intent as the gateway reports it. */
  tx?: Record<string, unknown>;
  bundle?: 'ok' | '404' | '500';
  portable?: 'ok' | '404' | '500';
}

export interface ToolResult {
  isError: boolean;
  /** The parsed text content. */
  body: any;
  structured: any;
  text: string;
}

export interface AgentWorld {
  gateway: Stub;
  accumulate: Stub;
  /** Call a tool through the real server. `env` is the server's configuration (what the operator set). */
  call: (name: string, args: Record<string, unknown>, env?: Record<string, string>) => Promise<ToolResult>;
  close: () => Promise<void>;
}

const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';

export async function startWorld(w: World = {}): Promise<AgentWorld> {
  const accumulate = await serve((_req, res) => (w.accumulate ?? ((r) => keyPageReply(r)))(res));
  const gateway = await serve((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    const bytes = (status: number, body: Buffer): void => { res.statusCode = status; res.setHeader('content-type', 'application/octet-stream'); res.end(body); };
    if (path === '/v1/chains') {
      return send(res, 200, {
        version: '2026-10-15', last_updated: 'x', count: 3,
        ...(w.noAccumulateEndpoint ? {} : { accumulate: { network: 'kermit', environment: 'testnet', api: `${accumulate.url}/v3`, explorer: 'https://explorer.accumulatenetwork.io' } }),
        chains: [chainEntry('ethereum-sepolia', 11155111), chainEntry('base-sepolia', 84532), chainEntry('arbitrum-sepolia', 421614)],
      });
    }
    if (path === '/v1/billing/balance') return send(res, ...(w.balance ?? [200, goodBalance]));
    if (path === `/v1/identity/${ID}`) return send(res, ...(w.identity ?? [200, goodIdentity()]));
    if (path === '/v1/portfolio') return send(res, 200, { identities: [], total_chains: 0 });
    if (path === `/v1/transaction/${INTENT}`) return send(res, 200, w.tx ?? completedTx);
    if (path === `/v1/proof/${PROOF}/bundle`) {
      if (w.bundle === '404') return send(res, 404, { message: 'no such bundle' });
      if (w.bundle === '500') return send(res, 500, { message: 'proof service down' });
      return bytes(200, Buffer.from(JSON.stringify(execBundle)));
    }
    if (path === `/v1/proof/${PROOF}/v2`) {
      if (w.portable === '404') return send(res, 404, { message: 'none' });
      if (w.portable === '500') return send(res, 500, { message: 'down' });
      return send(res, 200, portable);
    }
    if (path.startsWith('/v1/proof/tx/') && path.endsWith('/receipt')) return send(res, 200, { tx_hash: ACCUM, status: 'delivered', anchored: true });
    const shared = /^\/v1\/proof\/shared\/([^/]+)$/.exec(path);
    if (shared) {
      // A redirect out of the origin, for the case where an allowed host tries to send the fetch somewhere it was never allowed to go.
      if (shared[1] === 'redirect-out' && w.redirectShareTo) { res.statusCode = 302; res.setHeader('location', w.redirectShareTo); return void res.end(); }
      return send(res, 200, sharedProof());
    }
    return send(res, 404, { message: `no route ${path}` });
  });

  const call: AgentWorld['call'] = async (name, args, env = {}) => {
    // maxRetries 0: the SDK's backoff on a 5xx or a refused connection is its own tested behaviour, and it would make every "the gateway is down" case seconds long.
    const handlers = createHandlers({
      env: { CERTEN_API_KEY: 'test-key', CERTEN_API_URL: gateway.url, ...env } as NodeJS.ProcessEnv,
      client: new CertenClient({ apiKey: 'test-key', baseUrl: gateway.url, maxRetries: 0 }),
    });
    const res = (await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { [PV]: '2026-07-28', [CAPS]: {} } } }, handlers))?.result as any;
    const text: string = res.content?.[0]?.text ?? '';
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { isError: res.isError === true, body, structured: res.structuredContent, text };
  };

  return { gateway, accumulate, call, close: async () => { await gateway.close(); await accumulate.close(); } };
}
