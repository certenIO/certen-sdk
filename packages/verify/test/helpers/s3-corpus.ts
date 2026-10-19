import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readS3, sha256hex } from './s3.js';

/**
 * A Go-written corpus under test/fixtures/s3/go-written: the file is pinned by its sha256 (a corpus is regenerated only by the Go program,
 * test/fixtures/s3/gen/*.go.txt, and the new hash is a reviewed change), and its cases are run in chunks so a slow machine is a slow test,
 * never a failed one.
 */
export function readCorpus<T>(name: string, hash: string): T {
  const raw = readS3(name);
  expect(sha256hex(raw)).toBe(hash);
  return JSON.parse((name.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')) as T;
}

/** One `it` per chunk of `size` cases; `judge` returns the differences between Go's verdict and ours for one case (empty: they agree). */
export function defineChunks<C extends { id?: string; name?: string }>(title: string, cases: C[], judge: (c: C) => string[], size = 50): void {
  describe(title, () => {
    for (let at = 0; at < cases.length; at += size) {
      const part = cases.slice(at, at + size);
      it(`reaches Go's verdict on ${part.length} cases (${at + 1}-${at + part.length} of ${cases.length})`, () => {
        const wrong: string[] = [];
        for (const c of part) {
          const d = judge(c);
          if (d.length > 0) wrong.push(`${c.id ?? c.name}: ${d.join(' | ')}`);
        }
        expect(wrong).toEqual([]);
      });
    }
  });
}
