import { describe, it, expect, afterEach } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { ALL_TOOLS, READ_TOOLS, annotationsFor } from '../src/tools.js';
import { outputSchemaFor } from '../src/output-schemas.js';
import {
  startWorld, serve, keyPageReply, goodIdentity, ID, ACCOUNT, KEY, OTHER_KEY,
  type AgentWorld, type Stub,
} from './agent-world.js';

/**
 * `certen_readiness`: "can THIS identity, on THIS chain, act right now?" - for an agent, in one call.
 *
 * Before it an agent assembled the answer from certen_doctor (org-wide), certen_identity_get (the gateway's word on the key page), certen_billing_balance,
 * certen_portfolio_get (the gas) and a hand-written look at Accumulate it cannot make. The judgement is the SDK's (`client.readiness()`, exercised by 47
 * tests of its own); what is pinned HERE is what this tool adds around it and the rules of this server:
 *
 * - it never takes a node to call: the only Accumulate endpoint is the one the gateway's registry advertises or the OPERATOR configured. An argument that
 *   names one is not contacted;
 * - a chain this server does not enable, and an amount that looks like wei, are refused before a single request;
 * - it is never `ready` over something it could not answer;
 * - fixes are in words: the SDK never names a CLI command, and an agent has no CLI to run.
 */

const worlds: AgentWorld[] = [];
const extra: Stub[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  for (const s of extra.splice(0)) await s.close();
});
const world = async (...a: Parameters<typeof startWorld>): Promise<AgentWorld> => { const w = await startWorld(...a); worlds.push(w); return w; };

const ARGS = { identityId: ID, chain: 'base-sepolia', keyHash: KEY };
const names = (r: { checks: Array<{ name: string }> }): string[] => r.checks.map((c) => c.name);
const byName = (r: { checks: Array<{ name: string; status: string; code?: string; detail: string; fix?: any }> }, n: string) => r.checks.find((c) => c.name === n)!;

describe('certen_readiness: the healthy case', () => {
  it('is ready, with every check in dependency order and the facts of the context', async () => {
    const w = await world();
    const r = await w.call('certen_readiness', ARGS);
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ ready: true, state: 'ready', first_blocker: null });
    expect(names(r.body)).toEqual(['gateway', 'credential', 'identity', 'chain', 'key page', 'accumulate credits', 'gateway balance', 'gas']);
    expect(r.body.checks.map((c: { status: string }) => c.status)).toEqual(Array(8).fill('ok'));
    expect(r.body.context).toMatchObject({ identity_id: ID, chain: 'base-sepolia', abstract_account: ACCOUNT, key_hash: KEY });
    // The independent read: from Accumulate, not from the gateway.
    expect(byName(r.body, 'key page').detail).toMatch(/read from Accumulate .* not the gateway/);
    expect(r.structured).toEqual(r.body);
  });

  it('is ONE tool call for what took an agent five, and four requests behind it (three to the gateway, one to Accumulate)', async () => {
    const w = await world();
    await w.call('certen_readiness', ARGS);
    expect([...w.gateway.hits].sort()).toEqual(['GET /v1/billing/balance', 'GET /v1/chains', `GET /v1/identity/${ID}`]);
    expect(w.accumulate.hits).toEqual(['POST /v3']);
  });

  it('without a key hash the key page is read from the gateway only, and the check says it was not compared with a key', async () => {
    const w = await world();
    const r = await w.call('certen_readiness', { identityId: ID, chain: 'base-sepolia' });
    expect(byName(r.body, 'key page')).toMatchObject({ status: 'warn', code: 'KEY_PAGE_NOT_INDEPENDENTLY_CHECKED' });
    expect(w.accumulate.hits).toEqual([]);
  });

  it('treats an optional argument sent as null as not provided, the way a model says "not provided"', async () => {
    const w = await world();
    const r = await w.call('certen_readiness', { identityId: ID, chain: 'base-sepolia', keyHash: null, amount: null, tokenSymbol: null });
    expect(r.isError, r.text).toBe(false);
    expect(byName(r.body, 'key page').code).toBe('KEY_PAGE_NOT_INDEPENDENTLY_CHECKED');
    expect(w.accumulate.hits).toEqual([]);
  });

  it('accepts the key hash with a 0x prefix and in capitals', async () => {
    const w = await world();
    const r = await w.call('certen_readiness', { ...ARGS, keyHash: `0x${KEY.toUpperCase()}` });
    expect(r.body.context.key_hash).toBe(KEY);
    expect(byName(r.body, 'key page').status).toBe('ok');
  });
});

