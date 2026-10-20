/**
 * Vitest config of the ethl1 mutation gate. With MUTANT='{"file":"verify.ts","find":"...","replace":"..."}' in the environment, the
 * named source file under src/proof-v2/finality/ethl1 is transformed in memory (the text `find`, which must occur exactly once, is
 * replaced by `replace`); no file on disk is modified, so several mutants can run at once from one worktree. Without MUTANT the config
 * is the plain one. Used only by tools/mutation-ethl1/run.mjs.
 */
import { defineConfig } from 'vitest/config';

const spec = process.env.MUTANT ? (JSON.parse(process.env.MUTANT) as { file: string; find: string; replace: string }) : null;

export default defineConfig({
  plugins: spec
    ? [
        {
          name: 'ethl1-mutant',
          enforce: 'pre',
          transform(code: string, id: string) {
            const norm = id.split('\\').join('/');
            if (!norm.endsWith(`/src/proof-v2/finality/ethl1/${spec.file}`)) return null;
            const i = code.indexOf(spec.find);
            if (i < 0) throw new Error(`MUTANT_NOFIND: ${spec.find}`);
            if (code.indexOf(spec.find, i + 1) >= 0) throw new Error(`MUTANT_NOTUNIQUE: ${spec.find}`);
            return { code: code.slice(0, i) + spec.replace + code.slice(i + spec.find.length), map: null };
          },
        },
      ]
    : [],
  test: {
    include: ['test/finality/ethl1/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '**/timing.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
