import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { readKeyPage, verifyKeyPageHolds, keyHashesOf, CertenError } from '../src/index.js';

/**
 * The independent key page read.
 *
 * It is the documented `curl` to the Accumulate API turned into code, so what is pinned here is what that read must get right and what
 * it must never do:
 *
 * - a key that IS on the page must read as present in both spellings Accumulate has been seen to use (a hex string, a serialised Node
 *   Buffer), or a correct page reports "your key is not on it";
 * - a page that could not be read is `unreadable`, never `absent`: "I could not tell" and "it is not there" are different facts, and only
 *   the second may be acted on as a refusal;
 * - no CERTEN credential, cookie or redirect ever reaches the node: it is a different origin, and a key sent there is a key leaked.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const PAGE = 'acc://probe.acme/book/1';

interface Stub { url: string; close: () => Promise<void>; requests: Array<{ headers: http.IncomingHttpHeaders; body: string }> }

async function node(handler: (body: Record<string, unknown>, res: http.ServerResponse, req: http.IncomingMessage) => void): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      handler(body ? JSON.parse(body) : {}, res, req);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const reply = (res: http.ServerResponse, account: Record<string, unknown>): void => {
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { recordType: 'account', account: { type: 'keyPage', url: PAGE, ...account } } }));
};

describe('keyHashesOf', () => {
  it('reads a hex string, a serialised Buffer and a byte array, lower-cased', () => {
    const bytes = Array.from({ length: 32 }, (_, i) => i);
    const asHex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(keyHashesOf({ keys: [{ publicKeyHash: HASH_A.toUpperCase() }, { publicKeyHash: { type: 'Buffer', data: bytes } }, { publicKeyHash: bytes }] }))
      .toEqual([HASH_A, asHex, asHex]);
  });

  it('accepts a 0x prefix and skips entries that are not hashes', () => {
    expect(keyHashesOf({ keys: [{ publicKeyHash: `0x${HASH_B}` }, { publicKeyHash: 'not hex' }, { publicKeyHash: '' }, {}, null, { publicKeyHash: 'abc' }] })).toEqual([HASH_B]);
  });

  it('is empty, not a throw, for a page with no keys', () => {
    expect(keyHashesOf({})).toEqual([]);
    expect(keyHashesOf(null)).toEqual([]);
    expect(keyHashesOf({ keys: 'x' })).toEqual([]);
  });
});

describe('readKeyPage', () => {
  it('asks for the page by URL, as JSON-RPC, and returns what the node says', async () => {
    const stub = await node((body, res) => reply(res, { keys: [{ publicKeyHash: HASH_A }], creditBalance: 1240, version: 2, acceptThreshold: 1 }));
    try {
      const r = await readKeyPage(PAGE, { rpc: stub.url });
      expect(r).toMatchObject({ url: PAGE, keyHashes: [HASH_A], creditBalance: 1240, version: 2, acceptThreshold: 1 });
      expect(JSON.parse(stub.requests[0].body)).toMatchObject({ jsonrpc: '2.0', method: 'query', params: { scope: PAGE } });
    } finally { await stub.close(); }
  });

  it('sends no CERTEN credential, cookie or authorization to the node', async () => {
    const stub = await node((_b, res) => reply(res, { keys: [] }));
    try {
      await readKeyPage(PAGE, { rpc: stub.url });
      const h = stub.requests[0].headers;
      expect(h['x-api-key']).toBeUndefined();
      expect(h.authorization).toBeUndefined();
      expect(h.cookie).toBeUndefined();
    } finally { await stub.close(); }
  });

  it('does not follow a redirect to another node', async () => {
    const target = await node((_b, res) => reply(res, { keys: [{ publicKeyHash: HASH_A }] }));
    const redirecting = await node((_b, res) => { res.statusCode = 307; res.setHeader('location', target.url); res.end(); });
    try {
      await expect(readKeyPage(PAGE, { rpc: redirecting.url })).rejects.toMatchObject({ code: 'KEY_PAGE_UNREADABLE' });
      expect(target.requests).toHaveLength(0);
    } finally { await redirecting.close(); await target.close(); }
  });

  it('names a node that has no such account, separately from one that is down', async () => {
    const stub = await node((_b, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -33001, message: 'key page not found' } })));
    try {
      await expect(readKeyPage(PAGE, { rpc: stub.url })).rejects.toMatchObject({ code: 'KEY_PAGE_NOT_FOUND' });
    } finally { await stub.close(); }
    const other = await node((_b, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'internal error' } })));
    try {
      await expect(readKeyPage(PAGE, { rpc: other.url })).rejects.toMatchObject({ code: 'KEY_PAGE_UNREADABLE' });
    } finally { await other.close(); }
  });

  it('refuses an account that is not a key page, a non-200, a non-JSON reply and an empty result', async () => {
    const cases: Array<[string, (res: http.ServerResponse) => void]> = [
      ['not a key page', (res) => reply(res, { type: 'identity' })],
      ['http 500', (res) => { res.statusCode = 500; res.end('{}'); }],
      ['html', (res) => res.end('<html>marketing site</html>')],
      ['no account', (res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))],
    ];
    for (const [label, send] of cases) {
      const stub = await node((_b, res) => send(res));
      try {
        await expect(readKeyPage(PAGE, { rpc: stub.url }), label).rejects.toMatchObject({ code: 'KEY_PAGE_UNREADABLE' });
      } finally { await stub.close(); }
    }
  });

  it('gives up on a node that does not answer, within the budget it was given', async () => {
    const stub = await node(() => { /* never answers */ });
    const started = Date.now();
    try {
      await expect(readKeyPage(PAGE, { rpc: stub.url, timeoutMs: 150 })).rejects.toMatchObject({ code: 'KEY_PAGE_UNREADABLE', message: expect.stringMatching(/did not answer within/) });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally { await stub.close(); }
  });

  it('refuses a bad endpoint before making any request', async () => {
    for (const rpc of ['not a url', 'ftp://node/v3', 'https://user:pass@node/v3', 'file:///etc/passwd']) {
      await expect(readKeyPage(PAGE, { rpc, fetch: (() => { throw new Error('must not be called'); }) as unknown as typeof fetch }), rpc)
        .rejects.toMatchObject({ code: 'ACCUMULATE_RPC_INVALID' });
    }
  });

  it('refuses something that is not an Accumulate URL', async () => {
    await expect(readKeyPage('https://example.com/page', { rpc: 'http://127.0.0.1:1' })).rejects.toBeInstanceOf(CertenError);
  });

  it('does not read a reply too large to be a key page', async () => {
    const stub = await node((_b, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { account: { type: 'keyPage', pad: 'x'.repeat(1_100_000) } } })));
    try {
      await expect(readKeyPage(PAGE, { rpc: stub.url })).rejects.toMatchObject({ code: 'KEY_PAGE_UNREADABLE', message: expect.stringMatching(/too large/) });
    } finally { await stub.close(); }
  });
});

