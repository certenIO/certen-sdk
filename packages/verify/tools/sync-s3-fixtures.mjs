#!/usr/bin/env node
/**
 * Copies the Go-written evidence 2.1 conformance vectors (validator pkg/proof/v2/testdata/xpartition*, and the govRoot v4 golden) into
 * test/fixtures/s3 BYTE FOR BYTE and writes test/fixtures/s3/MANIFEST.json, which pins every file by sha256.
 *
 *   node tools/sync-s3-fixtures.mjs <validator-checkout> <commit>
 *
 * The bytes are read with `git show <commit>:<path>`, never from the working tree, so a checkout with core.autocrlf cannot change
 * them. Each Go suite carries its own MANIFEST.sha256 (the hash of its manifest.json); this tool refuses to copy a suite whose
 * manifest does not hash to it. Vectors are never edited: a verdict the TypeScript verifier disagrees with is a defect in one of the
 * two verifiers, never a vector to change.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , checkout, commit] = process.argv;
if (!checkout || !commit) {
  console.error('usage: node tools/sync-s3-fixtures.mjs <validator-checkout> <commit>');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, '..', 'test', 'fixtures', 's3');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { maxBuffer: 1 << 28 });

const GITATTRIBUTES = "# The vectors are the Go validator's files byte for byte (their hashes are pinned in MANIFEST.json); no line-ending conversion may touch them.\n* -text\n";
const SUITES = ['xpartition', 'xpartition2', 'xpartition2b', 'xpartition3', 'xpartition3b', 'xpartition4', 'xpartition5'];
const GOLDENS = [{ from: 'pkg/intentcert/testdata/govroot_v4/cross_partition_golden.json', to: 'govroot_v4/cross_partition_golden.json' }];

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, '.gitattributes'), GITATTRIBUTES);
const out = { format: 'certen:s3-vectors-manifest:v1', validatorCommit: git('rev-parse', commit).toString('utf8').trim(), suites: [], goldens: [] };

for (const s of SUITES) {
  const base = `pkg/proof/v2/testdata/${s}`;
  const names = git('ls-tree', '-r', '--name-only', commit, base).toString('utf8').split('\n').filter(Boolean);
  const files = [];
  for (const n of names) {
    const rel = n.slice(base.length + 1);
    const bytes = git('show', `${commit}:${n}`);
    const path = join(dest, s, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    files.push({ name: rel, sha256: sha(bytes), bytes: bytes.length });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  const suite = { name: s, files };
  const mf = files.find((f) => f.name === 'manifest.json');
  const mh = files.find((f) => f.name === 'MANIFEST.sha256');
  if (mf && mh) {
    const stated = git('show', `${commit}:${base}/MANIFEST.sha256`).toString('utf8');
    if (!stated.startsWith(`${mf.sha256}  manifest.json`)) {
      console.error(`${s}: MANIFEST.sha256 does not state the hash ${mf.sha256} of manifest.json`);
      process.exit(1);
    }
    suite.manifestSha256 = mf.sha256;
  }
  out.suites.push(suite);
}
for (const g of GOLDENS) {
  const bytes = git('show', `${commit}:${g.from}`);
  const path = join(dest, g.to);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  out.goldens.push({ name: g.to, from: g.from, sha256: sha(bytes), bytes: bytes.length });
}

const h = createHash('sha256');
for (const s of out.suites) for (const f of s.files) h.update(`${s.name}/${f.name}:${f.sha256}\n`);
for (const g of out.goldens) h.update(`${g.name}:${g.sha256}\n`);
out.manifestHash = h.digest('hex');
writeFileSync(join(dest, 'MANIFEST.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`copied ${out.suites.reduce((n, s) => n + s.files.length, 0)} files in ${out.suites.length} suites and ${out.goldens.length} golden(s); manifest hash ${out.manifestHash}`);
