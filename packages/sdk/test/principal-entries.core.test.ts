/**
 * AGT-F25: registerAgent, issueGrant and issueMandate judge the document with the CORE's own profile functions (validateGrant,
 * validateRegistration, mandateShape), byte-pinned copies of transaction-controls (scripts/sync-core.mjs, src/core/PIN.json), BEFORE any
 * key is used or anything is sent. Every tcl vector the core marks invalid for a Grant, a registration or a mandate is refused here too,
 * read from the pinned vector copies (test/fixtures/certen-vectors). FICTIONAL parties.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CertenClient, buildPrincipalEntry, coreVerdict, issueGrant, issueMandate, registerAgent, PRINCIPAL_ENTRY_REFUSED_BY_CORE } from '../src/index.js';
import { parseJson } from '../src/core/jcs.js';
import { parseGrantTextUnhashed } from '../src/core/grant-profile.js';
// @ts-expect-error the script is plain ESM without types
import { checkCopies, FILES, PKG } from '../scripts/sync-core.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'certen-vectors');
const read = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const golden = read('principal-entries.golden.json');
const doc = (kind: string) => golden.cases.find((c: any) => c.kind === kind).document;
const PRINCIPAL = 'acc://harbor-mfg.acme';
const PAGE = `${PRINCIPAL}/book/1`;
const noSign = () => { throw new Error('a key was used'); };
const signer = { publicKey: '1f'.repeat(32), sign: noSign };

describe('the core copies are the pinned bytes', () => {
  it('every copied file matches src/core/PIN.json, which names the tcl commit; the shim src/agent/core.ts is not pinned', () => {
    expect(checkCopies()).toBeNull();
    const pin = JSON.parse(readFileSync(join(PKG, 'src', 'core', 'PIN.json'), 'utf8'));
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(pin.files).sort()).toEqual(Object.keys(FILES).sort());
    expect(Object.keys(pin.files)).not.toContain('src/agent/core.ts');
  });
  it('a changed byte in any copy is drift, named by file', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdk-core-drift-'));
    try {
      cpSync(join(PKG, 'src'), join(root, 'src'), { recursive: true });
      for (const f of Object.keys(FILES)) {
        const original = readFileSync(join(root, f));
        writeFileSync(join(root, f), Buffer.concat([original, Buffer.from(' ')]));
        expect(checkCopies(root)).toEqual([`${f} differs from its pin`]);
        writeFileSync(join(root, f), original);
      }
      expect(checkCopies(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function recordingGateway() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(500, { 'content-type': 'application/json' }).end('{}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

describe('each call: a document the core refuses is refused before any key use or request', () => {
  const cases: Array<[string, (c: CertenClient, d: unknown) => Promise<unknown>, string, (d: any) => unknown, string]> = [
    ['registerAgent', (c, d) => registerAgent(c, { principal: PRINCIPAL, page: PAGE, registration: d, signer }), 'registration', (d) => ({ ...d, status: 'sleeping' }), 'registration'],
    ['issueGrant', (c, d) => issueGrant(c, { principal: PRINCIPAL, page: PAGE, grant: d, signer }), 'grant', (d) => ({ ...d, validity: { notBefore: d.validity.notAfter, notAfter: d.validity.notBefore } }), 'grant'],
    ['issueMandate', (c, d) => issueMandate(c, { principal: PRINCIPAL, page: PAGE, mandate: d, signer }), 'mandate', (d) => ({ ...d, purpose: 'anything' }), 'mandate'],
  ];
  it.each(cases)('%s', async (_n, call, kind, spoil) => {
    const bad = spoil(doc(kind));
    expect(coreVerdict(kind as never, bad)).not.toBeNull();
    const gw = await recordingGateway();
    try {
      await expect(call(new CertenClient({ apiKey: 'ck_live_test', baseUrl: gw.url, maxRetries: 0 }), bad)).rejects.toMatchObject({ code: PRINCIPAL_ENTRY_REFUSED_BY_CORE, details: coreVerdict(kind as never, bad) });
      expect(gw.seen).toEqual([]);
    } finally { gw.close(); }
  });
});

describe('every tcl vector the core marks invalid is refused by the SDK too', () => {
  const refused = (kind: string, d: any, page: string) => {
    try {
      buildPrincipalEntry({ kind: kind as never, principal: PRINCIPAL, page, document: d, signer });
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? 'thrown';
    }
  };
  it('grant-canonical: every invalid Grant (kind grant); a text the core cannot even parse into a document never reaches the object API', () => {
    const cases = read('grant-canonical.json').cases.filter((c: any) => c.input.kind === 'grant' && c.expect.ok === false);
    expect(cases.length).toBeGreaterThan(40);
    let objects = 0;
    let texts = 0;
    for (const c of cases) {
      let parsed: unknown;
      try { parsed = parseJson(c.input.text, { integersOnly: true }); } catch { texts++; continue; } // duplicate key, number spelling, beyond 2^53: refused at the text by the core's Grant parse (parseGrantTextUnhashed)
      if (coreVerdict('grant', parsed) === null) {
        // the refusal is of the presented TEXT (e.g. gc-48: 72,019 bytes of padding around a Grant whose canonical text is in bounds);
        // the SDK writes the canonical text, which the core accepts. The core's text parse refuses the presented text by the vector's reason.
        expect(parseGrantTextUnhashed(c.input.text), c.id).toMatchObject({ ok: false, reason: c.expect.reason });
        texts++;
        continue;
      }
      objects++;
      const book = (parsed as any)?.grantor?.keyBook;
      const page = typeof book === 'string' && book.startsWith(`${PRINCIPAL}/`) ? `${book}/1` : PAGE;
      expect(refused('grant', parsed, page), c.id).not.toBeNull();
      expect(coreVerdict('grant', parsed)?.reason, c.id).toBe(c.expect.reason);
    }
    expect(objects + texts).toBe(cases.length);
    expect(objects).toBeGreaterThan(30);
  });
  it('subject-registry: every registration the core marks registration_malformed', () => {
    const cases = read('subject-registry.json').cases.filter((c: any) => c.expect.reason === 'registration_malformed');
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) for (const e of c.input.registry) {
      expect(coreVerdict('registration', e.record), c.id).not.toBeNull();
      expect(refused('registration', e.record, PAGE), c.id).not.toBeNull();
    }
  });
  it('agent-mandate: every mandate the core marks mandate_malformed', () => {
    const cases = read('agent-mandate.json').cases.filter((c: any) => c.expect.reason === 'mandate_malformed');
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(coreVerdict('mandate', c.input.mandate), c.id).toMatchObject({ reason: 'mandate_malformed' });
      expect(refused('mandate', c.input.mandate, PAGE), c.id).not.toBeNull();
    }
  });
  it('the documents the core accepts (the goldens) are not refused by the core check', () => {
    for (const c of golden.cases) expect(coreVerdict(c.kind, c.document), c.kind).toBeNull();
  });
});
