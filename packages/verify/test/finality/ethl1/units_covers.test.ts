/**
 * Unit tests of the execution-header spine (covers, blockAt, the positional RLP reader) beyond the vector set: the exact reason of
 * every positional-reader refusal, the uint64 wrap of at_number, the order of the chain checks, and the bounds.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import {
  blockAt,
  covers,
  rlpHeaderItems,
  type FinalizedHead,
  type L1Block,
} from '../../../src/proof-v2/finality/ethl1/index.js';
import { readHeader } from '../../../src/proof-v2/finality/rlpheader.js';
import { FinalityStateError, hexLower } from '../../../src/proof-v2/finality/state.js';
import { readSpineFile } from './helpers.js';

const cat = (...p: Uint8Array[]): Uint8Array => Uint8Array.from(p.flatMap((x) => Array.from(x)));
const lenPrefix = (base: number, n: number): Uint8Array => {
  if (n <= 55) return Uint8Array.of(base + n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Uint8Array.of(base + 55 + bytes.length, ...bytes);
};
const str = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? b : cat(lenPrefix(0x80, b.length), b));
const list = (...items: Uint8Array[]): Uint8Array => {
  const body = cat(...items);
  return cat(lenPrefix(0xc0, body.length), body);
};
const uint = (n: bigint): Uint8Array => {
  const b: number[] = [];
  for (let v = n; v > 0n; v >>= 8n) b.unshift(Number(v & 0xffn));
  return str(Uint8Array.from(b));
};
const fill = (b: number, n = 32): Uint8Array => new Uint8Array(n).fill(b);

/** A header of `extra` further items after the twelve the verifier reads (23 items on Sepolia since 2026-10-06). */
function header(parent: Uint8Array, state: Uint8Array, number: bigint, timestamp: bigint, extra = 11): Uint8Array {
  return list(
    str(parent), str(fill(0x01)), str(fill(0x02, 20)), str(state), str(fill(0x04)), str(fill(0x05)), str(fill(0x06, 256)),
    uint(0n), uint(number), uint(30000000n), uint(1n), uint(timestamp),
    ...Array.from({ length: extra }, (_, i) => str(fill(0x10 + i, 3))),
  );
}

const keccak = (b: Uint8Array): Uint8Array => keccak_256(b);
const headOf = (h: Uint8Array): FinalizedHead => ({ slot: 0n, epoch: 0n, beaconRoot: new Uint8Array(32), execHash: keccak(h), participants: 0, periodsCrossed: 0n });
const named = (f: () => unknown): FinalityStateError => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('did not throw');
};

/** headers[0] is the top; each header's parent hash is the hash of the next one. */
function chain(top: bigint, n: number, tsBase = 1000n): Uint8Array[] {
  const out: Uint8Array[] = new Array(n);
  let parent = fill(0xaa);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = header(parent, fill(0x30 + (i % 16)), top - BigInt(i), tsBase + BigInt(n - i));
    parent = keccak(out[i]!);
  }
  return out;
}

