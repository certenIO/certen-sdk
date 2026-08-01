#!/usr/bin/env node
/**
 * agentgen — regenerate everything derived from the vendored gateway spec.
 *
 *   node tools/agentgen/index.mjs            # write the artifacts
 *   node tools/agentgen/index.mjs --check    # fail if any artifact is out of date (CI)
 *
 * The point of `--check` is that generated context which has silently gone stale is WORSE than no
 * generated context, because an agent trusts it. If the gateway spec moves and nobody regenerates,
 * CI fails here rather than an agent confidently calling an endpoint that changed shape.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from './lib/paths.mjs';
import { loadSpec, operations, SPEC_PATH } from './lib/spec.mjs';
import { sdkMap } from './lib/sdk-map.mjs';
import { emitLlms } from './emit/llms.mjs';
import { emitLlmsFull } from './emit/llms-full.mjs';
import { buildContract, contractFixturePath } from '../../packages/sdk/scripts/build-contract-fixture.mjs';

const check = process.argv.includes('--check');

if (!existsSync(SPEC_PATH)) {
  console.error(`agentgen: no vendored spec at ${SPEC_PATH}\n  run: npm run spec:refresh`);
  process.exit(2);
}

const spec = loadSpec();
const ops = operations(spec);
const map = sdkMap(spec);
const sdkVersion = JSON.parse(
  readFileSync(join(REPO_ROOT, 'packages', 'sdk', 'package.json'), 'utf8'),
).version;

// Every endpoint the SDK calls must exist in the spec. If one does not, either the SDK is calling a
// route the gateway removed, or the vendored spec is stale — both are drift, and both are worth a
// hard failure rather than a silently thin doc.
const known = new Set(ops.map((o) => o.id));
const unknown = [];
for (const r of map) {
  for (const m of r.methods) {
    for (const c of m.calls) {
      if (!known.has(c.id)) unknown.push(`certen.${r.resource}.${m.name}() -> ${c.method} ${c.path}`);
    }
  }
}
if (unknown.length > 0) {
  console.error('agentgen: SDK calls endpoints that are not in the vendored spec:');
  for (const u of unknown) console.error(`  ${u}`);
  console.error('\n  Either the SDK is wrong, or spec/openapi.json is stale (npm run spec:refresh).');
  process.exit(1);
}

const artifacts = [
  { path: join(REPO_ROOT, 'llms.txt'), content: emitLlms({ ops, map, sdkVersion }) },
  { path: join(REPO_ROOT, 'llms-full.txt'), content: emitLlmsFull({ spec, ops, map, sdkVersion }) },
  {
    path: contractFixturePath(),
    content: `${JSON.stringify(buildContract(spec), null, 2)}\n`,
  },
];

let stale = 0;
for (const a of artifacts) {
  const rel = relative(REPO_ROOT, a.path).replaceAll('\\', '/');
  const current = existsSync(a.path) ? readFileSync(a.path, 'utf8') : null;
  if (current === a.content) {
    if (!check) console.log(`  ok      ${rel}`);
    continue;
  }
  if (check) {
    console.error(`  STALE   ${rel}`);
    stale++;
  } else {
    writeFileSync(a.path, a.content, 'utf8');
    console.log(`  ${current === null ? 'created' : 'updated'} ${rel}`);
  }
}

if (check) {
  if (stale > 0) {
    console.error(
      `\nagentgen: ${stale} generated artifact(s) out of date.\n`
      + '  Run `npm run agentgen` and commit the result.',
    );
    process.exit(1);
  }
  const methodCount = map.reduce((n, r) => n + r.methods.length, 0);
  console.log(
    `agentgen: ${artifacts.length} artifacts up to date `
    + `(${ops.length} spec operations, ${methodCount} SDK methods across ${map.length} resources).`,
  );
}
