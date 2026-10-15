import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * One identity reference type, everywhere: a UUID, an `acc://` ADI URL, or a name this machine knows it by.
 *
 * The gateway keys identities three different ways (`/v1/identity/{id}` wants a UUID, `/v1/governance` wants an ADI URL,
 * `/v1/portfolio` and `/v1/pending` take either), and the CLI used to make the person know which: `governance` took an ADI,
 * `call` took a UUID, and nothing translated. The gateway's identity route accepts a UUID only, so an ADI or a name has to be
 * resolved on this side, from what this machine recorded when it made the identity and then from the gateway's portfolio.
 *
 * What these cases pin is that it never guesses: two identities answering to one name is a question, an ADI nobody can map to a
 * UUID is a named failure, and a reference that is none of the three forms is refused before any request is made.
 */
let scratch = '';
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => scratch }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => scratch }));

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

async function load(): Promise<{ ref: typeof import('../src/identity-ref.js'); cfg: typeof import('../src/config.js') }> {
  return { ref: await import('../src/identity-ref.js'), cfg: await import('../src/config.js') };
}

/** A client that counts what it is asked, so a test can assert what did NOT reach the network. */
function fakeClient(opts: {
  identity?: Record<string, { adi_url: string }>;
  portfolio?: Array<{ id?: string; adi_url: string }>;
} = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      identity: {
        get: async (id: string) => {
          calls.push(`identity.get ${id}`);
          const hit = opts.identity?.[id];
          if (!hit) { const e = new Error('not found') as Error & { status: number }; e.status = 404; throw e; }
          return { id, adi_url: hit.adi_url };
        },
      },
      portfolio: {
        get: async (identity?: string) => {
          calls.push(`portfolio.get ${identity ?? ''}`);
          return { identities: opts.portfolio ?? [], total_chains: 0 };
        },
      },
    } as never,
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'certen-idref-'));
  vi.resetModules();
});
afterEach(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ } });

describe('classifying a reference', () => {
  it.each([
    [ID_A, 'uuid'],
    [ID_A.toUpperCase(), 'uuid'],
    ['acc://jason-dev.acme', 'adi'],
    ['ACC://Jason-Dev.acme/', 'adi'],
    ['jason-dev', 'alias'],
    ['Jason.Dev_2', 'alias'],
  ])('%s is %s', async (text, kind) => {
    const { ref } = await load();
    expect(ref.classifyIdentityRef(text).kind).toBe(kind);
  });

  it.each(['', '   ', 'acc://', 'acc://jason-dev.acme/book/1', 'has space', 'semi;colon', '../x', 'a'.repeat(200)])(
    'refuses %j as not an identity reference, before any request',
    async (text) => {
      const { ref } = await load();
      expect(() => ref.classifyIdentityRef(text)).toThrowError(/identity/i);
      try { ref.classifyIdentityRef(text); } catch (e) { expect(e).toMatchObject({ code: 'INVALID_IDENTITY_REF', exitCode: 2 }); }
    },
  );

  it('normalises an ADI URL: lower case, no trailing slash', async () => {
    const { ref } = await load();
    expect(ref.classifyIdentityRef('ACC://Jason-Dev.ACME//')).toMatchObject({ kind: 'adi', adi_url: 'acc://jason-dev.acme' });
  });
});

