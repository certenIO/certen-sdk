import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { defaultLimits, type Limits } from '../../src/proof-v2/finality/codec.js';
import { hexLower } from '../../src/proof-v2/finality/state.js';

const here = dirname(fileURLToPath(import.meta.url));

/** test/fixtures/finality: the validator's vector sets, copied byte for byte (their manifests are pinned in vectors.test.ts). */
export const FIXTURES = join(here, '..', 'fixtures', 'finality');

export const readFixture = (...parts: string[]): Buffer => readFileSync(join(FIXTURES, ...parts));
export const fixtureJSON = <T = any>(...parts: string[]): T => JSON.parse(readFixture(...parts).toString('utf8')) as T;
export const sha256Hex = (b: Uint8Array): string => hexLower(sha256(b));

export const hexToBytes = (s: string): Uint8Array => {
  if (!/^([0-9a-f]{2})*$/.test(s)) throw new Error(`not lower-case hex: ${s}`);
  return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
};

export const fill = (b: number, n = 32): Uint8Array => new Uint8Array(n).fill(b);

/** The `limits` object of a container or probe vector: only these four keys exist (codec_test.go limitsFrom). */
export function limitsFrom(m: Record<string, number> | undefined): Limits {
  const l = defaultLimits();
  for (const [k, v] of Object.entries(m ?? {})) {
    switch (k) {
      case 'max_evidence_bytes':
        l.maxEvidenceBytes = v;
        break;
      case 'max_string_bytes':
        l.maxStringBytes = v;
        break;
      case 'max_nodes':
        l.maxNodes = v;
        break;
      case 'max_node_bytes':
        l.maxNodeBytes = v;
        break;
      default:
        throw new Error(`unknown limit ${k} in a vector`);
    }
  }
  return l;
}