describe('certen_readiness: what is in the way, in words', () => {
  it('blocked on gas names the account and what to send, and offers a faucet link, with no CLI command in it', async () => {
    const w = await world({ identity: [200, goodIdentity({ balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: 'ETH', balance: '0' }] })] });
    const r = await w.call('certen_readiness', ARGS);
    expect(r.body).toMatchObject({ ready: false, state: 'blocked' });
    expect(r.body.first_blocker).toMatchObject({ name: 'gas', status: 'fail', code: 'ABSTRACT_ACCOUNT_UNFUNDED' });
    expect(r.body.first_blocker.fix.text).toContain(ACCOUNT);
    expect(r.body.first_blocker.fix.url).toMatch(/^https:\/\//);
    // The SDK states fixes in plain words: an agent has no `certen` binary to run.
    expect(JSON.stringify(r.body)).not.toMatch(/\bcerten (gas|fund|status|setup|send|call)\b/);
    for (const c of r.body.checks) expect(c.fix?.command).toBeUndefined();
  });

  it('judges the amount about to be moved together with an estimate of the gas, and says the reserve is an estimate', async () => {
    const w = await world({ identity: [200, goodIdentity({ balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: 'ETH', balance: '0.0021' }] })] });
    const enough = await w.call('certen_readiness', { ...ARGS, amount: '0.0001' });
    expect(byName(enough.body, 'gas').status).toBe('ok');
    const short = await w.call('certen_readiness', { ...ARGS, amount: '0.0021' });
    expect(byName(short.body, 'gas')).toMatchObject({ status: 'fail', code: 'ABSTRACT_ACCOUNT_UNDERFUNDED' });
    expect(byName(short.body, 'gas').detail).toMatch(/estimate/);
  });

  it('an identity that is still being created is a blocker, and what depends on it is skipped, not dropped', async () => {
    const w = await world({ identity: [200, goodIdentity({ status: 'creating', can_sign: null })] });
    const r = await w.call('certen_readiness', ARGS);
    expect(r.body.state).toBe('blocked');
    expect(r.body.first_blocker).toMatchObject({ name: 'identity', code: 'IDENTITY_PROVISIONING' });
    expect(names(r.body)).toHaveLength(8);
    expect(byName(r.body, 'gas').status).toBe('skipped');
  });

  it('the gateway and Accumulate disagreeing about the key page is a blocker with its own code: neither is preferred', async () => {
    const w = await world({ identity: [200, goodIdentity({ can_sign: false })] });
    const r = await w.call('certen_readiness', ARGS);
    expect(byName(r.body, 'key page')).toMatchObject({ status: 'fail', code: 'KEY_PAGE_DISAGREES' });
    expect(r.body.state).toBe('blocked');
  });

  it('a key page that does not list the key is a blocker', async () => {
    const w = await world();
    const r = await w.call('certen_readiness', { ...ARGS, keyHash: OTHER_KEY });
    expect(byName(r.body, 'key page').status).toBe('fail');
    expect(r.body.ready).toBe(false);
  });
});

describe('certen_readiness: never ready over something it could not answer', () => {
  it('an Accumulate node that cannot be read leaves the answer unconfirmed, naming the key page', async () => {
    const w = await world({ accumulate: (res) => { res.statusCode = 500; res.end('{}'); } });
    const r = await w.call('certen_readiness', ARGS);
    expect(r.body).toMatchObject({ ready: false, state: 'unconfirmed' });
    expect(r.body.first_blocker).toMatchObject({ name: 'key page', status: 'unknown', code: 'KEY_PAGE_UNCONFIRMED' });
  });

  it('a registry that advertises no Accumulate endpoint, with none configured, is unknown and says why - and nothing is called', async () => {
    const w = await world({ noAccumulateEndpoint: true });
    const r = await w.call('certen_readiness', ARGS);
    expect(r.body.state).toBe('unconfirmed');
    expect(byName(r.body, 'key page')).toMatchObject({ status: 'unknown' });
    expect(byName(r.body, 'key page').detail).toMatch(/no Accumulate endpoint/);
    expect(w.accumulate.hits).toEqual([]);
  });

  it('a gateway that is down is an error the agent can read, not a thrown failure or a pass', async () => {
    const w = await world();
    await w.gateway.close();
    const r = await w.call('certen_readiness', ARGS);
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ ready: false, state: 'blocked' });
    expect(r.body.first_blocker).toMatchObject({ name: 'gateway', code: 'GATEWAY_UNREACHABLE' });
    expect(r.body.checks.filter((c: { status: string }) => c.status === 'skipped')).toHaveLength(7);
  });
});

