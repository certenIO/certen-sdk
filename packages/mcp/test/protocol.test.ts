import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { dispatch, serve, RpcError, RPC, LATEST_PROTOCOL_VERSION } from '../src/protocol.js';
import { createHandlers } from '../src/server.js';

/**
 * Protocol-level behaviour, driven with real JSON-RPC frames.
 *
 * The framing rules are the ones worth pinning: notifications must never draw a response, and
 * stdout must carry nothing but protocol frames. Both are invisible to a functional test and both
 * break clients hard.
 */

const WRITES_ON = { CERTEN_MCP_ALLOW_WRITES: '1', CERTEN_API_KEY: 'ck_test' } as NodeJS.ProcessEnv;
const READ_ONLY = { CERTEN_API_KEY: 'ck_test' } as NodeJS.ProcessEnv;

function req(method: string, params: Record<string, unknown> = {}, id: number | string = 1) {
  return { jsonrpc: '2.0' as const, id, method, params };
}

describe('JSON-RPC framing', () => {
  it('answers a request with a matching id', async () => {
    const res = await dispatch(req('ping', {}, 42), createHandlers({ env: READ_ONLY }));
    expect(res).toMatchObject({ jsonrpc: '2.0', id: 42, result: {} });
  });

  it('never responds to a notification', async () => {
    const handlers = createHandlers({ env: READ_ONLY });
    const res = await dispatch(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      handlers,
    );
    expect(res).toBeNull();
  });

  it('ignores unknown notifications rather than erroring', async () => {
    const res = await dispatch(
      { jsonrpc: '2.0', method: 'notifications/somethingNew', params: {} },
      createHandlers({ env: READ_ONLY }),
    );
    expect(res).toBeNull();
  });

  it('returns method-not-found for an unknown request', async () => {
    const res = await dispatch(req('nope'), createHandlers({ env: READ_ONLY }));
    expect(res?.error?.code).toBe(RPC.METHOD_NOT_FOUND);
  });

  it('converts a thrown RpcError into its declared code', async () => {
    const res = await dispatch(req('boom'), {
      boom: () => {
        throw new RpcError(RPC.INVALID_PARAMS, 'bad input');
      },
    });
    expect(res?.error).toMatchObject({ code: RPC.INVALID_PARAMS, message: 'bad input' });
  });

  it('reports a malformed line as a parse error without dying', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (c) => chunks.push(String(c)));

    const done = serve(input, output, createHandlers({ env: READ_ONLY }));
    input.write('{not json\n');
    input.write(`${JSON.stringify(req('ping', {}, 2))}\n`);
    input.end();
    await done;

    const messages = chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(messages[0].error.code).toBe(RPC.PARSE_ERROR);
    // The stream survives: the next well-formed message is still answered.
    expect(messages[1]).toMatchObject({ id: 2, result: {} });
  });

  it('answers in the order received', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (c) => chunks.push(String(c)));

    const done = serve(input, output, createHandlers({ env: READ_ONLY }));
    input.write(`${JSON.stringify(req('initialize', {}, 1))}\n`);
    input.write(`${JSON.stringify(req('tools/list', {}, 2))}\n`);
    input.write(`${JSON.stringify(req('ping', {}, 3))}\n`);
    input.end();
    await done;

    const ids = chunks.join('').trim().split('\n').map((l) => JSON.parse(l).id);
    expect(ids).toEqual([1, 2, 3]);
  });
});