describe('verifyKeyPageHolds', () => {
  it('holds when the page lists the key, whatever the case or prefix of the hash given', async () => {
    const stub = await node((_b, res) => reply(res, { keys: [{ publicKeyHash: HASH_A }, { publicKeyHash: HASH_B }] }));
    try {
      expect((await verifyKeyPageHolds(PAGE, HASH_B, { rpc: stub.url })).state).toBe('holds');
      expect((await verifyKeyPageHolds(PAGE, `0x${HASH_A.toUpperCase()}`, { rpc: stub.url })).state).toBe('holds');
    } finally { await stub.close(); }
  });

  it('is absent, with the reading, when the page was read and does not list the key', async () => {
    const stub = await node((_b, res) => reply(res, { keys: [{ publicKeyHash: HASH_A }], creditBalance: 5 }));
    try {
      const r = await verifyKeyPageHolds(PAGE, HASH_B, { rpc: stub.url });
      expect(r.state).toBe('absent');
      if (r.state === 'absent') expect(r.reading.keyHashes).toEqual([HASH_A]);
    } finally { await stub.close(); }
  });

  it('is UNREADABLE, never absent, when the node cannot be read or has no such account', async () => {
    const down = await verifyKeyPageHolds(PAGE, HASH_A, { rpc: 'http://127.0.0.1:1/v3', timeoutMs: 500 });
    expect(down.state).toBe('unreadable');
    const stub = await node((_b, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'account not found' } })));
    try {
      const r = await verifyKeyPageHolds(PAGE, HASH_A, { rpc: stub.url });
      expect(r).toMatchObject({ state: 'unreadable', notFound: true });
    } finally { await stub.close(); }
  });

  it('treats a malformed key hash as a programming error, not a result', async () => {
    await expect(verifyKeyPageHolds(PAGE, 'abc', { rpc: 'http://127.0.0.1:1' })).rejects.toMatchObject({ code: 'INVALID_KEY_HASH' });
  });

  it('treats a bad endpoint as a programming error, not "unreadable"', async () => {
    await expect(verifyKeyPageHolds(PAGE, HASH_A, { rpc: 'nope' })).rejects.toMatchObject({ code: 'ACCUMULATE_RPC_INVALID' });
  });
});
