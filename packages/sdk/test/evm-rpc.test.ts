import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  CertenError, checkEvmRpcEndpoint, evmRpcCall, readEvmChainId, assertRpcChain, readEvmBalance, readEvmBlockHeader,
} from '../src/index.js';

/**
 * Asking the caller's own EVM node.
 *
 * The receipt's effect check and the proof's execution layer both reduce to "what does MY node say", so what is pinned here is what that
 * question must get right and what it must never do:
 *
 * - **The URL is a secret.** Hosted node providers put the API key in the path. Every message and every `details` names the HOST and never
 *   the URL, whichever way the node misbehaves, so the key cannot reach a log, a receipt or a pasted error.
 * - **The chain is checked, not assumed.** A node for another network answers every question happily; a balance from it means nothing.
 * - **Unreadable is an error with a code, never a zero.** The effect check turns it into "unreadable", not "not observed".
 * - No redirect is followed, the reply is bounded in size and time, and a credential in the URL is refused.
 */

const KEY = 'SECRETKEY_0123456789';
const ADDR = `0x${'ab'.repeat(20)}`;

interface Seen { method: string; params: unknown[]; path: string; headers: http.IncomingHttpHeaders }
interface Node { url: string; urlWithKey: string; port: number; seen: Seen[]; close: () => Promise<void> }

/** A JSON-RPC node on localhost. `handler` gets the parsed call and the raw response, and answers however it likes. */
async function node(handler: (call: { method: string; params: unknown[] }, res: http.ServerResponse, req: http.IncomingMessage) => void): Promise<Node> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ method: body.method, params: body.params, path: req.url ?? '', headers: req.headers });
      handler({ method: body.method, params: body.params }, res, req);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    urlWithKey: `http://127.0.0.1:${port}/v2/${KEY}`,
    port,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const ok = (res: http.ServerResponse, result: unknown): void => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
};

/** Whatever was thrown, as text, including `details`: the place a key could hide. */
const everything = (err: unknown): string => {
  const e = err as CertenError;
  return `${e.message}\n${JSON.stringify(e.details ?? null)}\n${e.code}\n${e.stack ?? ''}`;
};

async function failure(p: Promise<unknown>): Promise<CertenError> {
  try { await p; } catch (e) { return e as CertenError; }
  throw new Error('expected the call to throw');
}

describe('checkEvmRpcEndpoint', () => {
  it('accepts http and https, names the host, and allows a key in the path (that is how hosted nodes are addressed)', () => {
    expect(checkEvmRpcEndpoint('https://base-sepolia.g.alchemy.com/v2/abc')).toEqual({ url: 'https://base-sepolia.g.alchemy.com/v2/abc', host: 'base-sepolia.g.alchemy.com' });
    expect(checkEvmRpcEndpoint('http://127.0.0.1:8545').host).toBe('127.0.0.1:8545');
  });

  it('refuses a username or password in the URL: it would be sent on to whoever answers', () => {
    expect(() => checkEvmRpcEndpoint('https://user:pw@node.example/')).toThrowError(expect.objectContaining({ code: 'EVM_RPC_INVALID' }));
    expect(() => checkEvmRpcEndpoint('https://user@node.example/')).toThrowError(expect.objectContaining({ code: 'EVM_RPC_INVALID' }));
  });

  it('refuses anything that is not an http(s) URL, without repeating what it was given', () => {
    for (const bad of ['ftp://node.example/', 'file:///etc/passwd', 'ws://node.example/', 'not a url', '']) {
      const err = (() => { try { checkEvmRpcEndpoint(bad); } catch (e) { return e as CertenError; } return undefined; })();
      expect(err).toBeInstanceOf(CertenError);
      expect(err!.code).toBe('EVM_RPC_INVALID');
      // The refusal never echoes the endpoint, which for a half-typed hosted URL can be most of a key.
      if (bad.length > 3) expect(err!.message).not.toContain(bad);
    }
  });
});

