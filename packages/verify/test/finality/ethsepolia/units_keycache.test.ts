/**
 * The sync-committee key cache of ethl1 (RB12 Part 3: ~2.1 s per call went into decoding and subgroup-checking the 342+ participating
 * keys of every committee on every call). Validity of a key is a function of its 48 bytes alone, so a process-wide, bounded cache keyed by
 * those bytes decodes each key once between calls. These tests pin: the second call with the same committee decodes nothing; a different
 * committee decodes; the cache is bounded (least recently used out); a refusal is cached too; and no verdict depends on the cache.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEY_CACHE_KEYS, KeyCache, defaultKeyCache, resetDefaultKeyCache, verifyFinalizedHead, ethl1PinsFrom } from '../../../src/proof-v2/finality/ethl1/index.js';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { loadVerifyCase, read, runVerifyCase } from './vectorset.js';
import { recorded } from './recorded.js';

// real verifications of 3 MB objects: a loaded machine must not read a slow decode as a failure
vi.setConfig({ testTimeout: 300_000 });

describe('KeyCache', () => {
  // a valid compressed G1 point (the generator) and bytes that are not a point
  const generator = Uint8Array.from(Buffer.from('97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb', 'hex'));
  const junk = (i: number): Uint8Array => {
    const b = new Uint8Array(48);
    b[0] = 0x80;
    b[47] = i;
    return b;
  };

  it('decodes a key once and returns the same point; a refusal is cached and re-thrown without decoding again', () => {
    const c = new KeyCache();
    const p1 = c.key(generator);
    const p2 = c.key(Uint8Array.from(generator));
    expect(p2).toBe(p1);
    expect([c.decodes, c.decoded]).toEqual([1, 1]);
    let first: unknown;
    let second: unknown;
    try {
      c.key(junk(1));
    } catch (e) {
      first = e;
    }
    try {
      c.key(junk(1));
    } catch (e) {
      second = e;
    }
    expect(first).toBeInstanceOf(Error);
    expect(second).toBe(first);
    expect([c.decodes, c.decoded]).toEqual([2, 2]);
  });

  it('is bounded: at most max keys are held, the least recently used leaves first, and a returning key is decoded again', () => {
    const c = new KeyCache(3);
    const refuse = (b: Uint8Array): void => {
      try {
        c.key(b);
      } catch {
        /* a refusal is cached like a key */
      }
    };
    refuse(junk(1));
    refuse(junk(2));
    refuse(junk(3));
    expect(c.decoded).toBe(3);
    refuse(junk(1)); // refreshes 1: the order is now 2, 3, 1
    expect(c.decodes).toBe(3);
    refuse(junk(4)); // evicts 2
    expect([c.decoded, c.decodes]).toEqual([3, 4]);
    refuse(junk(1));
    refuse(junk(3));
    expect(c.decodes).toBe(4); // 1 and 3 were still held
    refuse(junk(2));
    expect(c.decodes).toBe(5); // 2 was evicted and is decoded again
    expect(c.decoded).toBe(3);
    expect(() => new KeyCache(0)).toThrow();
    expect(DEFAULT_KEY_CACHE_KEYS).toBe(4096);
  });
});

describe('the process-wide cache of verifyFinalizedHead', () => {
  const pins = parsePinsOverride(read('eth_sepolia1', 'pins/main.json'));
  const lc = recorded('eth_sepolia1', 'gloas_latest').body.lc;
  const l1 = ethl1PinsFrom(pins.ethSepolia!);

  it('a second call with the same committee decodes no key; a call against a different committee does', () => {
    resetDefaultKeyCache();
    const cache = defaultKeyCache();
    expect(cache.decodes).toBe(0);
    const h1 = verifyFinalizedHead(l1, lc);
    const afterFirst = cache.decodes;
    expect(afterFirst).toBeGreaterThanOrEqual(342); // the participating seats of the final update
    const h2 = verifyFinalizedHead(l1, lc);
    expect(cache.decodes).toBe(afterFirst);
    expect(h2).toEqual(h1);
    // another real leg is signed by another period's committee
    const other = recorded('eth_sepolia1', 'gloas_period').body.lc;
    verifyFinalizedHead(l1, other);
    expect(cache.decodes).toBeGreaterThan(afterFirst);
    // and the first committee is still warm
    const mid = cache.decodes;
    verifyFinalizedHead(l1, lc);
    expect(cache.decodes).toBe(mid);
  });

  it('14 committees of 342+ keys share their validators: the whole active set fits, and the process-wide cache never holds more than DEFAULT_KEY_CACHE_KEYS', () => {
    resetDefaultKeyCache();
    const c = loadVerifyCase('eth_sepolia2', 'valid_gloas_latest');
    runVerifyCase('eth_sepolia2', c);
    const cache = defaultKeyCache();
    // Sepolia's ~1,873 validators fill every committee, so 14 committees decode far fewer keys than 14 x 342 (4,788)
    expect(cache.decodes).toBeGreaterThanOrEqual(342);
    expect(cache.decodes).toBeLessThan(14 * 342);
    expect(cache.decoded).toBe(cache.decodes);
    // flooding the process-wide cache with distinct keys cannot grow it past its bound
    for (let i = 0; i < DEFAULT_KEY_CACHE_KEYS + 50; i++) {
      const k = new Uint8Array(48);
      k[0] = 0x80;
      k[44] = (i >>> 24) & 0xff;
      k[45] = (i >>> 16) & 0xff;
      k[46] = (i >>> 8) & 0xff;
      k[47] = i & 0xff;
      try {
        cache.key(k);
      } catch {
        /* an invalid key is cached as a refusal */
      }
    }
    expect(cache.decoded).toBe(DEFAULT_KEY_CACHE_KEYS);
    // the verdict is unchanged after the flood evicted the real keys
    expect(runVerifyCase('eth_sepolia2', c)).toBe(c.expect_canonical);
  });

  it('no verdict depends on the cache: cold, warm, a private cache and a cache that evicts everything all give the Go-written verdict', () => {
    const c = loadVerifyCase('eth_sepolia1', 'valid_gloas_period');
    resetDefaultKeyCache();
    const cold = runVerifyCase('eth_sepolia1', c);
    const warm = runVerifyCase('eth_sepolia1', c);
    expect([cold, warm]).toEqual([c.expect_canonical, c.expect_canonical]);
    const lcP = recorded('eth_sepolia1', 'gloas_period').body.lc;
    const priv = verifyFinalizedHead(l1, lcP, { keyCache: new KeyCache() });
    const tiny = verifyFinalizedHead(l1, lcP, { keyCache: new KeyCache(1) });
    expect(tiny).toEqual(priv);
    // a refusal is the same with a warm cache: one flipped signature byte of the final update is finality_signature_invalid either way
    const bad = { ...lcP, finalUpdate: { ...lcP.finalUpdate, ssz: Uint8Array.from(lcP.finalUpdate.ssz) } };
    bad.finalUpdate.ssz[bad.finalUpdate.ssz.length - 8 - 5]! ^= 1;
    const codes = [0, 1].map(() => {
      try {
        verifyFinalizedHead(l1, bad);
        return 'accepted';
      } catch (e) {
        return (e as { code?: string }).code;
      }
    });
    expect(codes).toEqual(['finality_signature_invalid', 'finality_signature_invalid']);
  });
});
