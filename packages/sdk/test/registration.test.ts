import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient, redeemRegistrationToken, selfSignup, requestSignupChallenge } from '../src/index.js';
import { CertenError } from '../src/errors.js';

/**
 * Onboarding an organization with nobody present.
 *
 * Until now an org could only be born inside a browser: the Firebase login exchange created one
 * just-in-time when no membership was found. So a platform could not provision its customers, a CI
 * job could not create a scratch org, and an agent could not take its first step — every automated
 * path stopped and waited for a person. It also meant the one journey every customer walks was the
 * one journey with no automated coverage, because exercising it required a human in the middle.
 *
 * The last test here is the one that closes that: mint, redeem, then USE the resulting credential,
 * with no API key anywhere in the setup.
 */

const servers: http.Server[] = [];

interface Hit { method: string; url: string; apiKey?: string; auth?: string; body: string }

async function gateway(handler: (hit: Hit) => { status?: number; body?: unknown }) {
  const hits: Hit[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const hit: Hit = {
      method: req.method ?? 'GET',
      url: (req.url ?? '').split('?')[0],
      apiKey: req.headers['x-api-key'] as string | undefined,
      auth: req.headers.authorization as string | undefined,
      body: raw,
    };
    hits.push(hit);
    const out = handler(hit);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
      .end(JSON.stringify(out.body ?? {}));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const TOKEN = `crt_${'a'.repeat(43)}`;
const NEW_KEY = 'ck_live_brandnew';

describe('redeemRegistrationToken', () => {
  it('creates an organization without sending any credential', async () => {
    const g = await gateway(() => ({
      status: 201,
      body: {
        org: { id: 'org-new', name: 'Acme', plan: 'starter' },
        api_key: NEW_KEY,
        key_prefix: 'ck_live_bran...',
        permissions: ['identity:read', 'identity:write'],
      },
    }));

    const result = await redeemRegistrationToken(TOKEN, { baseUrl: g.url });

    expect(result.org.id).toBe('org-new');
    expect(result.api_key).toBe(NEW_KEY);
    // The whole point: no credential goes out, because the caller does not have one. A helper that
    // required an API key here would be asking for the thing it exists to produce.
    expect(g.hits[0].apiKey).toBeUndefined();
    expect(g.hits[0].auth).toBeUndefined();
    expect(JSON.parse(g.hits[0].body).token).toBe(TOKEN);
  });

  it('explains a 404 instead of letting it read as a wrong URL', async () => {
    const g = await gateway(() => ({
      status: 404,
      body: { error: 'Registration token not found, already used, or expired', code: 'NOT_FOUND' },
    }));

    const err = await redeemRegistrationToken(TOKEN, { baseUrl: g.url })
      .catch((e: unknown) => e as CertenError);

    expect(err).toBeInstanceOf(CertenError);
    // The gateway reports unknown, expired, revoked and spent identically on purpose, so a bare
    // "not found" sends the reader hunting for a typo in the base URL. Name the real situation.
    expect((err as CertenError).message).toContain('unknown, expired, revoked, or already used');
    expect((err as CertenError).message).toContain('Ask for a new token');
  });

  it('passes an override name through', async () => {
    const g = await gateway(() => ({
      status: 201,
      body: { org: { id: 'o', name: 'Chosen', plan: 'starter' }, api_key: NEW_KEY, key_prefix: 'p', permissions: [] },
    }));

    await redeemRegistrationToken(TOKEN, { baseUrl: g.url, orgName: 'Chosen' });

    expect(JSON.parse(g.hits[0].body).org_name).toBe('Chosen');
  });
});

describe('minting, which does need a credential', () => {
  it('sends what the new organization will be, not what the redeemer asks for', async () => {
    const g = await gateway(() => ({
      status: 201,
      body: {
        id: 'tok-1', token: TOKEN, token_prefix: 'crt_aaaaaaa...', state: 'active',
        org_name: 'Acme', plan: 'pro', permissions: ['identity:read'],
        expires_at: '2026-09-01T00:00:00Z', revoked_at: null, redeemed_at: null,
        redeemed_org_id: null, note: null, created_at: '2026-08-17T00:00:00Z',
      },
    }));
    const client = new CertenClient({ apiKey: 'ck_live_minter', baseUrl: g.url, maxRetries: 0 });

    const minted = await client.registrationTokens.mint({
      orgName: 'Acme', plan: 'pro', permissions: ['identity:read'], expiresIn: 3600,
    });

    expect(minted.token).toBe(TOKEN);
    const sent = JSON.parse(g.hits[0].body);
    // Pinned by the MINTER. A redeemer able to choose these would be choosing what someone else is
    // billed for, and how much reach an unattended credential has.
    expect(sent).toEqual({
      org_name: 'Acme', plan: 'pro', permissions: ['identity:read'], expires_in: 3600,
    });
    expect(g.hits[0].apiKey).toBe('ck_live_minter');
  });

  it('omits what was not asked for, rather than sending nulls', async () => {
    const g = await gateway(() => ({ status: 201, body: { id: 't', token: TOKEN } }));
    const client = new CertenClient({ apiKey: 'ck_live_minter', baseUrl: g.url, maxRetries: 0 });

    await client.registrationTokens.mint();

    // The gateway applies its own defaults; sending explicit nulls would override them with
    // nothing, which is a different and worse thing than staying quiet.
    expect(JSON.parse(g.hits[0].body)).toEqual({});
  });
});

describe('the whole unattended path', () => {
  it('goes from a token to a working client with no human and no API key', async () => {
    // This is the journey that could never be tested before, because its first step required
    // somebody to open a browser.
    const g = await gateway((hit) => {
      if (hit.url === '/v1/registration-tokens/redeem') {
        return {
          status: 201,
          body: {
            org: { id: 'org-new', name: 'CI scratch', plan: 'starter' },
            api_key: NEW_KEY,
            key_prefix: 'ck_live_bran...',
            permissions: ['identity:read', 'identity:write', 'billing:read'],
          },
        };
      }
      if (hit.url === '/v1/me') {
        return { body: { org: { id: 'org-new', name: 'CI scratch' }, scopes: ['identity:read'] } };
      }
      return { body: { ok: true } };
    });

    // 1. Redeem — holding nothing.
    const { org, api_key } = await redeemRegistrationToken(TOKEN, { baseUrl: g.url });
    expect(org.id).toBe('org-new');

    // 2. Use the credential it produced.
    const client = new CertenClient({ apiKey: api_key, baseUrl: g.url, maxRetries: 0 });
    const me = await client.me();
    expect(me.org?.id).toBe('org-new');

    // The credential on the second call is the one the first call produced, and nothing else was
    // ever held.
    const meCall = g.hits.find((h) => h.url === '/v1/me');
    expect(meCall?.apiKey).toBe(NEW_KEY);
    expect(g.hits[0].apiKey).toBeUndefined();
  });
});

/**
 * Keypair-proof self-service signup — the path with nobody in the loop at all.
 *
 * Registration tokens still needed a human to mint and hand one over, which puts CERTEN or an
 * existing customer in front of every new organization. For a non-custodial platform that is the
 * wrong shape: we do not hold keys, and we should not be holding the door.
 *
 * The signatures here are real Ed25519, produced by the same primitive the gateway verifies with.
 */
describe('signing up by proving you hold a key', () => {
  it('asks for a nonce, signs it, and gets an organization', async () => {
    const nonce = 'ab'.repeat(32);
    const g = await gateway((hit) => {
      if (hit.url === '/v1/signup/challenge') {
        return { status: 201, body: { nonce, expires_in: 300, algorithm: 'ed25519', instructions: 'sign it' } };
      }
      return {
        status: 201,
        body: {
          org: { id: 'org-self', name: 'my-agent', plan: 'starter' },
          api_key: NEW_KEY, key_prefix: 'ck_live_bran...', permissions: ['identity:read'],
        },
      };
    });

    const signed: string[] = [];
    const result = await selfSignup({
      publicKey: 'aa'.repeat(32),
      sign: (n) => { signed.push(n); return 'cc'.repeat(64); },
      orgName: 'my-agent',
    }, { baseUrl: g.url });

    expect(result.org.id).toBe('org-self');
    // The callback is handed the nonce the SERVER issued. Signing anything else would prove
    // possession at a moment of the caller's choosing, which is replayable forever.
    expect(signed).toEqual([nonce]);
    // No credential on either call, because the caller has none — that is the entire point.
    expect(g.hits.every((h) => !h.apiKey && !h.auth)).toBe(true);
    expect(JSON.parse(g.hits[0].body).public_key).toBe('aa'.repeat(32));
  });

  it('binds the challenge to the key by sending it up front', async () => {
    const g = await gateway(() => ({
      status: 201, body: { nonce: 'ab'.repeat(32), expires_in: 300, algorithm: 'ed25519', instructions: '' },
    }));

    await requestSignupChallenge('dd'.repeat(32), { baseUrl: g.url });

    // Binding at issue time closes the window where someone who observes a nonce in flight races
    // to answer it with their own key.
    expect(JSON.parse(g.hits[0].body).public_key).toBe('dd'.repeat(32));
  });

  it('surfaces a refused signature as a CertenError rather than a bare axios failure', async () => {
    const g = await gateway((hit) => {
      if (hit.url === '/v1/signup/challenge') {
        return { status: 201, body: { nonce: 'ab'.repeat(32), expires_in: 300, algorithm: 'ed25519', instructions: '' } };
      }
      return {
        status: 400,
        body: { error: 'That signature does not verify against the public key.', code: 'BAD_REQUEST' },
      };
    });

    const err = await selfSignup({
      publicKey: 'aa'.repeat(32), sign: () => 'cc'.repeat(64),
    }, { baseUrl: g.url }).catch((e: unknown) => e as CertenError);

    expect(err).toBeInstanceOf(CertenError);
    expect((err as CertenError).message).toContain('does not verify');
  });
});