describe('evmRpcCall', () => {
  it('posts JSON-RPC and returns the result, sending no credential, cookie or authorization', async () => {
    const n = await node((_c, res) => ok(res, '0x14a34'));
    try {
      expect(await evmRpcCall({ rpc: n.url }, 'eth_chainId', [])).toBe('0x14a34');
      expect(n.seen[0]).toMatchObject({ method: 'eth_chainId', params: [] });
      expect(n.seen[0]!.headers['content-type']).toBe('application/json');
      // A different origin from the gateway: nothing of CERTEN's goes there.
      expect(n.seen[0]!.headers.authorization).toBeUndefined();
      expect(n.seen[0]!.headers['x-api-key']).toBeUndefined();
      expect(n.seen[0]!.headers.cookie).toBeUndefined();
    } finally { await n.close(); }
  });

  it('sends the request to the path the caller gave, key and all', async () => {
    const n = await node((_c, res) => ok(res, '0x1'));
    try {
      await evmRpcCall({ rpc: n.urlWithKey }, 'eth_chainId', []);
      expect(n.seen[0]!.path).toBe(`/v2/${KEY}`);
    } finally { await n.close(); }
  });

  it('never puts the URL, and so never the key, in any message or details, however the node misbehaves', async () => {
    const cases: Array<[string, (c: unknown, res: http.ServerResponse, req: http.IncomingMessage) => void, Partial<{ timeoutMs: number }>]> = [
      ['a non-200', (_c, res) => { res.statusCode = 503; res.end('down'); }, {}],
      ['a non-JSON reply', (_c, res) => { res.end('<html>nope</html>'); }, {}],
      ['an error member', (_c, res) => { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } })); }, {}],
      ['no result', (_c, res) => { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1 })); }, {}],
      ['an oversize reply', (_c, res) => { res.end(JSON.stringify({ result: 'x'.repeat(250_000) })); }, {}],
      ['a redirect', (_c, res) => { res.statusCode = 302; res.setHeader('location', '/elsewhere'); res.end(); }, {}],
      ['silence', () => { /* never answers */ }, { timeoutMs: 150 }],
    ];
    for (const [name, handler, extra] of cases) {
      const n = await node(handler as never);
      try {
        const err = await failure(evmRpcCall({ rpc: n.urlWithKey, ...extra }, 'eth_chainId', []));
        expect(err, name).toBeInstanceOf(CertenError);
        expect(everything(err), name).not.toContain(KEY);
        expect(everything(err), name).not.toContain('/v2/');
        // The host is what is reported, so a person can still tell which node it was.
        expect(err.message, name).toContain(`127.0.0.1:${n.port}`);
      } finally { await n.close(); }
    }
  });

  it('classifies each way a node can fail', async () => {
    const run = async (handler: Parameters<typeof node>[0], extra: { timeoutMs?: number } = {}): Promise<CertenError> => {
      const n = await node(handler);
      try { return await failure(evmRpcCall({ rpc: n.url, ...extra }, 'eth_chainId', [])); } finally { await n.close(); }
    };
    expect(await run((_c, res) => { res.statusCode = 500; res.end('x'); })).toMatchObject({ code: 'EVM_RPC_UNREADABLE', message: expect.stringContaining('HTTP 500') });
    expect(await run((_c, res) => { res.end('not json'); })).toMatchObject({ code: 'EVM_RPC_UNREADABLE', message: expect.stringContaining('JSON') });
    expect(await run((_c, res) => { res.end(JSON.stringify({ id: 1, jsonrpc: '2.0' })); })).toMatchObject({ code: 'EVM_RPC_UNREADABLE', message: expect.stringContaining('no result') });
    expect(await run((_c, res) => { res.end('null'); })).toMatchObject({ code: 'EVM_RPC_UNREADABLE' });
    expect(await run((_c, res) => { res.end(JSON.stringify({ error: { code: -32601, message: 'method not found' } })); }))
      .toMatchObject({ code: 'EVM_RPC_ERROR', message: expect.stringContaining('method not found') });
    expect(await run(() => { /* silence */ }, { timeoutMs: 100 })).toMatchObject({ code: 'EVM_RPC_UNREADABLE', message: expect.stringContaining('did not answer within') });
  });

  it('does not follow a redirect: a node that redirects is not the node that was named', async () => {
    const target = await node((_c, res) => ok(res, '0x1'));
    const n = await node((_c, res) => { res.statusCode = 307; res.setHeader('location', `${target.url}/landed`); res.end(); });
    try {
      const err = await failure(evmRpcCall({ rpc: n.url }, 'eth_chainId', []));
      expect(err.code).toBe('EVM_RPC_UNREADABLE');
      expect(target.seen).toHaveLength(0);
    } finally { await n.close(); await target.close(); }
  });

  it('refuses a reply too large to be an answer, without reading it to the end', async () => {
    const n = await node((_c, res) => { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(300_000) })); });
    try {
      const err = await failure(evmRpcCall({ rpc: n.url }, 'eth_getBalance', [ADDR, 'latest']));
      expect(err).toMatchObject({ code: 'EVM_RPC_UNREADABLE', message: expect.stringContaining('too large') });
    } finally { await n.close(); }
  });

  it('refuses a bad endpoint before any request, and the error is the endpoint check\'s', async () => {
    await expect(evmRpcCall({ rpc: 'https://user:pw@x.example/' }, 'eth_chainId', [])).rejects.toMatchObject({ code: 'EVM_RPC_INVALID' });
  });

  it('uses the fetch it is given, so a caller (or a test) can route it', async () => {
    let asked = '';
    const fake = (async (url: string) => { asked = String(url); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x7' }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await evmRpcCall({ rpc: 'https://rpc.example/v2/abc', fetch: fake }, 'eth_chainId', [])).toBe('0x7');
    expect(asked).toBe('https://rpc.example/v2/abc');
  });
});

