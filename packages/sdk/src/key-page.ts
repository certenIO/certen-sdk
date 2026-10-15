import { CertenError } from './errors.js';

/**
 * Read a key page straight from Accumulate, and say whether it holds a key.
 *
 * **Why this exists.** `GET /v1/identity/{id}` already reports `can_sign`, computed by the gateway reading the key page from Accumulate
 * and matching its own record of the key. That is one party's word. The documented first-transaction walkthrough therefore ends in a
 * hand-written `curl` to the Accumulate API, so that the person can see for themselves that the page lists their key. This is that
 * `curl` as code, so a CLI, an agent and the MCP server get the same second opinion without anyone typing JSON-RPC.
 *
 * **What it trusts, and what it does not.** It trusts the Accumulate node it asks. It does not trust the CERTEN gateway, it sends no
 * CERTEN credential (the node is a different origin and has no business with the key), and it follows no redirect. It does NOT verify a
 * Merkle receipt for the page: that needs an anchor the client has no way to hold. So this is "read from Accumulate, not from the
 * gateway", which is the claim it makes, not "proved".
 *
 * **Why not `@certen.io/proof-verify`'s Accumulate encoding.** Nothing here is binary-encoded: the comparison is a hash match on JSON the
 * node returns. The verifier would also pull `accumulate-sdk-opendlt` and `node:crypto` into an entry that is statically forbidden to
 * reach a Node built-in (`browser-entry.test.ts`).
 *
 * Unreadable is a result, not an exception, for the caller that asks "does it hold my key": the answer to that is "I could not tell", and
 * that is never the same as "no".
 */

/** The wire shape this reads: `result.account` of a v3 `query` on a key page. Open, because the node's records carry far more. */
interface KeyPageRecord {
  type?: unknown;
  keys?: unknown;
  creditBalance?: unknown;
  version?: unknown;
  acceptThreshold?: unknown;
}

export interface KeyPageReading {
  /** The key page that was read. */
  url: string;
  /** The Accumulate node that answered. */
  rpc: string;
  /** SHA-256 of each public key on the page, lower-case hex. */
  keyHashes: string[];
  /**
   * The page's credit balance exactly as the node reports it. The spec does not pin whether that is whole credits or hundredths of one, so
   * it is never converted here: zero is zero in either, and nothing else should be read as a quantity of credits without knowing which.
   */
  creditBalance: number | null;
  version: number | null;
  /** How many of the page's keys must sign for a transaction to execute. */
  acceptThreshold: number | null;
}

export type KeyPageHold =
  /** The page was read and lists the key. */
  | { state: 'holds'; reading: KeyPageReading }
  /** The page was read and does not list the key. A fact about the page, not a failure to read it. */
  | { state: 'absent'; reading: KeyPageReading }
  /** The page could not be read. `notFound` is the node saying it has no such account (a wrong node, or an identity not yet anchored). */
  | { state: 'unreadable'; rpc: string; reason: string; notFound: boolean };

export interface KeyPageReadOptions {
  /** The Accumulate API endpoint, e.g. `https://kermit.accumulatenetwork.io/v3`. */
  rpc: string;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetch?: typeof fetch;
  /** Default 10 seconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** A key page is a few kilobytes. Anything past this is not one, and is not read to the end. */
const MAX_RESPONSE_CHARS = 1_000_000;

const HEX = /^[0-9a-f]+$/;

const hex = (bytes: number[]): string => bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');

/**
 * The key hashes on a key page, lower-case hex.
 *
 * Accumulate v3 returns `publicKeyHash` in more than one shape - a hex string, or a serialised Node Buffer (`{type:'Buffer',data:[...]}`)
 * that leaked out of a JSON serializer - and the gateway normalises both for the same reason: a comparison that silently failed to parse
 * one of them would report "this key is not on the page" for a key that is.
 */
export function keyHashesOf(account: { keys?: unknown } | null | undefined): string[] {
  const keys = account?.keys;
  if (!Array.isArray(keys)) return [];
  const out: string[] = [];
  for (const k of keys) {
    const raw = (k as { publicKeyHash?: unknown } | null)?.publicKeyHash;
    let h: string | undefined;
    if (typeof raw === 'string') h = raw.trim().replace(/^0x/i, '').toLowerCase();
    else if (Array.isArray(raw)) h = hex(raw as number[]);
    else if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) h = hex((raw as { data: number[] }).data);
    if (h && h.length % 2 === 0 && HEX.test(h)) out.push(h);
  }
  return out;
}

function fail(message: string, code: string): never {
  throw new CertenError(message, 0, code);
}

function checkEndpoint(rpc: string): string {
  let u: URL;
  try {
    u = new URL(rpc);
  } catch {
    return fail(`certen: "${rpc}" is not a URL, so it cannot be an Accumulate API endpoint.`, 'ACCUMULATE_RPC_INVALID');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    fail(`certen: the Accumulate API endpoint must be http or https, not ${u.protocol}`, 'ACCUMULATE_RPC_INVALID');
  }
  // A credential in the URL would be sent on to whoever answers; there is no reason for one on a public read.
  if (u.username || u.password) {
    fail('certen: the Accumulate API endpoint must not carry a username or password in the URL.', 'ACCUMULATE_RPC_INVALID');
  }
  return u.toString();
}

