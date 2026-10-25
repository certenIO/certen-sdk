/** The epoch record (BCS, BLAKE3, the signed message) and the Adiri pins (V2_SPEC_S7 4.2, 5.8 O2). */
import { describe, expect, it } from 'vitest';
import { blake3 } from '@noble/hashes/blake3';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import {
  Codec,
  Name,
  bcsRecord,
  digestOf,
  decodeHex,
  parsePins,
  recordDigests,
  signedMessage,
  uleb,
} from '../../../src/proof-v2/finality/adiri/index.js';
import { assertRegistered } from './regcheck.js';
import { embeddedAdiriPins } from './vectorset.js';
import { live } from './live.js';
import { concat, filled, hex, pinsOfSection, pinsOfText, unhex } from './synth.js';

function refusal(f: () => unknown): FinalityStateError {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(FinalityStateError);
    assertRegistered(e as FinalityStateError);
    return e as FinalityStateError;
  }
  throw new Error('expected a refusal');
}
const j = (e: FinalityStateError): string => e.canonical();

describe('uleb128', () => {
  it('is the BCS length prefix', () => {
    expect(Array.from(uleb(0))).toEqual([0]);
    expect(Array.from(uleb(1))).toEqual([1]);
    expect(Array.from(uleb(127))).toEqual([0x7f]);
    expect(Array.from(uleb(128))).toEqual([0x80, 0x01]);
    expect(Array.from(uleb(300))).toEqual([0xac, 0x02]);
    expect(Array.from(uleb(16384))).toEqual([0x80, 0x80, 0x01]);
    expect(Array.from(uleb(2 ** 32))).toEqual([0x80, 0x80, 0x80, 0x80, 0x10]);
  });
});

describe('the BCS record and its digest', () => {
  it('is built field by field from the specification', () => {
    const k1 = filled(96, 1);
    const k2 = filled(96, 2);
    const k3 = filled(96, 3);
    const parent = filled(32, 0xaa);
    const fs = { number: 0x0102030405060708n, hash: filled(32, 0xbb) };
    const fc = { number: 9n, hash: filled(32, 0xcc) };
    const got = bcsRecord(0x01020304, [k1, k2], [k3], parent, fs, fc);
    const want = concat(
      Uint8Array.of(0x04, 0x03, 0x02, 0x01), // u32le(epoch)
      Uint8Array.of(2),
      Uint8Array.of(0x60),
      k1,
      Uint8Array.of(0x60),
      k2,
      Uint8Array.of(1),
      Uint8Array.of(0x60),
      k3,
      Uint8Array.of(0x20),
      parent,
      Uint8Array.of(8, 7, 6, 5, 4, 3, 2, 1), // u64le(fs.number)
      Uint8Array.of(0x20),
      fs.hash,
      Uint8Array.of(9, 0, 0, 0, 0, 0, 0, 0),
      Uint8Array.of(0x20),
      fc.hash,
    );
    expect(hex(got)).toBe(hex(want));
    expect(hex(digestOf(got))).toBe(hex(blake3(want, { dkLen: 32 })));
    expect(digestOf(got).length).toBe(32);
  });

  it('the message the committee signs is scope, version, app id, then the BCS of the 32-byte digest', () => {
    const d = filled(32, 7);
    expect(hex(signedMessage(d))).toBe(`01000120${hex(d)}`);
  });

  it('reproduces the record digests Telcoin itself certified for epochs 0, 1, 2 and 642 (annex M3)', () => {
    const l = live('live-513643-epoch651');
    const d = recordDigests(l.cfa1);
    expect(hex(d[0]!)).toBe('f07c39528bea398d8a8470a3188a4464da2c569b713831935bd190933d8939a7');
    expect(hex(d[1]!)).toBe('d2e939960b3d79616d5ca42bf3f5fc12d67bdaad06510a251595efcddbefd713');
    expect(hex(d[2]!)).toBe('b9eaa809acf4c608394508155f4e016baaab6be475466f8a9a74c98f0a10f4a4');
    expect(hex(d[642]!)).toBe('5ea75eb276abfd43ef7ec353b21f7b31a96b10a876d02aa73c606cff92d3f11f');
    expect(d.length).toBe(652);
  });

  it('chains each record to its parent digest (record 0 has the zero parent)', () => {
    const l = live();
    const r = l.cfa1.records;
    const d = recordDigests(l.cfa1);
    for (const i of [0, 1, 17]) {
      const rec = r[i]!;
      const again = digestOf(bcsRecord(i, l.cfa1.tables[rec.committeeIdx]!, l.cfa1.tables[rec.nextIdx]!, i === 0 ? new Uint8Array(32) : d[i - 1]!, rec.finalState, rec.finalConsensus));
      expect(hex(again)).toBe(hex(d[i]!));
    }
  });
});