describe('readEvmChainId', () => {
  it('parses the hex quantity into a number', async () => {
    const n = await node((_c, res) => ok(res, '0x14a34'));
    try { expect(await readEvmChainId({ rpc: n.url })).toBe(84532); } finally { await n.close(); }
  });

  it('refuses a result that is not a hex quantity, rather than reading it as zero', async () => {
    for (const bad of ['84532', 'abc', 84532, '', '0x', '0xZZ', null, { chain: 1 }]) {
      const n = await node((_c, res) => ok(res, bad));
      try {
        const err = await failure(readEvmChainId({ rpc: n.url }));
        expect(err.code, JSON.stringify(bad)).toBe('EVM_RPC_UNREADABLE');
      } finally { await n.close(); }
    }
  });
});

describe('assertRpcChain', () => {
  it('passes for a node on the named chain, by slug or by numeric id', async () => {
    const n = await node((_c, res) => ok(res, '0x14a34'));
    try {
      await expect(assertRpcChain({ rpc: n.url }, 'base-sepolia')).resolves.toBeUndefined();
      await expect(assertRpcChain({ rpc: n.url }, 84532)).resolves.toBeUndefined();
      await expect(assertRpcChain({ rpc: n.url }, '84532')).resolves.toBeUndefined();
    } finally { await n.close(); }
  });

  it('refuses a node on another network, with what it expected and what it found', async () => {
    const n = await node((_c, res) => ok(res, '0xaa36a7')); // Ethereum Sepolia, 11155111
    try {
      const err = await failure(assertRpcChain({ rpc: n.urlWithKey }, 'base-sepolia'));
      expect(err.code).toBe('EVM_RPC_WRONG_CHAIN');
      expect(err.details).toMatchObject({ expected: 84532, actual: 11155111, host: `127.0.0.1:${n.port}` });
      expect(err.message).toMatch(/11155111/);
      expect(err.message).toMatch(/base-sepolia/);
      expect(everything(err)).not.toContain(KEY);
    } finally { await n.close(); }
  });

  it('refuses a chain it cannot compare with, and asks the node nothing', async () => {
    const n = await node((_c, res) => ok(res, '0x1'));
    try {
      const err = await failure(assertRpcChain({ rpc: n.url }, 'mystery-chain'));
      expect(err.code).toBe('EVM_RPC_CHAIN_UNKNOWN');
      expect(n.seen).toHaveLength(0);
    } finally { await n.close(); }
  });

  it('passes on an unreadable node\'s own failure rather than guessing the chain', async () => {
    const n = await node((_c, res) => { res.statusCode = 502; res.end('bad gateway'); });
    try {
      await expect(assertRpcChain({ rpc: n.url }, 'base-sepolia')).rejects.toMatchObject({ code: 'EVM_RPC_UNREADABLE' });
    } finally { await n.close(); }
  });
});

