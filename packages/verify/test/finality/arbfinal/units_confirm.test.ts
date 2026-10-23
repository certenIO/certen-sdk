/**
 * T3 and T4 of the Go twin list under hostile input: proveWallet is a boolean that never throws (truncated, foreign, empty, corrupted and
 * re-rooted node sets; another address; each pin changed), and reads K's state only; the transaction hash is go-ethereum's (the sidecar of a
 * blob transaction stays out of it); the selector helpers and the proof-leaf rule are exact.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { decodeTx } from '../../../src/proof-v2/finality/baseposted/ethtx.js';
import { rlpIndexKey } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { ethl1PinsFrom } from '../../../src/proof-v2/finality/ethl1/index.js';
import { embeddedPins, sepoliaPins } from '../../../src/proof-v2/finality/pins.js';
import { readHeader } from '../../../src/proof-v2/finality/rlpheader.js';
import { FinalityStateError, hexLower } from '../../../src/proof-v2/finality/state.js';
import { FINAL1, FINAL3, bytesOfHex, evidenceOf, load, pinsOf, vectorByName, type SetInfo } from './vectorset.js';

const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

const world = async (set: SetInfo, name: string) => {
  const A = await load();
  const v = vectorByName(set, name);
  const arb = A.loadArbFinalPins(pinsOf(set, v));
  const ep = ethl1PinsFrom(sepoliaPins(pinsOf(set, v)));
  const c = decodeContainer(evidenceOf(set, v), defaultLimits());
  const e = A.decodeEvidence(c.body, A.boundsFor(ep.maxLinks, ep.maxSpineHeaders, arb));
  const k = e.l1Spine.map((r) => readHeader(r)).find((h) => h.number === e.confBlock)!;
  const tx = decodeTx(e.confTxRaw);
  return { A, arb, e, k, tx, to: tx.to!, expect: v.expect };
};
const WALLET = 'synth_valid_wallet_execute_transaction_proven';

describe('proveWallet (T3)', () => {
  it('is true for the proven wallet world and reads the proxy account, the implementation slot and the implementation account under K', async () => {
    const { A, arb, e, k, to } = await world(FINAL3, WALLET);
    expect(A.proveWallet(arb, k.stateRoot, to, e.nodes)).toBe(true);
    expect(JSON.parse((await world(FINAL3, WALLET)).expect).fields.confirmation_route).toBe('wallet');
  });

  it('is false for another state root, another wallet address, an address with no account and an empty node set', async () => {
    const { A, arb, e, k, to } = await world(FINAL3, WALLET);
    const root = Uint8Array.from(k.stateRoot);
    root[0] ^= 1;
    expect(A.proveWallet(arb, root, to, e.nodes)).toBe(false);
    expect(A.proveWallet(arb, k.stateRoot, Uint8Array.from(to, (x, i) => (i === 19 ? x ^ 1 : x)), e.nodes)).toBe(false);
    expect(A.proveWallet(arb, k.stateRoot, new Uint8Array(20), e.nodes)).toBe(false);
    expect(A.proveWallet(arb, k.stateRoot, to, [])).toBe(false);
    expect(A.proveWallet(arb, k.stateRoot, to, [new Uint8Array(0)])).toBe(false);
    expect(A.proveWallet(arb, k.stateRoot, to, [...e.nodes, new Uint8Array(0)])).toBe(false);
  });

  it('dropping any one node is true or false and never throws, and at least the nodes of the three proofs make it false', async () => {
    const { A, arb, e, k, to } = await world(FINAL3, WALLET);
    let falses = 0;
    for (let i = 0; i < e.nodes.length; i++) {
      const nodes = e.nodes.filter((_, j) => j !== i);
      const r = A.proveWallet(arb, k.stateRoot, to, nodes);
      expect(typeof r).toBe('boolean');
      if (!r) falses++;
    }
    expect(falses).toBeGreaterThanOrEqual(4);
    expect(falses).toBeLessThan(e.nodes.length);
  });

  it('truncated, extended and bit-flipped nodes (every node, then 600 seeded mutations of the whole set) never throw', async () => {
    const { A, arb, e, k, to } = await world(FINAL3, WALLET);
    let seed = 0x9e3779b9;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < e.nodes.length; i++) {
      for (const f of [(n: Uint8Array) => n.subarray(0, Math.max(0, n.length - 1)), (n: Uint8Array) => cat(n, Uint8Array.of(0)), (n: Uint8Array) => Uint8Array.from(n, (x, j) => (j === 0 ? x ^ 0x80 : x)), (n: Uint8Array) => n.subarray(0, n.length >> 1)]) {
        const nodes = e.nodes.map((n, j) => (j === i ? f(n) : n));
        expect(typeof A.proveWallet(arb, k.stateRoot, to, nodes)).toBe('boolean');
      }
    }
    for (let i = 0; i < 600; i++) {
      const nodes = e.nodes.map((n) => {
        if (rnd(6) !== 0) return n;
        const m = Uint8Array.from(n);
        switch (rnd(4)) {
          case 0:
            m[rnd(m.length)] = rnd(256);
            return m;
          case 1:
            return m.subarray(0, rnd(m.length));
          case 2:
            return cat(m, Uint8Array.of(rnd(256)));
          default:
            return Uint8Array.from({ length: rnd(200) }, () => rnd(256));
        }
      });
      expect(typeof A.proveWallet(arb, k.stateRoot, to, nodes)).toBe('boolean');
    }
  });

  it('is false when any single pin changes: the implementation address, its slot, the proxy role, the logic role, or the two roles swapped', async () => {
    const { A, arb, e, k, to } = await world(FINAL3, WALLET);
    const other = { ...arb };
    expect(A.proveWallet({ ...other, walletImpl: Uint8Array.from(arb.walletImpl, (x, i) => (i === 0 ? x ^ 1 : x)) }, k.stateRoot, to, e.nodes)).toBe(false);
    expect(A.proveWallet({ ...other, walletImplSlot: Uint8Array.from(arb.walletImplSlot, (x, i) => (i === 31 ? x ^ 1 : x)) }, k.stateRoot, to, e.nodes)).toBe(false);
    const proxy = [...arb.logicPins].find(([, r]) => r === 'validator_wallet_proxy')![0];
    const logic = [...arb.logicPins].find(([, r]) => r === 'validator_wallet_logic')![0];
    const without = (h: string): Map<string, string> => new Map([...arb.logicPins].filter(([k2]) => k2 !== h));
    expect(A.proveWallet({ ...other, logicPins: without(proxy) }, k.stateRoot, to, e.nodes)).toBe(false);
    expect(A.proveWallet({ ...other, logicPins: without(logic) }, k.stateRoot, to, e.nodes)).toBe(false);
    const swapped = new Map(arb.logicPins);
    swapped.set(proxy, 'validator_wallet_logic');
    swapped.set(logic, 'validator_wallet_proxy');
    expect(A.proveWallet({ ...other, logicPins: swapped }, k.stateRoot, to, e.nodes)).toBe(false);
    expect(A.proveWallet(arb, k.stateRoot, to, e.nodes)).toBe(true);
  });

  it('the Go-judged worlds of set 3 where a proof is missing or foreign are refused through the classifier as indirect', async () => {
    for (const n of ['adv_wallet_proofs_only_in_the_state_at_s', 'adv_wallet_callee_is_an_eoa', 'adv_wallet_proof_of_the_implementation_slot_omitted', 'adv_wallet_proofs_are_for_another_address']) {
      const w = await world(FINAL3, n);
      expect(w.A.proveWallet(w.arb, w.k.stateRoot, w.to, w.e.nodes), n).toBe(false);
      expect(JSON.parse(w.expect).fields.reason, n).toBe('indirect');
    }
  });
});

describe('the transaction hash (go-ethereum tx.Hash)', () => {
  it('is keccak256 of the raw bytes for a typed transaction, and equals the hash a Go-judged verdict records', async () => {
    const A = await load();
    for (const [set, name] of [[FINAL3, 'synth_valid_direct'], [FINAL3, WALLET], [FINAL1, 'real_valid']] as const) {
      const w = await world(set, name);
      expect(hexLower(A.txHashOf(w.e.confTxRaw)), name).toBe(hexLower(keccak_256(w.e.confTxRaw)));
      expect(`0x${hexLower(A.txHashOf(w.e.confTxRaw))}`, name).toBe(JSON.parse(w.expect).fields.confirmation_tx);
    }
  });

  const rb = (b: Uint8Array): Uint8Array => {
    const lenHead = (base: number, n: number): Uint8Array => {
      if (n < 56) return Uint8Array.of(base + n);
      const x: number[] = [];
      for (let v = n; v > 0; v = Math.floor(v / 256)) x.unshift(v % 256);
      return Uint8Array.of(base + 55 + x.length, ...x);
    };
    return b.length === 1 && b[0]! < 0x80 ? Uint8Array.from(b) : cat(lenHead(0x80, b.length), b);
  };
  const rl = (...items: Uint8Array[]): Uint8Array => {
    const body = cat(...items);
    const n = body.length;
    const head = n < 56 ? Uint8Array.of(0xc0 + n) : Uint8Array.of(0xf7 + (n < 256 ? 1 : n < 65536 ? 2 : 3), ...(n < 256 ? [n] : n < 65536 ? [n >> 8, n & 255] : [n >> 16, (n >> 8) & 255, n & 255]));
    return cat(head, body);
  };
  const ru = (n: number): Uint8Array => (n === 0 ? rb(new Uint8Array(0)) : rb(Uint8Array.from(n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), '0').match(/../g)!, (h) => parseInt(h, 16))));
  const blobFields = rl(ru(11155111), ru(6), ru(1), ru(10), ru(500000), rb(new Uint8Array(20).fill(0xaa)), ru(0), rb(Uint8Array.of(1, 2, 3)), rl(), ru(3), rl(rb(new Uint8Array(32).fill(9))), ru(1), rb(new Uint8Array(32).fill(1)), rb(new Uint8Array(32).fill(2)));

  it('a blob transaction in its canonical form hashes as 0x03 || rlp(fields), in its network form (sidecar version 0 and 1) as the canonical transaction inside it', async () => {
    const A = await load();
    const canonical = cat(Uint8Array.of(3), blobFields);
    const blob = rb(new Uint8Array(131072));
    const net0 = cat(Uint8Array.of(3), rl(blobFields, rl(blob), rl(rb(new Uint8Array(48))), rl(rb(new Uint8Array(48)))));
    const net1 = cat(Uint8Array.of(3), rl(blobFields, ru(1), rl(blob), rl(rb(new Uint8Array(48))), rl(rb(new Uint8Array(48)))));
    for (const raw of [canonical, net0, net1]) expect(decodeTx(raw).type).toBe(3);
    const want = hexLower(keccak_256(canonical));
    expect(hexLower(A.txHashOf(canonical))).toBe(want);
    expect(hexLower(A.txHashOf(net0))).toBe(want);
    expect(hexLower(A.txHashOf(net1))).toBe(want);
    expect(hexLower(keccak_256(net0))).not.toBe(want);
  });

  it('a legacy transaction hashes as keccak256 of its RLP, and the type byte of a typed envelope is part of its hash', async () => {
    const A = await load();
    const legacy = rl(ru(1), ru(5), ru(21000), rb(new Uint8Array(20).fill(0xaa)), ru(0), rb(Uint8Array.of(1)), ru(27), rb(new Uint8Array(32).fill(1)), rb(new Uint8Array(32).fill(2)));
    expect(decodeTx(legacy).type).toBe(0);
    expect(hexLower(A.txHashOf(legacy))).toBe(hexLower(keccak_256(legacy)));
    const w = await world(FINAL3, 'synth_valid_direct');
    expect(hexLower(A.txHashOf(w.e.confTxRaw))).not.toBe(hexLower(keccak_256(w.e.confTxRaw.subarray(1))));
  });
});

describe('selectors and the proof-leaf rule', () => {
  it('selectorOf is the first four bytes, zero and not ok below four; isWalletSelector is exactly the four pinned entry points', async () => {
    const A = await load();
    expect(A.selectorOf(Uint8Array.of(1, 2, 3, 4, 5))).toEqual({ sel: Uint8Array.of(1, 2, 3, 4), ok: true });
    expect(A.selectorOf(Uint8Array.of(1, 2, 3, 4))).toEqual({ sel: Uint8Array.of(1, 2, 3, 4), ok: true });
    expect(A.selectorOf(Uint8Array.of(1, 2, 3))).toEqual({ sel: new Uint8Array(4), ok: false });
    expect(A.selectorOf(new Uint8Array(0))).toEqual({ sel: new Uint8Array(4), ok: false });
    const arb = A.loadArbFinalPins(embeddedPins());
    for (const s of [arb.sel.walletTx, arb.sel.walletTxs, arb.sel.walletTxRefund, arb.sel.walletTxsRef]) expect(A.isWalletSelector(arb, s)).toBe(true);
    for (const s of [arb.sel.confirm, arb.sel.force, arb.sel.fast, arb.sel.fastNew, new Uint8Array(4), Uint8Array.of(0xce, 0x1d, 0x57, 0x1e)]) expect(A.isWalletSelector(arb, s)).toBe(false);
  });

  it('walletCallee is the To of a non-Rollup transaction whose calldata decodes canonically as an entry point, and nothing else', async () => {
    const w = await world(FINAL3, WALLET);
    const { A, arb } = w;
    expect(A.walletCallee(arb, { to: w.to, data: w.tx.data })).toEqual(w.to);
    expect(A.walletCallee(arb, { to: arb.rollup, data: w.tx.data })).toBeUndefined();
    expect(A.walletCallee(arb, { to: null, data: w.tx.data })).toBeUndefined();
    expect(A.walletCallee(arb, null)).toBeUndefined();
    expect(A.walletCallee(arb, { to: w.to, data: cat(w.tx.data, new Uint8Array(32)) })).toBeUndefined();
    expect(A.walletCallee(arb, { to: w.to, data: w.tx.data.subarray(0, 3) })).toBeUndefined();
  });

  it('proveLeaf is true only for the exact carried leaf at the exact index under the exact root', async () => {
    const w = await world(FINAL3, 'synth_valid_direct');
    const { A, e, k } = w;
    expect(A.proveLeaf(k.transactionRoot, e.confTxIndex, e.nodes, e.confTxRaw)).toBe(true);
    expect(A.proveLeaf(k.receiptsRoot, e.confTxIndex, e.nodes, e.confReceiptRaw)).toBe(true);
    expect(A.proveLeaf(k.transactionRoot, e.confTxIndex, e.nodes, e.confReceiptRaw)).toBe(false);
    expect(A.proveLeaf(k.receiptsRoot, e.confTxIndex, e.nodes, e.confTxRaw)).toBe(false);
    expect(A.proveLeaf(k.transactionRoot, e.confTxIndex + 1, e.nodes, e.confTxRaw)).toBe(false);
    expect(A.proveLeaf(k.transactionRoot, e.confTxIndex, e.nodes, cat(e.confTxRaw, Uint8Array.of(0)))).toBe(false);
    expect(A.proveLeaf(k.transactionRoot, e.confTxIndex, e.nodes, e.confTxRaw.subarray(1))).toBe(false);
    expect(A.proveLeaf(k.transactionRoot, e.confTxIndex, [], e.confTxRaw)).toBe(false);
    expect(A.proveLeaf(k.transactionRoot, e.confTxIndex, [new Uint8Array(0), ...e.nodes], e.confTxRaw)).toBe(true);
    expect(A.proveLeaf(Uint8Array.from(k.transactionRoot, (x, i) => (i === 0 ? x ^ 1 : x)), e.confTxIndex, e.nodes, e.confTxRaw)).toBe(false);
    expect(rlpIndexKey(e.confTxIndex).length).toBeGreaterThan(0);
  });

  it('a wallet confirmation needs the Rollup account at K: without it the classifier refuses to answer rather than guess', async () => {
    const w = await world(FINAL3, WALLET);
    const { A, arb, e, k } = w;
    const assertion = JSON.parse(w.expect).fields.assertion as string;
    const ok = (acct: { storageRoot: Uint8Array } | null): (() => unknown) => () =>
      A.classifyConfirmation(arb, { number: e.confBlock, stateRoot: k.stateRoot }, k, acct, bytesOfHex(assertion), e);
    expect(ok(null)).toThrow(/Rollup account at K is required/);
    try {
      ok(null)();
    } catch (err) {
      expect(err).not.toBeInstanceOf(FinalityStateError);
    }
  });
});
