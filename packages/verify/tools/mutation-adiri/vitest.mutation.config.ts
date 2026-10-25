/**
 * Vitest config of the Adiri mutation gate. With MUTANT='{"file":"chain.ts","offset":123,"find":"===","replace":"!=="}' in the environment,
 * the named source file under src/proof-v2/finality/adiri is transformed in memory (the text at `offset` must be `find`; it is replaced by
 * `replace`); no file on disk is modified, so several mutants can run at once from one worktree. Used only by tools/mutation-adiri/run.mjs.
 */
import { defineConfig } from 'vitest/config';

const spec = process.env.MUTANT ? (JSON.parse(process.env.MUTANT) as { file: string; offset: number; find: string; replace: string }) : null;
const tests = (process.env.MUTATION_TESTS ?? 'test/finality/adiri/units_*.test.ts,test/finality/adiri/vectors_fast.test.ts').split(',');

export default defineConfig({
  plugins: spec
    ? [
        {
          name: 'adiri-mutant',
          enforce: 'pre',
          transform(code: string, id: string) {
            const norm = id.split('\\').join('/');
            if (!norm.endsWith(`/src/proof-v2/finality/adiri/${spec.file}`)) return null;
            if (code.slice(spec.offset, spec.offset + spec.find.length) !== spec.find) throw new Error(`MUTANT_NOFIND: ${spec.find} at ${spec.offset}`);
            return { code: code.slice(0, spec.offset) + spec.replace + code.slice(spec.offset + spec.find.length), map: null };
          },
        },
      ]
    : [],
  test: {
    include: tests,
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
