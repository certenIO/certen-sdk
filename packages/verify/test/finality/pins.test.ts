/** The pins loader (the twin of pkg/finality pins_test.go): the embedded file is byte-identical to the validator's and hash-pinned. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PINS_FORMAT,
  PINS_SHA256,
  anchorFor,
  embeddedPins,
  embeddedPinsBytes,
  loadPins,
  parsePinsOverride,
  pinsIdentity,
  sepoliaPins,
} from '../../src/proof-v2/finality/pins.js';
import { FinalityStateError, canonOf } from '../../src/proof-v2/finality/state.js';
import { fixtureJSON, hexToBytes, sha256Hex } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const pinsFile = readFileSync(join(here, '..', '..', 'src', 'proof-v2', 'finality', 'finality-pins.json'));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const want = (raw: Uint8Array): Uint8Array => hexToBytes(sha256Hex(raw));

/** The sha256 of certen-validator pv2/rb11-e1-raise@cbb6373 pkg/finality/pins/finality-pins.json (PinsSHA256 there; the sync target). The framework's first value, 507d72b3..., was the file at pv2/rb11-b-finality-framework@4377bb3. */
const VALIDATOR_PINS_SHA256 = 'fdba733e7fc4206d96d73c87352834c51801ee8fe0af76d60654cb461fbd5440';

const codeOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e.code;
    throw e;
  }
  return 'ok';
};

describe('PINS_SHA256 and the embedded bytes', () => {
  it('the constant, the file on disk, the embedded text and the validator\'s hash are one', () => {
    expect(PINS_SHA256).toBe(VALIDATOR_PINS_SHA256);
    expect(sha256Hex(pinsFile)).toBe(PINS_SHA256);
    expect(Buffer.from(embeddedPinsBytes()).equals(pinsFile)).toBe(true);
    expect(pinsFile.includes(0x0d)).toBe(false);
  });
  it('the embedded file loads against the constant and reports its identity', () => {
    const p = embeddedPins();
    expect(pinsIdentity(p)).toEqual([PINS_SHA256, 'embedded']);
    expect(pinsIdentity(null)).toEqual(['', 'none']);
  });
});

describe("the embedded pins hold the Sepolia network section of 4.2 with its root anchor, the other chains' raw sections and the shared KZG pin", () => {
  it('has the section 4.2 values', () => {
    const p = embeddedPins();
    expect(p.format).toBe(PINS_FORMAT);
    expect(p.onchainCommitment).toBeNull();
    expect([...p.sections.keys()].sort()).toEqual(['adiri', 'arb_sepolia', 'base_sepolia']);
    expect(p.shared?.kzgSetupSha256).toBe('f8e44a31ebf0a6d0734dcb301b0716e2c77f3ae18ed0cab0870fbcc2ca55616f');
    const e = sepoliaPins(p);
    expect(e.chainId).toBe(11155111n);
    expect(e.genesisValidatorsRoot).toBe('0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078');
    expect(e.genesisTime).toBe(1655733600n);
    expect(e.spec).toBe('consensus-specs v1.7.0-beta.4 aa16bb4c');
    expect([e.syncCommitteeSize, e.minParticipants, e.epochsPerPeriod, e.maxLinks, e.maxSpineHeaders]).toEqual([512n, 342n, 256n, 64n, 16384n]);
    expect(e.anchors.map((a) => [a.period, a.wspEpochs, a.linkSha256])).toEqual([[1378n, 279n, 'e55bc5ef6ede9cf7b1f09ba302d1723001bd03268672f2dd4875c8c38889c81d']]);
    expect(e.forks.map((f) => [f.name, Number(f.epoch), f.version, f.layout])).toEqual([
      ['genesis', 0, '0x90000069', null], ['altair', 50, '0x90000070', null], ['bellatrix', 100, '0x90000071', null],
      ['capella', 56832, '0x90000072', null], ['deneb', 132608, '0x90000073', null], ['electra', 222464, '0x90000074', 'electra'],
      ['fulu', 272640, '0x90000075', 'electra'], ['gloas', 353024, '0x90000076', 'gloas'],
    ]);
    expect(codeOf(() => anchorFor(e, 1000n))).toBe('finality_pin_unknown');
    expect(anchorFor(e, 1378n).period).toBe(1378n);
    expect(anchorFor(e, 5000n).period).toBe(1378n);
  });
  it('an absent Sepolia section is finality_pin_unknown and a raw section of another chain is kept', () => {
    const only = parsePinsOverride(enc('{\n  "format": "certen-finality-pins/1",\n  "onchain_commitment": null,\n  "published_utc": "2026-10-20T02:35:00Z"\n}\n'));
    expect(codeOf(() => sepoliaPins(only))).toBe('finality_pin_unknown');
    const [h, src] = pinsIdentity(only);
    expect(src.startsWith('override:') && h === src.slice('override:'.length)).toBe(true);
    const withBase = parsePinsOverride(enc('{\n  "base_sepolia": {"chain_id": 84532},\n  "format": "certen-finality-pins/1",\n  "published_utc": "2026-10-20T02:35:00Z"\n}\n'));
    expect(withBase.sections.has('base_sepolia')).toBe(true);
  });
  it('anchorFor chooses the latest entry with period <= sigPeriod (the two-anchor vector)', () => {
    const v = fixtureJSON('finality_chain2', 'pins.json').vectors.find((x: any) => x.name === 'pins_two_anchors_valid');
    const e = sepoliaPins(parsePinsOverride(enc(v.text)));
    expect(e.anchors.length).toBe(2);
    const [a, b] = e.anchors;
    expect(anchorFor(e, b!.period).period).toBe(b!.period);
    expect(anchorFor(e, b!.period + 100n).period).toBe(b!.period);
    expect(anchorFor(e, a!.period).period).toBe(a!.period);
    expect(codeOf(() => anchorFor(e, a!.period - 1n))).toBe('finality_pin_unknown');
  });
});

