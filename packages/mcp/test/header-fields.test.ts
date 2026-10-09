import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CertenClient } from '@certen.io/sdk';
import { ALL_TOOLS } from '../src/tools.js';

/**
 * `additionalAuthorities` / `expiresAt` on `certen_transaction_open`.
 *
 * Optional and backwards compatible: omitting both sends exactly what the tool sent before. When a caller asks for them they reach
 * the gateway through the SDK's own validation, which is the same code the CLI and a direct SDK caller run. This package used to
 * build against a registry copy of the SDK three minors old and had to REFUSE these fields (`HEADER_FIELDS_UNSUPPORTED`) because that
 * copy would have dropped them silently; it now builds against the workspace SDK, so the workaround is gone, and this test runs the real
 * SDK against a stub gateway.
 */

const open = ALL_TOOLS.find((t) => t.name === 'certen_transaction_open')!;
const FIRM = 'acc://fictional-firm.acme/book';
const SOON = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000).toISOString();

async function gateway(): Promise<{ client: CertenClient; bodies: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/transaction') bodies.push(JSON.parse(raw));
      res.setHeader('content-type', 'application/json');
      res.statusCode = 201;
      res.end(JSON.stringify({ intent_id: 'i1', status: 'signing_required' }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return {
    client: new CertenClient({ apiKey: 'k', baseUrl: url, maxRetries: 0 }),
    bodies,
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

describe('certen_transaction_open header fields', () => {
  it('declares both as optional parameters with the default-refusal caveat', () => {
    const props = open.inputSchema.properties as Record<string, { description?: string; maxItems?: number }>;
    expect(props.additionalAuthorities.maxItems).toBe(8);
    expect(props.additionalAuthorities.description).toContain('HEADER_AUTHORITY_NOT_EXECUTABLE');
    expect(props.expiresAt.description).toMatch(/RFC 3339/);
    expect(open.inputSchema.required).not.toContain('additionalAuthorities');
    expect(open.inputSchema.required).not.toContain('expiresAt');
  });

  it('without the fields, sends neither', async () => {
    const g = await gateway();
    try {
      await open.run(g.client, { identityId: 'id', intent: {}, confirm: true });
      expect(g.bodies).toHaveLength(1);
      expect(g.bodies[0]).not.toHaveProperty('additional_authorities');
      expect(g.bodies[0]).not.toHaveProperty('expires_at');
    } finally { await g.close(); }
  });

  it('with the fields, the gateway receives them - the SDK sends them, nothing drops them', async () => {
    const g = await gateway();
    try {
      await open.run(g.client, { identityId: 'id', intent: {}, additionalAuthorities: [FIRM.toUpperCase(), FIRM], expiresAt: SOON, confirm: true });
      // normalised by the shared SDK validation: lower-cased and de-duplicated, the deadline in RFC 3339
      expect(g.bodies[0]).toMatchObject({ additional_authorities: [FIRM], expires_at: SOON });
    } finally { await g.close(); }
  });

  it('refuses a bad value through the shared SDK validation before anything is sent', async () => {
    const g = await gateway();
    try {
      await expect(open.run(g.client, { identityId: 'id', intent: {}, additionalAuthorities: ['https://fictional-firm.example'], confirm: true }))
        .rejects.toMatchObject({ code: 'INVALID_ADDITIONAL_AUTHORITIES' });
      await expect(open.run(g.client, { identityId: 'id', intent: {}, expiresAt: 'soon', confirm: true }))
        .rejects.toMatchObject({ code: 'INVALID_EXPIRES_AT' });
      expect(g.bodies).toEqual([]);
    } finally { await g.close(); }
  });

  it('no longer carries the version-sniffing workaround', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tools.ts'), 'utf8');
    expect(src).not.toContain('HEADER_FIELDS_UNSUPPORTED');
    expect(src).not.toContain('assertHeaderFieldsSupported');
    expect(src).not.toMatch(/import \* as \w+ from '@certen\.io\/sdk'/);
  });
});
