/**
 * Vitest config of the Go/TS cross-check generator (gen.xcheck.ts is NOT part of the default suite: it needs XCHECK_DIR and a Go run).
 * From packages/verify:  XCHECK_DIR=<dir> npx vitest run --config tools/xcheck-basefinal/vitest.config.ts
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tools/xcheck-basefinal/gen.xcheck.ts'],
    environment: 'node',
    testTimeout: 900_000,
  },
});
