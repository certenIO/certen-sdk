/**
 * RB11-D2-FIX and RB11-E2B/E2-FIX on base-sepolia/l1_posted/v1 (the findings of the independent review V-D2-A1; Go 42083c43, e9ac28d, 14472e2,
 * aa50bc8 at pv2/rb11-e1-raise@cbb6373): every deposit transaction must be type 0x7e and no batch transaction may be one (or empty), the
 * channel timeout is 50 from Granite and 300 before it and is selected per frame by the timestamp of the L1 block holding that frame, the
 * Granite pins are required, isthmus_time changes no verdict, the OP Brotli channel is read strictly, no pin near 2^64 wraps, and the KZG
 * setup pin is read from the shared section (a legacy copy in base_sepolia only when no shared section exists).
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { embeddedPins, parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError, canonValue } from '../../../src/proof-v2/finality/state.js';
import { ChannelError, decompress } from '../../../src/proof-v2/finality/baseposted/channel.js';
import { parseBasePins } from '../../../src/proof-v2/finality/baseposted/pins.js';
import { trieRoot } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { verifyChannel } from '../../../src/proof-v2/finality/baseposted/verify.js';
import { assertRegistered } from './regcheck.js';
import { l1InfoDeposit, makeSynth, rlpStreamItem, singularPayload, userTx, utf8, type Synth, type SynthOpts } from './synth.js';
import { readPins } from './vectorset.js';

const run = (s: Synth) => verifyChannel(s.bp, s.body, s.covered, s.l2, s.head);
const refusal = (fn: () => unknown): FinalityStateError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FinalityStateError) {
      assertRegistered(e);
      return e;
    }
    throw e;
  }
  throw new Error('verified, but a refusal was expected');
};
const wantCode = (fn: () => unknown, code: string, fields: Record<string, string> = {}): void => {
  const e = refusal(fn);
  expect(e.code, e.canonical()).toBe(code);
  for (const [k, v] of Object.entries(fields)) expect(JSON.parse(canonValue(e.fields[k]!)), `${code}.${k}`).toBe(v);
};
const mustOK = (s: Synth): void => {
  run(s);
};

const parent = keccak_256(utf8('parent'));
const epochHash = keccak_256(utf8('epoch hash'));
const U64MAX = (1n << 64n) - 1n;

// ---- V-D2-A1 defect 1: the types of depositTxs and of the batch's transactions ----

/** A synthetic world whose batch carries batchTxs, whose block holds blockTxs and whose depositTxs are deposits. */
function synthBound(batchTxs: Uint8Array[], deposits: Uint8Array[], blockTxs: Uint8Array[]): Synth {
  const s = makeSynth({ compression: 'zlib', rawStream: rlpStreamItem(0, singularPayload(parent, 990n, epochHash, 1790000000n, batchTxs)) });
  s.body.deposits = deposits;
  return { ...s, l2: { ...s.l2, transactionRoot: trieRoot(blockTxs) } };
}

describe('depositTxs must all be deposits and the batch transactions must not be (V-D2-A1 defect 1)', () => {
  const dep0 = makeSynth({ compression: 'zlib' }).body.deposits[0]!;
  const depX = l1InfoDeposit(991n, epochHash);
  const u1 = userTx(1n);
  const u2 = userTx(2n);
  const empty = new Uint8Array(0);
  const cases: [string, Uint8Array[], Uint8Array[], Uint8Array[], string][] = [
    ['a user tx the batch never carried is moved into depositTxs', [u2], [dep0, u1], [dep0, u1, u2], 'deposit_txs'],
    ['an empty batch with every user tx in depositTxs', [], [dep0, u1, u2], [dep0, u1, u2], 'deposit_txs'],
    ['the last depositTxs entry is a user tx', [], [dep0, depX, u1], [dep0, depX, u1], 'deposit_txs'],
    ['an empty depositTxs entry', [u1, u2], [dep0, empty], [dep0, u1, u2], 'deposit_txs'],
    ['the batch carries a deposit-typed tx', [depX], [dep0], [dep0, depX], 'batch_txs'],
    ['the batch carries a deposit-typed tx between user txs', [u1, depX, u2], [dep0], [dep0, u1, depX, u2], 'batch_txs'],
    ['the batch carries an empty tx', [u1, empty], [dep0], [dep0, u1, empty], 'batch_txs'],
  ];
  for (const [name, batch, deposits, block, field] of cases) {
    it(name, () => wantCode(() => run(synthBound(batch, deposits, block)), 'batch_binding_mismatch', { field }));
  }
  it('a deposit entry that is only the type byte is typed: the transactions root, not the type check, decides (Go d2fix)', () => {
    const typeOnly = Uint8Array.of(0x7e);
    mustOK(synthBound([u1, u2], [dep0, typeOnly], [dep0, typeOnly, u1, u2]));
    wantCode(() => run(synthBound([u1, u2], [dep0, typeOnly], [dep0, u1, u2])), 'batch_binding_mismatch', { field: 'transactions_root' });
    wantCode(() => run(synthBound([u1, u2], [dep0, Uint8Array.of(0x02)], [dep0, Uint8Array.of(0x02), u1, u2])), 'batch_binding_mismatch', { field: 'deposit_txs' });
  });
  it('positive controls: several leading deposits are fine when they are all deposit-typed', () => {
    mustOK(synthBound([u1, u2], [dep0], [dep0, u1, u2]));
    mustOK(synthBound([u1, u2], [dep0, depX], [dep0, depX, u1, u2]));
    mustOK(synthBound([], [dep0, depX], [dep0, depX]));
  });
  it('the first deposit is checked before the others: a non-deposit first entry is l1_info_deposit, not deposit_txs', () => {
    wantCode(() => run(synthBound([u2], [u1], [u1, u2])), 'batch_binding_mismatch', { field: 'l1_info_deposit' });
    wantCode(() => run(synthBound([], [], [])), 'batch_binding_mismatch', { field: 'l1_info_deposit' });
  });
});

