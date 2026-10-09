#!/usr/bin/env node
/**
 * The test counts quoted in README.md and AGENTS.md are measured, not typed.
 *
 *   node scripts/test-counts.mjs           # run the suite once, fail if a quoted count is out of date
 *   node scripts/test-counts.mjs --write   # run the suite once and rewrite the quoted counts
 *
 * Prose cannot notice that the code moved: the README said "SDK 119, CLI 55, MCP 37" while the suite held 870 tests. Each quoted span sits
 * between <!-- test-counts:start --> and <!-- test-counts:end --> and is replaced with the line this script derives from vitest's own
 * JSON report. A skipped test shows in the line, so a suite that quietly stops running part of itself cannot hide in it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['README.md', 'AGENTS.md'];
const START = '<!-- test-counts:start -->';
const END = '<!-- test-counts:end -->';
const PACKAGES = ['sdk', 'cli', 'mcp', 'verify'];

/** vitest --reporter=json output -> { files, tests, skipped, failed, perPackage }. */
export function countsFromReport(report) {
  const perPackage = Object.fromEntries(PACKAGES.map((p) => [p, 0]));
  let files = 0, tests = 0, skipped = 0, failed = 0;
  for (const file of report.testResults ?? []) {
    files++;
    const m = /[\\/]packages[\\/]([^\\/]+)[\\/]/.exec(file.name);
    for (const t of file.assertionResults ?? []) {
      tests++;
      if (m && m[1] in perPackage) perPackage[m[1]]++;
      if (t.status === 'skipped' || t.status === 'pending' || t.status === 'todo') skipped++;
      if (t.status === 'failed') failed++;
    }
  }
  return { files, tests, skipped, failed, perPackage };
}

export const describeCounts = (c) =>
  `${c.tests} tests in ${c.files} files (${PACKAGES.map((p) => `${p} ${c.perPackage[p]}`).join(', ')}), ${c.skipped} skipped`;

/** Replace every marked span in `text`; returns the new text and how many spans were found. */
export function applyCounts(text, line) {
  let spans = 0;
  const out = text.replace(new RegExp(`${START}[\\s\\S]*?${END}`, 'g'), () => { spans++; return `${START}${line}${END}`; });
  return { text: out, spans };
}

function runSuite() {
  const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitest)) throw new Error(`cannot find vitest at ${vitest} — run npm ci at the repo root`);
  const dir = mkdtempSync(join(tmpdir(), 'test-counts-'));
  const outFile = join(dir, 'report.json');
  try {
    const res = spawnSync(process.execPath, [vitest, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${outFile}`], { cwd: ROOT, stdio: 'inherit' });
    if (!existsSync(outFile)) throw new Error('vitest wrote no JSON report');
    return { status: res.status ?? 1, report: JSON.parse(readFileSync(outFile, 'utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  const { status, report } = runSuite();
  const counts = countsFromReport(report);
  if (status !== 0 || counts.failed > 0) {
    console.error(`test-counts: the suite failed (exit ${status}, ${counts.failed} failing); counts are not checked on a red suite`);
    process.exit(status || 1);
  }
  const line = describeCounts(counts);
  let stale = 0;
  for (const doc of DOCS) {
    const file = join(ROOT, doc);
    const before = readFileSync(file, 'utf8');
    const { text, spans } = applyCounts(before, line);
    if (spans === 0) { console.error(`test-counts: ${doc} has no ${START} span`); stale++; continue; }
    if (text === before) { console.log(`  ok      ${doc}`); continue; }
    if (write) { writeFileSync(file, text); console.log(`  updated ${doc}`); }
    else { console.error(`  STALE   ${doc} — measured: ${line}`); stale++; }
  }
  if (stale > 0) {
    console.error('\ntest-counts: quoted counts are out of date. Run `npm run test:counts:write` and commit the result.');
    process.exit(1);
  }
  console.log(`test-counts: ${line}`);
}