describe('loadPins refuses a hash mismatch and every malformed file', () => {
  const good = new Uint8Array(pinsFile);
  const text = pinsFile.toString('utf8');
  it('loads the good file and refuses a wrong hash with both hashes', () => {
    expect(codeOf(() => loadPins(good, want(good)))).toBe('ok');
    const wrong = want(good).slice();
    wrong[0]! ^= 1;
    try {
      loadPins(good, wrong);
      throw new Error('loaded');
    } catch (e) {
      expect((e as FinalityStateError).canonical()).toBe(
        `{"code":"finality_pins_corrupt","fields":{"got_sha256":"0x${PINS_SHA256}","reason":"sha256_mismatch","want_sha256":"0x${Buffer.from(wrong).toString('hex')}"}}`,
      );
    }
  });
  it.each([
    ['CRLF', enc(text.replaceAll('\n', '\r\n')), 'contains_cr'],
    ['unknown top level', enc(text.replace('"format"', '"zzz": 1, "format"')), 'unsorted_or_unknown'],
    ['keys unsorted', enc(text.replace('"format": "certen-finality-pins/1",', '"format": "certen-finality-pins/1", "aaa": 0,')), 'unsorted_or_unknown'],
    ['wrong format', enc(text.replace('certen-finality-pins/1', 'certen-finality-pins/2')), 'wrong_format'],
    ['not UTF-8', Uint8Array.of(...good, 0xff), 'not_utf8'],
    ['unknown inner key', enc(text.replace('"chain_id": 11155111,', '"chain_id": 11155111, "extra": 1,')), 'unsorted_or_unknown'],
    ['bad genesis root', enc(text.replace('0xd8ea17', '0xD8ea17')), 'genesis_validators_root_malformed'],
    ['layout', enc(text.replace('"layout": "gloas"', '"layout": "fulu"')), 'fork_layout_unknown'],
    ['trailing data', Uint8Array.of(...good, ...enc('{}')), 'not_json'],
    ['duplicate key', enc(text.replace('"format": "certen-finality-pins/1",', '"format": "certen-finality-pins/1", "format": "certen-finality-pins/1",')), 'duplicate_key'],
    ['byte order mark', Uint8Array.of(0xef, 0xbb, 0xbf, ...good), 'byte_order_mark'],
  ])('%s', (_n, raw, reason) => {
    let got: FinalityStateError | undefined;
    try {
      loadPins(raw, want(raw));
    } catch (e) {
      got = e as FinalityStateError;
    }
    expect(got?.code).toBe('finality_pins_corrupt');
    if (reason !== 'unsorted_or_unknown') expect(got?.fields.reason).toBe(reason);
    else expect(['keys_unsorted', 'unknown_key']).toContain(got?.fields.reason);
  });
});

