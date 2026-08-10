import { describe, it, expect } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import {
  CertenClient,
  CertenError,
  CertenBadRequestError,
  CertenPaymentRequiredError,
} from '../src/index.js';

/**
 * 402 as a typed, actionable error.
 *
 * Two things were wrong before this existed. A payment problem arrived as
 * `CertenBadRequestError`, indistinguishable from a malformed request — so a host
 * product could not tell whether to show a top-up prompt or a validation message.
 * And the response body was discarded entirely, which threw away the payment
 * target the gateway mints with the refusal and left the caller a message string
 * to regex.
 *
 * Real server rather than a mocked axios: what matters is how the client turns an
 * actual HTTP 402 into an error, and a mock would let us assert our own beliefs
 * about that instead of the behaviour.
 */

async function serve(status: number, body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const RESOLVE = {
  payment_intent: 'dep_9f2',
  chain: 'base',
  to_address: '0xTreasury',
  amount_usd: '0.230000',
  expires_at: '2026-08-10T15:30:00Z',
  reused_existing: false,
  portal_url: 'https://gateway.example/portal#funding?intent=dep_9f2',
  cli_command: 'certen fund 0.230000 --chain base',
  note: 'Send exactly 0.230000 USDC on base.',
};

const INSUFFICIENT = {
  error: 'Payment required',
  code: 'PAYMENT_REQUIRED',
  quote: { id: 'q-77', expires_at: '2026-08-10T15:00:00Z' },
  balance: {
    available_usd: '0.120000', held_usd: '0.000000',
    spendable_usd: '0.120000', shortfall_usd: '0.230000',
  },
  resolve: RESOLVE,
};

const COMMITMENT = {
  error: 'Payment required',
  code: 'COMMITMENT_EXCEEDED',
  quote: { id: 'q-78', expires_at: '2026-08-10T15:00:00Z' },
  commitments: {
    pending_intents: 3, uncovered_usd: '1.050000', shortfall_usd: '0.150000',
  },
  resolve: { ...RESOLVE, amount_usd: '0.150000' },
};

function client(url: string): CertenClient {
  return new CertenClient({ apiKey: 'ck_live_x', baseUrl: url, maxRetries: 0 });
}

async function caught(status: number, body: unknown): Promise<CertenError> {
  const srv = await serve(status, body);
  try {
    await client(srv.url).portfolio.get();
    throw new Error('expected the call to reject');
  } catch (e) {
    return e as CertenError;
  } finally {
    await srv.close();
  }
}

describe('402 becomes its own error type', () => {
  it('is a CertenPaymentRequiredError, not a bad-request error', async () => {
    const e = await caught(402, INSUFFICIENT);

    expect(e).toBeInstanceOf(CertenPaymentRequiredError);
    // The distinction a host product needs: nothing is wrong with the request.
    expect(e).not.toBeInstanceOf(CertenBadRequestError);
    expect(e.status).toBe(402);
    expect(e.code).toBe('PAYMENT_REQUIRED');
  });

  it('is never retryable, because only money changes the outcome', async () => {
    const e = await caught(402, INSUFFICIENT);
    expect(e.isRetryable).toBe(false);
    expect(e.isClientError).toBe(true);
  });

  it('exposes the shortfall, quote and payment target without parsing prose', async () => {
    const e = (await caught(402, INSUFFICIENT)) as CertenPaymentRequiredError;

    expect(e.shortfallUsd).toBe('0.230000');
    expect(e.spendableUsd).toBe('0.120000');
    expect(e.quoteId).toBe('q-77');
    expect(e.quoteExpiresAt).toBe('2026-08-10T15:00:00Z');
    expect(e.resolution).toEqual(RESOLVE);
    expect(e.portalUrl).toBe(RESOLVE.portal_url);
    expect(e.cliCommand).toBe(RESOLVE.cli_command);
  });

  it('distinguishes a commitment shortfall, where waiting is also a remedy', async () => {
    const e = (await caught(402, COMMITMENT)) as CertenPaymentRequiredError;

    expect(e.isCommitmentExceeded).toBe(true);
    expect(e.pendingIntents).toBe(3);
    // Read from `commitments`, which is where this code puts it.
    expect(e.shortfallUsd).toBe('0.150000');
    // Telling this customer only to add funds would be wrong: their pending work
    // settling or expiring frees the same capacity.
    expect(e.summary).toContain('wait');
  });

  it('summarises a plain shortfall without mentioning waiting', async () => {
    const e = (await caught(402, INSUFFICIENT)) as CertenPaymentRequiredError;
    expect(e.isCommitmentExceeded).toBe(false);
    expect(e.summary).toContain('0.230000');
    expect(e.summary).not.toContain('wait');
  });

  it('reports a null resolution rather than inventing one', async () => {
    // The gateway could not mint a target — no deposit chain configured, say. The
    // refusal is still valid, so the error must be usable without it.
    const e = (await caught(402, { ...INSUFFICIENT, resolve: null })) as CertenPaymentRequiredError;

    expect(e.resolution).toBeNull();
    expect(e.portalUrl).toBeUndefined();
    expect(e.cliCommand).toBeUndefined();
    // Everything else still works.
    expect(e.shortfallUsd).toBe('0.230000');
    expect(e.summary).toContain('0.230000');
  });

  it('survives a 402 with no body at all', async () => {
    const e = (await caught(402, 'gateway timeout page')) as CertenPaymentRequiredError;

    expect(e).toBeInstanceOf(CertenPaymentRequiredError);
    // A non-JSON body must not become a typed payload full of undefined reads.
    expect(e.body).toBeUndefined();
    expect(e.resolution).toBeNull();
    expect(e.shortfallUsd).toBeUndefined();
    expect(e.summary).toBe('Not enough funds for this request.');
  });
});

describe('the response body reaches every error', () => {
  it('is attached for other statuses too', async () => {
    const e = await caught(400, { error: 'bad', code: 'VALIDATION_FAILED', field: 'chain' });

    expect(e).toBeInstanceOf(CertenBadRequestError);
    expect((e.body as { field?: string }).field).toBe('chain');
  });

  it('is left undefined when the body is not an object', async () => {
    // A string body would give typed accessors something meaningless to read.
    const e = await caught(500, '<html>502 Bad Gateway</html>');
    expect(e.body).toBeUndefined();
  });
});