describe('covers', () => {
  it('walks a chain top first and returns each header\'s hash, number, state root and timestamp read positionally', () => {
    const sp = chain(100n, 4);
    const blocks = covers(headOf(sp[0]!), sp, 16);
    expect(blocks.map((b) => b.number)).toEqual([100n, 99n, 98n, 97n]);
    expect(blocks.map((b) => b.timestamp)).toEqual([1004n, 1003n, 1002n, 1001n]);
    for (let i = 0; i < 4; i++) {
      expect(hexLower(blocks[i]!.hash)).toBe(hexLower(keccak(sp[i]!)));
      expect(hexLower(blocks[i]!.stateRoot)).toBe(hexLower(fill(0x30 + (i % 16))));
    }
    // exactly max headers is accepted, one more is too large with the count reported
    expect(covers(headOf(sp[0]!), sp, 4).length).toBe(4);
    expect(named(() => covers(headOf(sp[0]!), sp, 3)).canonical()).toBe('{"code":"finality_evidence_too_large","fields":{"count":"4","limit":"3","part":"spine"}}');
    expect(named(() => covers(headOf(sp[0]!), [], 3)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"0","index":"0","part":"spine","reason":"empty","want_len":"1"}}',
    );
  });

  it('reads a header of any item count at least twelve, hashed as given', () => {
    for (const extra of [0, 5, 9, 11, 40]) {
      const h = header(fill(0xaa), fill(0x77), 55n, 2000n, extra);
      const [b] = covers(headOf(h), [h], 1);
      expect(b!.number).toBe(55n);
      expect(hexLower(b!.hash)).toBe(hexLower(keccak(h)));
    }
    const short = list(...Array.from({ length: 11 }, () => str(fill(1, 32))));
    expect(named(() => covers(headOf(short), [short], 1)).fields.reason).toBe('rlp');
  });

  it('refuses a head hash mismatch with the number of the first header', () => {
    const sp = chain(100n, 2);
    const wrong: FinalizedHead = { ...headOf(sp[0]!), execHash: fill(0x99) };
    expect(named(() => covers(wrong, sp, 8)).canonical()).toBe(
      `{"code":"finality_header_chain_broken","fields":{"at_number":"100","got_hash":"0x${hexLower(keccak(sp[0]!))}","reason":"hash","spine":"l1","want_hash":"0x${'99'.repeat(32)}"}}`,
    );
  });

  it('refuses a hash break and a number break between neighbours, each with the child\'s expected number', () => {
    const sp = chain(100n, 3);
    const hashBroken = [sp[0]!, sp[2]!];
    expect(named(() => covers(headOf(sp[0]!), hashBroken, 8)).canonical()).toBe(
      `{"code":"finality_header_chain_broken","fields":{"at_number":"99","got_hash":"0x${hexLower(keccak(sp[2]!))}","reason":"hash","spine":"l1","want_hash":"0x${hexLower(keccak(sp[1]!))}"}}`,
    );
    // number break: the child hashes right but has the wrong number
    const child = header(fill(0xaa), fill(0x40), 90n, 1n);
    const top = header(keccak(child), fill(0x41), 100n, 2n);
    const e = named(() => covers(headOf(top), [top, child], 8));
    expect(e.fields.reason).toBe('number');
    expect(e.fields.at_number).toBe(99n);
    expect(hexLower(e.fields.want_hash as Uint8Array)).toBe(hexLower(keccak(child)));
    expect(hexLower(e.fields.got_hash as Uint8Array)).toBe(hexLower(keccak(child)));
    // a child numbered above its parent is a number break as well
    const up = header(fill(0xaa), fill(0x40), 101n, 1n);
    const top2 = header(keccak(up), fill(0x41), 100n, 2n);
    expect(named(() => covers(headOf(top2), [top2, up], 8)).fields.reason).toBe('number');
  });

  it('wraps at_number at 2^64 like Go\'s uint64 when the top header is block zero', () => {
    const child = header(fill(0xaa), fill(0x40), 5n, 1n);
    const genesis = header(keccak(child), fill(0x41), 0n, 2n);
    const e = named(() => covers(headOf(genesis), [genesis, child], 8));
    expect(e.fields.reason).toBe('number');
    expect(e.canonical()).toContain('"at_number":"18446744073709551615"');
    const e2 = named(() => covers(headOf(genesis), [genesis, header(fill(0xaa), fill(0x40), 6n, 1n)], 8));
    expect(e2.fields.reason).toBe('hash');
    expect(e2.canonical()).toContain('"at_number":"18446744073709551615"');
  });

  it('reports an unreadable header as rlp with the hash it should have had', () => {
    const sp = chain(100n, 3);
    const junk = Uint8Array.of(1, 2, 3);
    const e0 = named(() => covers(headOf(sp[0]!), [junk], 8));
    expect(e0.canonical()).toBe(
      `{"code":"finality_header_chain_broken","fields":{"at_number":"0","got_hash":"0x${hexLower(keccak(junk))}","reason":"rlp","spine":"l1","want_hash":"0x${hexLower(keccak(sp[0]!))}"}}`,
    );
    const e1 = named(() => covers(headOf(sp[0]!), [sp[0]!, junk], 8));
    expect(e1.fields.at_number).toBe(99n);
    expect(e1.fields.reason).toBe('rlp');
    expect(hexLower(e1.fields.want_hash as Uint8Array)).toBe(hexLower(keccak(sp[1]!)));
    // an unreadable second header after a block-zero top wraps as well
    const genesis = header(fill(0xaa), fill(0x41), 0n, 2n);
    expect(named(() => covers(headOf(genesis), [genesis, junk], 8)).fields.at_number).toBe(2n ** 64n - 1n);
  });
});