describe('the strict refusals of the invariants (each with its own reason)', () => {
  const base = JSON.parse(pinsFile.toString('utf8'));
  const anchor = { block_root: '', committee_root: `0x${'11'.repeat(32)}`, derived_by: ['a'], link_sha256: '22'.repeat(32), period: 5, wsp_epochs: 279 };
  const make = (mut: (e: any) => void): Uint8Array => {
    const o = structuredClone(base);
    mut(o.eth_sepolia);
    return enc(`${JSON.stringify(sortKeys(o), null, 2)}\n`);
  };
  const sortKeys = (v: any): any =>
    Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
  const reasonOf = (raw: Uint8Array): string => {
    try {
      parsePinsOverride(raw);
    } catch (e) {
      return `${(e as FinalityStateError).code}/${(e as FinalityStateError).fields.reason}`;
    }
    return 'ok';
  };
  it.each([
    ['wsp_epochs < 256', (e: any) => (e.anchors = [{ ...anchor, wsp_epochs: 255 }]), 'finality_pins_corrupt/anchor_wsp_epochs_below_256'],
    ['wsp_epochs 256 is allowed', (e: any) => (e.anchors = [{ ...anchor, wsp_epochs: 256 }]), 'ok'],
    ['anchors not ascending', (e: any) => (e.anchors = [{ ...anchor, period: 6 }, { ...anchor, period: 5 }]), 'finality_pins_corrupt/anchor_period_not_ascending'],
    ['anchors duplicated', (e: any) => (e.anchors = [anchor, anchor]), 'finality_pins_corrupt/anchor_period_duplicate'],
    ['anchors strictly ascending', (e: any) => (e.anchors = [anchor, { ...anchor, period: 6 }]), 'ok'],
    ['derived_by empty', (e: any) => (e.anchors = [{ ...anchor, derived_by: [] }]), 'finality_pins_corrupt/anchor_derived_by_empty'],
    ['forks descending', (e: any) => (e.forks[2].epoch = 10), 'finality_pins_corrupt/fork_epoch_not_ascending'],
    ['first fork not at 0', (e: any) => (e.forks[0].epoch = 1), 'finality_pins_corrupt/first_fork_not_epoch_zero'],
    ['zero bound', (e: any) => (e.max_links = 0), 'finality_pins_corrupt/bound_missing'],
    ['participation below two thirds', (e: any) => (e.min_participants = 341), 'finality_pins_corrupt/participation_floor_invalid'],
    ['participation above the committee', (e: any) => (e.min_participants = 513), 'finality_pins_corrupt/participation_floor_invalid'],
    ['wrong chain id', (e: any) => (e.chain_id = 1), 'finality_pins_corrupt/chain_id_mismatch'],
    ['a string where an integer is', (e: any) => (e.max_links = '64'), 'finality_pins_corrupt/bad_value'],
    ['a fraction where an integer is', (e: any) => (e.max_links = 64.5), 'finality_pins_corrupt/bad_value'],
  ])('%s', (_n, mut, want) => {
    expect(reasonOf(make(mut as (e: any) => void))).toBe(want);
  });
  it('treats an integer beyond int64 as bad_value and wraps the participation product like Go int arithmetic', () => {
    const t = pinsFile.toString('utf8');
    expect(reasonOf(enc(t.replace('"max_links": 64', '"max_links": 9223372036854775808')))).toBe('finality_pins_corrupt/bad_value');
    // 3 * 3074457345618258603 = 2^63 + 2 wraps negative in Go's int, so Go refuses the floor here where unbounded arithmetic would accept it
    const wrap = t.replace('"min_participants": 342', '"min_participants": 3074457345618258603').replace('"sync_committee_size": 512', '"sync_committee_size": 3074457345618258604');
    expect(reasonOf(enc(wrap))).toBe('finality_pins_corrupt/participation_floor_invalid');
  });
});