describe('certen_readiness: it calls no node the caller names', () => {
  it('uses the operator\'s CERTEN_ACCUMULATE_RPC instead of the registry\'s advertisement', async () => {
    const w = await world();
    const operator = await serve((_req, res) => keyPageReply(res));
    extra.push(operator);
    const r = await w.call('certen_readiness', ARGS, { CERTEN_ACCUMULATE_RPC: `${operator.url}/v3` });
    expect(byName(r.body, 'key page').status).toBe('ok');
    expect(operator.hits).toEqual(['POST /v3']);
    expect(w.accumulate.hits).toEqual([]);
  });

  it('an operator setting that is not a usable endpoint leaves the key page unknown, never ok', async () => {
    const w = await world();
    const r = await w.call('certen_readiness', ARGS, { CERTEN_ACCUMULATE_RPC: 'file:///etc/passwd' });
    expect(byName(r.body, 'key page').status).toBe('unknown');
    expect(r.body.ready).toBe(false);
    expect(w.accumulate.hits).toEqual([]);
  });

  it('an accumulateRpc (or rpc, url, node...) in the ARGUMENTS is refused by name, and never contacted - not silently ignored, which an agent would read as "it worked"', async () => {
    const w = await world();
    const named = await serve((_req, res) => keyPageReply(res));
    extra.push(named);
    for (const key of ['accumulateRpc', 'rpc', 'rpcUrl', 'url', 'endpoint', 'node']) {
      const r = await w.call('certen_readiness', { ...ARGS, [key]: `${named.url}/v3` });
      expect(r.isError, key).toBe(true);
      expect(r.body.error.code, key).toBe('NODE_ARGUMENT_REFUSED');
      expect(r.body.error.message, key).toContain(`"${key}"`);
      expect(r.body.error.message, key).toMatch(/never calls a node you name/);
      // And it says what to do instead: the node is the operator's to set.
      expect(r.body.error.message, key).toMatch(/CERTEN_ACCUMULATE_RPC/);
    }
    expect(named.hits).toEqual([]);
    expect(w.gateway.hits, 'nothing was sent').toEqual([]);
    expect(w.accumulate.hits).toEqual([]);
    const tool = ALL_TOOLS.find((t) => t.name === 'certen_readiness')!;
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['amount', 'chain', 'identityId', 'keyHash', 'tokenSymbol']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });
});

