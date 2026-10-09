import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as ModernClient } from '@modelcontextprotocol/client';
import { StdioClientTransport as ModernStdio } from '@modelcontextprotocol/client/stdio';
import { startSpecGateway, type SpecGateway } from './spec-gateway.js';

/**
 * Interop: the built `certen-mcp` over stdio, driven by the OFFICIAL MCP clients, one per protocol revision it claims to speak.
 *
 *   2026-07-28  @modelcontextprotocol/client 2.3.1   (pinned to the modern era, then `auto`, then its legacy default)
 *   2025-11-25  @modelcontextprotocol/sdk 1.32.1     (as `mcp-sdk-2025-11-25`)
 *   2025-06-18  @modelcontextprotocol/sdk 1.13.0     (as `mcp-sdk-2025-06-18`)
 *   2025-03-26  @modelcontextprotocol/sdk 1.12.1     (as `mcp-sdk-2025-03-26`)
 *   2024-11-05  @modelcontextprotocol/sdk 1.0.2      (as `mcp-sdk-2024-11-05`)
 *
 * Each release asks for exactly one revision, which is what makes it a test of that revision. They are devDependencies of this package,
 * exact-pinned, and never shipped: `certen-mcp` itself has no runtime dependency (decision D6). The older ones carry advisories in the
 * SDK's HTTP server and OAuth code, none of which a stdio client exercises (RUNLOG_RB7b Entry 10).
 *
 * The client does what a real client does: connect, list tools, call one, read a resource. The newer clients also validate
 * `structuredContent` against the tool's `outputSchema` themselves and throw if it does not conform.
 */
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const UUID = '396f863c-879c-4046-8591-3f0405c5f6bd';

let gateway: SpecGateway;
beforeAll(async () => { gateway = await startSpecGateway(); });
afterAll(async () => { await gateway.close(); });

const serverEnv = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
  CERTEN_API_KEY: 'ck_interop',
  CERTEN_API_URL: gateway.url,
  CERTEN_MCP_ALLOW_WRITES: '1',
});
const params = () => ({ command: process.execPath, args: [DIST], env: serverEnv() });

/** What each revision's client should be able to see of the same server. */
const BY_VERSION = [
  { version: '2025-11-25', annotations: true, outputSchema: true },
  { version: '2025-06-18', annotations: true, outputSchema: true },
  { version: '2025-03-26', annotations: true, outputSchema: false },
  { version: '2024-11-05', annotations: false, outputSchema: false },
] as const;

const LEGACY_CLIENTS: Record<string, () => Promise<[any, any, any]>> = {
  '2025-11-25': async () => [(await import('mcp-sdk-2025-11-25/client/index.js')).Client, (await import('mcp-sdk-2025-11-25/client/stdio.js')).StdioClientTransport, (await import('mcp-sdk-2025-11-25/types.js')).CallToolResultSchema],
  '2025-06-18': async () => [(await import('mcp-sdk-2025-06-18/client/index.js')).Client, (await import('mcp-sdk-2025-06-18/client/stdio.js')).StdioClientTransport, (await import('mcp-sdk-2025-06-18/types.js')).CallToolResultSchema],
  '2025-03-26': async () => [(await import('mcp-sdk-2025-03-26/client/index.js')).Client, (await import('mcp-sdk-2025-03-26/client/stdio.js')).StdioClientTransport, (await import('mcp-sdk-2025-03-26/types.js')).CallToolResultSchema],
  '2024-11-05': async () => [(await import('mcp-sdk-2024-11-05/client/index.js')).Client, (await import('mcp-sdk-2024-11-05/client/stdio.js')).StdioClientTransport, (await import('mcp-sdk-2024-11-05/types.js')).CallToolResultSchema],
};

describe('the built server exists', () => {
  it('has a dist entry to spawn (build before testing)', () => {
    expect(existsSync(DIST), `${DIST} is missing: run npm run build`).toBe(true);
  });
});