// ---- V-D2-A1 defect 4: the channel timeout ----

describe('the channel timeout is 50 after Granite, 300 before it, selected by the L1 block time of each frame (V-D2-A1 defect 4)', () => {
  // the synthetic L1 block n is timed 1790000000 + n
  const world = (granite: bigint, ...blocks: bigint[]): Synth => {
    const s = makeSynth({ compression: 'zlib', nFrames: blocks.length, frameBlocks: blocks });
    s.bp.graniteTime = granite;
    return s;
  };
  const past = 1723478400n; // Granite long ago
  const far = 1790000000n + 1_000_000n; // Granite after the world
  const edge = 1790000000n + 1100n; // block 1100 is the first Granite block

  it('post-Granite: a gap of 50 verifies and 51, 250, 300, 301 are channel_timed_out', () => {
    mustOK(world(past, 1000n, 1050n));
    for (const gap of [51n, 250n, 300n, 301n]) wantCode(() => run(world(past, 1000n, 1000n + gap)), 'channel_timed_out');
  });
  it('pre-Granite: gaps of 51, 250 and 300 verify and 301 is channel_timed_out', () => {
    for (const gap of [51n, 250n, 300n]) mustOK(world(far, 1000n, 1000n + gap));
    wantCode(() => run(world(far, 1000n, 1301n)), 'channel_timed_out');
  });
  it('the switch: block 1099 is before Granite and block 1100 (time == granite_time) is the first after it', () => {
    mustOK(world(edge, 1000n, 1099n));
    wantCode(() => run(world(edge, 1000n, 1100n)), 'channel_timed_out');
    // selecting by the FIRST frame block would accept (gap 150 <= 300)
    wantCode(() => run(world(edge, 1000n, 1150n)), 'channel_timed_out');
    mustOK(world(edge, 1100n, 1150n));
  });
  it('a gap is measured from the first frame to each later frame, so a later frame back within the bound is not rescued by an earlier one', () => {
    mustOK(world(past, 1000n, 1020n, 1050n));
    wantCode(() => run(world(past, 1000n, 1020n, 1051n)), 'channel_timed_out');
  });
});

describe('isthmus_time is an informational pin of l1_posted: no value of it changes a verdict (V-D2-A1 defect 3)', () => {
  const outcomes = (isthmus: bigint): string[] => {
    const out: string[] = [];
    for (const o of [{}, { nFrames: 2, frameBlocks: [1000n, 1100n] }, { epochNum: 990n, frameBlocks: [4591n] }] as SynthOpts[]) {
      const s = makeSynth({ compression: 'zlib', ...o });
      s.bp.isthmusTime = isthmus;
      try {
        out.push(`ok ${canonValue(run(s).fields)}`);
      } catch (e) {
        if (!(e instanceof FinalityStateError)) throw e;
        out.push(e.canonical());
      }
    }
    return out;
  };
  it('verdicts are identical for 1, the Granite time, the world time, +5000 and 2^64-1', () => {
    const base = outcomes(1744905600n);
    for (const ts of [1n, 1723478400n, 1790000000n, 1790000000n + 5000n, U64MAX]) expect(outcomes(ts)).toEqual(base);
    expect(base[0]!.startsWith('ok ')).toBe(true);
    expect(base[1]).toContain('channel_timed_out');
    expect(base[2]).toContain('batch_outside_sequencing_window');
  });
});

// ---- the pins ----

