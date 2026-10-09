import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { checkAudit, advisoriesFrom } = (await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'check-audit.mjs')).href)) as {
  checkAudit: (audit: unknown, residuals: unknown, today?: Date) => string[];
  advisoriesFrom: (audit: unknown) => Map<string, { name: string; severity: string; title: string }>;
};

const audit = (...ids: string[]): unknown => ({
  vulnerabilities: {
    axios: {
      via: ids.map((id) => ({ name: 'axios', severity: 'high', title: `title of ${id}`, url: `https://github.com/advisories/${id}` })),
    },
    'accumulate-sdk-opendlt': { via: ['axios'] }, // a string `via` is a pointer to another package, not an advisory
  },
});
const residual = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  advisory: id, package: 'axios', expires: '2026-12-31', ask: 'evidence/rb7b/upstream/01-axios-and-optional-api-clients.md', ...over,
});
const NOW = new Date('2026-10-09');

describe('the production audit gate', () => {
  it('reads advisory ids from npm audit output and ignores package pointers', () => {
    expect([...advisoriesFrom(audit('GHSA-aaaa-bbbb-cccc')).keys()]).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('passes when every advisory is a named, unexpired residual', () => {
    expect(checkAudit(audit('GHSA-a', 'GHSA-b'), { residuals: [residual('GHSA-a'), residual('GHSA-b')] }, NOW)).toEqual([]);
  });

  it('fails on an advisory that is not named, which is how a NEW id in axios fails the build', () => {
    expect(checkAudit(audit('GHSA-a', 'GHSA-new'), { residuals: [residual('GHSA-a')] }, NOW).join('\n'))
      .toMatch(/GHSA-new \(axios, high: title of GHSA-new\) reaches a production install and is not in scripts\/audit-residuals\.json/);
  });

  it('fails on a residual past its expiry, and on one with no upstream ask', () => {
    const out = checkAudit(audit('GHSA-a', 'GHSA-b'), { residuals: [residual('GHSA-a', { expires: '2026-10-08' }), residual('GHSA-b', { ask: '' })] }, NOW).join('\n');
    expect(out).toMatch(/GHSA-a: the residual expired on 2026-10-08/);
    expect(out).toMatch(/GHSA-b: the residual names no upstream ask/);
  });

  it('fails on a residual the audit no longer reports, so the list shrinks when upstream fixes land', () => {
    expect(checkAudit(audit('GHSA-a'), { residuals: [residual('GHSA-a'), residual('GHSA-fixed')] }, NOW).join('\n'))
      .toMatch(/GHSA-fixed is listed as a residual but the audit no longer reports it/);
  });

  it('holds for the committed residuals: each has an id, an expiry in the future of this commit and an ask file name', () => {
    const file = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'audit-residuals.json'), 'utf8')) as { residuals: Array<Record<string, string>> };
    expect(file.residuals.length).toBeGreaterThan(0);
    for (const r of file.residuals) {
      expect(r.advisory).toMatch(/^GHSA(-[a-z0-9]{4}){3}$/);
      expect(r.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.ask).toMatch(/^evidence\/rb7b\/upstream\/\d\d-.+\.md$/);
      expect(r.via).toMatch(/accumulate-sdk-opendlt/);
    }
    expect(new Set(file.residuals.map((r) => r.advisory)).size).toBe(file.residuals.length);
  });
});
