/** The Adiri genesis link (annex A7): the embedded asset, its load-time check, and registerAdiri failing closed. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { describe, expect, it } from 'vitest';
import { Registry } from '../../../src/proof-v2/finality/registry.js';
import { FinalityStateError, hexLower } from '../../../src/proof-v2/finality/state.js';
import {
  GenesisLinkError,
  checkEmbeddedGenesisLink,
  checkGenesisLink,
  embeddedGenesisLink,
  parsePins,
  registerAdiri,
  splitHeaders,
  verifyGenesisLink,
} from '../../../src/proof-v2/finality/adiri/index.js';
import { GENESIS_LINK_LENGTH, GENESIS_LINK_SHA256 } from '../../../src/proof-v2/finality/adiri/genesis-link-data.js';
import { assertRegistered } from './regcheck.js';
import { embeddedAdiriPins, readSet4, sha256Hex } from './vectorset.js';
import { concat, filled, hashOf, hex, makeHeader, pinsOfSection } from './synth.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', '..', 'src', 'proof-v2', 'finality');
const REAL_SHA = '6ccf8d955bbb92278e5cecfc9b580d2e4946dfee234a64eb582e33bd3452cbbd';

async function refusal(f: () => unknown): Promise<FinalityStateError> {
  try {
    await f();
  } catch (e) {
    expect(e).toBeInstanceOf(FinalityStateError);
    assertRegistered(e as FinalityStateError);
    return e as FinalityStateError;
  }
  throw new Error('expected a refusal');
}

const section = (): Record<string, any> => {
  const p = embeddedAdiriPins().sections.get('adiri') as { pairs: [string, unknown][] };
  const toJs = (v: any): any => (v && v.pairs ? Object.fromEntries(v.pairs.map(([k, x]: [string, unknown]) => [k, toJs(x)])) : v && v.lit !== undefined ? Number(v.lit) : Array.isArray(v) ? v.map(toJs) : v);
  return toJs(p);
};

describe('the embedded asset', () => {
  it('is the Go-published 176,758 byte genesis link, hash-pinned three ways', async () => {
    const bytes = await embeddedGenesisLink();
    expect(bytes.length).toBe(176758);
    expect(GENESIS_LINK_LENGTH).toBe(176758);
    expect(hexLower(sha256(bytes))).toBe(REAL_SHA);
    expect(GENESIS_LINK_SHA256).toBe(REAL_SHA);
    expect(Buffer.from(bytes).equals(readSet4('link/genesis_link_1_290.bin'))).toBe(true);
    expect(parsePins(embeddedAdiriPins()).genesisLinkSha).toBe(REAL_SHA);
  });
  it('is returned as a fresh copy each time', async () => {
    const a = await embeddedGenesisLink();
    a[0] = 0;
    const b = await embeddedGenesisLink();
    expect(b[0]).not.toBe(0);
    expect(hexLower(sha256(b))).toBe(REAL_SHA);
  });
  it('is loaded lazily: only genesislink.ts mentions the data module, and only by a dynamic import', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith('.ts') && e.name !== 'genesis-link-data.ts') {
          const text = readFileSync(join(dir, e.name), 'utf8');
          if (/from\s+['"][^'"]*genesis-link-data(\.js)?['"]/.test(text)) offenders.push(e.name);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
    expect(readFileSync(join(SRC, 'adiri', 'genesislink.ts'), 'utf8')).toContain("await import('./genesis-link-data.js')");
    expect(readFileSync(join(SRC, 'adiri', 'index.ts'), 'utf8')).not.toContain('genesis-link-data');
  });
});

describe('splitHeaders', () => {
  const h1 = makeHeader({ number: 1n });
  const h2 = makeHeader({ number: 2n });
  it('splits a concatenation of RLP lists, and an empty file into nothing', () => {
    expect(splitHeaders(new Uint8Array(0))).toEqual([]);
    const hs = splitHeaders(concat(h1, h2));
    expect(hs.length).toBe(2);
    expect(hex(hs[0]!)).toBe(hex(h1));
    expect(hex(hs[1]!)).toBe(hex(h2));
  });
  it('refuses a non-list, a truncated list, a hostile length and trailing garbage, naming the header', () => {
    for (const bad of [Uint8Array.of(0x80), Uint8Array.of(0x01), h1.subarray(0, h1.length - 1), Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), Uint8Array.of(0xf9, 0xff, 0xff, 1)]) {
      expect(() => splitHeaders(bad)).toThrow(GenesisLinkError);
    }
    expect(() => splitHeaders(concat(h1, Uint8Array.of(0x80)))).toThrow(/^header 1: /);
    expect(() => splitHeaders(concat(h1, h2, Uint8Array.of(0xc1)))).toThrow(/^header 2: /);
  });
});

/** headers 1..n of a synthetic link, each naming the hash of the one before (the first names `genesis`) */
function link(n: number, genesis: Uint8Array = filled(32, 0x0a)): { file: Uint8Array; headers: Uint8Array[]; genesis: Uint8Array } {
  const headers: Uint8Array[] = [];
  let parent = genesis;
  for (let i = 1; i <= n; i++) {
    const h = makeHeader({ number: BigInt(i), parentHash: parent });
    headers.push(h);
    parent = hashOf(h);
  }
  return { file: concat(...headers), headers, genesis };
}
const shaOf = (b: Uint8Array): string => hexLower(sha256(b));

