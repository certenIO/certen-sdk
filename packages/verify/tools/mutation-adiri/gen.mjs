#!/usr/bin/env node
/**
 * Generates mutants.json for the Adiri kind: every comparison, equality, boolean operator, boundary constant and single-line guard
 * (`if (cond) throw`) of src/proof-v2/finality/adiri/{cfa1,record,chain,sigs,kind,genesislink}.ts, as exact (offset, find, replace) edits of the
 * source text. Comments and string literals are masked first. Usage, from packages/verify: node tools/mutation-adiri/gen.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const FILES = ['cfa1.ts', 'record.ts', 'chain.ts', 'sigs.ts', 'kind.ts', 'genesislink.ts'];
const mutants = [];

for (const file of FILES) {
  const src = readFileSync(join(root, 'src', 'proof-v2', 'finality', 'adiri', file), 'utf8').split('\r').join('');
  // mask comments and strings (same length, so offsets stay valid)
  let masked = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  masked = masked.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  masked = masked.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[m.length - 1]);
  const lineOf = (off) => src.slice(0, off).split('\n').length;
  const add = (off, find, replace, note) => mutants.push({ file, offset: off, find, replace, note: `${file}:${lineOf(off)} ${note}` });
  const ops = [
    [/===/g, '!==', 'eq -> neq'],
    [/!==/g, '===', 'neq -> eq'],
    [/(?<![<=!>])<=(?!=)/g, '<', '<= -> <'],
    [/(?<![=!>])>=(?!=)/g, '>', '>= -> >'],
    [/(?<![<>=!-])<(?![<=])(?=\s)/g, '<=', '< -> <='],
    [/(?<![<>=!-])>(?![>=])(?=\s)/g, '>=', '> -> >='],
    [/&&/g, '||', '&& -> ||'],
    [/\|\|/g, '&&', '|| -> &&'],
  ];
  for (const [re, rep, note] of ops) {
    for (const m of masked.matchAll(re)) {
      const off = m.index;
      const lineStart = masked.lastIndexOf('\n', off) + 1;
      const line = masked.slice(lineStart, masked.indexOf('\n', off));
      if (/^\s*(export (type|interface)|import |type |interface )/.test(line)) continue;
      if (/:\s*(Uint8Array|number|bigint|string)\s*[<>]/.test(line)) continue;
      add(off, m[0], rep, note);
    }
  }
  // guard removal: `if (cond) throw` on one line -> if (false) throw
  for (const m of masked.matchAll(/^(\s*)if \((.*)\) throw /gm)) {
    const condStart = m.index + m[1].length + 4;
    add(condStart, src.slice(condStart, condStart + m[2].length), 'false', 'guard removed (if (false) throw)');
  }
  // boundary constants: n + 1 -> n + 0, n - 1 -> n - 0; 2 * / 3 * (the two-thirds arithmetic) swapped
  for (const m of masked.matchAll(/(?<=[+-] )1n?(?![\w.])/g)) add(m.index, m[0], m[0].endsWith('n') ? '0n' : '0', 'boundary +/- 1 -> 0');
  for (const m of masked.matchAll(/\b[23](?= \* )/g)) add(m.index, m[0], m[0] === '2' ? '3' : '2', 'two-thirds constant swapped');
}
const seen = new Set();
const out = mutants.filter((m) => {
  const k = `${m.file}:${m.offset}:${m.replace}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
writeFileSync(join(here, 'mutants.json'), JSON.stringify({ format: 'certen-adiri-ts-mutants/1', mutants: out }, null, 1));
console.log(`${out.length} mutants`);
const byFile = {};
for (const m of out) byFile[m.file] = (byFile[m.file] ?? 0) + 1;
console.log(byFile);
