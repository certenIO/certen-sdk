/**
 * Hostile-input tests of the body decoder and of the node-size bound: every field truncated at its start names its part, every count and length is
 * judged against its bound AND the remaining bytes before anything is allocated (N passes, N-1 fails exactly), the body re-encodes to itself,
 * a trailing byte is refused, NODES are strictly ascending, and the max_node_bytes split exempts only the transaction and receipt proof paths.
 * The body is assembled by hand here, field by field from the V2_SPEC_S7 3.3 layout, independently of encodeEvidence.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { encodeLC } from '../../../src/proof-v2/finality/ethl1/index.js';
import { buildTrie, rlpIndexKey } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { FinalityStateError, hexLower } from '../../../src/proof-v2/finality/state.js';
import { FINAL3, evidenceOf, load, vectorByName } from './vectorset.js';

const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const u32 = (n: number): Uint8Array => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u64 = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, false);
  return b;
};
const lp = (b: Uint8Array): Uint8Array => cat(u32(b.length), b);
const fill = (n: number, v = 0): Uint8Array => new Uint8Array(n).fill(v);

const LC = encodeLC({
  profile: 'x',
  anchorKind: 1,
  anchorPeriod: 0n,
  anchorRoot: fill(32),
  anchorBody: { layout: 0, ssz: new Uint8Array(0) },
  links: [],
  finalUpdate: { layout: 0, ssz: new Uint8Array(0) },
});

interface Parts {
  l1Spine: Uint8Array;
  fixed1: Uint8Array;
  fixed2: Uint8Array;
  l2Spine: Uint8Array;
  confTxIndex: Uint8Array;
  confTxRaw: Uint8Array;
  confReceiptRaw: Uint8Array;
  nodes: Uint8Array;
}
/** The fields in order, each as its bytes; fixed1 is stateBlock..sequencerBatchAcc, fixed2 is the parent config. */
const base = (): Parts => ({
  l1Spine: u32(0),
  fixed1: cat(u64(5n), u64(4n), fill(32, 1), fill(32, 2), fill(32, 3), u64(7n), u64(8n), Uint8Array.of(1), fill(32, 4), fill(32, 5)),
  fixed2: cat(fill(32, 6), fill(32, 7), fill(20, 8), u64(20n), u64(9n)),
  l2Spine: u32(0),
  confTxIndex: u32(1),
  confTxRaw: lp(new Uint8Array(0)),
  confReceiptRaw: lp(new Uint8Array(0)),
  nodes: u32(0),
});
/** The byte offset of the l2Spine count in body(p). */
const l2Pos = (p: Parts): number => LC.length + p.l1Spine.length + p.fixed1.length + p.fixed2.length;
const body = (p: Parts): Uint8Array => cat(LC, p.l1Spine, p.fixed1, p.fixed2, p.l2Spine, p.confTxIndex, p.confTxRaw, p.confReceiptRaw, p.nodes);

const bounds = async (over: { maxHeaderChain?: bigint; maxLinks?: number; maxSpineHeaders?: number } = {}) => ({
  lim: defaultLimits(),
  maxLinks: over.maxLinks ?? 64,
  maxSpineHeaders: over.maxSpineHeaders ?? 16384,
  maxHeaderChain: over.maxHeaderChain ?? 32768n,
});

const refusal = async (b: Uint8Array, over = {}): Promise<FinalityStateError | undefined> => {
  const A = await load();
  try {
    A.decodeEvidence(b, await bounds(over));
    return undefined;
  } catch (e) {
    if (!(e instanceof FinalityStateError)) throw e;
    return e;
  }
};
const canon = (e: FinalityStateError | undefined): string => (e === undefined ? 'accepted' : e.canonical());
const mal = (part: string, reason: string, got: number, want: number): string =>
  `{"code":"finality_evidence_malformed","fields":{"got_len":"${got}","part":"${part}","reason":"${reason}","want_len":"${want}"}}`;
