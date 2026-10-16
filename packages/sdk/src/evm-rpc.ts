import { CertenError } from './errors.js';
import { chainInfo, chainSlug } from './chains.js';

/**
 * Ask an EVM node a few questions, as a caller who does not want to take CERTEN's word for what happened on a chain.
 *
 * The receipt's effect check and the proof's execution layer both reduce to "what does MY node say": the recipient's balance before and
 * after, and the block header the bundle's receipts root must match. Both go through here so they are hardened the same way as the
 * Accumulate key page read (`key-page.ts`), and for the same reasons:
 *
 * - The endpoint is the CALLER's. It is http(s) only, it follows no redirect (a node that redirects is not the node that was named), the
 *   reply is bounded in size and time, and no CERTEN credential is ever sent to it.
 * - **The URL is a secret.** Hosted node providers put the API key in the path (`.../v2/<key>`). Every message names the HOST and never the
 *   URL, so the key cannot end up in a log, a receipt or a pasted error.
 * - **The chain is checked, not assumed.** `eth_chainId` must equal the chain the caller named before anything else is believed. A node for
 *   another network answers every question happily, and a balance from the wrong chain is worse than none.
 *
 * Unreadable is an error with a code the caller can branch on, never a zero: the effect check turns it into "unreadable", not "not observed".
 */

export interface EvmRpcOptions {
  /** The node's JSON-RPC endpoint. */
  rpc: string;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetch?: typeof fetch;
  /** Default 10 seconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Every answer this module asks for is a few hundred bytes. Anything past this is not one, and is not read to the end. */
const MAX_RESPONSE_CHARS = 200_000;

function fail(message: string, code: string, details?: Record<string, unknown>): never {
  throw new CertenError(message, 0, code, details ? { details } : undefined);
}

/**
 * Validate an endpoint and name its host.
 *
 * @throws CertenError `EVM_RPC_INVALID` for something that is not an http(s) URL, or that carries a username or password (a credential in the
 *   URL would be sent on to whoever answers). A key in the PATH is allowed: it is how hosted nodes are addressed, and it is why only the host is
 *   ever reported.
 */
export function checkEvmRpcEndpoint(rpc: string): { url: string; host: string } {
  let u: URL;
  try {
    u = new URL(rpc);
  } catch {
    return fail('certen: the RPC endpoint is not a URL.', 'EVM_RPC_INVALID');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    fail(`certen: the RPC endpoint must be http or https, not ${u.protocol}`, 'EVM_RPC_INVALID');
  }
  if (u.username || u.password) {
    fail('certen: the RPC endpoint must not carry a username or password in the URL.', 'EVM_RPC_INVALID');
  }
  return { url: u.toString(), host: u.host };
}

/** One JSON-RPC call. The result is whatever the node returned under `result`; an `error` member, a non-200 or a non-JSON reply throws. */
export async function evmRpcCall(options: EvmRpcOptions, method: string, params: unknown[]): Promise<unknown> {
  const { url, host } = checkEvmRpcEndpoint(options.rpc);
  const doFetch = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) fail('certen: this environment has no fetch, so the node cannot be asked.', 'EVM_RPC_UNREADABLE');

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text: string;
  try {
    const res = await doFetch!(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) fail(`certen: the node at ${host} answered HTTP ${res.status} to ${method}.`, 'EVM_RPC_UNREADABLE', { host, method, status: res.status });
    text = await res.text();
  } catch (err) {
    if (err instanceof CertenError) throw err;
    // fetch's own messages can contain the URL, and the URL can contain a key. The reason is reduced to what is safe to repeat.
    const why = controller.signal.aborted ? `did not answer within ${timeoutMs / 1000}s` : 'could not be reached';
    return fail(`certen: the node at ${host} ${why} (${method}).`, 'EVM_RPC_UNREADABLE', { host, method });
  } finally {
    clearTimeout(timer);
  }

