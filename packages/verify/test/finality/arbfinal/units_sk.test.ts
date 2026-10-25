/**
 * K versus S (RB12-TS-FIX-ARBSEP, audit B-1, B1, B2): the Rollup storage is read at TWO different covered L1 blocks and the two reads are
 * not interchangeable. Go (arbfinal verify.go) reads the assertion node and the parent's ConfigData under S's Rollup storage root (acctS,
 * :214 and :225) and the anyTrustFastConfirmer slot under K's (acctK, :238 into confirm.go:155). No Go-published vector can tell the two apart
 * (synthworld builds both states from one Parts), so these worlds are built here with BOTH states as hand-made tries whose Rollup storage
 * differs, and they are judged through ArbFinalKind.verifyState (exported for exactly this). Every expected literal below is the verdict Go
 * cbb6373 gives the same scenario (the Go-judged copies of these worlds are test/fixtures/finality/arb_final_sk, run by vectors_sk.test.ts).
 *
 * A mutant that swaps the state read (acctK for acctS at the fast-confirmer read, or acctS for acctK at the node or config slot read) changes
 * the verdict of at least one world here; the check-in of the package records each one re-applied by hand.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { buildTrie } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { decodeTx } from '../../../src/proof-v2/finality/baseposted/ethtx.js';
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { ethl1PinsFrom } from '../../../src/proof-v2/finality/ethl1/index.js';
import { sepoliaPins } from '../../../src/proof-v2/finality/pins.js';
import { readHeader } from '../../../src/proof-v2/finality/rlpheader.js';
import { FINAL3, bytesOfHex, canonicalOutcome, evidenceOf, expectedOf, legOf, load, pinsOf, vectorByName } from './vectorset.js';

const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const lenHead = (base: number, n: number): Uint8Array => {
  if (n < 56) return Uint8Array.of(base + n);
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v % 256);
  return Uint8Array.of(base + 55 + b.length, ...b);
};
const rb = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? Uint8Array.from(b) : cat(lenHead(0x80, b.length), b));
const rl = (...items: Uint8Array[]): Uint8Array => {
  const body = cat(...items);
  return cat(lenHead(0xc0, body.length), body);
};
const trim = (b: Uint8Array): Uint8Array => {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  return b.subarray(i);
};
const be32 = (v: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let x = BigInt.asUintN(256, v);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};
const bigOf = (b: Uint8Array): bigint => b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);
const account = (storageRoot: Uint8Array, codeHash: Uint8Array): Uint8Array => rl(rb(new Uint8Array(0)), rb(new Uint8Array(0)), rb(storageRoot), rb(codeHash));
const EMPTY_STORAGE = bytesOfHex('56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421');
const ADMIN_IMPL = new Uint8Array(20).fill(0xa1);
const USER_IMPL = new Uint8Array(20).fill(0xa2);
/** an address with a non-zero low bit set in the fast-confirmer window (the owner-controlled fast confirmer of the audit worlds) */
const FAST = bytesOfHex('00000000000000000000000000000000000fa570');
const BAD_CONFIG = bytesOfHex('7777777777777777777777777777777777777777777777777777777777777777');
const WALLET_VECTOR = 'synth_valid_wallet_execute_transaction_proven';

/** The Rollup storage of one covered L1 block: the node status (0: the node slot is absent), the ConfigData word, the fast confirmer. */
interface Side {
  status?: bigint;
  cfg?: Uint8Array;
  fast?: Uint8Array;
}