const big = (part: string, count: number | bigint, limit: number | bigint, index?: number): string =>
  `{"code":"finality_evidence_too_large","fields":{"count":"${count}",${index === undefined ? '' : `"index":"${index}",`}"limit":"${limit}","part":"${part}"}}`;

describe('the body of the base shape decodes, re-encodes to itself and refuses a trailing byte', () => {
  it('decodes the hand-built body field by field', async () => {
    const A = await load();
    const e = A.decodeEvidence(body(base()), await bounds());
    expect(e.stateBlock).toBe(5n);
    expect(e.confBlock).toBe(4n);
    expect(hexLower(e.parentAssertionHash)).toBe('01'.repeat(32));
    expect(hexLower(e.after.blockHash)).toBe('02'.repeat(32));
    expect(hexLower(e.after.sendRoot)).toBe('03'.repeat(32));
    expect(e.after.inboxPosition).toBe(7n);
    expect(e.after.positionInMessage).toBe(8n);
    expect(e.after.machineStatus).toBe(1);
    expect(hexLower(e.after.endHistoryRoot)).toBe('04'.repeat(32));
    expect(hexLower(e.sequencerBatchAcc)).toBe('05'.repeat(32));
    expect(hexLower(e.parent.wasmModuleRoot)).toBe('06'.repeat(32));
    expect(hexLower(e.parent.requiredStake)).toBe('07'.repeat(32));
    expect(hexLower(e.parent.challengeManager)).toBe('08'.repeat(20));
    expect(e.parent.confirmPeriodBlocks).toBe(20n);
    expect(e.parent.nextInboxPosition).toBe(9n);
    expect(e.confTxIndex).toBe(1);
    expect(e.l1Spine).toEqual([]);
    expect(e.l2Spine).toEqual([]);
    expect(e.nodes).toEqual([]);
    expect(A.encodeEvidence(e)).toEqual(body(base()));
  });

  it('a body with one trailing byte is trailing_bytes of the part "body"', async () => {
    expect(canon(await refusal(cat(body(base()), Uint8Array.of(0))))).toBe(mal('body', 'trailing_bytes', 1, 0));
  });

  it('a real evidence body re-encodes to itself byte for byte (encode(decode(x)) == x)', async () => {
    const A = await load();
    for (const n of ['synth_valid_wallet_execute_transaction_proven', 'synth_valid_direct', 'real_valid_direct_route_unchanged']) {
      const c = decodeContainer(evidenceOf(FINAL3, vectorByName(FINAL3, n)), defaultLimits());
      expect(A.encodeEvidence(A.decodeEvidence(c.body, await bounds())), n).toEqual(c.body);
    }
  });
});