  if (text.length > MAX_RESPONSE_CHARS) fail(`certen: the node at ${host} sent a reply too large to be an answer to ${method}.`, 'EVM_RPC_UNREADABLE', { host, method });
  let body: { result?: unknown; error?: { message?: unknown; code?: unknown } };
  try {
    body = JSON.parse(text);
  } catch {
    return fail(`certen: the node at ${host} did not answer ${method} with JSON.`, 'EVM_RPC_UNREADABLE', { host, method });
  }
  if (body?.error) {
    const message = typeof body.error.message === 'string' ? body.error.message.slice(0, 200) : 'an error';
    fail(`certen: the node at ${host} could not answer ${method}: ${message}`, 'EVM_RPC_ERROR', { host, method });
  }
  if (body === null || typeof body !== 'object' || !('result' in body)) {
    fail(`certen: the node at ${host} returned no result for ${method}.`, 'EVM_RPC_UNREADABLE', { host, method });
  }
  return body.result;
}

const hexToBigInt = (value: unknown, what: string, host: string): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    return fail(`certen: the node at ${host} returned ${what} that is not a hex quantity.`, 'EVM_RPC_UNREADABLE', { host });
  }
  return BigInt(value);
};

/** The node's chain id (`eth_chainId`). */
export async function readEvmChainId(options: EvmRpcOptions): Promise<number> {
  const { host } = checkEvmRpcEndpoint(options.rpc);
  const id = hexToBigInt(await evmRpcCall(options, 'eth_chainId', []), 'a chain id', host);
  return Number(id);
}

/**
 * Refuse a node that is not on the named chain.
 *
 * @throws CertenError `EVM_RPC_CHAIN_UNKNOWN` (the chain is not in the catalogue, so there is nothing to compare with) or
 *   `EVM_RPC_WRONG_CHAIN` (the node says it is another network; `details` has `expected` and `actual`).
 */
export async function assertRpcChain(options: EvmRpcOptions, chain: string | number): Promise<void> {
  const { host } = checkEvmRpcEndpoint(options.rpc);
  const info = chainInfo(chain);
  if (!info) fail(`certen: ${JSON.stringify(String(chain))} is not a chain this client knows, so the node at ${host} cannot be checked to be on it.`, 'EVM_RPC_CHAIN_UNKNOWN');
  const actual = await readEvmChainId(options);
  if (actual !== info!.chainId) {
    fail(
      `certen: the node at ${host} is chain ${actual}, not ${chainSlug(chain)} (${info!.chainId}). A balance read from another network would mean nothing here.`,
      'EVM_RPC_WRONG_CHAIN',
      { host, expected: info!.chainId, actual },
    );
  }
}

/** An address's native balance in base units at a block (`'latest'` or a number). Needs a node that still holds that block's state. */
export async function readEvmBalance(options: EvmRpcOptions, address: string, block: 'latest' | number = 'latest'): Promise<bigint> {
  const { host } = checkEvmRpcEndpoint(options.rpc);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) fail(`certen: ${JSON.stringify(address)} is not an EVM address.`, 'INVALID_ADDRESS');
  const tag = block === 'latest' ? 'latest' : `0x${block.toString(16)}`;
  return hexToBigInt(await evmRpcCall(options, 'eth_getBalance', [address, tag]), 'a balance', host);
}

/** The header of a block: number, hash and receipts root, as the node reports them. Undefined when the node has no such block. */
export async function readEvmBlockHeader(
  options: EvmRpcOptions,
  block: number,
): Promise<{ number: string; hash?: string; receiptsRoot?: string } | undefined> {
  const result = await evmRpcCall(options, 'eth_getBlockByNumber', [`0x${block.toString(16)}`, false]);
  if (result === null || result === undefined) return undefined;
  const h = result as { number?: string; hash?: string; receiptsRoot?: string };
  return { number: h.number ?? `0x${block.toString(16)}`, ...(h.hash ? { hash: h.hash } : {}), ...(h.receiptsRoot ? { receiptsRoot: h.receiptsRoot } : {}) };
}
