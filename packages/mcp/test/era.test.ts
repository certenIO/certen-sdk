import { describe, it, expect } from 'vitest';
import { dispatch, PROTOCOL_VERSIONS, MODERN_VERSIONS, LEGACY_VERSIONS, RPC } from '../src/protocol.js';
import { createHandlers, SERVER_NAME, SERVER_VERSION } from '../src/server.js';

/**
 * Protocol 2026-07-28 is stateless: no `initialize`, every request carries its protocol version and the client's capabilities in
 * `_meta`, every result carries `resultType`, cacheable results carry `ttlMs` and `cacheScope`, and `server/discover` is mandatory. This
 * server is dual-era: the same process also serves the older, handshake-based revisions. These tests drive both with real JSON-RPC
 * frames; interop with the official clients is in interop.test.ts.
 */
const ENV = { CERTEN_API_KEY: 'ck_test' } as NodeJS.ProcessEnv;
const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const INFO = 'io.modelcontextprotocol/clientInfo';
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const modernMeta = (over: Record<string, unknown> = {}) => ({ [PV]: '2026-07-28', [CAPS]: {}, [INFO]: { name: 'test', version: '1' }, ...over });
const call = (handlers: ReturnType<typeof createHandlers>, method: string, params: Record<string, unknown> = {}, id = 1) =>
  dispatch({ jsonrpc: '2.0', id, method, params }, handlers);
type Res = { result?: any; error?: { code: number; message: string; data?: any } };

