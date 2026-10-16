import { describe, it, expect, afterEach } from 'vitest';
import { ALL_TOOLS } from '../src/tools.js';
import { startWorld, serve, sharedProof, type AgentWorld, type Stub } from './agent-world.js';

/**
 * Which host a share link may be fetched from.
 *
 * `certen_proof_verify` accepts a proof SHARE link so a counterparty with no CERTEN account can check a proof. The SDK's `fetchSharedProof` takes the link's
 * own origin, so the host that was fetched from was whichever one the caller (an agent, and so anyone who can put text in front of one) wrote into the link,
 * and a bare `cps_` token went to the DEFAULT gateway whatever this server was configured for. A server that connects wherever a prompt says is a way to make
 * it probe the network it sits in, which the rest of this server is built never to do.
 *
 * So the origin must be the gateway this server is configured for, or one the OPERATOR listed in `CERTEN_SHARE_ORIGINS` (server configuration, like
 * `CERTEN_ENABLED_CHAINS`; never an argument). Anything else is refused before a request, naming the variable. The CLI and the SDK are unchanged: a person naming
 * a link on their own machine is not a server an agent drives.
 *
 * `certen_proof_open_shared` was never affected: it takes the TOKEN from a link and asks this server's own gateway. That is pinned here too, because this
 * ledger once said otherwise.
 */

const worlds: AgentWorld[] = [];
const stubs: Stub[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  for (const s of stubs.splice(0)) await s.close();
});
const world = async (...a: Parameters<typeof startWorld>): Promise<AgentWorld> => { const w = await startWorld(...a); worlds.push(w); return w; };
/** Another deployment: a second origin that serves share links. */
const elsewhere = async (): Promise<Stub> => {
  const s = await serve((_req, res) => { res.statusCode = 200; res.end(JSON.stringify(sharedProof())); });
  stubs.push(s);
  return s;
};
const link = (origin: string, token = 'tok1'): string => `${origin}/v1/proof/shared/${token}`;
const outcome = (body: any) => body.layers.find((l: { id: string }) => l.id === 'outcome');

