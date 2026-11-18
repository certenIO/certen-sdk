#!/usr/bin/env node
/**
 * Copy the CERTEN core document profiles into packages/sdk/src/core (transaction-controls packages/core/src) and the mandate shape into
 * packages/sdk/src/agent (transaction-controls packages/agent/src/mandate.ts), byte for byte, and keep them honest (MOD-03: consume by a
 * byte-for-byte copy with a drift check, never retype or fork; the same rule and pin shape as certen-approval-console scripts/sync-agent.mjs).
 *
 * The agent file imports the core only through './core.js'. That file is NOT copied: src/agent/core.ts is this package's own shim onto its
 * copy of the core (src/core), unpinned. Every other file is the canonical bytes; PIN.json names the source repo, branch, commit and the
 * sha256 of every copied file.
 *
 * Usage (the canonical repo is read with `git show`, never written):
 *   CERTEN_TCL_REPO=<a transaction-controls checkout or worktree> node scripts/sync-core.mjs --commit <sha> [--branch <name>]
 *   node scripts/sync-core.mjs --check
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG = resolve(HERE, '..');
export const PIN_FILE = join(PKG, 'src', 'core', 'PIN.json');
/** published path in this package -> source path in transaction-controls */
export const FILES = {
  'src/core/bytes.ts': 'packages/core/src/bytes.ts',
  'src/core/jcs.ts': 'packages/core/src/jcs.ts',
  'src/core/grant-profile.ts': 'packages/core/src/grant-profile.ts',
  'src/core/registry-profile.ts': 'packages/core/src/registry-profile.ts',
  'src/core/hashes.ts': 'packages/core/src/hashes.ts',
  'src/agent/mandate.ts': 'packages/agent/src/mandate.ts',
};

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** null when every copy matches its pin, else the list of findings */
export function checkCopies(root = PKG) {
  const pinPath = join(root, 'src', 'core', 'PIN.json');
  if (!existsSync(pinPath)) return ['PIN.json missing'];
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  const out = [];
  for (const f of Object.keys(FILES)) {
    if (!pin.files?.[f]) { out.push(`${f} not pinned`); continue; }
    if (!existsSync(join(root, f))) { out.push(`${f} missing`); continue; }
    if (sha256(readFileSync(join(root, f))) !== pin.files[f].sha256) out.push(`${f} differs from its pin`);
  }
  for (const f of Object.keys(pin.files ?? {})) if (!(f in FILES)) out.push(`${f} pinned but not part of the copy`);
  if (!/^[0-9a-f]{40}$/.test(pin.commit ?? '')) out.push('PIN.json commit malformed');
  return out.length ? out : null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const f = checkCopies();
    if (f) { console.error(f.join('\n')); process.exit(1); }
    console.log('core copies match PIN.json');
    return;
  }
  const commit = args[args.indexOf('--commit') + 1];
  const branch = args.includes('--branch') ? args[args.indexOf('--branch') + 1] : null;
  const tcl = process.env.CERTEN_TCL_REPO;
  if (!tcl || !/^[0-9a-f]{40}$/.test(commit ?? '')) { console.error('usage: CERTEN_TCL_REPO=<repo> node scripts/sync-core.mjs --commit <40-hex sha> [--branch <name>]'); process.exit(2); }
  const files = {};
  for (const [dest, src] of Object.entries(FILES)) {
    const bytes = execFileSync('git', ['-C', tcl, 'show', `${commit}:${src}`], { maxBuffer: 1 << 26 });
    mkdirSync(dirname(join(PKG, dest)), { recursive: true });
    writeFileSync(join(PKG, dest), bytes);
    files[dest] = { source: src, sha256: sha256(bytes) };
  }
  writeFileSync(PIN_FILE, JSON.stringify({ repo: 'transaction-controls', branch, commit, files }, null, 2) + '\n');
  console.log(`copied ${Object.keys(FILES).length} files from ${commit}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
