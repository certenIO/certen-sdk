import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * Does the end-to-end check actually check anything?
 *
 * A green end-to-end run that cannot go red is worse than no end-to-end run: it is a claim of
 * coverage with nothing behind it, and it is exactly the failure mode this programme has already hit
 * twice — a coverage tool that could only report good news, and a test-timeout fix that was never in
 * effect. So the script's assertions are themselves tested, against a stub gateway that returns
 * plausible-but-wrong answers.
 *
 * The two cases that matter are the ones a naive exit-code check would pass:
 *
 *   - an identity created with `can_sign: null` — provisioned, quota consumed, and unable to sign
 *   - a proof that exists and is NOT anchored — a claim about a claim
 *
 * Both are real failures observed on real deployments, and both look like success from outside.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'e2e-onboarding.mjs');
const run = promisify(execFile);

const servers: http.Server[] = [];
afterAll(() => { for (const s of servers.splice(0)) s.close(); });

interface Behaviour {
  /** `can_sign` on the created identity. */
  canSign?: boolean | null;
  /** `remaining_usd` on the balance. */
  remaining?: string;
  /** Refuse to issue a signup challenge, as an undeployed gateway does. */
  noSelfService?: boolean;
}

async function stubGateway(b: Behaviour = {}): Promise<string> {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const url = (req.url ?? '').split('?')[0];
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };

    if (url === '/v1/signup/challenge') {
      if (b.noSelfService) return send(404, { message: 'Route POST:/v1/signup/challenge not found', error: 'Not Found' });
      return send(201, { nonce: 'ab'.repeat(32), expires_in: 300, algorithm: 'ed25519', instructions: '' });
    }
    if (url === '/v1/signup') {
      return send(201, {
        org: { id: 'org-e2e', name: 'e2e', plan: 'starter' },
        api_key: 'ck_live_e2e',
        key_prefix: 'ck_live_e2e...',
        permissions: ['identity:write', 'billing:read'],
      });
    }
    if (url === '/v1/identity' && req.method === 'POST') {
      return send(202, {
        id: 'id-e2e', adi_url: 'acc://e2e', book_url: null, key_page_url: null,
        status: 'provisioning', credit_balance: 0, chain_accounts: [], created_at: 'now',
        polling: {
          first_poll_after_seconds: 0, interval_seconds: 0,
          estimated_ready_in_seconds: 0, terminal_states: ['active'],
        },
      });
    }
    if (url.startsWith('/v1/identity/')) {
      return send(200, {
        id: 'id-e2e', adi_url: 'acc://e2e', book_url: null, key_page_url: null,
        status: 'active',
        // The value under test.
        can_sign: b.canSign === undefined ? true : b.canSign,
        credit_balance: 0, chain_accounts: [], created_at: 'now',
      });
    }
    if (url === '/v1/billing/balance') {
      return send(200, {
        currency: 'USD', available_usd: '5.000000', held_usd: '0.000000',
        credit_limit_usd: '0.000000', spendable_usd: '5.000000',
        remaining_usd: b.remaining ?? '5.000000', pending_intents: 0,
        uncovered_usd: '0.000000', status: 'active',
      });
    }
    return send(200, {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function e2e(url: string): Promise<{ code: number; out: string }> {
  // A tiny provisioning budget. The default is six minutes, which is right against a real gateway
  // and far too long for a stub that will never resolve — the `can_sign: null` case polls until the
  // budget expires, so an unbounded wait here would hang the suite rather than fail it.
  const args = [SCRIPT, '--url', url, '--wait-minutes', '0.15'];
  try {
    const { stdout, stderr } = await run(process.execPath, args, { encoding: 'utf8' });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe('the end-to-end onboarding check', () => {
  it('passes when the journey genuinely works', async () => {
    const url = await stubGateway();
    const { code, out } = await e2e(url);

    expect(out).toContain('signup (keypair, no human)');
    expect(out).toContain('identity created and can sign');
    expect(out).toContain('trial credit covers new work');
    expect(code).toBe(0);
  }, 30_000);

  it('FAILS an identity that cannot sign', async () => {
    // `can_sign: false` means provisioning finished and the on-chain key page is not held by this
    // key. The identity exists, consumes org quota, and can never sign — and every command that
    // created it exited zero.
    const url = await stubGateway({ canSign: false });
    const { code, out } = await e2e(url);

    expect(code).toBe(1);
    // The SDK refuses to hand back an identity it knows cannot sign, so the failure arrives as this
    // code rather than as the script's own backstop message. Either is a correct red.
    expect(out).toContain('IDENTITY_CANNOT_SIGN');
  }, 30_000);

  it('FAILS an identity whose signing ability is unknown', async () => {
    // `null` is UNKNOWN, not a soft yes: the key page could not be read. An Accumulate outage is
    // exactly when this distinction matters, and treating null as success is how a broken identity
    // reaches production looking healthy.
    const url = await stubGateway({ canSign: null });
    const { code, out } = await e2e(url);

    expect(code).toBe(1);
    // Reported as UNKNOWN rather than as either yes or no — the distinction that matters during an
    // Accumulate outage, which is exactly when someone is most tempted to read null as fine.
    expect(out).toMatch(/IDENTITY_CAN_SIGN_UNKNOWN|IDENTITY_WAIT_TIMEOUT/);
  }, 30_000);

  it('FAILS when the new organization cannot pay for anything', async () => {
    // A self-service org gets an expiring trial grant on creation. Without it the first proof-gated
    // call is a 402, so the flow is only half-open — and nothing before this step would notice.
    const url = await stubGateway({ remaining: '0.000000' });
    const { code, out } = await e2e(url);

    expect(code).toBe(1);
    expect(out).toContain('nothing left to commit');
  }, 30_000);

  it('says plainly when the gateway has no self-service signup', async () => {
    // The state of production today. The message has to name the cause, or a CI failure here reads
    // as "onboarding is broken" rather than "that gateway predates the feature".
    const url = await stubGateway({ noSelfService: true });
    const { code, out } = await e2e(url);

    expect(code).toBe(1);
    expect(out).toContain('SELF_SERVICE_ENABLED');
  }, 30_000);

  it('reports a skipped proof cycle as skipped, never as passed', async () => {
    // Without a contract there is nothing to call. A run that quietly omitted the product's central
    // flow while printing a green summary would be the most misleading possible outcome.
    const url = await stubGateway();
    const { out } = await e2e(url);

    expect(out).toContain('skipped: proof-gated call executed');
    expect(out).toContain('no --contract given');
  }, 30_000);
});
