/** Runs one shard of the finality_adiri3 vectors: vector i belongs to shard i % SHARDS. Every vector must equal the Go-written verdict. */
import { describe, expect, it } from 'vitest';
import { judge, vectors } from './vectorset.js';

export const SHARDS = 4;

export function runShard(shard: number): void {
  const all = vectors();
  describe(`finality_adiri3 shard ${shard}`, () => {
    all.forEach((v, i) => {
      if (i % SHARDS !== shard) return;
      it(`${v.name}`, () => {
        expect(judge(v)).toBe(v.expect);
      });
    });
  });
}
