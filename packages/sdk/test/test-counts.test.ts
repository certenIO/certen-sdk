import { describe, it, expect } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { countsFromReport, describeCounts, applyCounts } = (await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'test-counts.mjs')).href)) as {
  countsFromReport: (r: unknown) => { files: number; tests: number; skipped: number; failed: number; perPackage: Record<string, number> };
  describeCounts: (c: ReturnType<typeof countsFromReport>) => string;
  applyCounts: (text: string, line: string) => { text: string; spans: number };
};

const report = {
  testResults: [
    { name: 'C:\\repo\\packages\\sdk\\test\\a.test.ts', assertionResults: [{ status: 'passed' }, { status: 'passed' }] },
    { name: '/repo/packages/cli/test/b.test.ts', assertionResults: [{ status: 'passed' }, { status: 'skipped' }, { status: 'failed' }] },
    { name: '/repo/packages/verify/test/c.test.ts', assertionResults: [{ status: 'passed' }] },
  ],
};

describe('test counts quoted in the docs are measured from vitest\'s report', () => {
  it('counts files, tests, skips and failures, per package, on either path style', () => {
    const c = countsFromReport(report);
    expect(c).toMatchObject({ files: 3, tests: 6, skipped: 1, failed: 1 });
    expect(c.perPackage).toEqual({ sdk: 2, cli: 3, mcp: 0, verify: 1 });
    expect(describeCounts(c)).toBe('6 tests in 3 files (sdk 2, cli 3, mcp 0, verify 1), 1 skipped');
  });

  it('rewrites every marked span and leaves the rest of the text alone', () => {
    const doc = 'a <!-- test-counts:start -->old<!-- test-counts:end --> b\n| x | <!-- test-counts:start -->older<!-- test-counts:end --> |';
    const { text, spans } = applyCounts(doc, 'NEW');
    expect(spans).toBe(2);
    expect(text).toBe('a <!-- test-counts:start -->NEW<!-- test-counts:end --> b\n| x | <!-- test-counts:start -->NEW<!-- test-counts:end --> |');
  });

  it('reports zero spans for a doc that has none, so a deleted marker cannot pass silently', () => {
    expect(applyCounts('no markers here', 'NEW').spans).toBe(0);
  });
});