describe('server/discover', () => {
  it('answers a modern probe with versions, capabilities, identity and cache hints', async () => {
    const r = (await call(createHandlers({ env: ENV }), 'server/discover', { _meta: modernMeta() })) as Res;
    expect(r.error).toBeUndefined();
    expect(r.result.resultType).toBe('complete');
    expect(r.result.supportedVersions).toEqual([...PROTOCOL_VERSIONS]);
    expect(r.result.supportedVersions).toEqual(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    expect(r.result.capabilities).toEqual({ tools: {}, resources: {} });
    expect(r.result._meta[SERVER_INFO]).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(r.result.instructions).toMatch(/HOLDS NO SIGNING KEY/);
    expect(Number.isInteger(r.result.ttlMs) && r.result.ttlMs >= 0).toBe(true);
    expect(r.result.cacheScope).toBe('public');
  });

  it('refuses a discover request that does not carry the modern _meta', async () => {
    const r = (await call(createHandlers({ env: ENV }), 'server/discover')) as Res;
    expect(r.error?.code).toBe(RPC.INVALID_PARAMS);
    expect(r.error?.message).toMatch(/needs _meta/);
  });
});

describe('version negotiation, per request', () => {
  it('answers an unsupported version with UnsupportedProtocolVersion (-32022) listing what it does support', async () => {
    const r = (await call(createHandlers({ env: ENV }), 'tools/list', { _meta: modernMeta({ [PV]: '1900-01-01' }) })) as Res;
    expect(r.error).toEqual({ code: -32022, message: 'Unsupported protocol version', data: { supported: [...PROTOCOL_VERSIONS], requested: '1900-01-01' } });
  });

  it('does not take a legacy version string in _meta as a modern request: legacy versions open with initialize', async () => {
    for (const v of LEGACY_VERSIONS) {
      const r = (await call(createHandlers({ env: ENV }), 'tools/list', { _meta: modernMeta({ [PV]: v }) })) as Res;
      expect(r.error?.code, v).toBe(-32022);
    }
  });

  it('rejects a modern request that omits clientCapabilities or sends a non-string version as malformed (-32602)', async () => {
    const h = createHandlers({ env: ENV });
    const noCaps = (await call(h, 'tools/list', { _meta: { [PV]: '2026-07-28' } })) as Res;
    expect(noCaps.error?.code).toBe(RPC.INVALID_PARAMS);
    expect(noCaps.error?.message).toContain(CAPS);
    const badVersion = (await call(h, 'tools/list', { _meta: { [PV]: 20260728, [CAPS]: {} } })) as Res;
    expect(badVersion.error?.code).toBe(RPC.INVALID_PARAMS);
    const nonObjectCaps = (await call(h, 'tools/list', { _meta: { [PV]: '2026-07-28', [CAPS]: 'none' } })) as Res;
    expect(nonObjectCaps.error?.code).toBe(RPC.INVALID_PARAMS);
  });

  it('accepts clientInfo being absent (it is optional)', async () => {
    const r = (await call(createHandlers({ env: ENV }), 'tools/list', { _meta: { [PV]: '2026-07-28', [CAPS]: {} } })) as Res;
    expect(r.error).toBeUndefined();
  });

  it('lists the versions by era', () => {
    expect([...MODERN_VERSIONS]).toEqual(['2026-07-28']);
    expect([...LEGACY_VERSIONS]).toEqual(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
  });
});

describe('modern results', () => {
  it('needs no initialize: a fresh process answers the first request', async () => {
    const r = (await call(createHandlers({ env: ENV }), 'tools/list', { _meta: modernMeta() })) as Res;
    expect(r.result.tools.length).toBeGreaterThan(30);
  });

  it('carries resultType, the server identity and cache hints on every cacheable list and read', async () => {
    const h = createHandlers({ env: ENV });
    for (const [method, params] of [
      ['tools/list', {}], ['resources/list', {}], ['resources/read', { uri: 'certen://docs/llms.txt' }], ['server/discover', {}],
    ] as const) {
      const r = (await call(h, method, { ...params, _meta: modernMeta() })) as Res;
      expect(r.error, method).toBeUndefined();
      expect(r.result.resultType, method).toBe('complete');
      expect(r.result._meta[SERVER_INFO], method).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });
      expect(r.result.ttlMs, method).toBeGreaterThanOrEqual(0);
      expect(['public', 'private'], method).toContain(r.result.cacheScope);
    }
  });

  it('returns tools in a deterministic order across requests', async () => {
    const h = createHandlers({ env: ENV });
    const a = ((await call(h, 'tools/list', { _meta: modernMeta() })) as Res).result.tools.map((t: { name: string }) => t.name);
    const b = ((await call(createHandlers({ env: ENV }), 'tools/list', { _meta: modernMeta() }, 2)) as Res).result.tools.map((t: { name: string }) => t.name);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it('puts resultType on a tool result, and not on the legacy one', async () => {
    const modern = (await call(createHandlers({ env: ENV }), 'tools/call', { name: 'certen_errors_missing', arguments: {}, _meta: modernMeta() })) as Res;
    expect(modern.error?.code).toBe(RPC.INVALID_PARAMS); // unknown tool is a protocol error in both eras
    const h = createHandlers({ env: ENV, client: { admin: { errors: async () => ({ errors: [] }) } } as never });
    const m = (await call(h, 'tools/call', { name: 'certen_errors', arguments: {}, _meta: modernMeta() })) as Res;
    expect(m.result.resultType).toBe('complete');
    expect(m.result._meta[SERVER_INFO].name).toBe(SERVER_NAME);
    const l = (await call(h, 'tools/call', { name: 'certen_errors', arguments: {} })) as Res;
    expect(l.result.resultType).toBeUndefined();
    expect(l.result._meta).toBeUndefined();
  });

  it('answers an unknown resource with -32602 (modern) and the uri in data', async () => {
    const r = (await call(createHandlers({ env: ENV }), 'resources/read', { uri: 'certen://docs/nope', _meta: modernMeta() })) as Res;
    expect(r.error?.code).toBe(RPC.INVALID_PARAMS);
    expect(r.error?.data).toEqual({ uri: 'certen://docs/nope' });
  });

  it('has removed ping for the modern era but still answers it for the legacy one', async () => {
    const h = createHandlers({ env: ENV });
    expect(((await call(h, 'ping', { _meta: modernMeta() })) as Res).error?.code).toBe(RPC.METHOD_NOT_FOUND);
    expect(((await call(h, 'ping', {})) as Res).result).toEqual({});
  });
});

describe('both eras on one process', () => {
  it('serves a legacy initialize and a modern request interleaved, each by its own rules', async () => {
    const h = createHandlers({ env: ENV });
    const init = (await call(h, 'initialize', { protocolVersion: '2025-06-18' })) as Res;
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.resultType).toBeUndefined();

    const legacy = (await call(h, 'tools/list', {}, 2)) as Res;
    expect(legacy.result.resultType).toBeUndefined();
    const modern = (await call(h, 'tools/list', { _meta: modernMeta() }, 3)) as Res;
    expect(modern.result.resultType).toBe('complete');
    const legacyAgain = (await call(h, 'tools/list', {}, 4)) as Res;
    expect(legacyAgain.result.resultType).toBeUndefined();
  });

  it('keeps a modern request independent of an earlier initialize: nothing the handshake negotiated changes it', async () => {
    const h = createHandlers({ env: ENV });
    await call(h, 'initialize', { protocolVersion: '2024-11-05' });
    const modern = (await call(h, 'tools/list', { _meta: modernMeta() }, 2)) as Res;
    const fresh = (await call(createHandlers({ env: ENV }), 'tools/list', { _meta: modernMeta() }, 2)) as Res;
    expect(modern.result.tools).toEqual(fresh.result.tools);
  });
});