describe('certen_proof_verify given a share link: the origin must be one this server is allowed to talk to', () => {
  it('a link on the gateway this server is configured for is fetched from it, and verified here', async () => {
    const w = await world();
    const r = await w.call('certen_proof_verify', { target: link(w.gateway.url) });
    expect(r.isError, r.text).toBe(false);
    expect(w.gateway.hits).toEqual(['GET /v1/proof/shared/tok1']);
    expect(outcome(r.body)).toBeDefined();
  });

  it('a link on any other origin is refused BEFORE a request, naming the origin and the operator\'s variable', async () => {
    const w = await world();
    const other = await elsewhere();
    const r = await w.call('certen_proof_verify', { target: link(other.url) });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('SHARE_ORIGIN_NOT_ALLOWED');
    expect(r.body.error.status).toBe(0);
    expect(r.body.error.message).toContain(new URL(other.url).origin);
    expect(r.body.error.message).toContain('CERTEN_SHARE_ORIGINS');
    expect(other.hits).toEqual([]);
    expect(w.gateway.hits).toEqual([]);
  });

  it('an origin the operator listed is fetched from, and only that origin', async () => {
    const w = await world();
    const listed = await elsewhere();
    const unlisted = await elsewhere();
    const env = { CERTEN_SHARE_ORIGINS: new URL(listed.url).origin };
    const ok = await w.call('certen_proof_verify', { target: link(listed.url) }, env);
    expect(ok.isError, ok.text).toBe(false);
    expect(listed.hits).toEqual(['GET /v1/proof/shared/tok1']);
    const refused = await w.call('certen_proof_verify', { target: link(unlisted.url) }, env);
    expect(refused.body.error.code).toBe('SHARE_ORIGIN_NOT_ALLOWED');
    expect(unlisted.hits).toEqual([]);
  });

  it('the list is read as origins: commas and spaces, a trailing slash, a path, and upper-case host all mean the same origin', async () => {
    const w = await world();
    const listed = await elsewhere();
    const u = new URL(listed.url);
    for (const entry of [`${u.origin}/`, `${u.origin}/some/path`, `  ${u.origin} , https://another.example `, `${u.protocol}//${u.host.toUpperCase()}`]) {
      const r = await w.call('certen_proof_verify', { target: link(listed.url, 'tokx') }, { CERTEN_SHARE_ORIGINS: entry });
      expect(r.isError, `${entry}: ${r.text}`).toBe(false);
    }
  });

  it('a different port, or the other scheme, is a different origin', async () => {
    const w = await world();
    const listed = await elsewhere();
    const u = new URL(listed.url);
    const otherPort = `${u.protocol}//${u.hostname}:${Number(u.port) + 1}`;
    const r = await w.call('certen_proof_verify', { target: link(listed.url) }, { CERTEN_SHARE_ORIGINS: `${otherPort},https://${u.host}` });
    expect(r.body.error.code).toBe('SHARE_ORIGIN_NOT_ALLOWED');
    expect(listed.hits).toEqual([]);
  });

  it('a bare token is fetched from the gateway this server is configured for, not from the default one', async () => {
    const w = await world();
    const r = await w.call('certen_proof_verify', { target: 'cps_abc123' });
    expect(r.isError, r.text).toBe(false);
    expect(w.gateway.hits).toEqual(['GET /v1/proof/shared/cps_abc123']);
  });

  it('a misspelt list is refused by name for every share fetch until it is fixed, never skipped', async () => {
    const w = await world();
    for (const bad of ['not a url', 'ftp://files.example', 'file:///etc/passwd', 'https://ok.example,nope']) {
      const r = await w.call('certen_proof_verify', { target: link(w.gateway.url) }, { CERTEN_SHARE_ORIGINS: bad });
      expect(r.isError, bad).toBe(true);
      expect(r.body.error.code, bad).toBe('SHARE_ORIGINS_INVALID');
      expect(r.body.error.message, bad).toContain('CERTEN_SHARE_ORIGINS');
    }
    expect(w.gateway.hits).toEqual([]);
  });

  it('an empty list is the same as none', async () => {
    const w = await world();
    const r = await w.call('certen_proof_verify', { target: link(w.gateway.url) }, { CERTEN_SHARE_ORIGINS: '  ' });
    expect(r.isError, r.text).toBe(false);
  });

  it('a link that is not a share link is refused by the SDK\'s own check, with nothing requested', async () => {
    const w = await world();
    const r = await w.call('certen_proof_verify', { target: `${w.gateway.url}/v1/identity/abc` });
    expect(r.isError).toBe(true);
    expect(w.gateway.hits).toEqual([]);
  });

  it('an allowed host that redirects the fetch somewhere else is refused, and the somewhere else is never contacted', async () => {
    const trap = await serve((_req, res) => { res.statusCode = 200; res.end(JSON.stringify(sharedProof())); });
    stubs.push(trap);
    const w = await world({ redirectShareTo: `${trap.url}/v1/proof/shared/landed` });
    const r = await w.call('certen_proof_verify', { target: link(w.gateway.url, 'redirect-out') });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('FOREIGN_ORIGIN_URL');
    expect(trap.hits).toEqual([]);
  });
});

describe('certen_proof_open_shared never chose a host, and still does not', () => {
  it('takes only the token from a link on another origin and asks this server\'s own gateway', async () => {
    const w = await world();
    const other = await elsewhere();
    const r = await w.call('certen_proof_open_shared', { link: link(other.url, 'tokY') });
    expect(r.isError, r.text).toBe(false);
    expect(w.gateway.hits).toEqual(['GET /v1/proof/shared/tokY']);
    expect(other.hits).toEqual([]);
  });
});

describe('what the tools say about it', () => {
  it('the verify tool\'s description tells a client which links it will open', () => {
    const d = ALL_TOOLS.find((t) => t.name === 'certen_proof_verify')!.description;
    expect(d).toMatch(/share link/i);
    expect(d).toMatch(/CERTEN_SHARE_ORIGINS/);
  });
});