describe('readEvmBalance', () => {
  it('asks for latest by default and for a block number as a hex tag', async () => {
    const n = await node((c, res) => ok(res, c.params[1] === 'latest' ? '0xde0b6b3a7640000' : '0x1bc16d674ec80000'));
    try {
      expect(await readEvmBalance({ rpc: n.url }, ADDR)).toBe(1_000_000_000_000_000_000n);
      expect(await readEvmBalance({ rpc: n.url }, ADDR, 46437431)).toBe(2_000_000_000_000_000_000n);
      expect(n.seen[0]).toMatchObject({ method: 'eth_getBalance', params: [ADDR, 'latest'] });
      expect(n.seen[1]).toMatchObject({ method: 'eth_getBalance', params: [ADDR, `0x${(46437431).toString(16)}`] });
    } finally { await n.close(); }
  });

  it('reads zero as zero (a real, empty balance) and an unreadable answer as an error, never as zero', async () => {
    const zero = await node((_c, res) => ok(res, '0x0'));
    const junk = await node((_c, res) => ok(res, 'zero'));
    try {
      expect(await readEvmBalance({ rpc: zero.url }, ADDR)).toBe(0n);
      await expect(readEvmBalance({ rpc: junk.url }, ADDR)).rejects.toMatchObject({ code: 'EVM_RPC_UNREADABLE' });
    } finally { await zero.close(); await junk.close(); }
  });

  it('refuses a malformed address before any request is made', async () => {
    const n = await node((_c, res) => ok(res, '0x1'));
    try {
      for (const bad of ['0x1234', 'ab'.repeat(20), `0x${'g'.repeat(40)}`, '']) {
        await expect(readEvmBalance({ rpc: n.url }, bad)).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
      }
      expect(n.seen).toHaveLength(0);
    } finally { await n.close(); }
  });

  it('does not echo the node\'s URL when the state for a block is gone', async () => {
    const n = await node((_c, res) => { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'missing trie node' } })); });
    try {
      const err = await failure(readEvmBalance({ rpc: n.urlWithKey }, ADDR, 5));
      expect(err).toMatchObject({ code: 'EVM_RPC_ERROR', message: expect.stringContaining('missing trie node') });
      expect(everything(err)).not.toContain(KEY);
    } finally { await n.close(); }
  });
});

describe('readEvmBlockHeader', () => {
  it('returns the number, hash and receipts root as the node reports them, asking for the block by hex number', async () => {
    const n = await node((_c, res) => ok(res, { number: '0x2c4a737', hash: `0x${'11'.repeat(32)}`, receiptsRoot: `0x${'22'.repeat(32)}`, transactions: ['ignored'] }));
    try {
      const h = await readEvmBlockHeader({ rpc: n.url }, 46437431);
      expect(h).toEqual({ number: '0x2c4a737', hash: `0x${'11'.repeat(32)}`, receiptsRoot: `0x${'22'.repeat(32)}` });
      expect(n.seen[0]).toMatchObject({ method: 'eth_getBlockByNumber', params: [`0x${(46437431).toString(16)}`, false] });
    } finally { await n.close(); }
  });

  it('is undefined for a block the node does not have, so the comparison fails for the right reason', async () => {
    const n = await node((_c, res) => ok(res, null));
    try { expect(await readEvmBlockHeader({ rpc: n.url }, 9)).toBeUndefined(); } finally { await n.close(); }
  });

  it('leaves out a hash or root the node did not send instead of inventing one', async () => {
    const n = await node((_c, res) => ok(res, { number: '0x9' }));
    try { expect(await readEvmBlockHeader({ rpc: n.url }, 9)).toEqual({ number: '0x9' }); } finally { await n.close(); }
  });
});