describe('the Granite pins are required, non-zero and read; the embedded values are op-node\'s', () => {
  const withSection = (edit: (s: any) => void) => {
    const j = JSON.parse(readPins('pins/main.json').toString('utf8'));
    edit(j.base_sepolia);
    const sorted = (v: any): any => (Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
    return parsePinsOverride(new TextEncoder().encode(`${JSON.stringify(sorted(j), null, 2)}\n`));
  };
  const corrupt = (key: string): string => `{"code":"finality_pins_corrupt","fields":{"key":"${key}","reason":"bad_value"}}`;

  it('the embedded base_sepolia section carries granite_time 1723478400 and channel_timeout_granite 50 beside channel_timeout 300', () => {
    const bp = parseBasePins(embeddedPins());
    expect([bp.graniteTime, bp.channelTimeoutGranite, bp.channelTimeout]).toEqual([1723478400n, 50n, 300n]);
    expect(bp.kzgSetupKey).toBe('shared.kzg_setup_sha256');
  });
  for (const key of ['granite_time', 'channel_timeout_granite']) {
    it(`${key}: zero and absent are finality_pins_corrupt{bad_value, base_sepolia.${key}}`, () => {
      expect(refusal(() => parseBasePins(withSection((s) => (s[key] = 0)))).canonical()).toBe(corrupt(`base_sepolia.${key}`));
      expect(refusal(() => parseBasePins(withSection((s) => delete s[key]))).canonical()).toBe(corrupt(`base_sepolia.${key}`));
    });
  }
});

describe('max_blobs is an int: values above the largest 32-bit int are clamped to it, below it exact', () => {
  const blobsOf = (v: number | bigint): number => {
    const j = JSON.parse(readPins('pins/main.json').toString('utf8'));
    j.base_sepolia.max_blobs = v;
    const sorted = (x: any): any => (Array.isArray(x) ? x.map(sorted) : x !== null && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sorted(x[k])])) : x);
    return parseBasePins(parsePinsOverride(new TextEncoder().encode(`${JSON.stringify(sorted(j), null, 2)}
`))).maxBlobs;
  };
  it('1 and 32 are exact, 2^31-1 is exact, 2^31 and 2^40 are clamped to 2^31-1', () => {
    expect(blobsOf(1)).toBe(1);
    expect(blobsOf(32)).toBe(32);
    expect(blobsOf(2147483647)).toBe(2147483647);
    expect(blobsOf(2147483648)).toBe(2147483647);
    expect(blobsOf(1099511627776)).toBe(2147483647);
  });
});

describe('the KZG setup pin is read from the shared section (Go KZGSetupPin), a legacy copy only when there is none', () => {
  const KZG = 'f8e44a31ebf0a6d0734dcb301b0716e2c77f3ae18ed0cab0870fbcc2ca55616f';
  const doc = (edit: (j: any) => void) => {
    const j = JSON.parse(readPins('pins/main.json').toString('utf8'));
    edit(j);
    const sorted = (v: any): any => (Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
    return parsePinsOverride(new TextEncoder().encode(`${JSON.stringify(sorted(j), null, 2)}\n`));
  };
  const corrupt = (key: string): string => `{"code":"finality_pins_corrupt","fields":{"key":"${key}","reason":"bad_value"}}`;

  it('a shared pin alone loads (no base_sepolia copy), and the shared pin equal to the legacy copy loads', () => {
    const alone = parseBasePins(doc((j) => { j.shared = { kzg_setup_sha256: KZG }; delete j.base_sepolia.kzg_setup_sha256; }));
    expect(alone.kzgSetupSha256).toBe(KZG);
    expect(alone.kzgSetupKey).toBe('shared.kzg_setup_sha256');
    const both = parseBasePins(doc((j) => (j.shared = { kzg_setup_sha256: KZG })));
    expect(both.kzgSetupKey).toBe('shared.kzg_setup_sha256');
  });
  it('a shared pin that differs from the legacy copy is finality_pins_corrupt naming the legacy key (never "the shared one wins")', () => {
    expect(refusal(() => parseBasePins(doc((j) => (j.shared = { kzg_setup_sha256: 'ab'.repeat(32) })))).canonical()).toBe(corrupt('base_sepolia.kzg_setup_sha256'));
  });
  it('neither a shared pin nor a legacy copy is finality_pins_corrupt naming the shared key', () => {
    expect(refusal(() => parseBasePins(doc((j) => delete j.base_sepolia.kzg_setup_sha256))).canonical()).toBe(corrupt('shared.kzg_setup_sha256'));
  });
  it('a malformed shared pin is refused under the shared key', () => {
    expect(refusal(() => parseBasePins(doc((j) => { j.shared = { kzg_setup_sha256: 'F8' }; delete j.base_sepolia.kzg_setup_sha256; }))).canonical()).toContain('finality_pins_corrupt');
  });
});

// ---- the OP Brotli channel is read strictly ----

const brotliChannel = (data: Uint8Array): Uint8Array => Uint8Array.from([1, ...brotliCompressSync(data)]);
const patterned = (n: number, seed = 5): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 131 + seed + (i >> 5) * 17) & 0xff);