describe('decodeHex is hex.DecodeString, strictly', () => {
  it('decodes exact hex of either case and refuses everything else: odd length, a non-hex digit, a prefix', () => {
    expect(hex(decodeHex('abcd')!)).toBe('abcd');
    expect(hex(decodeHex('ABCD')!)).toBe('abcd');
    expect(hex(decodeHex('09afAF')!)).toBe('09afaf');
    expect(hex(decodeHex('')!)).toBe('');
    expect(decodeHex('abc')).toBeUndefined();
    expect(decodeHex('a')).toBeUndefined();
    expect(decodeHex('abzz')).toBeUndefined();
    expect(decodeHex('zzab')).toBeUndefined();
    expect(decodeHex('aG')).toBeUndefined();
    expect(decodeHex('0xab')).toBeUndefined();
    expect(decodeHex('ab ')).toBeUndefined();
    expect(decodeHex('g0')).toBeUndefined();
    expect(decodeHex('0g')).toBeUndefined();
    expect(decodeHex('@0')).toBeUndefined();
    expect(decodeHex('0@')).toBeUndefined();
    expect(decodeHex('/0')).toBeUndefined();
    expect(decodeHex('0:')).toBeUndefined();
    expect(decodeHex('`0')).toBeUndefined();
    expect(decodeHex('0`')).toBeUndefined();
    expect(decodeHex('G0')).toBeUndefined();
    expect(decodeHex('é0')).toBeUndefined();
    expect(hex(decodeHex('fF')!)).toBe('ffff'.slice(0, 2));
    expect(hex(decodeHex('00ff')!)).toBe('00ff');
  });
});

