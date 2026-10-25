import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { legBindingOf, newAddendum, type Addendum } from '../../src/proof-v2/finality/addendum.js';
import { defaultLimits, encodeContainer, type Limits } from '../../src/proof-v2/finality/codec.js';
import type { BlockRef } from '../../src/proof-v2/finality/evidence.js';
import { Level } from '../../src/proof-v2/finality/level.js';
import { FinalityStateError, hexLower } from '../../src/proof-v2/finality/state.js';
import { ChainBaseSepolia } from '../../src/proof-v2/finality/table.js';

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

export const testBase = (): BlockRef => ({ chain: ChainBaseSepolia, number: 47368146n, hash: fill(0x33) });
export const testProofId = Uint8Array.of(1, 2, 3, 4, 5, 6, 0x47, 8, 0x89, 10, 11, 12, 13, 14, 15, 16);
export const kBaseL1 = 'base-sepolia/l1_posted/v1';
export const kBaseFin = 'base-sepolia/finalized/v1';

export function containerFor(kind: string, b: BlockRef, level: Level, body: string): Uint8Array {
  return encodeContainer({
    header: { kind, chain: b.chain, level, blockNumber: b.number, blockHash: b.hash },
    body: new TextEncoder().encode(body),
  });
}

/** A valid chain for leg b through newAddendum, in the given level order. */
export function buildChain(b: BlockRef, ...levels: Level[]): Addendum[] {
  const kinds: Record<number, string> = { [Level.L1Posted]: kBaseL1, [Level.Finalized]: kBaseFin };
  const chain: Addendum[] = [];
  for (const l of levels) chain.push(newAddendum(legBindingOf(b), testProofId, chain, b.chain, l, kinds[l]!, containerFor(kinds[l]!, b, l, 'body')));
  return chain;
}

/** One RLP list of short strings (test helper). */
export function rlpList(items: Uint8Array[]): Uint8Array {
  const body: number[] = [];
  for (const it of items) {
    if (it.length === 1 && it[0]! < 0x80) body.push(it[0]!);
    else if (it.length <= 55) body.push(0x80 + it.length, ...it);
    else throw new Error('test items are short');
  }
  return body.length <= 55 ? Uint8Array.of(0xc0 + body.length, ...body) : Uint8Array.of(0xf8, body.length, ...body);
}


/** The named state f throws (anything else, or no throw, fails the test). */
export const stateOf = (f: () => unknown): FinalityStateError => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('did not throw');
};