describe('verifyGenesisLink', () => {
  it('accepts blocks 1..n linked from the genesis hash to the pinned tip, and counts them', () => {
    const l = link(5);
    const tip = { number: 5n, hash: hashOf(l.headers[4]!) };
    expect(verifyGenesisLink(l.file, shaOf(l.file), l.genesis, tip)).toBe(5);
    expect(verifyGenesisLink(link(1).file, shaOf(link(1).file), l.genesis, { number: 1n, hash: hashOf(link(1).headers[0]!) })).toBe(1);
  });
  it('refuses a file of another hash, an empty file, a first header that is not block 1 on the genesis hash, a broken link, a gap and a wrong tip', () => {
    const l = link(4);
    const tip = { number: 4n, hash: hashOf(l.headers[3]!) };
    const good = shaOf(l.file);
    expect(() => verifyGenesisLink(l.file, good.replace(/^./, 'f'), l.genesis, tip)).toThrow(/genesis link sha256/);
    expect(() => verifyGenesisLink(new Uint8Array(0), shaOf(new Uint8Array(0)), l.genesis, tip)).toThrow(/empty/);
    expect(() => verifyGenesisLink(l.file, good, filled(32, 0x0b), tip)).toThrow(/first header/);
    const second = concat(...l.headers.slice(1));
    expect(() => verifyGenesisLink(second, shaOf(second), l.genesis, tip)).toThrow(/first header/);
    const brokenLink = concat(l.headers[0]!, makeHeader({ number: 2n, parentHash: filled(32, 0x77) }), l.headers[2]!, l.headers[3]!);
    expect(() => verifyGenesisLink(brokenLink, shaOf(brokenLink), l.genesis, tip)).toThrow(/does not link/);
    const gap = concat(l.headers[0]!, makeHeader({ number: 3n, parentHash: hashOf(l.headers[0]!) }));
    expect(() => verifyGenesisLink(gap, shaOf(gap), l.genesis, { number: 3n, hash: hashOf(gap.subarray(l.headers[0]!.length)) })).toThrow(/does not link/);
    expect(() => verifyGenesisLink(l.file, good, l.genesis, { number: 5n, hash: tip.hash })).toThrow(/ends at/);
    expect(() => verifyGenesisLink(l.file, good, l.genesis, { number: 4n, hash: filled(32, 1) })).toThrow(/ends at/);
    const unreadable = concat(l.headers[0]!, Uint8Array.of(0xc1, 0x01));
    expect(() => verifyGenesisLink(unreadable, shaOf(unreadable), l.genesis, tip)).toThrow(/header 1/);
  });
  it('reads the real embedded link as blocks 1..290', async () => {
    const file = await embeddedGenesisLink();
    const p = parsePins(embeddedAdiriPins());
    expect(verifyGenesisLink(file, p.genesisLinkSha, p.genesisHash, p.epoch0FinalState)).toBe(290);
  });
});

