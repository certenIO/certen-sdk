#!/usr/bin/env node
/**
 * Every internal @certen.io/* dependency must resolve to the workspace, never to a registry copy.
 *
 *   node scripts/check-workspace-pins.mjs [repoRoot]
 *
 * Two defects have the same shape. `packages/mcp` declared `@certen.io/sdk: ^0.7.0`; under 0.x caret rules that excludes the
 * workspace's 0.9.0, so npm installed registry 0.7.1 into `packages/mcp/node_modules` and the MCP tests ran against a
 * three-minor-old SDK while CI stayed green. This check fails when:
 *   - a declared range does not accept the workspace's own version, or
 *   - any node_modules/@certen.io/<workspace package> is a real directory instead of a link to packages/<name>.
 */
import { readFileSync, readdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** `1.2.3`, `^1.2.3` and `~1.2.3` only: a range any looser than that is itself a finding. */
export function accepts(range, version) {
  const m = /^([\^~]?)(\d+\.\d+\.\d+)$/.exec(range);
  const low = m && parse(m[2]);
  const v = parse(version);
  if (!low || !v) return false;
  if (m[1] === '') return cmp(low, v) === 0;
  let upper;
  if (m[1] === '~') upper = [low[0], low[1] + 1, 0];
  else if (low[0] > 0) upper = [low[0] + 1, 0, 0];
  else if (low[1] > 0) upper = [0, low[1] + 1, 0];
  else upper = [0, 0, low[2] + 1];
  return cmp(v, low) >= 0 && cmp(v, upper) < 0;
}

export function checkWorkspacePins(root = resolve(HERE, '..')) {
  const problems = [];
  const pkgsDir = join(root, 'packages');
  const workspace = new Map(); // name -> { dir, version }
  for (const d of readdirSync(pkgsDir)) {
    const f = join(pkgsDir, d, 'package.json');
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    workspace.set(j.name, { dir: join(pkgsDir, d), version: j.version });
  }
  for (const [name, { dir }] of workspace) {
    const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const field of DEP_FIELDS) {
      for (const [dep, range] of Object.entries(j[field] ?? {})) {
        const target = workspace.get(dep);
        if (target && !accepts(range, target.version)) {
          problems.push(`${name} ${field}.${dep} is "${range}" but the workspace is ${target.version}; npm would install a registry copy`);
        }
      }
    }
  }
  const holders = [root, ...[...workspace.values()].map((w) => w.dir)];
  for (const h of holders) {
    const scope = join(h, 'node_modules', '@certen.io');
    if (!existsSync(scope)) continue;
    for (const entry of readdirSync(scope)) {
      const name = `@certen.io/${entry}`;
      const target = workspace.get(name);
      if (!target) continue;
      const p = join(scope, entry);
      const linked = lstatSync(p).isSymbolicLink() && realpathSync(p) === realpathSync(target.dir);
      if (!linked) problems.push(`${p.slice(root.length + 1)} is a nested registry copy of a workspace package, not a link to ${target.dir.slice(root.length + 1)}`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkWorkspacePins(process.argv[2] ? resolve(process.argv[2]) : undefined);
  if (problems.length) {
    console.error('workspace pin violations:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
  console.log('workspace pins: ok');
}
