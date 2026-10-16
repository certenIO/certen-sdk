import {
  CertenError, DEFAULT_BASE_URL, chainInfo, evmAddressProblem, nativeSymbolFor, wholeUnitAmountProblem,
} from '@certen.io/sdk';
import type { CertenClient, Readiness, Receipt, ReceiptRequest } from '@certen.io/sdk';
import { ALLOW_ANY_CHAIN_ENV_VAR, assertChainUsable, configuredChains } from './chains.js';

/**
 * What `certen_readiness` and `certen_receipt` do around the SDK.
 *
 * The judgement is the SDK's: `client.readiness()` and `buildReceipt()` are what `certen status` and `certen receipt` render, and they are tested
 * there. What belongs HERE is this server's own rules, which an SDK user (who may well want a node of their own) does not share:
 *
 *   - **It never calls a node the caller names.** A server an agent drives, handed a URL, is a way to make that server probe the network it sits in. So
 *     neither tool takes an `rpc`. The execution layer is closed with a block header the caller fetched itself; the Accumulate endpoint for the
 *     independent key page read is the one the gateway's registry advertises, or the OPERATOR's `CERTEN_ACCUMULATE_RPC` (server configuration, beside
 *     `CERTEN_ENABLED_CHAINS`), never an argument. A parameter this file does not read cannot be used, whatever a caller sends.
 *   - **Everything about the invocation is checked before a request is made**: the identity is a UUID, the chain is one this server enables, the amount
 *     is whole units, the recipient's checksum holds. A mistake is told as a mistake (status 0, nothing sent), not as a gateway answer to nonsense.
 *   - **It writes nothing.** The CLI keeps receipts under `~/.certen`; this server keeps no state, and the result is the record.
 */

type Env = Record<string, string | undefined>;

