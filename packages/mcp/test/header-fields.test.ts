import { describe, it, expect } from 'vitest';
import * as sdk from '@certen.io/sdk';
import { ALL_TOOLS, assertHeaderFieldsSupported } from '../src/tools.js';

/**
 * `additionalAuthorities` / `expiresAt` on `certen_transaction_open`.
 *
 * Optional and backwards compatible: omitting both sends exactly what the tool sent before. When a
 * caller does ask for them, they must either reach the SDK or be refused — this package depends on
 * the PUBLISHED SDK, and an older release drops unknown keys from the request body, which would open
 * an intent without the deadline the caller asked for.
 */

const open = ALL_TOOLS.find((t) => t.name === 'certen_transaction_open')!;
const FIRM = 'acc://fictional-firm.acme/book';
const SOON = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000).toISOString();

function fakeClient() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    client: { transaction: { create: async (p: Record<string, unknown>) => { calls.push(p); return { intent_id: 'i' }; } } },
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

  it('without the fields, calls the SDK exactly as before', async () => {
    const f = fakeClient();
    await open.run(f.client as never, { identityId: 'id', intent: {}, confirm: true });
    expect(f.calls[0].additionalAuthorities).toBeUndefined();
    expect(f.calls[0].expiresAt).toBeUndefined();
  });

  it('refuses the fields when the SDK cannot send them, and allows them when it can', () => {
    const args = { additionalAuthorities: [FIRM], expiresAt: SOON };
    expect(() => assertHeaderFieldsSupported(args, {})).toThrow(/nothing was sent/);
    expect(() => assertHeaderFieldsSupported(args, { normalizeExpiresAt: () => '' })).not.toThrow();
    expect(() => assertHeaderFieldsSupported({}, {})).not.toThrow();
  });

  it('with the fields, passes them through or refuses — never drops them', async () => {
    const f = fakeClient();
    const args = { identityId: 'id', intent: {}, additionalAuthorities: [FIRM], expiresAt: SOON, confirm: true };
    if (typeof (sdk as Record<string, unknown>).normalizeExpiresAt === 'function') {
      await open.run(f.client as never, args);
      expect(f.calls[0]).toMatchObject({ additionalAuthorities: [FIRM], expiresAt: SOON });
    } else {
      await expect(open.run(f.client as never, args)).rejects.toMatchObject({ code: 'HEADER_FIELDS_UNSUPPORTED' });
      expect(f.calls).toHaveLength(0);
    }
  });
});