const asNumber = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Read one key page from an Accumulate node.
 *
 * @throws CertenError `ACCUMULATE_RPC_INVALID` (a bad endpoint, before any request), `KEY_PAGE_NOT_FOUND` (the node has no such account) or
 *   `KEY_PAGE_UNREADABLE` (anything else: no answer, a non-200, a malformed reply, an account that is not a key page).
 */
export async function readKeyPage(keyPageUrl: string, options: KeyPageReadOptions): Promise<KeyPageReading> {
  if (!/^acc:\/\/\S+$/i.test(keyPageUrl)) {
    fail(`certen: "${keyPageUrl}" is not an Accumulate URL (acc://...), so it cannot be a key page.`, 'KEY_PAGE_UNREADABLE');
  }
  const endpoint = checkEndpoint(options.rpc);
  const doFetch = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) fail('certen: this environment has no fetch, so the Accumulate node cannot be asked.', 'KEY_PAGE_UNREADABLE');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let text: string;
  try {
    const res = await doFetch!(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The same request the gateway makes for the same page.
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { scope: keyPageUrl } }),
      // A node that redirects is not the node that was named. Not followed.
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) fail(`certen: the Accumulate node at ${endpoint} answered HTTP ${res.status}.`, 'KEY_PAGE_UNREADABLE');
    text = await res.text();
  } catch (err) {
    if (err instanceof CertenError) throw err;
    const why = controller.signal.aborted
      ? `did not answer within ${(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
      : err instanceof Error ? err.message : String(err);
    return fail(`certen: the Accumulate node at ${endpoint} ${why}`, 'KEY_PAGE_UNREADABLE');
  } finally {
    clearTimeout(timer);
  }

  if (text.length > MAX_RESPONSE_CHARS) {
    fail(`certen: the Accumulate node at ${endpoint} sent a reply too large to be a key page.`, 'KEY_PAGE_UNREADABLE');
  }
  let body: { result?: { account?: KeyPageRecord }; error?: { message?: unknown; code?: unknown } };
  try {
    body = JSON.parse(text);
  } catch {
    return fail(`certen: the Accumulate node at ${endpoint} did not answer with JSON.`, 'KEY_PAGE_UNREADABLE');
  }
  if (body?.error) {
    const message = typeof body.error.message === 'string' ? body.error.message : JSON.stringify(body.error);
    fail(
      `certen: the Accumulate node at ${endpoint} could not read ${keyPageUrl}: ${message}`,
      /not found|does not exist|no such/i.test(message) ? 'KEY_PAGE_NOT_FOUND' : 'KEY_PAGE_UNREADABLE',
    );
  }
  const account = body?.result?.account;
  if (!account || typeof account !== 'object') {
    return fail(`certen: the Accumulate node at ${endpoint} returned no account record for ${keyPageUrl}.`, 'KEY_PAGE_UNREADABLE');
  }
  if (account.type !== undefined && account.type !== 'keyPage') {
    fail(`certen: ${keyPageUrl} is a ${String(account.type)} on Accumulate, not a key page.`, 'KEY_PAGE_UNREADABLE');
  }

  return {
    url: keyPageUrl,
    rpc: endpoint,
    keyHashes: keyHashesOf(account),
    creditBalance: asNumber(account.creditBalance),
    version: asNumber(account.version),
    acceptThreshold: asNumber(account.acceptThreshold),
  };
}

/**
 * Does this key page list this key?
 *
 * `keyHash` is the SHA-256 of the raw public key, hex (what `identity.create` takes as `publicKeyHash`). A malformed hash is a programming
 * error and throws; a page that cannot be read is a result.
 */
export async function verifyKeyPageHolds(keyPageUrl: string, keyHash: string, options: KeyPageReadOptions): Promise<KeyPageHold> {
  const want = keyHash.trim().replace(/^0x/i, '').toLowerCase();
  if (want.length !== 64 || !HEX.test(want)) {
    throw new CertenError(`certen: "${keyHash}" is not a key hash. Expected 64 hex characters (SHA-256 of the public key).`, 0, 'INVALID_KEY_HASH');
  }
  let reading: KeyPageReading;
  try {
    reading = await readKeyPage(keyPageUrl, options);
  } catch (err) {
    if (err instanceof CertenError && err.code !== 'ACCUMULATE_RPC_INVALID') {
      return { state: 'unreadable', rpc: options.rpc, reason: err.message.replace(/^certen: /, ''), notFound: err.code === 'KEY_PAGE_NOT_FOUND' };
    }
    throw err;
  }
  return { state: reading.keyHashes.includes(want) ? 'holds' : 'absent', reading };
}