/** The Accumulate JSON-RPC endpoint for the independent key page read, set by whoever runs the server. Never an argument. */
export const ACCUMULATE_RPC_ENV_VAR = 'CERTEN_ACCUMULATE_RPC';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_KEY_HASH = /^(0x)?[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOPIC = /^0x[0-9a-fA-F]{64}$/;

const refuse = (message: string, code: string): CertenError => new CertenError(message, 0, code);

/** An argument that would name a node to call, by any of the names an agent reaches for. */
const NODE_ARGUMENT = /^(rpc|rpcUrl|rpc_url|evmRpc|jsonRpc|accumulateRpc|accumulate_rpc|node|nodeUrl|node_url|url|uri|endpoint|host)$/i;

/**
 * Refuse an argument the tool does not have, by name, instead of ignoring it.
 *
 * Ignoring is the dangerous answer here: an agent that passes `rpc` and gets a normal result will believe the node was used, and a receipt whose effect
 * says "no node of yours was given" reads like an invitation to try again. So a name that means "call this node" says why it will not, and what to do
 * instead; any other unknown name lists the ones the tool takes. (The same choice `HEADER_FIELDS_UNSUPPORTED` made for header fields: refused, nothing sent.)
 */
function onlyKnown(tool: string, where: string, args: Record<string, unknown>, known: readonly string[], instead: string): void {
  for (const key of Object.keys(args)) {
    if (known.includes(key)) continue;
    const place = where === 'arguments' ? 'argument' : `field in ${where}`;
    if (NODE_ARGUMENT.test(key)) {
      throw refuse(`${tool} never calls a node you name, so it has no "${key}" ${place}. ${instead}`, 'NODE_ARGUMENT_REFUSED');
    }
    throw refuse(`${tool} has no "${key}" ${place}. ${where === 'arguments' ? 'It takes' : 'That object takes'}: ${known.join(', ')}.`, 'UNKNOWN_ARGUMENT');
  }
}

/** An optional argument that was given. A model that sends `null` for "not provided" has not provided it; it is not a malformed value. */
const given = (value: unknown): boolean => value !== undefined && value !== null;

function plain(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function uuid(args: Record<string, unknown>, key: string, code: string, what: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !UUID.test(v)) {
    throw refuse(`${key} must be ${what} as a UUID (it looks like 396f863c-879c-4046-8591-3f0405c5f6bd), got ${JSON.stringify(v)}.`, code);
  }
  return v;
}

function chainName(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw refuse(`${where} needs a chain, e.g. "base-sepolia".`, 'MISSING_CHAIN');
  return value;
}

/** A whole-unit amount, as a string: the same rule `certen send` and `certen status --amount` apply, including the refusal of wei. */
function amountOf(value: unknown, where: string): string {
  if (typeof value !== 'string') throw refuse(`${where} must be a decimal STRING in whole units, e.g. "0.001" (a JSON number loses precision), got ${JSON.stringify(value)}.`, 'INVALID_AMOUNT');
  const problem = wholeUnitAmountProblem(value);
  if (problem) throw refuse(problem, 'INVALID_AMOUNT');
  return value;
}

// ── share links ───────────────────────────────────────────────────────────────────────────────────────

/** Other deployments whose proof share links this server may open, set by whoever runs it (comma-separated origins). Never an argument. */
export const SHARE_ORIGINS_ENV_VAR = 'CERTEN_SHARE_ORIGINS';

const originOf = (value: string): string | undefined => {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The origins the operator listed. A setting that does not parse is refused by name, never skipped: a typo that quietly narrowed the list would look like a
 * counterparty's link being broken, and one that quietly widened it would be worse. (The same rule `CERTEN_ENABLED_CHAINS` follows.)
 */
function listedShareOrigins(env: Env): string[] {
  const out: string[] = [];
  for (const entry of (env[SHARE_ORIGINS_ENV_VAR] ?? '').split(',').map((e) => e.trim()).filter(Boolean)) {
    const origin = originOf(entry);
    if (!origin) {
      throw refuse(`${SHARE_ORIGINS_ENV_VAR} names "${entry}", which is not an http(s) origin (e.g. https://gateway.example). Fix the setting; no share link is opened until it parses.`, 'SHARE_ORIGINS_INVALID');
    }
    out.push(origin);
  }
  return out;
}

/**
 * Where a proof SHARE link may be fetched from, or a refusal before any request.
 *
 * The SDK's `fetchSharedProof` takes a link's own origin, so the host fetched from was whichever one a caller wrote into the link, and a bare `cps_` token
 * went to the DEFAULT gateway rather than the one this server is configured for. A server that connects wherever a prompt says is a way to make it probe the
 * network it sits in. So: the gateway this server is configured for, or an origin its operator listed, and nothing else. A bare token is this gateway's.
 */
export function shareSource(target: string, env: Env): { baseUrl: string } {
  const configured = env.CERTEN_API_URL || DEFAULT_BASE_URL;
  const listed = listedShareOrigins(env);
  const text = target.trim();
  if (!/^https?:\/\//i.test(text)) return { baseUrl: configured.replace(/\/+$/, '') };
  let origin: string;
  try { origin = new URL(text).origin; } catch { throw refuse(`"${target}" is not a share link (expected https://<gateway>/v1/proof/shared/<token>).`, 'INVALID_SHARE_LINK'); }
  const own = originOf(configured);
  if (origin === own || listed.includes(origin)) return { baseUrl: origin };
  throw refuse(
    `The share link is on ${origin}, which this server does not open links from. It opens links on its own gateway${own ? ` (${own})` : ''} and on origins its operator lists in `
    + `${SHARE_ORIGINS_ENV_VAR} (comma-separated, e.g. ${SHARE_ORIGINS_ENV_VAR}=${origin}). Nothing was requested.`,
    'SHARE_ORIGIN_NOT_ALLOWED',
  );
}

// ── certen_readiness ──────────────────────────────────────────────────────────────────────────────────

/** Is this identity, on this chain, able to act right now? One call, ordered checks, never ready over an unknown. */
export async function runReadinessTool(client: CertenClient, args: Record<string, unknown>, env: Env): Promise<Readiness> {
  // Every check on the arguments comes before the first request.
  onlyKnown('certen_readiness', 'arguments', args, ['identityId', 'chain', 'keyHash', 'amount', 'tokenSymbol'],
    `The Accumulate node for the key page read is the one the gateway advertises, or the operator's ${ACCUMULATE_RPC_ENV_VAR}.`);
  const identityId = uuid(args, 'identityId', 'INVALID_IDENTITY_ID', 'the identity\'s id (an acc:// URL is not accepted: certen_portfolio_get lists the ids)');
  const rawChain = chainName(args.chain, 'certen_readiness');
  let keyHash: string | undefined;
  if (given(args.keyHash)) {
    if (typeof args.keyHash !== 'string' || !HEX_KEY_HASH.test(args.keyHash)) {
      throw refuse('keyHash must be the SHA-256 of the signing key\'s PUBLIC key: 64 hex characters.', 'INVALID_KEY_HASH');
    }
    keyHash = args.keyHash.replace(/^0x/i, '').toLowerCase();
  }
  const amount = given(args.amount) ? amountOf(args.amount, 'amount') : undefined;
  const tokenSymbol = typeof args.tokenSymbol === 'string' && args.tokenSymbol !== '' ? args.tokenSymbol : undefined;
  if (given(args.tokenSymbol) && tokenSymbol === undefined) throw refuse('tokenSymbol must be a token symbol such as "USDC".', 'INVALID_TOKEN');

  const chain = await assertChainUsable(client, rawChain, env);
  return client.readiness({
    identityId,
    chain,
    keyHash,
    amount,
    tokenSymbol,
    // The operator's endpoint, or (when unset) the one the gateway's registry advertises. Never from `args`.
    accumulateRpc: env[ACCUMULATE_RPC_ENV_VAR] || undefined,
    // The set this server accepts anywhere else, so a chain it would refuse in another tool cannot read as fine here. The deliberate escape
    // (a chain the gateway serves that the catalogue does not list) judges by the gateway's registry alone, as the other tools do.
    configuredChains: env[ALLOW_ANY_CHAIN_ENV_VAR] === '1' ? undefined : configuredChains(env),
  });
}

// ── certen_receipt ────────────────────────────────────────────────────────────────────────────────────

/** What the caller says the intent was, so the receipt can say what of it is established. Neither is needed to read a receipt. */
interface Described {
  request: ((identityId: string) => ReceiptRequest) | null;
  expect: { address: string; topic0: string; topic1?: string } | undefined;
}

const FETCH_THE_HEADER = 'To close the proof\'s execution layer, fetch the block header from your own node and pass it as header: { receiptsRoot, hash, number }.';

async function describeIntent(client: CertenClient, args: Record<string, unknown>, env: Env): Promise<Described> {
  const transfer = given(args.transfer) ? plain(args.transfer) : undefined;
  const call = given(args.call) ? plain(args.call) : undefined;
  if (given(args.transfer) && !transfer) throw refuse('transfer must be an object { chain, to, amount }.', 'INVALID_TRANSFER');
  if (given(args.call) && !call) throw refuse('call must be an object { chain, expect? }.', 'INVALID_CALL');
  if (transfer) onlyKnown('certen_receipt', 'transfer', transfer, ['chain', 'to', 'amount'], FETCH_THE_HEADER);
  if (call) {
    onlyKnown('certen_receipt', 'call', call, ['chain', 'expect'], FETCH_THE_HEADER);
    const expectObject = plain(call.expect);
    if (expectObject) onlyKnown('certen_receipt', 'call.expect', expectObject, ['address', 'topic0', 'topic1'], FETCH_THE_HEADER);
  }
  if (transfer && call) throw refuse('Give transfer or call, not both: an intent is one or the other.', 'CONFLICTING_OPTIONS');
  if (!transfer && !call) return { request: null, expect: undefined };

  if (transfer) {
    // Everything checked before the chain is (which can ask the gateway about an opt-in chain), so a bad invocation sends nothing.
    if (typeof transfer.to !== 'string' || transfer.amount === undefined) {
      throw refuse('transfer needs { chain, to, amount }: the chain, the recipient address and the amount in whole units.', 'INVALID_TRANSFER');
    }
    const problem = evmAddressProblem(transfer.to);
    if (problem) throw refuse(problem, 'INVALID_ADDRESS');
    const amount = amountOf(transfer.amount, 'transfer.amount');
    if (!/[1-9]/.test(amount)) throw refuse('transfer.amount must be greater than zero.', 'INVALID_AMOUNT');
    const raw = chainName(transfer.chain, 'transfer');
    const chain = await assertChainUsable(client, raw, env);
    const to = transfer.to;
    return {
      expect: undefined,
      request: (identityId) => ({
        kind: 'transfer', chain, chain_id: chainInfo(chain)?.chainId ?? null, identity_id: identityId, adi_url: null,
        from: null, to, amount, asset: nativeSymbolFor(chain) ?? null, contract_call: null,
      }),
    };
  }

  const c = call!;
  let expect: Described['expect'];
  if (given(c.expect)) {
    const e = plain(c.expect);
    const topic1 = e?.topic1;
    if (!e || typeof e.address !== 'string' || !ADDRESS.test(e.address) || typeof e.topic0 !== 'string' || !TOPIC.test(e.topic0)
      || (given(topic1) && (typeof topic1 !== 'string' || !TOPIC.test(topic1)))) {
      throw refuse('call.expect must be { address, topic0, topic1? }: the emitting contract (0x + 40 hex) and the event\'s topic (0x + 64 hex).', 'INVALID_EXPECTATION');
    }
    expect = { address: e.address, topic0: e.topic0, ...(typeof topic1 === 'string' ? { topic1 } : {}) };
  }
  const chain = await assertChainUsable(client, chainName(c.chain, 'call'), env);
  return {
    expect,
    request: (identityId) => ({
      kind: 'contract_call', chain, chain_id: chainInfo(chain)?.chainId ?? null, identity_id: identityId, adi_url: null,
      from: null, to: null, amount: null, asset: null, contract_call: null,
    }),
  };
}

/**
 * Everything known about one intent: what happened, the ids to keep, whether the proof holds, and what of the effect is established.
 * The document is the CLI's (`certen receipt`, docs/CLI-CONTRACT.md section 10), unchanged.
 */
export async function runReceiptTool(client: CertenClient, args: Record<string, unknown>, env: Env): Promise<Receipt> {
  onlyKnown('certen_receipt', 'arguments', args, ['intentId', 'header', 'transfer', 'call'], FETCH_THE_HEADER);
  const intentId = uuid(args, 'intentId', 'INVALID_INTENT_ID', 'the intent\'s id');
  // The verifier is loaded on first use: it brings the Accumulate encoder, which the other tools never need.
  const { buildReceipt, assertComparableHeader } = await import('@certen.io/sdk/verify');
  // Checked first, before anything is read, so a header that compares nothing is refused and not turned into a verdict.
  const header = given(args.header) ? assertComparableHeader(args.header) : undefined;
  const described = await describeIntent(client, args, env);

  const transaction = await client.transaction.get(intentId);
  return buildReceipt(client, intentId, {
    transaction,
    header,
    expect: described.expect,
    request: described.request ? described.request(transaction.identity_id) : null,
    gateway: env.CERTEN_API_URL || DEFAULT_BASE_URL,
  });
}
