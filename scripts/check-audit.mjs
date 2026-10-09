#!/usr/bin/env node
/**
 * The production dependency audit as a gate, not a count.
 *
 *   node scripts/check-audit.mjs                 # runs `npm audit --omit=dev --json` (needs the registry)
 *   node scripts/check-audit.mjs --file audit.json
 *
 * Every advisory that reaches a production install must be named in scripts/audit-residuals.json with the package it comes
 * through, an expiry date and the upstream ask that would remove it. This is not a blanket ignore:
 *   - an advisory that is not listed fails (a NEW id appearing in axios or anywhere else fails the build);
 *   - a listed advisory past its expiry fails, so a residual cannot be forgotten;
 *   - a listed advisory the audit no longer reports fails, so the list shrinks when upstream fixes land.
 * Full `npm audit` (development tools included) is held to a stricter line in CI: no critical advisories.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** npm audit --json -> Map(advisory id -> { name, severity, title }). */
export function advisoriesFrom(audit) {
  const out = new Map();
  for (const v of Object.values(audit.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (via && typeof via === 'object' && via.url) out.set(String(via.url).split('/').pop(), { name: via.name, severity: via.severity, title: via.title });
    }
  }
  return out;
}

export function checkAudit(audit, residuals, today = new Date()) {
  const problems = [];
  const day = today.toISOString().slice(0, 10);
  const found = advisoriesFrom(audit);
  const listed = new Map((residuals.residuals ?? []).map((r) => [r.advisory, r]));
  for (const [id, a] of found) {
    const r = listed.get(id);
    if (!r) {
      problems.push(`${id} (${a.name}, ${a.severity}: ${a.title}) reaches a production install and is not in scripts/audit-residuals.json`);
      continue;
    }
    if (!r.expires || r.expires < day) problems.push(`${id}: the residual expired on ${r.expires ?? '(no date)'}; resolve it upstream or renew it deliberately with evidence`);
    if (!r.ask || String(r.ask).trim().length < 10) problems.push(`${id}: the residual names no upstream ask`);
  }
  for (const id of listed.keys()) {
    if (!found.has(id)) problems.push(`${id} is listed as a residual but the audit no longer reports it; remove the entry`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fileArg = process.argv.indexOf('--file');
  let raw;
  if (fileArg > 0) raw = readFileSync(process.argv[fileArg + 1], 'utf8');
  else {
    // Run npm's own CLI script with this node when npm started us (no shell, no escaping question); otherwise one fixed command string.
    const npmCli = process.env.npm_execpath;
    const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
    const res = npmCli && /\.c?js$/.test(npmCli)
      ? spawnSync(process.execPath, [npmCli, 'audit', '--omit=dev', '--json'], opts)
      : spawnSync('npm audit --omit=dev --json', { ...opts, shell: true });
    raw = res.stdout;
  }
  let audit;
  try { audit = JSON.parse(raw); } catch { console.error('audit gate: npm audit returned no JSON (registry unreachable?)'); process.exit(2); }
  if (audit.error) { console.error(`audit gate: npm audit failed: ${audit.error.summary ?? audit.error.code}`); process.exit(2); }
  const problems = checkAudit(audit, JSON.parse(readFileSync(join(HERE, 'audit-residuals.json'), 'utf8')));
  if (problems.length) {
    console.error('production audit gate violations:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(`audit gate: ok (${advisoriesFrom(audit).size} named residual advisories, all within their expiry)`);
}