describe('the positional RLP reader', () => {
  const ok = (n = 11): Uint8Array => header(fill(0xaa), fill(0xbb), 7n, 9n, n);
  it('accepts a header and reports the item count', () => {
    const r = rlpHeaderItems(ok(11));
    expect(r.reason).toBe('');
    expect(r.count).toBe(23);
    expect(r.items.length).toBe(12);
    expect(rlpHeaderItems(ok(0)).count).toBe(12);
  });
  it('names each refusal', () => {
    expect(rlpHeaderItems(new Uint8Array(0)).reason).toBe('not_a_list');
    expect(rlpHeaderItems(Uint8Array.of(0x80)).reason).toBe('not_a_list');
    expect(rlpHeaderItems(Uint8Array.of(0xbf, 0)).reason).toBe('not_a_list');
    // list prefix: long form with a leading zero length byte, more length bytes than 4, truncated length, non-canonical length
    expect(rlpHeaderItems(Uint8Array.of(0xf8, 0)).reason).toBe('list_length');
    expect(rlpHeaderItems(Uint8Array.of(0xfc, 1, 2, 3, 4, 5)).reason).toBe('list_length');
    expect(rlpHeaderItems(Uint8Array.of(0xf9)).reason).toBe('list_length');
    expect(rlpHeaderItems(Uint8Array.of(0xf8, 55, ...new Uint8Array(55))).reason).toBe('list_length_noncanonical');
    expect(rlpHeaderItems(Uint8Array.of(0xc2, 0x80)).reason).toBe('list_length_mismatch');
    expect(rlpHeaderItems(Uint8Array.of(0xc0, 0x80)).reason).toBe('list_length_mismatch');
    const good = ok();
    expect(rlpHeaderItems(cat(good, Uint8Array.of(0))).reason).toBe('list_length_mismatch');
    expect(rlpHeaderItems(good.subarray(0, good.length - 1)).reason).toBe('list_length_mismatch');
    // item level
    const wrap = (...items: Uint8Array[]): Uint8Array => list(...items, ...Array.from({ length: 12 }, () => uint(1n)));
    expect(rlpHeaderItems(wrap(Uint8Array.of(0x81, 0x05))).reason).toBe('string_noncanonical');
    expect(rlpHeaderItems(wrap(Uint8Array.of(0x81, 0x80))).reason).toBe('');
    expect(rlpHeaderItems(wrap(Uint8Array.of(0xb8, 0))).reason).toBe('string_length');
    expect(rlpHeaderItems(wrap(Uint8Array.of(0xb8, 5, 1, 2, 3, 4, 5))).reason).toBe('string_length_noncanonical');
    expect(rlpHeaderItems(wrap(Uint8Array.of(0xbc, 1, 2, 3, 4, 5))).reason).toBe('string_length');
    const tailOf = (...t: number[]): Uint8Array => list(...Array.from({ length: 12 }, () => uint(1n)), Uint8Array.from(t));
    expect(rlpHeaderItems(tailOf(0xb9, 0x01)).reason).toBe('string_length');
    expect(rlpHeaderItems(tailOf(0xf9, 0x01)).reason).toBe('list_length');
    expect(rlpHeaderItems(tailOf(0xb9, 0x01, 0x00)).reason).toBe('item_overruns');
    expect(rlpHeaderItems(tailOf(0x85, 1, 2)).reason).toBe('item_overruns');
    expect(rlpHeaderItems(wrap(Uint8Array.of(0xf8, 0))).reason).toBe('list_length');
    expect(rlpHeaderItems(wrap(Uint8Array.of(0xf8, 7, 1))).reason).toBe('list_length_noncanonical');
    expect(rlpHeaderItems(wrap(Uint8Array.of(0xfd, 1))).reason).toBe('list_length');
    expect(rlpHeaderItems(wrap(Uint8Array.of(0xc2, 1, 2))).reason).toBe('item_not_string');
    // a list among the first twelve items is refused; a list after them is only counted
    const tail = list(...Array.from({ length: 12 }, () => uint(1n)), list(uint(1n)));
    expect(rlpHeaderItems(tail)).toMatchObject({ reason: '', count: 13 });
    // fewer than twelve items
    expect(rlpHeaderItems(list(...Array.from({ length: 11 }, () => uint(1n))))).toMatchObject({ reason: 'too_few_items', count: 11 });
    expect(rlpHeaderItems(list())).toMatchObject({ reason: 'too_few_items', count: 0 });
    // a long-form list prefix (payload >= 56) with a 2-byte length is parsed
    const big = header(fill(0xaa), fill(0xbb), 7n, 9n, 40);
    expect(big[0]).toBeGreaterThanOrEqual(0xf9);
    expect(rlpHeaderItems(big).reason).toBe('');
  });
  it('refuses items the verifier reads when they have the wrong shape', () => {
    const mk = (over: Record<number, Uint8Array>): Uint8Array => {
      const items = [str(fill(0xaa)), str(fill(1)), str(fill(2, 20)), str(fill(0xbb)), str(fill(4)), str(fill(5)), str(fill(6, 256)), uint(0n), uint(7n), uint(1n), uint(1n), uint(9n)];
      for (const [i, v] of Object.entries(over)) items[Number(i)] = v;
      return list(...items);
    };
    const reason = (h: Uint8Array): string => {
      try {
        covers(headOf(h), [h], 1);
        return 'ok';
      } catch (e) {
        return `${(e as FinalityStateError).fields.reason}`;
      }
    };
    expect(reason(mk({}))).toBe('ok');
    expect(reason(mk({ 0: str(fill(0xaa, 31)) }))).toBe('rlp');
    expect(reason(mk({ 3: str(fill(0xbb, 33)) }))).toBe('rlp');
    expect(reason(mk({ 8: str(fill(0x01, 9)) }))).toBe('rlp');
    expect(reason(mk({ 8: Uint8Array.of(0x82, 0, 1) }))).toBe('rlp');
    expect(reason(mk({ 11: str(fill(0x01, 9)) }))).toBe('rlp');
    expect(reason(mk({ 11: Uint8Array.of(0x82, 0, 1) }))).toBe('rlp');
    expect(reason(mk({ 8: Uint8Array.of(0x80) }))).toBe('ok'); // number zero is the empty string
    expect(reason(mk({ 8: str(fill(0xff, 8)) }))).toBe('ok');
  });
});