/** Everything a wallet-route verifyState needs, with the Rollup storage at S and at K built from `S` and `K`. */
const world = async (S: Side, K: Side) => {
  const A = await load();
  const v = vectorByName(FINAL3, WALLET_VECTOR);
  const pins = pinsOf(FINAL3, v);
  const arb = A.loadArbFinalPins(pins);
  const ep = ethl1PinsFrom(sepoliaPins(pins));
  const c = decodeContainer(evidenceOf(FINAL3, v), defaultLimits());
  const e = A.decodeEvidence(c.body, A.boundsFor(ep.maxLinks, ep.maxSpineHeaders, arb));
  const heads = e.l1Spine.map((r) => readHeader(r));
  const hs = heads.find((h) => h.number === e.stateBlock)!;
  const hk = heads.find((h) => h.number === e.confBlock)!;
  const to = decodeTx(e.confTxRaw).to!;
  const L = arb.layout;
  const roleHash = (r: string): Uint8Array => bytesOfHex([...arb.logicPins].find(([, role]) => role === r)![0]);
  const assertion = A.assertionHash(e.parentAssertionHash, e.after, e.sequencerBatchAcc);
  const storageOf = (side: Side) => {
    const entries = [
      { key: keccak_256(arb.adminSlot), value: rb(trim(cat(new Uint8Array(12), ADMIN_IMPL))) },
      { key: keccak_256(arb.userSlot), value: rb(trim(cat(new Uint8Array(12), USER_IMPL))) },
      { key: keccak_256(A.configSlot(e.parentAssertionHash, L.assertionsSlot, L.configSlotOffset)), value: rb(trim(side.cfg ?? A.configHash(e.parent))) },
    ];
    const status = side.status ?? 2n;
    if (status !== 0n) entries.push({ key: keccak_256(A.nodeSlot(assertion, L.assertionsSlot)), value: rb(trim(be32(status << L.statusShiftBits))) });
    if (side.fast !== undefined) entries.push({ key: keccak_256(be32(L.fastConfirmerSlot)), value: rb(trim(be32(bigOf(side.fast) << L.fastConfirmerShiftBits))) });
    return buildTrie(entries);
  };
  const walletStorage = buildTrie([{ key: keccak_256(arb.walletImplSlot), value: rb(trim(cat(new Uint8Array(12), arb.walletImpl))) }]);
  const stateOf = (rollupStorageRoot: Uint8Array) =>
    buildTrie([
      { key: keccak_256(arb.rollup), value: account(rollupStorageRoot, keccak_256(Uint8Array.of(2))) },
      { key: keccak_256(ADMIN_IMPL), value: account(EMPTY_STORAGE, roleHash('rollup_admin_logic')) },
      { key: keccak_256(USER_IMPL), value: account(EMPTY_STORAGE, roleHash('rollup_user_logic')) },
      { key: keccak_256(to), value: account(walletStorage.root, roleHash('validator_wallet_proxy')) },
      { key: keccak_256(arb.walletImpl), value: account(EMPTY_STORAGE, roleHash('validator_wallet_logic')) },
    ]);
  const rsS = storageOf(S);
  const rsK = storageOf(K);
  const stS = stateOf(rsS.root);
  const stK = stateOf(rsK.root);
  const nodes = [...e.nodes, ...rsS.nodes, ...rsK.nodes, ...stS.nodes, ...stK.nodes, ...walletStorage.nodes];
  const s = { hash: hs.hash, number: hs.number, stateRoot: stS.root, timestamp: hs.timestamp };
  const kb = { hash: hk.hash, number: hk.number, stateRoot: stK.root, timestamp: hk.timestamp };
  const run = (): string => canonicalOutcome(() => new A.ArbFinalKind().verifyState(arb, s, kb, hk, legOf(v), { ...e, nodes }));
  const tx = JSON.parse(v.expect).fields.confirmation_tx as string;
  return { A, run, s, kb, tx, expectValid: expectedOf(FINAL3, v), rsS, rsK };
};

const fast = (tx: string): string => `{"code":"confirmation_path_unproven","fields":{"l1_block":"11999995","reason":"fast_confirmer_set","tx":"${tx}"}}`;
const NOT_CONFIRMED = (n: number): string => `{"code":"assertion_not_confirmed","fields":{"status":"${n}"}}`;
const UNKNOWN = '{"code":"assertion_unknown","fields":{}}';
const CONFIG_MISMATCH = '{"code":"assertion_preimage_mismatch","fields":{"part":"parent_config"}}';

describe('the Rollup storage at S differs from the storage at K (audit B-1): the world builder', () => {
  it('the two states are different trees with different roots, and with equal sides the verdict is the Go-judged valid wallet world', async () => {
    const w = await world({}, {});
    expect(w.run()).toBe(w.expectValid);
    expect(JSON.parse(w.expectValid).fields.confirmation_route).toBe('wallet');
    const d = await world({ fast: FAST }, {});
    expect(Buffer.from(d.rsS.root).equals(Buffer.from(d.rsK.root))).toBe(false);
    expect(Buffer.from(d.s.stateRoot).equals(Buffer.from(d.kb.stateRoot))).toBe(false);
    expect(d.s.number).not.toBe(d.kb.number);
  });
});