describe('initialize', () => {
  it('echoes a protocol version it supports', async () => {
    const res = await dispatch(
      req('initialize', { protocolVersion: '2024-11-05' }),
      createHandlers({ env: READ_ONLY }),
    );
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
  });

  it('falls back to its own version for an unknown one', async () => {
    const res = await dispatch(
      req('initialize', { protocolVersion: '1999-01-01' }),
      createHandlers({ env: READ_ONLY }),
    );
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('says in its instructions that it cannot sign', async () => {
    const res = await dispatch(req('initialize'), createHandlers({ env: READ_ONLY }));
    const { instructions } = res?.result as { instructions: string };
    expect(instructions).toMatch(/HOLDS NO SIGNING KEY/);
  });

  it('states whether writes are enabled', async () => {
    const ro = await dispatch(req('initialize'), createHandlers({ env: READ_ONLY }));
    expect((ro?.result as { instructions: string }).instructions).toMatch(/DISABLED/);

    const rw = await dispatch(req('initialize'), createHandlers({ env: WRITES_ON }));
    expect((rw?.result as { instructions: string }).instructions).toMatch(/ARE enabled/);
  });
});

describe('tools/list', () => {
  it('hides write tools when read-only', async () => {
    const res = await dispatch(req('tools/list'), createHandlers({ env: READ_ONLY }));
    const names = (res?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('certen_portfolio_get');
    expect(names).not.toContain('certen_transaction_submit_signature');
  });

  it('lists write tools when enabled', async () => {
    const res = await dispatch(req('tools/list'), createHandlers({ env: WRITES_ON }));
    const names = (res?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('certen_transaction_submit_signature');
  });
});

describe('tools/call', () => {
  it('explains that a write tool is gated, not missing', async () => {
    const res = await dispatch(
      req('tools/call', { name: 'certen_identity_create', arguments: {} }),
      createHandlers({ env: READ_ONLY }),
    );
    expect(res?.error?.message).toMatch(/disabled by configuration, not missing/);
  });

  it('distinguishes a genuinely unknown tool', async () => {
    const res = await dispatch(
      req('tools/call', { name: 'certen_not_a_tool', arguments: {} }),
      createHandlers({ env: READ_ONLY }),
    );
    expect(res?.error?.message).toMatch(/unknown tool/);
  });

  it('refuses to act on a write tool without confirm, and calls nothing', async () => {
    const retire = vi.fn();
    const client = { identity: { retire } } as never;
    const res = await dispatch(
      req('tools/call', { name: 'certen_identity_retire', arguments: { identityId: 'abc' } }),
      createHandlers({ env: WRITES_ON, client }),
    );
    const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(text).status).toBe('confirmation_required');
    // The point of the gate: the SDK was never touched.
    expect(retire).not.toHaveBeenCalled();
  });

  it('acts once confirm:true is passed', async () => {
    const retire = vi.fn().mockResolvedValue({ success: true });
    const client = { identity: { retire } } as never;
    const res = await dispatch(
      req('tools/call', {
        name: 'certen_identity_retire',
        arguments: { identityId: 'abc', confirm: true },
      }),
      createHandlers({ env: WRITES_ON, client }),
    );
    expect(retire).toHaveBeenCalledWith('abc');
    const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(text)).toEqual({ success: true });
  });

  it('redacts a signature from the confirmation echo', async () => {
    const res = await dispatch(
      req('tools/call', {
        name: 'certen_transaction_submit_signature',
        arguments: { intentId: 'i', signature: 'a'.repeat(128), publicKey: 'b'.repeat(64) },
      }),
      createHandlers({ env: WRITES_ON, client: {} as never }),
    );
    const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain('a'.repeat(128));
    expect(text).toContain('128-char signature');
  });

  it('returns a tool error as content, not a transport error', async () => {
    const client = {
      portfolio: {
        get: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'X' })),
      },
    } as never;
    const res = await dispatch(
      req('tools/call', { name: 'certen_portfolio_get', arguments: {} }),
      createHandlers({ env: READ_ONLY, client }),
    );
    expect(res?.error).toBeUndefined();
    expect((res?.result as { isError: boolean }).isError).toBe(true);
  });

  it('asks for an API key rather than failing obscurely when none is set', async () => {
    const res = await dispatch(
      req('tools/call', { name: 'certen_portfolio_get', arguments: {} }),
      createHandlers({ env: {} as NodeJS.ProcessEnv }),
    );
    expect(res?.error?.message).toMatch(/CERTEN_API_KEY is not set/);
  });
});

describe('resources', () => {
  it('lists the documentation resources', async () => {
    const res = await dispatch(req('resources/list'), createHandlers({ env: READ_ONLY }));
    const uris = (res?.result as { resources: Array<{ uri: string }> }).resources.map((r) => r.uri);
    expect(uris).toContain('certen://docs/llms.txt');
  });

  it('reads a resource without needing an API key', async () => {
    const res = await dispatch(
      req('resources/read', { uri: 'certen://docs/llms.txt' }),
      createHandlers({ env: {} as NodeJS.ProcessEnv }),
    );
    const { contents } = res?.result as { contents: Array<{ text: string }> };
    expect(contents[0].text).toMatch(/CERTEN/);
  });

  it('rejects an unknown resource uri', async () => {
    const res = await dispatch(
      req('resources/read', { uri: 'certen://docs/nope' }),
      createHandlers({ env: READ_ONLY }),
    );
    expect(res?.error?.code).toBe(RPC.INVALID_PARAMS);
  });
});
