/**
 * Cross-repo vectors (AGT-2): the SDK's canonical text, tagged hashes, envelope digest and entry bytes equal transaction-controls'.
 * The fixtures are byte copies of the tcl files at the commit in fixtures/certen-vectors/PIN.json (sha256 of each checked here), and the
 * golden entries were produced at that commit by the tcl encoders (core encodeGrantEntry / encodeRegistrationEntry, agent
 * encodeMandateEntry). A drift on either side fails this file.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrincipalEntry, canonicalJson, entryHash, envelopeDigestHex, taggedPreimage } from '../src/index.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'certen-vectors');
const read = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const pin = read('PIN.json');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const norm = (h: string) => h.replace(/^0x/, '').toLowerCase();

describe('the fixtures are the pinned bytes', () => {
  it('every fixture matches its sha256 in PIN.json (tcl commit and source path named)', () => {
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const [f, sha] of Object.entries(pin.files as Record<string, string>)) expect(createHash('sha256').update(readFileSync(join(DIR, f))).digest('hex'), f).toBe(sha);
  });
});

describe('hash goldens (docs/core/vectors/hash-goldens.json)', () => {
  const h = read('hash-goldens.json');
  const cases: any[] = Array.isArray(h.cases) ? h.cases : Object.values(h.cases);
  const byId = (id: string) => cases.find((c) => c.id === id);
  it.each(['gh-01', 'gh-02', 'gh-03', 'gh-04'])('%s: the Grant preimage and hash', (id) => {
    const c = byId(id);
    expect(hex(taggedPreimage('certen:grant:v1', [new TextEncoder().encode(canonicalJson(c.input.object))]))).toBe(norm(c.expect.preimageHex));
    expect(norm(entryHash('grant', c.input.object))).toBe(norm(c.expect.digest));
  });
  it.each(['gh-12', 'gh-17'])('%s: the registration hash (tag by schema)', (id) => {
    const c = byId(id);
    expect(norm(entryHash('registration', c.input.object))).toBe(norm(c.expect.digest));
  });
  it('gh-13: the envelope signature digest', () => {
    const c = byId('gh-13');
    expect(envelopeDigestHex(c.input.payloadTag, c.input.payloadHash, c.input.page)).toBe(norm(c.expect.digest));
  });
});

describe('agent vectors (docs/agentic/vectors)', () => {
  it('md-01: the mandate hash', () => {
    const c = read('agent-mandate.json').cases.find((x: any) => x.id === 'md-01');
    expect(entryHash('mandate', c.input.mandate)).toBe(c.expect.mandateHash);
  });
  it('ag-00: the profile Grant (given in member order, not canonical) hashes to the Grant head the mandate vectors name', () => {
    const c = read('agent-grant.json').cases.find((x: any) => x.id === 'ag-00');
    const md = read('agent-mandate.json').cases.find((x: any) => x.id === 'md-01');
    expect(canonicalJson(JSON.parse(c.input.text))).not.toBe(c.input.text);
    expect(entryHash('grant', JSON.parse(c.input.text))).toBe(md.input.grantHead.hash);
  });
});

describe('entry bytes equal the tcl encoders (principal-entries.golden.json)', () => {
  const g = read('principal-entries.golden.json');
  it.each(g.cases.map((c: any) => [c.kind, c]))('%s: hash, digest to sign and both elements', (_k, c: any) => {
    const signer = { publicKey: g.publicKey, sign: (d: string) => { expect(d).toBe(c.digestToSign); return g.signature; } };
    const e = buildPrincipalEntry({ kind: c.kind, principal: 'acc://harbor-mfg.acme', page: g.page, document: c.document, signer });
    expect(e.hash).toBe(c.hash);
    expect(e.elements).toEqual(c.elements);
  });
});