describe('blockAt', () => {
  const blocks = (top: bigint, n: number): L1Block[] =>
    Array.from({ length: n }, (_, i) => ({ hash: fill(i), number: top - BigInt(i), stateRoot: fill(i + 100), timestamp: BigInt(i) }));
  it('finds a number inside the spine and names the top when it lies outside', () => {
    const b = blocks(100n, 5);
    expect(blockAt(b, 100n).number).toBe(100n);
    expect(blockAt(b, 96n).number).toBe(96n);
    expect(hexLower(blockAt(b, 98n).stateRoot)).toBe(hexLower(fill(102)));
    expect(named(() => blockAt(b, 101n)).canonical()).toBe('{"code":"finality_block_not_covered","fields":{"block_number":"101","finalized_exec_number":"100"}}');
    expect(named(() => blockAt(b, 95n)).canonical()).toBe('{"code":"finality_block_not_covered","fields":{"block_number":"95","finalized_exec_number":"100"}}');
    expect(named(() => blockAt([], 7n)).canonical()).toBe('{"code":"finality_block_not_covered","fields":{"block_number":"7","finalized_exec_number":"0"}}');
    expect(blockAt(blocks(3n, 4), 0n).number).toBe(0n);
  });
});

describe('why covers has its own positional reader (the framework readHeader accepts a different set)', () => {
  const items = (over: Record<number, Uint8Array>): Uint8Array => {
    const it = [str(fill(0xaa)), str(fill(1)), str(fill(2, 20)), str(fill(0xbb)), str(fill(4)), str(fill(5)), str(fill(6, 256)), uint(0n), uint(7n), uint(1n), uint(1n), uint(9n)];
    for (const [i, v] of Object.entries(over)) it[Number(i)] = v;
    return list(...it);
  };
  it('the Go ethl1 reader refuses a list in an unread slot; readHeader accepts it', () => {
    const h = items({ 1: list(uint(1n)) });
    expect(rlpHeaderItems(h).reason).toBe('item_not_string');
    expect(() => readHeader(h)).not.toThrow();
  });
  it('the Go ethl1 reader accepts a short transactions root; readHeader refuses it', () => {
    const h = items({ 4: str(fill(4, 31)) });
    expect(rlpHeaderItems(h).reason).toBe('');
    expect(() => readHeader(h)).toThrow();
    const [b] = covers(headOf(h), [h], 1);
    expect(b!.number).toBe(7n);
  });
  it('the two readers agree on every header of the published legacy spine (4,057 Fulu-era headers)', () => {
    const spine = readSpineFile('raw/spine_legacy.bin');
    expect(spine.length).toBe(4057);
    for (const raw of spine) {
      const a = readHeader(raw);
      const r = rlpHeaderItems(raw);
      expect(r.reason).toBe('');
      expect(hexLower(a.stateRoot)).toBe(hexLower(r.items[3]!));
      expect(hexLower(a.parentHash)).toBe(hexLower(r.items[0]!));
    }
  });
});

