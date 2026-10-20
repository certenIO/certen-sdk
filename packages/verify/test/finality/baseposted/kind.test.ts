/**
 * BasePostedKind.verify before the channel: the container header, the leg, the pins and the post-Denim guard are judged in a fixed order,
 * each refusal a named state with the values it was judged at (the twin of the Go Kind.Verify refusal tests).
 */
import { describe, expect, it } from 'vitest';
import { decodeContainer, defaultLimits, encodeContainer } from '../../../src/proof-v2/finality/codec.js';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { Level } from '../../../src/proof-v2/finality/level.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { BasePostedKind } from '../../../src/proof-v2/finality/baseposted/index.js';
import { assertRegistered } from './regcheck.js';
import { bytesOfHex, read } from './vectorset.js';

const kind = new BasePostedKind();
const pins = parsePinsOverride(read('pins/main.json'));
const leg = JSON.parse(read('legs/a.json').toString('utf8')) as { chain: string; number: string; hash: string; header: string };
const ref = { chain: BigInt(leg.chain), number: BigInt(leg.number), hash: bytesOfHex(leg.hash), headerRlp: bytesOfHex(leg.header) };
const evidence = Uint8Array.from(read('evidence/valid_a.bin'));
const container = decodeContainer(evidence, defaultLimits());

const state = (fn: () => unknown): FinalityStateError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FinalityStateError) {
      assertRegistered(e);
      return e;
    }
    throw e;
  }
  throw new Error('accepted');
};
const withHeader = (h: Partial<typeof container.header>): Uint8Array => encodeContainer({ header: { ...container.header, ...h }, body: container.body });

describe('BasePostedKind.verify: the container, the leg and the pins', () => {
  it('names itself, its chain and its level', () => {
    expect(kind.name()).toBe('base-sepolia/l1_posted/v1');
    expect(kind.chain()).toBe(84532n);
    expect(kind.level()).toBe(Level.L1Posted);
  });

  it('a container of another kind is unrecognised and a container for another chain or level differs from the addendum', () => {
    expect(state(() => kind.verify(pins, ref, withHeader({ kind: 'base-sepolia/finalized/v1' }))).canonical()).toBe(
      '{"code":"finality_evidence_unrecognised","fields":{"kind":"base-sepolia/finalized/v1","version":""}}',
    );
    for (const h of [{ chain: 1n }, { level: Level.Finalized }, { chain: 84532n + 1n }]) {
      const e = state(() => kind.verify(pins, ref, withHeader(h)));
      expect(e.canonical()).toBe('{"code":"finality_evidence_malformed","fields":{"got_len":"0","part":"header.chain","reason":"differs_from_addendum","want_len":"0"}}');
    }
  });

  it('the leg must be the block the container is about, by number and then by hash', () => {
    const n = state(() => kind.verify(pins, { ...ref, number: ref.number + 1n }, evidence));
    expect(n.fields).toEqual({ field: 'blockNumber', want: ref.number + 1n, got: ref.number });
    expect(n.code).toBe('finality_block_mismatch');
    const bad = Uint8Array.from(ref.hash);
    bad[0]! ^= 1;
    const h = state(() => kind.verify(pins, { ...ref, hash: bad }, evidence));
    expect(h.code).toBe('finality_block_mismatch');
    expect(h.fields.field).toBe('blockHash');
  });

  it('the leg header is required, must hash to the leg hash and must carry the leg number', () => {
    for (const headerRlp of [undefined, new Uint8Array(0)]) {
      const e = state(() => kind.verify(pins, { ...ref, headerRlp }, evidence));
      expect(e.fields.part).toBe('leg.header');
      expect(e.fields.reason).toBe('header_not_rlp_list');
    }
    const other = bytesOfHex(JSON.parse(read('legs/b.json').toString('utf8')).header);
    const h = state(() => kind.verify(pins, { ...ref, headerRlp: other }, evidence));
    expect(h.code).toBe('finality_block_mismatch');
    expect(h.fields.field).toBe('blockHash');
    // a header whose hash is the leg hash but whose number is not the leg number: the container is re-labelled with that number
    const renumbered = withHeader({ blockNumber: ref.number + 7n });
    const nn = state(() => kind.verify(pins, { ...ref, number: ref.number + 7n }, renumbered));
    expect(nn.fields).toEqual({ field: 'blockNumber', want: ref.number + 7n, got: ref.number });
  });

  it('absent pins are named: no base_sepolia section, no Sepolia section', () => {
    expect(state(() => kind.verify(null, ref, evidence)).canonical()).toBe('{"code":"finality_pin_unknown","fields":{"chain":"84532","kind":"base_sepolia"}}');
    const onlyBase = JSON.parse(read('pins/main.json').toString('utf8'));
    delete onlyBase.eth_sepolia;
    const p = parsePinsOverride(new TextEncoder().encode(`${JSON.stringify(onlyBase, null, 2)}\n`));
    expect(state(() => kind.verify(p, ref, evidence)).canonical()).toBe('{"code":"finality_pin_unknown","fields":{"chain":"11155111","kind":"eth_sepolia"}}');
  });

  it('a block at or after the Denim time is the named batch_format_unsupported{post_denim}', () => {
    const p = parsePinsOverride(read('pins/denim_at_block_a.json'));
    expect(state(() => kind.verify(p, ref, evidence)).canonical()).toBe('{"code":"batch_format_unsupported","fields":{"type":"post_denim"}}');
  });

  it('garbage and a trailing byte are refused by the container and body codecs', () => {
    expect(state(() => kind.verify(pins, ref, new TextEncoder().encode('NOPE0000'))).code).toBe('finality_evidence_unrecognised');
    expect(state(() => kind.verify(pins, ref, Uint8Array.of(1, 2, 3))).code).toBe('finality_evidence_malformed');
    const trailing = new Uint8Array(evidence.length + 1);
    trailing.set(evidence);
    expect(state(() => kind.verify(pins, ref, trailing)).fields.reason).toBe('trailing_bytes');
  });
});
