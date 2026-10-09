#!/usr/bin/env node
/**
 * One Node policy for the whole repository, checked rather than remembered.
 *
 *   node scripts/check-node-policy.mjs [repoRoot]
 *
 * The rules (RB7b decision D1):
 *   - `.nvmrc` pins one exact Node version, on a line that is a current LTS and not end of life.
 *   - Every package's `engines.node` is the same `>=<floor>` and the floor is an LTS line that is not end of life.
 *   - Every workflow job either reads `node-version-file: .nvmrc` or takes its version from a matrix.
 *   - A matrix covers every non-end-of-life LTS line at or above the floor and no other line.
 *   - The devcontainer image runs the `.nvmrc` major.
 *
 * Node 18 and 20 are end of life, so supporting them would mean testing the SDK on unpatched runtimes. The data lives in
 * scripts/node-lts.json so the check is offline and deterministic.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function checkNodePolicy(root = resolve(HERE, '..'), today = new Date()) {
  const problems = [];
  const data = JSON.parse(readFileSync(join(HERE, 'node-lts.json'), 'utf8'));
  const day = today.toISOString().slice(0, 10);
  const supported = Object.entries(data.lines)
    .filter(([, l]) => l.ltsFrom <= data.asOf && l.end >= day)
    .map(([major]) => Number(major))
    .sort((a, b) => a - b);

  const nvmrcPath = join(root, '.nvmrc');
  let nvmMajor = null;
  if (!existsSync(nvmrcPath)) problems.push('.nvmrc is missing');
  else {
    const v = readFileSync(nvmrcPath, 'utf8').trim();
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m) problems.push(`.nvmrc must pin an exact version (x.y.z), found ${JSON.stringify(v)}`);
    else {
      nvmMajor = Number(m[1]);
      if (!supported.includes(nvmMajor)) problems.push(`.nvmrc ${v}: Node ${nvmMajor} is not a supported LTS line (${supported.join(', ')})`);
    }
  }

  const pkgFiles = ['package.json', ...readdirSync(join(root, 'packages')).map((d) => join('packages', d, 'package.json'))]
    .filter((f) => existsSync(join(root, f)));
  const floors = new Set();
  for (const f of pkgFiles) {
    const engines = JSON.parse(readFileSync(join(root, f), 'utf8')).engines?.node;
    const m = /^>=(\d+)$/.exec(engines ?? '');
    if (!m) problems.push(`${f}: engines.node must be ">=<major>", found ${JSON.stringify(engines)}`);
    else floors.add(Number(m[1]));
  }
  if (floors.size > 1) problems.push(`engines.node floors disagree across packages: ${[...floors].join(', ')}`);
  const floor = floors.size === 1 ? [...floors][0] : null;
  if (floor !== null && !supported.includes(floor)) problems.push(`engines floor ${floor} is not a supported LTS line (${supported.join(', ')})`);

  const wanted = floor === null ? [] : supported.filter((m) => m >= floor);
  const wfDir = join(root, '.github', 'workflows');
  for (const name of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(join(wfDir, name), 'utf8');
    const rel = `.github/workflows/${name}`;
    for (const line of text.split(/\r?\n/)) {
      const lit = /node-version:\s*(.+?)\s*(#.*)?$/.exec(line);
      if (!lit) continue;
      const val = lit[1].replace(/^["']|["']$/g, '');
      if (val !== '${{ matrix.node }}') problems.push(`${rel}: node-version must come from a matrix or .nvmrc, found ${JSON.stringify(val)}`);
    }
    for (const line of text.split(/\r?\n/)) {
      const f = /node-version-file:\s*([^\s,}]+)/.exec(line);
      if (f && f[1].replace(/^["']|["']$/g, '') !== '.nvmrc') problems.push(`${rel}: node-version-file must be .nvmrc, found ${f[1]}`);
    }
    for (const line of text.split(/\r?\n/)) {
      const mx = /^\s*node:\s*\[(.*)\]/.exec(line);
      if (!mx) continue;
      const lines = mx[1].split(',').map((s) => Number(s.trim().replace(/^["']|["']$/g, ''))).sort((a, b) => a - b);
      if (lines.join() !== wanted.join()) problems.push(`${rel}: matrix [${lines.join(', ')}] must be exactly the supported LTS lines >= ${floor}: [${wanted.join(', ')}]`);
    }
    if (!/node-version/.test(text) && /setup-node/.test(text)) problems.push(`${rel}: setup-node without a node-version`);
  }

  const dc = join(root, '.devcontainer', 'devcontainer.json');
  if (existsSync(dc) && nvmMajor !== null) {
    const img = /"image":\s*"[^"]*typescript-node:(?:\d+-)?(\d+)-/.exec(readFileSync(dc, 'utf8'));
    if (!img) problems.push('.devcontainer/devcontainer.json: image does not name a Node major');
    else if (Number(img[1]) !== nvmMajor) problems.push(`.devcontainer image runs Node ${img[1]} but .nvmrc is ${nvmMajor}`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkNodePolicy(process.argv[2] ? resolve(process.argv[2]) : undefined);
  if (problems.length) {
    console.error('node policy violations:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
  console.log('node policy: ok');
}