describe('a Brotli channel is a complete stream and nothing else (Go e9ac28d strictbrotli)', () => {
  const data = patterned(500);
  const ch = brotliChannel(data);
  const caught = (fn: () => unknown): unknown => {
    try {
      return fn();
    } catch (e) {
      return e;
    }
  };

  it('the complete channel decompresses to the data', () => {
    expect(Array.from(decompress(ch, 1n << 20n))).toEqual(Array.from(data));
  });
  it('a channel cut at any byte after the type byte is refused', () => {
    for (let i = 2; i < ch.length; i++) expect(caught(() => decompress(ch.subarray(0, i), 1n << 20n)), `cut to ${i} of ${ch.length}`).toBeInstanceOf(ChannelError);
  });
  it('the version byte alone (the empty stream) is refused', () => {
    expect(caught(() => decompress(Uint8Array.of(1), 1n << 20n))).toBeInstanceOf(ChannelError);
  });
  it('a byte after the end of the stream is refused, whatever it is', () => {
    for (const b of [0, 1, 0xff]) expect(caught(() => decompress(Uint8Array.from([...ch, b]), 1n << 20n)), `trailing ${b}`).toBeInstanceOf(ChannelError);
  });
  it('the smallest complete Brotli streams are streams of zero bytes, not "empty" ones: they decode to nothing and a byte after them is refused', () => {
    for (const b of [0x3b, 0x06]) {
      expect(decompress(Uint8Array.of(1, b), 1n << 20n).length, `stream ${b}`).toBe(0);
      expect(caught(() => decompress(Uint8Array.of(1, b, 0), 1n << 20n)), `stream ${b} + 1 byte`).toBeInstanceOf(ChannelError);
    }
    // and a one-byte stream that is not complete (an unterminated metablock header) is refused
    for (const b of [0x03, 0x0b, 0x13, 0x1b]) expect(caught(() => decompress(Uint8Array.of(1, b), 1n << 20n)), `stream ${b}`).toBeInstanceOf(ChannelError);
  });
  it('the cap is exact: len bytes pass and one fewer refuses', () => {
    expect(decompress(ch, BigInt(data.length)).length).toBe(data.length);
    expect(caught(() => decompress(ch, BigInt(data.length - 1)))).toBeInstanceOf(ChannelError);
  });
  it('the largest caps neither wrap nor refuse a channel that fits (Brotli and zlib)', () => {
    const rep = new Uint8Array(4000).map((_, i) => 'channel '.charCodeAt(i % 8));
    const z = deflateSync(rep);
    const b = brotliChannel(rep);
    for (const max of [BigInt(rep.length), (1n << 63n) - 2n, (1n << 63n) - 1n, 1n << 63n, U64MAX]) {
      expect(decompress(b, max).length, `brotli cap ${max}`).toBe(rep.length);
      expect(decompress(z, max).length, `zlib cap ${max}`).toBe(rep.length);
    }
    expect(caught(() => decompress(b, BigInt(rep.length - 1)))).toBeInstanceOf(ChannelError);
    expect(caught(() => decompress(z, BigInt(rep.length - 1)))).toBeInstanceOf(ChannelError);
  });
});

describe('the 64-bit pins neither wrap the channel timeout, the sequencing window nor the channel cap (Go 14472e2)', () => {
  it('a channel timeout of 2^64-1 does not wrap 1000 + timeout to 999 and time out the second frame', () => {
    const s = makeSynth({ compression: 'zlib', nFrames: 2, frameBlocks: [1000n, 1001n] });
    s.bp.channelTimeout = U64MAX;
    s.bp.channelTimeoutGranite = U64MAX;
    mustOK(s);
  });
  it('a sequencing window of 2^64-1 does not wrap 990 + window to 989 and put the frame block 1000 outside it', () => {
    const s = makeSynth({ compression: 'zlib', epochNum: 990n, frameBlocks: [1000n] });
    s.bp.seqWindowSize = U64MAX;
    mustOK(s);
  });
  it('a channel cap of 2^63-1 and above reads the whole channel', () => {
    for (const cp of [(1n << 63n) - 2n, (1n << 63n) - 1n, 1n << 63n, U64MAX]) {
      const s = makeSynth({ compression: 'zlib' });
      s.bp.maxRlpBytesPerChannel = cp;
      mustOK(s);
    }
  });
  it('a frame earlier than the first is not a wrapped huge gap: the order check refuses it as channel_incomplete before any timeout', () => {
    const s = makeSynth({ compression: 'zlib', nFrames: 2, frameBlocks: [1001n, 1000n] });
    wantCode(() => run(s), 'channel_incomplete');
  });
});