describe('2026-07-28: @modelcontextprotocol/client 2.3.1', () => {
  const connect = async (versionNegotiation?: unknown) => {
    const client = new ModernClient({ name: 'interop-modern', version: '1.0.0' }, versionNegotiation ? { versionNegotiation } as never : undefined);
    await client.connect(new ModernStdio(params()));
    return client;
  };

  it('pinned to 2026-07-28: no handshake, the server identifies itself and the tools come with annotations and schemas', async () => {
    const client = await connect({ mode: { pin: '2026-07-28' } });
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(client.getServerVersion()?.name).toBe('@certen.io/mcp');
      expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {} });
      expect(client.getInstructions()).toMatch(/HOLDS NO SIGNING KEY/);

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(48);
      for (const t of tools) {
        expect(t.annotations, t.name).toBeDefined();
        expect(t.outputSchema, t.name).toBeDefined();
      }
      const retire = tools.find((t) => t.name === 'certen_identity_retire')!;
      expect(retire.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
      expect(tools.find((t) => t.name === 'certen_transaction_get')!.annotations).toMatchObject({ readOnlyHint: true });
    } finally { await client.close(); }
  });

  it('calls a tool: structuredContent arrives and the client\'s own outputSchema validation accepts it', async () => {
    const client = await connect({ mode: { pin: '2026-07-28' } });
    try {
      const res: any = await client.callTool({ name: 'certen_transaction_get', arguments: { intentId: UUID } });
      expect(res.isError).not.toBe(true);
      expect(res.structuredContent).toMatchObject({ status: 'completed' });
      expect(res.structuredContent.outcome).toBeUndefined(); // that is certen_execute_wait's addition
      const waited: any = await client.callTool({ name: 'certen_execute_wait', arguments: { intentId: UUID } });
      expect(waited.structuredContent.outcome).toMatchObject({ outcome: 'completed', terminal: true });
    } finally { await client.close(); }
  });

  it('reads a documentation resource and lists them', async () => {
    const client = await connect({ mode: { pin: '2026-07-28' } });
    try {
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toContain('certen://docs/llms.txt');
      const read = await client.readResource({ uri: 'certen://docs/llms.txt' });
      expect((read.contents[0] as { text: string }).text).toMatch(/CERTEN/);
    } finally { await client.close(); }
  });

  it('turns a write tool called without confirm into an error result the model can read, and an unknown tool into a protocol error', async () => {
    const client = await connect({ mode: { pin: '2026-07-28' } });
    try {
      const stop: any = await client.callTool({ name: 'certen_identity_retire', arguments: { identityId: UUID } });
      expect(stop.isError).toBe(true);
      expect(JSON.parse(stop.content[0].text).status).toBe('confirmation_required');
      await expect(client.callTool({ name: 'certen_no_such_tool', arguments: {} })).rejects.toThrow(/unknown tool/);
    } finally { await client.close(); }
  });

  it('negotiates the modern era by itself in auto mode (it probes with server/discover)', async () => {
    const client = await connect({ mode: 'auto' });
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect((await client.listTools()).tools).toHaveLength(48);
    } finally { await client.close(); }
  });

  it('is served the legacy handshake when it does not opt in (its default), by the same process', async () => {
    const client = await connect();
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      expect((await client.listTools()).tools).toHaveLength(48);
    } finally { await client.close(); }
  });
});

describe.each(BY_VERSION)('$version: the official client that asks for it', ({ version, annotations, outputSchema }) => {
  const open = async () => {
    const [Client, Stdio, CallToolResultSchema] = await LEGACY_CLIENTS[version]();
    const client = new Client({ name: `interop-${version}`, version: '1.0.0' }, { capabilities: {} });
    await client.connect(new Stdio(params()));
    // The 2024-11-05 release of the client requires the result schema as an argument; the later ones default it to this same schema.
    const callTool = (p: { name: string; arguments: Record<string, unknown> }): Promise<any> => client.callTool(p, CallToolResultSchema);
    return Object.assign(client, { callToolWithSchema: callTool });
  };

  it('connects, and sees the server identity and capabilities', async () => {
    const client = await open();
    try {
      expect(client.getServerVersion()?.name).toBe('@certen.io/mcp');
      expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {} });
      await expect(client.ping()).resolves.toBeDefined();
    } finally { await client.close(); }
  });

  it(`lists all tools, with annotations ${annotations ? 'present' : 'absent'} and output schemas ${outputSchema ? 'present' : 'absent'}`, async () => {
    const client = await open();
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(48);
      for (const t of tools as Array<{ name: string; annotations?: unknown; outputSchema?: unknown }>) {
        expect(t.annotations !== undefined, `${t.name} annotations`).toBe(annotations);
        expect(t.outputSchema !== undefined, `${t.name} outputSchema`).toBe(outputSchema);
      }
    } finally { await client.close(); }
  });

  it('calls a tool and gets structuredContent only where the revision has it', async () => {
    const client = await open();
    try {
      const res: any = await client.callToolWithSchema({ name: 'certen_transaction_get', arguments: { intentId: UUID } });
      expect(res.isError).not.toBe(true);
      expect(JSON.parse(res.content[0].text)).toMatchObject({ status: 'completed' });
      expect(res.structuredContent !== undefined).toBe(outputSchema);
      if (outputSchema) expect(res.structuredContent).toMatchObject({ status: 'completed' });
      expect(res.resultType).toBeUndefined(); // resultType belongs to the modern era only
    } finally { await client.close(); }
  });

  it('reads a resource, and refuses a write tool without confirm', async () => {
    const client = await open();
    try {
      const read: any = await client.readResource({ uri: 'certen://docs/llms.txt' });
      expect(read.contents[0].text).toMatch(/CERTEN/);
      const stop: any = await client.callToolWithSchema({ name: 'certen_identity_retire', arguments: { identityId: UUID } });
      expect(stop.isError).toBe(true);
      expect(JSON.parse(stop.content[0].text).status).toBe('confirmation_required');
    } finally { await client.close(); }
  });
});
