// Locations and pinned hashes of the byte-identical S8 fixtures (copies of the validator's pkg/contractidentity/testdata/contractidentity).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES = join(__dirname, '..', 'fixtures', 'identity');
export const VECTORS = join(FIXTURES, 'vectors');

// The sha256 of the copied PINS.json and of the index vectors/MANIFEST.json.
export const PINS_SHA256 = '01aa9e889c8b3a137570a7891132bc5b4f93f956b2065c099da653e104e1cfeb';
export const INDEX_MANIFEST_SHA256 = '54716b1ceb2baac38b6bddd320a7e37bc921c167af39b1740843d4881b351842';
export const STATES_SHA256 = '4bd8f8db09c7a55cdcf1c47162dbd46357265f296aea60a0e97aa48c0958f909';
export const VOCAB_SHA256 = '754e486a2c7b41be9743f3e7b70ccfa618a1b7de39654af217ddfa9ee182766c';
export const SET_NAMES = ['s8_2a_1', 's8_2a_2', 's8_2b1_1', 's8_2b2_1', 's8_2c_1', 's8_2c_2', 's8_2c_3', 's8_int_1', 's8_int_2', 's8_int_3'];

/** The files of a published set, by name (bytes). */
export function setFiles(name: string): Map<string, Uint8Array> {
  const dir = join(VECTORS, name);
  return new Map(readdirSync(dir).map((f) => [f, new Uint8Array(readFileSync(join(dir, f)))] as const));
}

/** The vector ids of a set: one per `<id>.expected.json`, in file-name order. */
export const vectorIds = (files: ReadonlyMap<string, Uint8Array>): string[] =>
  [...files.keys()].filter((f) => f.endsWith('.expected.json')).map((f) => f.slice(0, -'.expected.json'.length)).sort();
