#!/usr/bin/env node
/**
 * The basefinal mutation gate: runs every mutant of mutants.json (comparison, condition, boundary and guard flips over
 * src/proof-v2/finality/basefinal/*.ts and the ProofDb lines of s6/mpt.ts) against the basefinal tests, in parallel, and reports KILLED / SURVIVED / NOFIND per mutant.
 * A mutant is applied in memory by vitest.mutation.config.ts (no file on disk changes). Usage, from packages/verify:
 *     node tools/mutation-basefinal/run.mjs [--jobs 4] [--only <substring of id or note>] [--ids 3,7,12] [--out result.json]
 * Every survivor must be killed by a new test or listed with its reason in test/finality/basefinal/mutation_equivalents.json.
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

const U = 'test/finality/basefinal/';
const tier = opt('--tier', '1');
const LIVE = [0, 1, 2, 3].map((i) => `${U}vectors_shard${i}.test.ts`).join(',');
const JV = `${U}vectors_judge0.test.ts,${U}vectors_judge1.test.ts`;
/** tier 1: the fast tests that judge each source file; tier 2 adds the live vectors (23 full containers, about 25 s) for the survivors */
const SURV = `${U}units_survivors.test.ts`;
const X = `${U}vectors_x.test.ts`;
/** pass 1 ran units_survivors/vectors_x only for what existed then; the current map is the whole fast set */
const TESTS = {
  'proof-v2/finality/basefinal/wire.ts': `${U}units_wire.test.ts,${U}units_kind.test.ts,${SURV}`,
  'proof-v2/finality/basefinal/pins.ts': `${U}units_pins.test.ts,${JV},${U}units_judge.test.ts,${SURV},${X}`,
  'proof-v2/finality/basefinal/verify.ts': `${JV},${U}units_judge.test.ts,${U}units_wire.test.ts,${U}units_pins.test.ts,${U}units_kind.test.ts,${SURV},${X}`,
  's6/mpt.ts': `${U}units_kind.test.ts,${JV}`,
};
if (tier === '2') for (const k of Object.keys(TESTS)) TESTS[k] += `,${LIVE}`;
const mutants = JSON.parse(readFileSync(join(here, 'mutants.json'), 'utf8')).mutants.map((m, i) => ({ id: i + 1, ...m }));
const todo = mutants.filter((m) => (!ids || ids.has(m.id)) && (!only || `${m.id} ${m.file} ${m.note}`.includes(only)));

function run(m) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env, MUTATION_TESTS: TESTS[m.file], MUTANT: JSON.stringify({ file: m.file, offset: m.offset, find: m.find, replace: m.replace }) };
    const p = spawn(process.execPath, [join(root, '..', '..', 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'tools/mutation-basefinal/vitest.mutation.config.ts', '--bail=1', '--maxWorkers=3', '--reporter=dot'], {
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
