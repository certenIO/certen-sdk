import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * AGT-2 WP1, standard fact F9: `certen agent add-authority` never signs, and never even calls the gateway, without an explicit
 * `--sign-with` key, whatever --json, --yes or a non-interactive pipe say. `enroll-status` signs nothing and reports the state.
 * FICTIONAL parties; the gateway is a local recording server that records every request.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');
const run = promisify(execFile);
const AGENT = 'acc://agent-7.harbor-mfg.acme';
const BOOK = 'acc://harbor-mfg.acme/book';

async function recordingGateway() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function cli(args: string[], url: string) {
  const home = mkdtempSync(join(tmpdir(), 'certen-agent-'));
  const env = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home, CERTEN_API_URL: url, CERTEN_API_KEY: 'ck_live_test', CERTEN_KEY: 'context-key' };
  try {
    const r = await run(process.execPath, [CLI, ...args], { env, timeout: 30000 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? -1, out: `${x.stdout ?? ''}${x.stderr ?? ''}` };
  }
}

describe('certen agent add-authority signs only with an explicit --sign-with (F9)', () => {
  for (const extra of [[], ['--json'], ['--yes'], ['--json', '--yes']]) {
    it(`without --sign-with, ${extra.join(' ') || 'plain'}: exit 2, SIGN_WITH_REQUIRED, no request reaches the gateway (even with a context key set)`, async () => {
      const s = await recordingGateway();
      try {
        const r = await cli(['agent', 'add-authority', '--identity', AGENT, '--principal-book', BOOK, '--account', 'identity', ...extra], s.url);
        expect(r.code).toBe(2);
        expect(r.out).toContain('SIGN_WITH_REQUIRED');
        expect(s.seen).toEqual([]);
      } finally { await s.close(); }
    }, 60000);
  }
  it('a principal book under the agent itself is refused before any request', async () => {
    const s = await recordingGateway();
    try {
      const r = await cli(['agent', 'add-authority', '--identity', AGENT, '--principal-book', `${AGENT}/book`, '--account', 'book', '--sign-with', 'k', '--json'], s.url);
      expect(r.code).toBe(2);
      expect(r.out).toContain('AGENT_AUTHORITY_MALFORMED');
      expect(s.seen).toEqual([]);
    } finally { await s.close(); }
  }, 60000);
});

describe('certen agent enroll-status', () => {
  it('reports a pending acceptance as NOT enrolled and names the principal as the signer of the next step; signs nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'certen-agent-facts-'));
    const facts = join(dir, 'facts.json');
    writeFileSync(facts, JSON.stringify({
      agentAdi: AGENT, principalAdi: 'acc://harbor-mfg.acme', principalBook: BOOK,
      adiAuthorities: [{ url: `${AGENT}/book`, disabled: false }], keyBookAuthorities: [{ url: `${AGENT}/book`, disabled: false }],
      pendingAuthorityAdds: { adi: 'ab'.repeat(32) }, registryResolve: { ok: false, reason: 'not_registered' },
      grant: { signerBook: null, accountAuthorities: [] }, mandate: { signerBook: null, accountAuthorities: [] },
    }));
    const s = await recordingGateway();
    try {
      const r = await cli(['agent', 'enroll-status', '--facts', facts, '--json', '--require-enrolled'], s.url);
      expect(r.code).toBe(1);
      expect(r.out).toContain('enrollment_acceptance_pending');
      expect(r.out).toContain('accept_authority');
      expect(r.out).toContain('principal');
      expect(s.seen).toEqual([]);
    } finally { await s.close(); }
  }, 60000);
});

describe('the principal\'s writes (register, issue-grant, issue-mandate) sign only with an explicit --sign-with (F9)', () => {
  const PRINCIPAL = 'acc://harbor-mfg.acme';
  const doc = (o: unknown) => { const d = mkdtempSync(join(tmpdir(), 'certen-doc-')); const f = join(d, 'doc.json'); writeFileSync(f, JSON.stringify(o)); return f; };
  const mandate = { schema: 'certen.mandate/v1', mandateId: 'md-1', version: 1, priorHash: null, principal: { adi: PRINCIPAL, keyBook: `${PRINCIPAL}/book` }, agent: { adi: AGENT } };
  for (const cmd of ['register', 'issue-grant', 'issue-mandate']) {
    for (const extra of [[], ['--json'], ['--yes'], ['--json', '--yes']]) {
      it(`${cmd} without --sign-with, ${extra.join(' ') || 'plain'}: exit 2, SIGN_WITH_REQUIRED, nothing read, no request (a context key in the environment is set)`, async () => {
        const s = await recordingGateway();
        try {
          const r = await cli(['agent', cmd, '--identity', PRINCIPAL, '--document', join(tmpdir(), 'does-not-exist.json'), ...extra], s.url);
          expect(r.code).toBe(2);
          expect(r.out).toContain('SIGN_WITH_REQUIRED');
          expect(r.out).not.toContain('PRINCIPAL_DOCUMENT_UNREADABLE');
          expect(s.seen).toEqual([]);
        } finally { await s.close(); }
      }, 60000);
    }
  }
  it('an unreadable document, and a mandate that names another principal book, are refused before any key or request', async () => {
    const s = await recordingGateway();
    try {
      const a = await cli(['agent', 'issue-mandate', '--identity', PRINCIPAL, '--document', join(tmpdir(), 'does-not-exist.json'), '--sign-with', 'k', '--json'], s.url);
      expect([a.code, a.out.includes('PRINCIPAL_DOCUMENT_UNREADABLE')]).toEqual([2, true]);
      const b = await cli(['agent', 'issue-mandate', '--identity', PRINCIPAL, '--document', doc({ ...mandate, principal: { adi: PRINCIPAL, keyBook: `${PRINCIPAL}/clerks` } }), '--sign-with', 'k', '--json'], s.url);
      expect([b.code, b.out.includes('PRINCIPAL_ENTRY_NOT_PRINCIPALS')]).toEqual([2, true]);
      expect(s.seen).toEqual([]);
    } finally { await s.close(); }
  }, 60000);
});

describe('AGT-F25: a document the core refuses is refused by the CLI before any key or request', () => {
  it('issue-mandate with a mandate the core\'s shape check refuses: exit 2, PRINCIPAL_ENTRY_REFUSED_BY_CORE, no request', async () => {
    const PRINCIPAL = 'acc://harbor-mfg.acme';
    const d = mkdtempSync(join(tmpdir(), 'certen-doc-'));
    const f = join(d, 'mandate.json');
    writeFileSync(f, JSON.stringify({ schema: 'certen.mandate/v1', mandateId: 'md-1', version: 1, priorHash: null, principal: { adi: PRINCIPAL, keyBook: `${PRINCIPAL}/book` }, agent: { adi: AGENT } }));
    const s = await recordingGateway();
    try {
      const r = await cli(['agent', 'issue-mandate', '--identity', PRINCIPAL, '--document', f, '--sign-with', 'k', '--json'], s.url);
      expect([r.code, r.out.includes('PRINCIPAL_ENTRY_REFUSED_BY_CORE')]).toEqual([2, true]);
      expect(s.seen).toEqual([]);
    } finally { await s.close(); }
  }, 60000);
});
