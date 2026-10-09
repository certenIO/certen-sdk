#!/usr/bin/env node
/**
 * Install-time scripts are an explicit, reviewed allow-list, not whatever the lockfile happens to contain.
 *
 *   node scripts/check-install-scripts.mjs [repoRoot]
 *
 * Every package in package-lock.json that declares an install script (`hasInstallScript`) must be named in
 * scripts/install-scripts.allow.json with the reason it runs, and must be development-only in the lockfile, so no install script
 * reaches a consumer who installs @certen.io/* packages. A new script-bearing dependency, a stale entry, or one that has moved
 * into the production tree fails here. The check reads the lockfile, so it behaves the same on every npm version (npm 10, which
 * Node 22 ships, only warns about npm 11's `allowScripts` settings).
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function checkInstallScripts(root = resolve(HERE, '..'), allowFile = join(HERE, 'install-scripts.allow.json')) {
  const problems = [];
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const allow = JSON.parse(readFileSync(allowFile, 'utf8')).allowed ?? [];
  const named = new Map(allow.map((a) => [a.package, a]));

  const found = new Map();
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!meta.hasInstallScript) continue;
    const name = path.split('node_modules/').pop();
    found.set(name, { version: meta.version, devOnly: meta.dev === true || meta.devOptional === true });
  }

  for (const [name, f] of found) {
    const entry = named.get(name);
    if (!entry) problems.push(`${name}@${f.version} has an install script and is not in scripts/install-scripts.allow.json`);
    else if (!entry.reason || String(entry.reason).trim().length < 20) problems.push(`${name}: the allow-list entry needs a reason`);
    if (!f.devOnly) problems.push(`${name}@${f.version} has an install script and is in the production dependency tree`);
  }
  for (const name of named.keys()) {
    if (!found.has(name)) problems.push(`${name} is allow-listed but no longer in the lockfile with an install script; remove the entry`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkInstallScripts(process.argv[2] ? resolve(process.argv[2]) : undefined);
  if (problems.length) {
    console.error('install-script policy violations:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
  console.log('install scripts: ok');
}