describe('a UUID', () => {
  it('needs no network at all when only the id is wanted', async () => {
    const { ref } = await load();
    const f = fakeClient();
    expect(await ref.resolveIdentityRef(ID_A, { client: f.client, need: 'id' })).toMatchObject({ id: ID_A, via: 'uuid' });
    expect(f.calls).toEqual([]);
  });

  it('takes the ADI from the local record, without a request', async () => {
    const { ref, cfg } = await load();
    cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://a.acme', chains: [] });
    const f = fakeClient();
    expect(await ref.resolveIdentityRef(ID_A, { client: f.client, need: 'adi' })).toMatchObject({ id: ID_A, adi_url: 'acc://a.acme', source: 'local' });
    expect(f.calls).toEqual([]);
  });

  it('asks the gateway for the ADI when this machine has no record of it', async () => {
    const { ref } = await load();
    const f = fakeClient({ identity: { [ID_A]: { adi_url: 'acc://remote.acme' } } });
    expect(await ref.resolveIdentityRef(ID_A, { client: f.client, need: 'adi' })).toMatchObject({ id: ID_A, adi_url: 'acc://remote.acme', source: 'gateway' });
    expect(f.calls).toEqual([`identity.get ${ID_A}`]);
  });

  it('fails with the gateway\'s own 404 when the UUID is not an identity, rather than inventing an ADI', async () => {
    const { ref } = await load();
    const f = fakeClient();
    await expect(ref.resolveIdentityRef(ID_A, { client: f.client, need: 'adi' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('an ADI URL', () => {
  it('finds the UUID in the local record first, case-insensitively', async () => {
    const { ref, cfg } = await load();
    cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://Jason-Dev.acme', chains: [] });
    const f = fakeClient();
    expect(await ref.resolveIdentityRef('acc://jason-dev.acme/', { client: f.client, need: 'id' })).toMatchObject({ id: ID_A, via: 'adi', source: 'local' });
    expect(f.calls).toEqual([]);
  });

  it('needs no id and no network when only the ADI is wanted', async () => {
    const { ref } = await load();
    const f = fakeClient();
    expect(await ref.resolveIdentityRef('acc://x.acme', { client: f.client, need: 'adi' })).toMatchObject({ adi_url: 'acc://x.acme' });
    expect(f.calls).toEqual([]);
  });

  it('falls back to the gateway\'s portfolio, which carries each identity\'s id', async () => {
    const { ref } = await load();
    const f = fakeClient({ portfolio: [{ id: ID_B, adi_url: 'acc://other.acme' }, { id: ID_A, adi_url: 'acc://x.acme' }] });
    expect(await ref.resolveIdentityRef('acc://x.acme', { client: f.client, need: 'id' })).toMatchObject({ id: ID_A, adi_url: 'acc://x.acme', source: 'gateway' });
    expect(f.calls).toEqual(['portfolio.get acc://x.acme']);
  });

  it('names the problem when the gateway is older than the portfolio ids, instead of guessing', async () => {
    const { ref } = await load();
    const f = fakeClient({ portfolio: [{ adi_url: 'acc://x.acme' }] });
    await expect(ref.resolveIdentityRef('acc://x.acme', { client: f.client, need: 'id' })).rejects.toMatchObject({ code: 'IDENTITY_ID_UNRESOLVED', exitCode: 2 });
    await expect(ref.resolveIdentityRef('acc://x.acme', { client: f.client, need: 'id' })).rejects.toThrowError(/does not return identity ids|UUID/);
  });

  it('names the problem when no identity of this organization has that ADI', async () => {
    const { ref } = await load();
    const f = fakeClient({ portfolio: [{ id: ID_B, adi_url: 'acc://other.acme' }] });
    await expect(ref.resolveIdentityRef('acc://x.acme', { client: f.client, need: 'id' })).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND', exitCode: 2 });
  });
});

describe('a name this machine knows an identity by', () => {
  it('matches the name the identity was created with, ignoring case', async () => {
    const { ref, cfg } = await load();
    cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://jason-dev.acme', chains: [], name: 'Jason-Dev' });
    const f = fakeClient();
    expect(await ref.resolveIdentityRef('jason-DEV', { client: f.client, need: 'id' })).toMatchObject({ id: ID_A, adi_url: 'acc://jason-dev.acme', via: 'alias', source: 'local' });
    expect(f.calls).toEqual([]);
  });

  it('also matches the label of the ADI, for records written before names were kept', async () => {
    const { ref, cfg } = await load();
    cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://legacy-bot.acme', chains: [] });
    expect((await ref.resolveIdentityRef('legacy-bot', { need: 'id' })).id).toBe(ID_A);
  });

  it('asks which one when two identities answer to the name, listing both', async () => {
    const { ref, cfg } = await load();
    cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://bot.acme', chains: [], name: 'bot' });
    cfg.rememberIdentity({ id: ID_B, adi_url: 'acc://other.acme', chains: [], name: 'Bot' });
    await expect(ref.resolveIdentityRef('bot', { need: 'id' })).rejects.toMatchObject({ code: 'AMBIGUOUS_IDENTITY', exitCode: 2 });
    try { await ref.resolveIdentityRef('bot', { need: 'id' }); } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(ID_A);
      expect(msg).toContain(ID_B);
    }
  });

  it('says what is recorded when nothing matches, and that the UUID or ADI always works', async () => {
    const { ref, cfg } = await load();
    cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://alpha.acme', chains: [], name: 'alpha' });
    await expect(ref.resolveIdentityRef('beta', { need: 'id' })).rejects.toMatchObject({ code: 'UNKNOWN_IDENTITY_ALIAS', exitCode: 2 });
    try { await ref.resolveIdentityRef('beta', { need: 'id' }); } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('alpha');
      expect(msg).toContain('acc://alpha.acme');
      expect(msg).toMatch(/UUID|acc:\/\//);
    }
  });

  it('says nothing is recorded when nothing is', async () => {
    const { ref } = await load();
    await expect(ref.resolveIdentityRef('beta', { need: 'id' })).rejects.toThrowError(/no identities recorded|nothing recorded|No identity is recorded/i);
  });
});

describe('need: any', () => {
  it('returns what it was given or what it knows, without a request', async () => {
    const { ref, cfg } = await load();
    cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://a.acme', chains: [], name: 'a-bot' });
    const f = fakeClient();
    expect(await ref.resolveIdentityRef(ID_C, { client: f.client, need: 'any' })).toMatchObject({ id: ID_C });
    expect(await ref.resolveIdentityRef('acc://z.acme', { client: f.client, need: 'any' })).toMatchObject({ adi_url: 'acc://z.acme' });
    expect(await ref.resolveIdentityRef('a-bot', { client: f.client, need: 'any' })).toMatchObject({ id: ID_A, adi_url: 'acc://a.acme' });
    expect(f.calls).toEqual([]);
  });
});

describe('what is recorded', () => {
  it('keeps the name an identity was created with, and replaces a record by id', async () => {
    const { cfg } = await load();
    cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://a.acme', chains: ['base-sepolia'], name: 'a-bot' });
    cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://a.acme', chains: ['base-sepolia', 'ethereum-sepolia'], name: 'a-bot' });
    const all = cfg.recordedIdentities();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: ID_A, name: 'a-bot', chains: ['base-sepolia', 'ethereum-sepolia'] });
  });
});