describe('the Adiri pins', () => {
  const embedded = (): Record<string, any> => JSON.parse(JSON.stringify(sectionOf()));
  const sectionOf = (): unknown => {
    const p = embeddedAdiriPins().sections.get('adiri') as { pairs: [string, unknown][] };
    const toJs = (v: any): any => (v && v.pairs ? Object.fromEntries(v.pairs.map(([k, x]: [string, unknown]) => [k, toJs(x)])) : v && v.lit !== undefined ? Number(v.lit) : Array.isArray(v) ? v.map(toJs) : v);
    return toJs(p);
  };
  const withMut = (mut: (m: Record<string, any>) => void): ReturnType<typeof refusal> => {
    const m = embedded();
    mut(m);
    return refusal(() => parsePins(pinsOfSection(m)));
  };
  const key = (e: FinalityStateError): string => String(e.fields.key);

  it('the embedded pins parse to the values of the annex', () => {
    const p = parsePins(embeddedAdiriPins());
    expect(p.chainId).toBe(2017n);
    expect(p.codec).toBe(Codec);
    expect(Name).toBe('adiri/finalized/v1');
    expect(p.genesisCommittee.length).toBe(5);
    expect(p.genesisCommittee.every((k) => k.length === 96)).toBe(true);
    expect(p.epoch0FinalState.number).toBe(290n);
    expect(hex(p.epoch0FinalState.hash)).toBe('725705f6ff227979f8812d8c395e9a048c5e97877462e8c12513dcda66cc01d5');
    expect(hex(p.eip2935Address)).toBe('0000f90827f1c53a10cb7a02335b175320002935');
    expect(hex(p.eip2935CodeHash)).toBe('6e49e66782037c0555897870e29fa5e552daf4719552131a0abce779daec0a5d');
    expect(p.minCommittee).toBe(4n);
    expect(p.maxHeaders > 0n).toBe(true);
    expect(p.genesisLinkSha.length).toBe(64);
    expect(hex(p.genesisHash).length).toBe(64);
  });

  it('an absent section is finality_pin_unknown; a null pins is the same', () => {
    expect(j(refusal(() => parsePins(null)))).toBe('{"code":"finality_pin_unknown","fields":{"chain":"2017","kind":"adiri"}}');
    expect(refusal(() => parsePins(undefined)).code).toBe('finality_pin_unknown');
    const p = { ...embeddedAdiriPins(), sections: new Map() };
    expect(refusal(() => parsePins(p)).code).toBe('finality_pin_unknown');
  });

  it('refuses an unknown field (top level and nested), naming it as written', () => {
    expect(j(withMut((m) => (m.extra = 1)))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"adiri.extra","reason":"unknown_key"}}');
    expect(j(withMut((m) => (m.eip2935.nope = 1)))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"adiri.nope","reason":"unknown_key"}}');
    expect(withMut((m) => (m.epoch0_final_state.extra = 1)).fields.reason).toBe('unknown_key');
  });

  it('refuses a value of the wrong type, naming the full path', () => {
    expect(j(withMut((m) => (m.chain_id = '2017')))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"adiri.chain_id","reason":"bad_value"}}');
    expect(key(withMut((m) => (m.eip2935.address = 5)))).toBe('adiri.eip2935.address');
    expect(key(withMut((m) => (m.epoch0_final_state.number = 'x')))).toBe('adiri.epoch0_final_state.number');
    expect(key(withMut((m) => (m.epoch0_final_state.hash = 7)))).toBe('adiri.epoch0_final_state.hash');
    expect(key(withMut((m) => (m.genesis_committee = 'abc')))).toBe('adiri.genesis_committee');
    expect(key(withMut((m) => (m.genesis_committee = [1])))).toBe('adiri.genesis_committee');
    expect(key(withMut((m) => (m.min_committee_size = 1.5)))).toBe('adiri.min_committee_size');
    expect(key(withMut((m) => (m.max_headers = 'x')))).toBe('adiri.max_headers');
    expect(key(withMut((m) => (m.eip2935 = 5)))).toBe('adiri.eip2935');
    expect(key(withMut((m) => (m.epoch_record_codec = 5)))).toBe('adiri.epoch_record_codec');
    expect(key(withMut((m) => (m.genesis_hash = false)))).toBe('adiri.genesis_hash');
    expect(key(withMut((m) => (m.genesis_link_sha256 = [])))).toBe('adiri.genesis_link_sha256');
    expect(key(withMut((m) => (m.chain_id = -1)))).toBe('adiri.chain_id');
    expect(key(withMut((m) => (m.chain_id = 1.5)))).toBe('adiri.chain_id');
  });

  it('the FIRST error of the document order is the one reported (a type error before an unknown field, and the reverse)', () => {
    const base = JSON.stringify(embedded());
    const typeFirst = pinsOfText(`{"chain_id":"x","zzz":1,${base.slice(1)}`.replace(/"chain_id":2017,/, ''));
    expect(key(refusal(() => parsePins(typeFirst)))).toBe('adiri.chain_id');
    const unknownFirst = pinsOfText(`{"zzz":1,"chain_id":"x",${base.slice(1)}`.replace(/"chain_id":2017,/, ''));
    expect(key(refusal(() => parsePins(unknownFirst)))).toBe('adiri.zzz');
  });

  it('matches field names case-insensitively, exactly or folded, as encoding/json does', () => {
    const m = embedded();
    const folded = Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toUpperCase(), v]));
    const p = parsePins(pinsOfSection(folded));
    expect(p.chainId).toBe(2017n);
    expect(p.minCommittee).toBe(4n);
  });

  it('null leaves a field at its zero value, which the checks then refuse', () => {
    expect(key(withMut((m) => (m.genesis_hash = null)))).toBe('adiri.genesis_hash');
    expect(key(withMut((m) => (m.genesis_committee = null)))).toBe('adiri.genesis_committee');
    expect(key(withMut((m) => (m.chain_id = null)))).toBe('adiri.chain_id');
    expect(key(withMut((m) => (m.eip2935 = null)))).toBe('adiri.eip2935.runtime_codehash');
    const nullSection = { ...embeddedAdiriPins(), sections: new Map([['adiri', null as never]]) };
    expect(key(refusal(() => parsePins(nullSection)))).toBe('adiri.genesis_hash');
    const notObject = { ...embeddedAdiriPins(), sections: new Map([['adiri', [] as never]]) };
    expect(j(refusal(() => parsePins(notObject)))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"adiri.","reason":"bad_value"}}');
  });

  it('hex pins: 0x required, 32 bytes, in the order genesis_hash, epoch0 hash, codehash, address, committee', () => {
    const h = (n: number): string => `0x${hex(filled(32, n))}`;
    expect(key(withMut((m) => (m.genesis_hash = '0x12')))).toBe('adiri.genesis_hash');
    expect(key(withMut((m) => (m.genesis_hash = hex(filled(32, 1)))))).toBe('adiri.genesis_hash');
    expect(key(withMut((m) => (m.genesis_hash = `0X${hex(filled(32, 1))}`)))).toBe('adiri.genesis_hash');
    expect(key(withMut((m) => (m.genesis_hash = `0x${hex(filled(33, 1))}`)))).toBe('adiri.genesis_hash');
    expect(key(withMut((m) => (m.epoch0_final_state = { hash: '0x00', number: 290 })))).toBe('adiri.epoch0_final_state.hash');
    expect(key(withMut((m) => (m.eip2935.runtime_codehash = '0x01')))).toBe('adiri.eip2935.runtime_codehash');
    expect(key(withMut((m) => (m.eip2935.address = '0x01')))).toBe('adiri.eip2935.address');
    expect(key(withMut((m) => (m.eip2935.address = '0000F90827F1C53a10cb7A02335B175320002935')))).toBe('adiri.eip2935.address');
    expect(key(withMut((m) => (m.eip2935.address = `0x${hex(filled(21, 1))}`)))).toBe('adiri.eip2935.address');
    // the order of the checks: when several are wrong the earlier one is reported
    expect(key(withMut((m) => { m.genesis_hash = '0x1'; m.epoch0_final_state.hash = '0x2'; m.eip2935.runtime_codehash = '0x3'; m.eip2935.address = '0x4'; m.genesis_committee = []; m.chain_id = 0; }))).toBe('adiri.genesis_hash');
    expect(key(withMut((m) => { m.epoch0_final_state.hash = '0x2'; m.eip2935.runtime_codehash = '0x3'; m.eip2935.address = '0x4'; m.genesis_committee = []; m.chain_id = 0; }))).toBe('adiri.epoch0_final_state.hash');
    expect(key(withMut((m) => { m.eip2935.runtime_codehash = '0x3'; m.eip2935.address = '0x4'; m.genesis_committee = []; m.chain_id = 0; }))).toBe('adiri.eip2935.runtime_codehash');
    expect(key(withMut((m) => { m.eip2935.address = '0x4'; m.genesis_committee = []; m.chain_id = 0; }))).toBe('adiri.eip2935.address');
    expect(key(withMut((m) => { m.genesis_committee = []; m.chain_id = 0; }))).toBe('adiri.genesis_committee');
    expect(key(withMut((m) => { m.chain_id = 0; m.min_committee_size = 0; m.max_headers = 0; m.genesis_link_sha256 = 'ab'; }))).toBe('adiri.chain_id');
    expect(key(withMut((m) => { m.min_committee_size = 0; m.max_headers = 0; m.genesis_link_sha256 = 'ab'; }))).toBe('adiri.min_committee_size');
    expect(key(withMut((m) => { m.max_headers = 0; m.genesis_link_sha256 = 'ab'; }))).toBe('adiri.max_headers');
    expect(key(withMut((m) => (m.genesis_link_sha256 = 'ab')))).toBe('adiri.genesis_link_sha256');
    // exact hex: an odd number of digits is refused, never padded with a zero; a non-hex digit is refused, never truncated; upper case is fine
    expect(key(withMut((m) => (m.genesis_hash = `0x${hex(filled(32, 0x1f)).slice(1)}`)))).toBe('adiri.genesis_hash');
    expect(key(withMut((m) => (m.genesis_hash = `0x${hex(filled(31, 0x1f))}zz`)))).toBe('adiri.genesis_hash');
    expect(key(withMut((m) => (m.epoch0_final_state = { hash: `0x${hex(filled(32, 1)).slice(1)}`, number: 290 })))).toBe('adiri.epoch0_final_state.hash');
    expect(key(withMut((m) => (m.eip2935.runtime_codehash = `0x${hex(filled(32, 1)).slice(1)}`)))).toBe('adiri.eip2935.runtime_codehash');
    expect(key(withMut((m) => (m.eip2935.address = `0x${hex(filled(20, 1)).slice(1)}`)))).toBe('adiri.eip2935.address');
    expect(key(withMut((m) => (m.eip2935.address = '0x')))).toBe('adiri.eip2935.address');
    expect(hex(parsePins(pinsOfSection({ ...embedded(), genesis_hash: `0x${hex(filled(32, 0xab)).toUpperCase()}` })).genesisHash)).toBe(hex(filled(32, 0xab)));
    expect(h(1)).toBe(`0x${hex(filled(32, 1))}`);
  });

  it('the committee pin: 1..255 keys of 96 bytes, the failing index named', () => {
    const k = hex(filled(96, 1));
    expect(j(withMut((m) => (m.genesis_committee = [])))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"adiri.genesis_committee","reason":"bad_value"}}');
    const err = withMut((m) => (m.genesis_committee = [k, k, 'abcd']));
    expect(j(err)).toBe('{"code":"finality_pins_corrupt","fields":{"index":"2","key":"adiri.genesis_committee","reason":"bad_value"}}');
    expect(withMut((m) => (m.genesis_committee = [`0x${k}`])).fields.index).toBe(0n);
    expect(withMut((m) => (m.genesis_committee = [k.slice(2)])).fields.index).toBe(0n);
    expect(withMut((m) => (m.genesis_committee = [`${k}00`])).fields.index).toBe(0n);
    const many = parsePins(pinsOfSection({ ...embedded(), genesis_committee: Array.from({ length: 255 }, () => k) }));
    expect(many.genesisCommittee.length).toBe(255);
    expect(withMut((m) => (m.genesis_committee = Array.from({ length: 256 }, () => k))).fields.key).toBe('adiri.genesis_committee');
  });

  it('the numeric pins: chain_id and max_headers must be positive, min_committee_size at least four; the link hash 64 characters', () => {
    // RB11-F1-FIX b2d2835: the smallest valid min_committee_size is Telcoin shrink floor of four (units_f1fix.test.ts pins 3, 2, 1, 0, -1 as refused)
    expect(parsePins(pinsOfSection({ ...embedded(), min_committee_size: 4 })).minCommittee).toBe(4n);
    expect(parsePins(pinsOfSection({ ...embedded(), max_headers: 1 })).maxHeaders).toBe(1n);
    expect(parsePins(pinsOfSection({ ...embedded(), chain_id: 1 })).chainId).toBe(1n);
    expect(key(withMut((m) => (m.min_committee_size = -3)))).toBe('adiri.min_committee_size');
    expect(key(withMut((m) => (m.max_headers = -3)))).toBe('adiri.max_headers');
    expect(key(withMut((m) => (m.genesis_link_sha256 = 'a'.repeat(65))))).toBe('adiri.genesis_link_sha256');
    expect(key(withMut((m) => (m.genesis_link_sha256 = 'a'.repeat(63))))).toBe('adiri.genesis_link_sha256');
    expect(parsePins(pinsOfSection({ ...embedded(), genesis_link_sha256: 'a'.repeat(64) })).genesisLinkSha).toBe('a'.repeat(64));
    expect(unhex('00ff').length).toBe(2);
  });
});