describe('the anyTrustFastConfirmer slot is read under K (confirm.go:155 acctK), never under S', () => {
  it('a fast confirmer set at K and zero at S is confirmation_path_unproven{fast_confirmer_set, l1_block K} (the mutant acctK -> acctS accepts it)', async () => {
    const w = await world({}, { fast: FAST });
    expect(w.run()).toBe(fast(w.tx));
  });

  it('a fast confirmer set at S and zero at K is the honest wallet route: the confirmation was made after the fast confirmer was cleared (the mutant reads S and refuses)', async () => {
    const w = await world({ fast: FAST }, {});
    expect(w.run()).toBe(w.expectValid);
  });

  it('a fast confirmer set at both is refused; at neither is the wallet route', async () => {
    const both = await world({ fast: FAST }, { fast: FAST });
    expect(both.run()).toBe(fast(both.tx));
    const none = await world({}, {});
    expect(none.run()).toBe(none.expectValid);
  });

  it('a different fast confirmer at each state is refused (the one at K decides, whatever S holds)', async () => {
    const other = bytesOfHex('00000000000000000000000000000000000000ff');
    const w = await world({ fast: other }, { fast: FAST });
    expect(w.run()).toBe(fast(w.tx));
  });
});

describe('the assertion node and the parent ConfigData are read under S (verify.go:214 and :225 acctS), never under K', () => {
  it('a node confirmed at S and still pending at K is judged confirmed (the mutant reads K: assertion_not_confirmed{1})', async () => {
    expect((await world({}, { status: 1n })).run()).toBe((await world({}, {})).expectValid);
  });

  it('a node pending at S and confirmed at K is assertion_not_confirmed{status 1}, not accepted (the mutant reads K and accepts)', async () => {
    expect((await world({ status: 1n }, {})).run()).toBe(NOT_CONFIRMED(1));
  });

  it('a node whose slot is absent at K but confirmed at S is judged confirmed; absent at S and confirmed at K is assertion_unknown', async () => {
    expect((await world({}, { status: 0n })).run()).toBe((await world({}, {})).expectValid);
    expect((await world({ status: 0n }, {})).run()).toBe(UNKNOWN);
  });

  it('a status other than 2 at S is refused with that status whatever K holds (0 is unknown, 1 and 3 are not confirmed)', async () => {
    expect((await world({ status: 3n }, {})).run()).toBe(NOT_CONFIRMED(3));
    expect((await world({ status: 3n }, { status: 3n })).run()).toBe(NOT_CONFIRMED(3));
    expect((await world({ status: 0n }, { status: 0n })).run()).toBe(UNKNOWN);
  });

  it('a ConfigData word right at S and wrong at K is judged; wrong at S and right at K is preimage_mismatch{parent_config} (the mutant reads K and accepts)', async () => {
    expect((await world({}, { cfg: BAD_CONFIG })).run()).toBe((await world({}, {})).expectValid);
    expect((await world({ cfg: BAD_CONFIG }, {})).run()).toBe(CONFIG_MISMATCH);
    expect((await world({ cfg: BAD_CONFIG }, { cfg: BAD_CONFIG })).run()).toBe(CONFIG_MISMATCH);
  });

  it('wrong at S in both the node and the ConfigData while K is right: the node (read first) is named; right at S while K is wrong in both: judged', async () => {
    expect((await world({ status: 1n, cfg: BAD_CONFIG }, {})).run()).toBe(NOT_CONFIRMED(1));
    expect((await world({}, { status: 1n, cfg: BAD_CONFIG })).run()).toBe((await world({}, {})).expectValid);
  });

  it('S and K together: the fast confirmer at K with a node pending at K is the fast_confirmer_set refusal (S decides the node, K the confirmer); at S the same pair is judged', async () => {
    const k = await world({}, { fast: FAST, status: 1n });
    expect(k.run()).toBe(fast(k.tx));
    const s = await world({ fast: FAST, status: 1n }, {});
    expect(s.run()).toBe(NOT_CONFIRMED(1));
  });
});