describe('the positional RLP reader: length-of-length boundaries', () => {
  const ones = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => 1);
  const tailOf = (...t: number[]): Uint8Array => list(...Array.from({ length: 12 }, () => uint(1n)), Uint8Array.from(t));

  it('a list payload of exactly 55 bytes uses the short form (0xf7); 56 uses the long form', () => {
    const item = cat(Uint8Array.of(0x80 + 42), ones(42)); // 43 bytes
    const short = cat(Uint8Array.of(0xf7), ones(12), item);
    expect(short.length).toBe(56);
    expect(rlpHeaderItems(short)).toMatchObject({ reason: '', count: 13 });
    const long = cat(Uint8Array.of(0xf8, 56), ones(12), cat(Uint8Array.of(0x80 + 43), ones(43)));
    expect(rlpHeaderItems(long)).toMatchObject({ reason: '', count: 13 });
  });

  it('accepts a four-byte list length and a four-byte string length (a 16 MiB header)', () => {
    const n = 1 << 24; // the last item: 0xbb + 4 length bytes (no leading zero byte needs n >= 2^24) + n bytes
    const total = 12 + 5 + n; // payload length of the list
    const body = new Uint8Array(total);
    body.fill(1, 0, 12);
    body.set([0xbb, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], 12);
    const raw = cat(Uint8Array.of(0xfb, (total >>> 24) & 255, (total >>> 16) & 255, (total >>> 8) & 255, total & 255), body);
    expect(rlpHeaderItems(raw)).toMatchObject({ reason: '', count: 13 });
    // five length bytes are never accepted
    expect(rlpHeaderItems(Uint8Array.of(0xfc, 1, 0, 0, 0, 0)).reason).toBe('list_length');
    expect(rlpHeaderItems(tailOf(0xbc, 1, 0, 0, 0, 0)).reason).toBe('string_length');
    expect(rlpHeaderItems(tailOf(0xfc, 1, 0, 0, 0, 0)).reason).toBe('list_length');
  });

  it('a length-of-length that exactly fills the remaining bytes is parsed, not refused as truncated', () => {
    expect(rlpHeaderItems(Uint8Array.of(0xf8, 100)).reason).toBe('list_length_mismatch');
    expect(rlpHeaderItems(tailOf(0xb8, 100)).reason).toBe('item_overruns');
    expect(rlpHeaderItems(tailOf(0xf8, 100)).reason).toBe('item_overruns');
    expect(rlpHeaderItems(tailOf(0xb8)).reason).toBe('string_length');
    expect(rlpHeaderItems(tailOf(0xf8)).reason).toBe('list_length');
  });
});
