#!/usr/bin/env node
/**
 * The ethl1 mutation gate: runs every mutant of mutants.json (hand-written comparison, condition, boundary, guard and field-swap flips
 * over src/proof-v2/finality/ethl1/*.ts) against the ethl1 tests, in parallel, and reports KILLED / SURVIVED / NOFIND per mutant.
 * A mutant is applied in memory by vitest.mutation.config.ts (no file on disk changes). Usage, from packages/verify:
 *     node tools/mutation-ethl1/run.mjs [--jobs 4] [--only <substring of id or note>] [--ids 3,7,12] [--out result.json]
 * Every survivor must be killed by a new test or listed with its reason in test/finality/ethl1/mutation_equivalents.json.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const jobs = Number(opt('--jobs', '4'));
const only = opt('--only', '');
const out = opt('--out', '');
const ids = opt('--ids', '') ? new Set(opt('--ids', '').split(',').map(Number)) : null;
const timeoutMs = Number(opt('--timeout', '240000'));

const mutants = JSON.parse(readFileSync(join(here, 'mutants.json'), 'utf8')).mutants.map((m, i) => ({ id: i + 1, ...m }));
const todo = mutants.filter((m) => (!ids || ids.has(m.id)) && (!only || `${m.id} ${m.file} ${m.note}`.includes(only)));

function run(m) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env, ETHL1_SHARED_KEYS: '1', MUTANT: JSON.stringify({ file: m.file, find: m.find, replace: m.replace }) };
    const p = spawn(process.execPath, [join(root, '..', '..', 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'tools/mutation-ethl1/vitest.mutation.config.ts', '--bail=1', '--maxWorkers=3', '--reporter=dot'], {
      cwd: root,
      env,
    });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stderr.on('data', (d) => (buf += d));
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      let status;
      if (/MUTANT_NOFIND|MUTANT_NOTUNIQUE/.test(buf)) status = 'NOFIND';
      else if (code === 0) status = 'SURVIVED';
      else status = 'KILLED';
      resolve({ ...m, status, ms: Date.now() - t0, killer: status === 'KILLED' ? (/FAIL\s+(\S+)/.exec(buf)?.[1] ?? 'timeout') : '' });
    });
  });
}

const results = [];
let next = 0;
async function worker() {
  while (next < todo.length) {
    const m = todo[next++];
    const r = await run(m);
    results.push(r);
    console.log(`${String(r.id).padStart(3)} ${r.status.padEnd(8)} ${String(r.ms).padStart(6)} ms  ${r.file}: ${r.note}${r.killer ? `   <- ${r.killer}` : ''}`);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\nmutants ${results.length}: killed ${count('KILLED')}, survived ${count('SURVIVED')}, nofind ${count('NOFIND')}`);
for (const r of results.filter((r) => r.status !== 'KILLED').sort((a, b) => a.id - b.id)) console.log(`  ${r.status} #${r.id} ${r.file}: ${r.note}`);
if (out) writeFileSync(out, JSON.stringify(results.sort((a, b) => a.id - b.id), null, 1));
process.exit(count('SURVIVED') + count('NOFIND') === 0 ? 0 : 1);
