#!/usr/bin/env node
/**
 * Copy the documentation this server serves into `bundled/`, so it survives packing.
 *
 * The docs live at the repo root (`llms.txt`) and in `docs/`, both of which are OUTSIDE this
 * package directory — and npm's `files` cannot reach outside a package root. Without this step the
 * published package installs cleanly, starts cleanly, lists its tools cleanly, and serves ZERO
 * resources, while its README promises nine. That failure is invisible in the monorepo, because
 * there the repo root is right there and every lookup succeeds.
 *
 * Runs from `prepack`, so it cannot be forgotten before a publish.
 */
import { readdirSync, mkdirSync, copyFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const OUT = join(PKG_ROOT, 'bundled');

/** Root-level files, plus every markdown file under docs/ so a new guide is picked up for free. */
const ROOT_FILES = ['llms.txt', 'llms-full.txt'];

function markdownUnder(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...markdownUnder(full));
    else if (entry.endsWith('.md')) found.push(full);
  }
  return found;
}

rmSync(OUT, { recursive: true, force: true });

const sources = [
  ...ROOT_FILES.map((f) => join(REPO_ROOT, f)),
  ...markdownUnder(join(REPO_ROOT, 'docs')),
];

let copied = 0;
const missing = [];
for (const src of sources) {
  if (!existsSync(src)) {
    missing.push(relative(REPO_ROOT, src));
    continue;
  }
  const dest = join(OUT, relative(REPO_ROOT, src));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  copied++;
}

if (missing.length > 0) {
  // llms.txt is generated — a missing one means `npm run agentgen` has not been run, and packing
  // now would ship a server whose primary resource does not exist.
  console.error(`bundle-docs: missing ${missing.join(', ')}\n  run: npm run agentgen`);
  process.exit(1);
}

console.log(`bundle-docs: copied ${copied} files into packages/mcp/bundled/`);
