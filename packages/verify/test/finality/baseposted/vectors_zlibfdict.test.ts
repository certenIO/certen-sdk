/**
 * The Go-judged zlib channels of test/fixtures/finality/base_zlib_fdict1 (README there): the validator's baseposted decompress at cbb6373 recorded
 * its answer for each channel and cap, and the TypeScript channel reader must answer identically (ok with the same output length and sha256 prefix,
 * or refused). RB12-TS-FIX-POSTED, audit defect D2.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ChannelError, decompress } from '../../../src/proof-v2/finality/baseposted/channel.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'finality', 'base_zlib_fdict1');
const raw = readFileSync(join(dir, 'vectors.json'));
/** the SHA-256 of vectors.json as written by the Go generator (GENERATOR.go.txt) against the validator at cbb6373 */
const VECTORS_SHA256 = '132734bd333f83912286356fe17782f4cbbb20965597018cc4d91db357de255f';
interface Vec {
  id: string;
  class: string;
  channel: string;
  cap: string;
  go: string;
}
const vectors = JSON.parse(raw.toString('utf8')) as Vec[];

function tsAnswer(v: Vec): string {
  try {
    const out = decompress(Uint8Array.from(Buffer.from(v.channel, 'hex')), BigInt(v.cap));
    return `ok:${out.length}:${createHash('sha256').update(out).digest('hex').slice(0, 16)}`;
  } catch (e) {
    if (e instanceof ChannelError) return 'err';
    throw e;
  }
}

describe('base_zlib_fdict1: the channel reader answers as Go answered on every recorded channel', () => {
  it('the vectors file is the one Go wrote (sha256) and holds 294 cases of 14 classes, with unique ids', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256);
    expect(vectors.length).toBe(294);
    expect(new Set(vectors.map((v) => v.id)).size).toBe(294);
    expect(new Set(vectors.map((v) => v.class)).size).toBe(14);
  });

  it('Go accepted 65 of them and refused 229, so both verdicts are exercised in every FDICT class that has an accepting member', () => {
    const accepted = vectors.filter((v) => v.go !== 'err');
    expect(accepted.length).toBe(65);
    for (const c of ['fdict1', 'fdict_flevel', 'fdict_trailing', 'fdict_id_off_by_one', 'audit_fdict_abc']) {
      expect(vectors.some((v) => v.class === c && v.go !== 'err'), `${c} accepted`).toBe(true);
    }
    for (const c of ['fdict_other_id', 'fdict_bad_fcheck', 'fdict_trunc_id', 'fdict_trunc_any', 'fdict_cmf_window', 'fdict_flip_after', 'fdict_id_flip']) {
      expect(vectors.filter((v) => v.class === c).every((v) => v.go === 'err'), `${c} refused`).toBe(true);
    }
  });

  it.each(vectors.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    expect(tsAnswer(v)).toBe(v.go);
  });
});