describe('the load-time check of the embedded pins', () => {
  it('passes for the pins of the Go set', async () => {
    await expect(checkEmbeddedGenesisLink(embeddedAdiriPins())).resolves.toBeUndefined();
    expect(() => checkGenesisLink(readSet4('link/genesis_link_1_290.bin'), embeddedAdiriPins())).not.toThrow();
  });
  it('names the pins state when the section is absent or malformed, before looking at the file', async () => {
    const none = { ...embeddedAdiriPins(), sections: new Map() };
    expect((await refusal(() => checkEmbeddedGenesisLink(none))).code).toBe('finality_pin_unknown');
    expect((await refusal(() => checkEmbeddedGenesisLink(null))).code).toBe('finality_pin_unknown');
    const bad = pinsOfSection({ ...section(), extra: 1 });
    expect((await refusal(() => checkEmbeddedGenesisLink(bad))).canonical()).toBe('{"code":"finality_pins_corrupt","fields":{"key":"adiri.extra","reason":"unknown_key"}}');
  });
  it('a pinned hash other than the file\'s is adiri.genesis_link_sha256; a right hash on a link that goes elsewhere is adiri.genesis_link', async () => {
    const sha = pinsOfSection({ ...section(), genesis_link_sha256: 'a'.repeat(64) });
    expect((await refusal(() => checkEmbeddedGenesisLink(sha))).canonical()).toBe('{"code":"finality_pins_corrupt","fields":{"key":"adiri.genesis_link_sha256","reason":"bad_value"}}');
    const upper = pinsOfSection({ ...section(), genesis_link_sha256: REAL_SHA.toUpperCase() });
    expect((await refusal(() => checkEmbeddedGenesisLink(upper))).fields.key).toBe('adiri.genesis_link_sha256');
    const genesis = pinsOfSection({ ...section(), genesis_hash: `0x${hex(filled(32, 9))}` });
    expect((await refusal(() => checkEmbeddedGenesisLink(genesis))).canonical()).toBe('{"code":"finality_pins_corrupt","fields":{"key":"adiri.genesis_link","reason":"bad_value"}}');
    const tip = pinsOfSection({ ...section(), epoch0_final_state: { hash: `0x${hex(filled(32, 9))}`, number: 290 } });
    expect((await refusal(() => checkEmbeddedGenesisLink(tip))).fields.key).toBe('adiri.genesis_link');
    // a link that is not RLP at all, pinned by its own hash
    const junk = filled(36, 0xff);
    const j = pinsOfSection({ ...section(), genesis_link_sha256: shaOf(junk) });
    expect(() => checkGenesisLink(junk, j)).toThrow(FinalityStateError);
    try {
      checkGenesisLink(junk, j);
    } catch (e) {
      expect((e as FinalityStateError).fields.key).toBe('adiri.genesis_link');
    }
  });
});

describe('registerAdiri fails closed', () => {
  it('registers the Kind once the embedded link verifies, and a second registration is refused', async () => {
    const reg = new Registry();
    await registerAdiri(reg, embeddedAdiriPins());
    expect(reg.kind('adiri/finalized/v1')).toBeDefined();
    await expect(registerAdiri(reg, embeddedAdiriPins())).rejects.toThrow();
  });
  it('registers nothing when the link or the pins are refused', async () => {
    for (const pins of [pinsOfSection({ ...section(), genesis_link_sha256: 'b'.repeat(64) }), pinsOfSection({ ...section(), genesis_hash: `0x${hex(filled(32, 3))}` }), null]) {
      const reg = new Registry();
      const e = await refusal(() => registerAdiri(reg, pins));
      expect(['finality_pins_corrupt', 'finality_pin_unknown']).toContain(e.code);
      expect(reg.kind('adiri/finalized/v1')).toBeUndefined();
    }
  });
  it('the manifest of the Go set names the same link file', () => {
    expect(sha256Hex(readSet4('link/genesis_link_1_290.bin'))).toBe(REAL_SHA);
  });
});
