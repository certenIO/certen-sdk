import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeNetworkDefinition, decodeNetworkGlobals } from '../src/proof-v2/netrecord.js';
import { encodeObject, networkDefinition } from '../src/proof-v2/accumulate.js';
import { toHex, VerifyError } from '../src/proof-v2/bytes.js';

/**
 * The binary decoder for the two records a network update writes, against vectors Go produced
 * (certen-validator cmd/netrecordvectors: each record as Go marshals it, and as Go renders it to JSON).
 */
const { vectors } = JSON.parse(readFileSync(new URL('./fixtures/netrecords.json', import.meta.url), 'utf8')) as {
  vectors: { name: string; kind: 'definition' | 'globals'; hex: string; json: unknown }[];
};
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

/** Go renders a zero value as absent or as an explicit zero; the comparison is on the meaningful content. */
function normalise(v: any): any {
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const n = normalise(x);
      if (n === undefined || n === 0 || n === '' || n === false || (Array.isArray(n) && n.length === 0)) continue;
      if (n && typeof n === 'object' && !Array.isArray(n) && Object.keys(n).length === 0) continue;
      o[k] = n;
    }
    return o;
  }
  return v;
}

describe('network record decoder, against Go', () => {
  it('has the vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(6);
    expect(vectors.filter((v) => v.kind === 'definition').length).toBeGreaterThanOrEqual(3);
    expect(vectors.filter((v) => v.kind === 'globals').length).toBeGreaterThanOrEqual(3);
  });

  for (const v of vectors) {
    it(`${v.name}: decodes to what Go renders, and re-encodes to Go's bytes`, () => {
      const obj = v.kind === 'definition' ? decodeNetworkDefinition(bytes(v.hex)) : decodeNetworkGlobals(bytes(v.hex));
      expect(toHex(encodeObject(obj))).toBe(v.hex);
      const got = normalise(obj.asObject());
      const want = normalise(v.json);
      // Go renders a duration as a string ("1.5s"), the SDK as seconds: compare the one field separately.
      if (v.kind === 'globals' && (want as any).blockInterval !== undefined) {
        expect(got.blockInterval).toBe(1.5);
        delete got.blockInterval;
        delete (want as any).blockInterval;
      }
      if (v.kind === 'definition') {
        // Go renders the enum as its name in the same lower-camel form the SDK uses; the url as a string.
        for (const p of (want as any).partitions ?? []) p.type = String(p.type).charAt(0).toLowerCase() + String(p.type).slice(1);
      }
      expect(got).toEqual(want);
    });
  }
});

describe('network record decoder refuses what it cannot prove it read', () => {
  const full = vectors.find((v) => v.name === 'definition-update-v2')!;
  const good = bytes(full.hex);
  const refuses = (b: Uint8Array, kind: 'definition' | 'globals' = 'definition') => {
    try {
      (kind === 'definition' ? decodeNetworkDefinition : decodeNetworkGlobals)(b);
    } catch (e) {
      expect(e).toBeInstanceOf(VerifyError);
      return (e as Error).message;
    }
    throw new Error('was accepted');
  };

  it('a truncated record', () => {
    for (const n of [1, 5, good.length - 1]) expect(refuses(good.subarray(0, n))).toMatch(/network_update_undecodable/);
  });

  it('trailing bytes that are not a field', () => {
    expect(refuses(new Uint8Array([...good, 0x7f]))).toMatch(/unknown field 127|network_update_undecodable/);
  });

  it('a field number the type does not have', () => {
    expect(refuses(new Uint8Array([...good, 9, 1]))).toMatch(/unknown field 9/);
  });

  it('fields out of order', () => {
    const name = good.subarray(0, 1 + 1 + 6); // 0x01 len "Kermit"
    const version = new Uint8Array([2, 2]);
    expect(refuses(new Uint8Array([...version, ...name]))).toMatch(/field 1 after 2/);
  });

  it('a single-field record repeated', () => {
    const name = good.subarray(0, 8);
    expect(refuses(new Uint8Array([...name, ...name]))).toMatch(/field 1 after 1/);
  });

  it('a boolean that is not 0 or 1', () => {
    expect(refuses(new Uint8Array([4, 2]), 'globals')).toMatch(/is not a boolean/);
  });

  it('a non-minimal varint, which the writer would never produce and which re-encodes differently', () => {
    // version 2 written as 0x82 0x00
    const name = good.subarray(0, 8);
    expect(refuses(new Uint8Array([...name, 2, 0x82, 0x00]))).toMatch(/does not encode back/);
  });

  it('invalid UTF-8 in a name', () => {
    expect(refuses(new Uint8Array([1, 2, 0xc3, 0x28]))).toMatch(/UTF-8|network_update_undecodable/);
  });

  it('input that decodes but is not the record the SDK would write', () => {
    // a partition type the SDK does not know
    const bad = new Uint8Array([3, 4, 1, 1, 0x41, 2, 99]);
    const m = refuses(bad);
    expect(m).toMatch(/network_update_undecodable/);
  });

  it('agrees with the SDK\'s own encoder on a definition built from JSON', () => {
    const def = networkDefinition({ networkName: 'N', version: 3, partitions: [{ id: 'Directory', type: 'directory' }], validators: [] });
    const round = decodeNetworkDefinition(encodeObject(def));
    expect(normalise(round.asObject())).toEqual(normalise(def.asObject()));
  });
});