describe('certen_readiness: the invocation is checked before anything is sent', () => {
  const refused = async (w: AgentWorld, args: Record<string, unknown>, code: string, env?: Record<string, string>): Promise<void> => {
    const r = await w.call('certen_readiness', args, env);
    expect(r.isError, JSON.stringify(r.body)).toBe(true);
    expect(r.body.error.code).toBe(code);
    expect(w.gateway.hits, 'nothing was sent').toEqual([]);
    expect(w.accumulate.hits).toEqual([]);
  };

  it('refuses a chain the catalogue does not know, naming the alternatives', async () => {
    const w = await world();
    await refused(w, { ...ARGS, chain: 'base-sepoli' }, 'UNSUPPORTED_CHAIN');
  });

  it('refuses a chain this server does not enable, however the gateway lists it', async () => {
    const w = await world();
    await refused(w, ARGS, 'UNSUPPORTED_CHAIN', { CERTEN_ENABLED_CHAINS: 'ethereum-sepolia' });
    await refused(w, { ...ARGS, chain: 'telcoin-adiri' }, 'UNSUPPORTED_CHAIN');
  });

  it('works on an enabled chain, and CERTEN_ALLOW_ANY_CHAIN=1 (the operator\'s deliberate escape) is honoured by the readiness judgement too, not refused by it', async () => {
    const w = await world();
    const enabled = await w.call('certen_readiness', ARGS, { CERTEN_ENABLED_CHAINS: 'base-sepolia' });
    expect(byName(enabled.body, 'chain').status).toBe('ok');
    // Without the escape this configuration refuses base-sepolia outright (above); with it the operator has said any chain the gateway serves is fine,
    // so the SDK must not turn around and call it "not enabled in this client's configuration".
    const escaped = await w.call('certen_readiness', ARGS, { CERTEN_ENABLED_CHAINS: 'ethereum-sepolia', CERTEN_ALLOW_ANY_CHAIN: '1' });
    expect(escaped.isError, escaped.text).toBe(false);
    expect(byName(escaped.body, 'chain').status).toBe('ok');
  });

  it('refuses an amount that looks like wei, with the reason, instead of reporting an account that cannot cover a thousand million ether', async () => {
    const w = await world();
    await refused(w, { ...ARGS, amount: '1000000000000000' }, 'INVALID_AMOUNT');
    const again = await w.call('certen_readiness', { ...ARGS, amount: '1000000000000000' });
    expect(again.body.error.message).toMatch(/wei|whole/i);
  });

  it('refuses an amount that is not a number', async () => {
    const w = await world();
    await refused(w, { ...ARGS, amount: 'a lot' }, 'INVALID_AMOUNT');
    await refused(w, { ...ARGS, amount: '-1' }, 'INVALID_AMOUNT');
  });

  it('refuses an identity that is not a UUID (an acc:// URL is not accepted: the gateway\'s identity routes take the id)', async () => {
    const w = await world();
    await refused(w, { ...ARGS, identityId: 'acc://probe.acme' }, 'INVALID_IDENTITY_ID');
    await refused(w, { ...ARGS, identityId: '../../v1/billing/balance' }, 'INVALID_IDENTITY_ID');
  });

  it('refuses an argument it does not have, listing the ones it does, instead of ignoring it', async () => {
    const w = await world();
    await refused(w, { ...ARGS, scope: 'context' }, 'UNKNOWN_ARGUMENT');
    const r = await w.call('certen_readiness', { ...ARGS, gasReserve: '0.1' });
    expect(r.body.error.message).toMatch(/identityId, chain, keyHash, amount, tokenSymbol/);
  });

  it('refuses a key hash that is not 32 bytes of hex', async () => {
    const w = await world();
    await refused(w, { ...ARGS, keyHash: 'my-key' }, 'INVALID_KEY_HASH');
    await refused(w, { ...ARGS, keyHash: 'a'.repeat(63) }, 'INVALID_KEY_HASH');
  });
});

describe('certen_readiness: how a client sees it', () => {
  it('is a read-tier tool that mutates nothing, with read-only annotations and no confirmation gate', () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'certen_readiness')!;
    expect(tool.tier).toBe('read');
    expect(tool.mutates).toBe(false);
    expect(READ_TOOLS).toContain(tool);
    expect(tool.inputSchema.properties).not.toHaveProperty('confirm');
    expect(annotationsFor(tool)).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tool.inputSchema.required).toEqual(['identityId', 'chain']);
  });

  it('declares an outputSchema that what it returns conforms to, ready or blocked or unconfirmed', async () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(outputSchemaFor('certen_readiness')!);
    for (const world_ of [
      {},
      { identity: [200, goodIdentity({ balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: 'ETH', balance: '0' }] })] as [number, unknown] },
      { noAccumulateEndpoint: true },
      { identity: [404, { message: 'no such identity' }] as [number, unknown] },
    ]) {
      const w = await world(world_);
      const r = await w.call('certen_readiness', ARGS);
      expect(validate(r.structured), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('says in its description what a client must not infer: unconfirmed is not ready, a warn is not an independent check, and it calls no node you name', () => {
    const d = ALL_TOOLS.find((t) => t.name === 'certen_readiness')!.description;
    expect(d).toMatch(/unconfirmed/);
    expect(d).toMatch(/NOT ready|not ready/);
    expect(d).toMatch(/warn/);
    expect(d).toMatch(/PUBLIC key/);
    expect(d).toMatch(/CERTEN_ACCUMULATE_RPC/);
    expect(d).toMatch(/estimate/);
  });
});