describe('every field truncated at its start names its part', () => {
  const fixedNames: [string, number][] = [
    ['stateBlock', 8], ['confBlock', 8], ['parentAssertionHash', 32], ['afterState.blockHash', 32], ['afterState.sendRoot', 32], ['afterState.inboxPosition', 8],
    ['afterState.positionInMessage', 8], ['afterState.machineStatus', 1], ['afterState.endHistoryRoot', 32], ['sequencerBatchAcc', 32],
    ['parentConfig.wasmModuleRoot', 32], ['parentConfig.requiredStake', 32], ['parentConfig.challengeManager', 20], ['parentConfig.confirmPeriodBlocks', 8],
    ['parentConfig.nextInboxPosition', 8],
  ];
  it('l1Spine.count, each fixed field, l2Spine.count, confTxIndex, the two LP lengths and nodes.count', async () => {
    const full = body(base());
    const start = LC.length;
    const cuts: [number, string, number][] = [[start, 'l1Spine.count', 4]];
    let off = start + 4;
    for (const [name, n] of fixedNames) {
      cuts.push([off, name, n]);
      off += n;
    }
    cuts.push([off, 'l2Spine.count', 4], [off + 4, 'confTxIndex', 4], [off + 8, 'confTxRaw.len', 4], [off + 12, 'confReceiptRaw.len', 4], [off + 16, 'nodes.count', 4]);
    expect(off + 20).toBe(full.length);
    for (const [at, part, want] of cuts) expect(canon(await refusal(full.subarray(0, at))), part).toBe(mal(part, 'truncated', 0, want));
    // one byte short of a field is the same part with the byte count that remains
    for (const [at, part, want] of cuts) expect(canon(await refusal(full.subarray(0, at + want - 1))), `${part} -1`).toBe(mal(part, 'truncated', want - 1, want));
  });

  it('the LC part: an empty body, and a cut at the end of each of its framing fields, is truncated', async () => {
    expect(canon(await refusal(new Uint8Array(0)))).toBe(mal('lc.profile.len', 'truncated', 0, 4));
    for (let n = 0; n < LC.length; n++) {
      const e = await refusal(LC.subarray(0, n));
      expect(e?.code, `${n}`).toBe('finality_evidence_malformed');
    }
  });

  it('every strict prefix of a real body is refused as a named state, never another error', async () => {
    const c = decodeContainer(evidenceOf(FINAL3, vectorByName(FINAL3, 'synth_valid_wallet_execute_transaction_proven')), defaultLimits());
    const A = await load();
    const b = await bounds();
    for (let n = 0; n < c.body.length; n += 7) {
      try {
        A.decodeEvidence(c.body.subarray(0, n), b);
        throw new Error(`prefix ${n} accepted`);
      } catch (e) {
        expect(e).toBeInstanceOf(FinalityStateError);
      }
    }
    for (let n = c.body.length - 40; n < c.body.length; n++) expect(await refusal(c.body.subarray(0, n)), `${n}`).toBeDefined();
    expect(await refusal(c.body)).toBeUndefined();
  });
});

describe('counts and lengths are bounded before anything is allocated (N passes, N-1 fails exactly)', () => {
  it('l2Spine: a count of max_header_chain passes the bound (and then fails on the bytes), one more is header_chain_exceeds_bound{needed, max}', async () => {
    const p = base();
    p.l2Spine = u32(5);
    expect(canon(await refusal(body(p), { maxHeaderChain: 5n }))).toBe(mal('l2Spine', 'count_exceeds_remaining', body(p).length - (l2Pos(p) + 4), 20));
    p.l2Spine = u32(6);
    expect(canon(await refusal(body(p), { maxHeaderChain: 5n }))).toBe('{"code":"header_chain_exceeds_bound","fields":{"max":"5","needed":"6"}}');
    p.l2Spine = u32(0xffffffff);
    expect(canon(await refusal(body(p)))).toBe('{"code":"header_chain_exceeds_bound","fields":{"max":"32768","needed":"4294967295"}}');
    p.l2Spine = u32(32768);
    expect((await refusal(body(p)))?.code).toBe('finality_evidence_malformed');
    p.l2Spine = u32(32769);
    expect((await refusal(body(p)))?.code).toBe('header_chain_exceeds_bound');
  });

  it('l2Spine: an element of 8192 bytes is read, one of 8193 is finality_evidence_too_large{part l2Spine} (no index), a length past the data is length_exceeds_remaining', async () => {
    const A = await load();
    const p = base();
    p.l2Spine = cat(u32(1), lp(fill(8192, 9)));
    expect((await A.decodeEvidence(body(p), await bounds())).l2Spine[0]!.length).toBe(8192);
    p.l2Spine = cat(u32(1), u32(8193), fill(8193, 9));
    expect(canon(await refusal(body(p)))).toBe(big('l2Spine', 8193, 8192));
    p.l2Spine = cat(u32(1), u32(8192), fill(100, 9));
    expect(canon(await refusal(body(p)))).toBe(mal('l2Spine', 'length_exceeds_remaining', body(p).length - (l2Pos(p) + 8), 8192));
  });

  it('l1Spine: a count above max_spine_headers is too_large, an element of 8193 bytes is too_large with its index, the bounds are exact', async () => {
    const p = base();
    p.l1Spine = u32(3);
    expect(canon(await refusal(body(p), { maxSpineHeaders: 2 }))).toBe(big('l1Spine', 3, 2));
    p.l1Spine = cat(u32(2), lp(fill(10, 1)), u32(8193), fill(8193, 1));
    expect(canon(await refusal(body(p)))).toBe(big('l1Spine', 8193, 8192, 1));
    p.l1Spine = cat(u32(2), lp(fill(8192, 1)), lp(fill(8192, 2)));
    const A = await load();
    expect(A.decodeEvidence(cat(LC, p.l1Spine, p.fixed1, p.fixed2, p.l2Spine, p.confTxIndex, p.confTxRaw, p.confReceiptRaw, p.nodes), await bounds()).l1Spine.map((x) => x.length)).toEqual([8192, 8192]);
  });

  it('confTxRaw and confReceiptRaw: max_tx_leaf_bytes (2097152) is the bound, 2097153 is too_large, a length past the data is length_exceeds_remaining', async () => {
    const lim = defaultLimits().maxTxLeafBytes;
    expect(lim).toBe(2097152);
    for (const part of ['confTxRaw', 'confReceiptRaw'] as const) {
      const p = base();
      p[part] = u32(lim + 1);
      expect(canon(await refusal(body(p))), part).toBe(big(part, lim + 1, lim));
      p[part] = u32(0xffffffff);
      expect(canon(await refusal(body(p))), part).toBe(big(part, 0xffffffff, lim));
      p[part] = cat(u32(lim), fill(10));
      expect((await refusal(body(p)))?.fields.reason, part).toBe('length_exceeds_remaining');
      p[part] = lp(fill(1000, 3));
      expect(await refusal(body(p)), part).toBeUndefined();
    }
  });

  it('a hostile length takes no time and no memory: 4 GiB lengths and counts in a 100-byte body are refused at once', async () => {
    const t0 = performance.now();
    const p = base();
    p.confTxRaw = u32(0xfffffff0);
    expect((await refusal(body(p)))?.code).toBe('finality_evidence_too_large');
    const q = base();
    q.nodes = u32(0xffffffff);
    expect((await refusal(body(q)))?.code).toBe('finality_evidence_too_large');
    const r = base();
    r.l1Spine = u32(0xffffffff);
    expect((await refusal(body(r)))?.code).toBe('finality_evidence_too_large');
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('NODES: a count above max_nodes is too_large; nodes must be strictly ascending by keccak256 and unique', async () => {
    const A = await load();
    const nodes = [fill(40, 1), fill(41, 2), fill(42, 3)].sort((a, b) => {
      const x = keccak_256(a);
      const y = keccak_256(b);
      for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
      return 0;
    });
    const mk = (ns: Uint8Array[]): Uint8Array => {
      const p = base();
      p.nodes = cat(u32(ns.length), ...ns.map(lp));
      return body(p);
    };
    expect((await A.decodeEvidence(mk(nodes), await bounds())).nodes.length).toBe(3);
    expect(canon(await refusal(mk([nodes[1]!, nodes[0]!, nodes[2]!])))).toBe(mal('nodes', 'nodes_not_ascending_unique', 0, 0).replace('"part"', '"index":"1","part"'));
    expect((await refusal(mk([nodes[0]!, nodes[0]!])))?.fields.reason).toBe('nodes_not_ascending_unique');
    const p = base();
    p.nodes = u32(defaultLimits().maxNodes + 1);
    expect(canon(await refusal(body(p)))).toBe(big('nodes', defaultLimits().maxNodes + 1, defaultLimits().maxNodes));
    p.nodes = u32(defaultLimits().maxNodes);
    expect((await refusal(body(p)))?.code).toBe('finality_evidence_malformed');
    const q = base();
    q.nodes = cat(u32(1), u32(2097153), fill(10));
    expect(canon(await refusal(body(q)))).toBe(big('nodes', 2097153, 2097152, 0));
  });

  it('the LC links count is bounded by max_links: N passes the bound, N+1 is finality_evidence_too_large{lc.links}', async () => {
    const link = { layout: 0, ssz: new Uint8Array(0) };
    const lcN = (n: number): Uint8Array => encodeLC({ profile: 'x', anchorKind: 1, anchorPeriod: 0n, anchorRoot: fill(32), anchorBody: link, links: Array.from({ length: n }, () => link), finalUpdate: link });
    const mk = (n: number): Uint8Array => cat(lcN(n), ...(([p]) => [p.l1Spine, p.fixed1, p.fixed2, p.l2Spine, p.confTxIndex, p.confTxRaw, p.confReceiptRaw, p.nodes])([base()]));
    expect(await refusal(mk(3), { maxLinks: 3 })).toBeUndefined();
    expect(canon(await refusal(mk(4), { maxLinks: 3 }))).toBe(big('lc.links', 4, 3));
    const hostile = cat(LC.subarray(0, LC.length - 9), u32(0xffffffff));
    expect((await refusal(hostile))?.code).toBe('finality_evidence_too_large');
  });
});

describe('checkNodeBounds: only the transaction and receipt proof paths may exceed max_node_bytes', () => {
  const idx = 3;
  const leaf = (n: number): Uint8Array => fill(n, 0xcd);
  const mk = async (txLeafLen: number, rcLeafLen: number) => {
    const tx = buildTrie([{ key: rlpIndexKey(idx), value: leaf(txLeafLen) }, { key: rlpIndexKey(idx + 1), value: leaf(10) }]);
    const rc = buildTrie([{ key: rlpIndexKey(idx), value: leaf(rcLeafLen) }, { key: rlpIndexKey(idx + 1), value: leaf(10) }]);
    const A = await load();
    const header = { transactionRoot: tx.root, receiptsRoot: rc.root } as never;
    const e = (nodes: Uint8Array[], index = idx) => ({ confTxIndex: index, nodes }) as never;
    return { A, header, tx, rc, e };
  };
  const run = (A: Awaited<ReturnType<typeof load>>, header: never, e: never): string => {
    try {
      A.checkNodeBounds(header, e, 4096);
      return 'ok';
    } catch (err) {
      return (err as FinalityStateError).canonical();
    }
  };

  it('a transaction or receipt proof node of any size on the path is exempt; the same nodes read at another index are not', async () => {
    const { A, header, tx, rc, e } = await mk(5000, 6000);
    expect(tx.nodes.some((n) => n.length > 4096)).toBe(true);
    expect(rc.nodes.some((n) => n.length > 4096)).toBe(true);
    expect(run(A, header, e([...tx.nodes, ...rc.nodes]))).toBe('ok');
    const all = [...tx.nodes, ...rc.nodes];
    const firstBig = all.findIndex((n) => n.length > 4096);
    expect(run(A, header, e(all, idx + 1))).toBe(big('nodes', all[firstBig]!.length, 4096, firstBig));
    expect(run(A, header, e(tx.nodes))).toBe('ok');
    expect(run(A, header, e(rc.nodes))).toBe('ok');
  });

  it('a filler of 4096 bytes passes, of 4097 is too_large{part nodes, count, limit, index = its position}, even beside a large leaf on the path', async () => {
    const { A, header, tx, rc, e } = await mk(5000, 6000);
    const f4096 = fill(4096, 1);
    const f4097 = fill(4097, 2);
    expect(run(A, header, e([f4096, ...tx.nodes, ...rc.nodes]))).toBe('ok');
    expect(run(A, header, e([...tx.nodes, f4097, ...rc.nodes]))).toBe(big('nodes', 4097, 4096, tx.nodes.length));
    expect(run(A, header, e([f4097]))).toBe(big('nodes', 4097, 4096, 0));
    expect(run(A, header, e([fill(10, 1), fill(4098, 1), f4097]))).toBe(big('nodes', 4098, 4096, 1));
  });

  it('a walk that fails part-way, junk nodes and empty nodes never throw anything but the named bound', async () => {
    const { A, header, e } = await mk(5000, 6000);
    expect(run(A, header, e([]))).toBe('ok');
    expect(run(A, header, e([new Uint8Array(0), fill(4097, 1)]))).toBe(big('nodes', 4097, 4096, 1));
    expect(run(A, header, e([fill(3, 1), fill(5000, 7)]))).toBe(big('nodes', 5000, 4096, 1));
  });
});
