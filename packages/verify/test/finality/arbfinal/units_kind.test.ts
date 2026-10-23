/**
 * The Rollup identity proof (O2) over hand-built state tries, and the exact boundaries of the kind's own bounds. The state is built here with
 * buildTrie (accounts as rlp [nonce, balance, storageRoot, codeHash], slots as rlp of the trimmed word), so the cases that live-looking evidence
 * cannot reach (both logic accounts wrong, an absent logic account, a dirty implementation word) are judged against the rule of identityAt in Go
 * (arbfinal verify.go: admin logic slot first, then the user logic slot; each implementation account proven under the same root and pinned with its role).
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { buildTrie } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { embeddedPins, parsePinsOverride, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError, cmpUtf8, hexLower } from '../../../src/proof-v2/finality/state.js';
import { FINAL3, bytesOfHex, evidenceOf, legOf, load, readIn, vectorByName } from './vectorset.js';

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
const word = (addr: Uint8Array, high = new Uint8Array(12)): Uint8Array => cat(high, addr);
const account = (storageRoot: Uint8Array, codeHash: Uint8Array): Uint8Array => rl(rb(new Uint8Array(0)), rb(new Uint8Array(0)), rb(storageRoot), rb(codeHash));
const EMPTY_STORAGE = bytesOfHex('56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421');

const ADMIN_IMPL = new Uint8Array(20).fill(0xa1);
const USER_IMPL = new Uint8Array(20).fill(0xa2);

interface Opts {
  adminWord?: Uint8Array;
  userWord?: Uint8Array;
  adminCode?: Uint8Array | 'absent';
  userCode?: Uint8Array | 'absent';
  rollupAbsent?: boolean;
}

const world = async (o: Opts = {}) => {
  const A = await load();
  const arb = A.loadArbFinalPins(embeddedPins());
  const roleHash = (r: string): Uint8Array => bytesOfHex([...arb.logicPins].find(([, role]) => role === r)![0]);
  const storage = buildTrie([
    { key: keccak_256(arb.adminSlot), value: rb(trim(o.adminWord ?? word(ADMIN_IMPL))) },
    { key: keccak_256(arb.userSlot), value: rb(trim(o.userWord ?? word(USER_IMPL))) },
  ]);
  const accts: { key: Uint8Array; value: Uint8Array }[] = [{ key: keccak_256(new Uint8Array(20).fill(0x99)), value: account(EMPTY_STORAGE, keccak_256(Uint8Array.of(1))) }];
  if (!o.rollupAbsent) accts.push({ key: keccak_256(arb.rollup), value: account(storage.root, keccak_256(Uint8Array.of(2))) });
  if (o.adminCode !== 'absent') accts.push({ key: keccak_256(ADMIN_IMPL), value: account(EMPTY_STORAGE, o.adminCode ?? roleHash('rollup_admin_logic')) });
  if (o.userCode !== 'absent') accts.push({ key: keccak_256(USER_IMPL), value: account(EMPTY_STORAGE, o.userCode ?? roleHash('rollup_user_logic')) });
  const state = buildTrie(accts);
  const x = { number: 11999997n, stateRoot: state.root };
  const run = (nodes = [...state.nodes, ...storage.nodes], pins = arb): string => {
    try {
      const a = A.identityAt(pins, x, nodes);
      return `ok:${hexLower(a.storageRoot) === hexLower(storage.root)}`;
    } catch (e) {
      return e instanceof FinalityStateError ? e.canonical() : `ERROR ${String(e)}`;
    }
  };
  return { A, arb, state, storage, run, roleHash };
};

const ident = (role: string, addr: Uint8Array, codeHash: Uint8Array): string =>
  `{"code":"contract_identity_unproven","fields":{"address":"0x${hexLower(addr)}","code_hash":"0x${hexLower(codeHash)}","judged_at":"11999997","role":"${role}"}}`;
const proofInvalid = (which: string): string => `{"code":"l1_state_proof_invalid","fields":{"which":"${which}"}}`;
const Z32 = new Uint8Array(32);

describe('identityAt (O2) over hand-built state tries', () => {
  it('the valid state: the Rollup account is proven and returned with its storage root', async () => {
    expect((await world()).run()).toBe('ok:true');
  });

  it('an absent Rollup account is contract_identity_unproven{role rollup, the Rollup address, a zero code hash}', async () => {
    const w = await world({ rollupAbsent: true });
    expect(w.run()).toBe(ident('rollup', w.arb.rollup, Z32));
  });

  it('the implementation word must be exactly an address: any of its 12 high bytes set is refused with the address from its low 20 bytes', async () => {
    for (const k of [0, 5, 11]) {
      const high = new Uint8Array(12);
      high[k] = 1;
      const w = await world({ adminWord: word(ADMIN_IMPL, high) });
      expect(w.run(), `admin byte ${k}`).toBe(ident('rollup_admin_logic', ADMIN_IMPL, w.roleHash('rollup_admin_logic')));
      const u = await world({ userWord: word(USER_IMPL, high) });
      expect(u.run(), `user byte ${k}`).toBe(ident('rollup_user_logic', USER_IMPL, u.roleHash('rollup_user_logic')));
    }
  });

  it('an absent implementation account is refused with a zero code hash; an unpinned one with its own code hash', async () => {
    const a = await world({ adminCode: 'absent' });
    expect(a.run()).toBe(ident('rollup_admin_logic', ADMIN_IMPL, Z32));
    const u = await world({ userCode: 'absent' });
    expect(u.run()).toBe(ident('rollup_user_logic', USER_IMPL, Z32));
    const other = keccak_256(Uint8Array.of(7));
    expect((await world({ adminCode: other })).run()).toBe(ident('rollup_admin_logic', ADMIN_IMPL, other));
    expect((await world({ userCode: other })).run()).toBe(ident('rollup_user_logic', USER_IMPL, other));
  });

  it('an absent implementation is refused even if the zero code hash were pinned with the role: the existence check is a rule of its own', async () => {
    const zero = `0x${'00'.repeat(32)}`;
    const a = await world({ adminCode: 'absent' });
    expect(a.run(undefined, { ...a.arb, logicPins: new Map([...a.arb.logicPins, [zero, 'rollup_admin_logic']]) })).toBe(ident('rollup_admin_logic', ADMIN_IMPL, Z32));
    const u = await world({ userCode: 'absent' });
    expect(u.run(undefined, { ...u.arb, logicPins: new Map([...u.arb.logicPins, [zero, 'rollup_user_logic']]) })).toBe(ident('rollup_user_logic', USER_IMPL, Z32));
  });

  it('a code hash pinned with the OTHER role is refused: the role must be the slot\'s', async () => {
    const w = await world();
    const adminHasUserCode = await world({ adminCode: w.roleHash('rollup_user_logic') });
    expect(adminHasUserCode.run()).toBe(ident('rollup_admin_logic', ADMIN_IMPL, w.roleHash('rollup_user_logic')));
    const userHasWalletCode = await world({ userCode: w.roleHash('validator_wallet_logic') });
    expect(userHasWalletCode.run()).toBe(ident('rollup_user_logic', USER_IMPL, w.roleHash('validator_wallet_logic')));
  });

  it('with both implementations wrong the admin logic is named (checked first); with only the user wrong, the user logic', async () => {
    const bad = keccak_256(Uint8Array.of(9));
    const both = await world({ adminCode: bad, userCode: bad });
    expect(both.run()).toBe(ident('rollup_admin_logic', ADMIN_IMPL, bad));
    const bothAbsent = await world({ adminCode: 'absent', userCode: 'absent' });
    expect(bothAbsent.run()).toBe(ident('rollup_admin_logic', ADMIN_IMPL, Z32));
    const user = await world({ userCode: bad });
    expect(user.run()).toBe(ident('rollup_user_logic', USER_IMPL, bad));
  });

  it('missing proof nodes are l1_state_proof_invalid of the part that cannot be read: the account first, then the slot', async () => {
    const w = await world();
    expect(w.run([])).toBe(proofInvalid('account'));
    expect(w.run(w.storage.nodes)).toBe(proofInvalid('account'));
    expect(w.run(w.state.nodes)).toBe(proofInvalid('slot'));
    expect(w.run([...w.state.nodes, new Uint8Array(0)])).toBe(proofInvalid('account'));
  });
});

describe('the exact boundaries of the kind\'s bounds', () => {
  const v = vectorByName(FINAL3, 'synth_valid_direct');
  const synth = JSON.parse(readIn(FINAL3.dir, 'pins/synth.json').toString('utf8'));
  const sortKeys = (o: unknown): unknown =>
    Array.isArray(o)
      ? o.map(sortKeys)
      : o !== null && typeof o === 'object'
        ? Object.fromEntries(Object.keys(o as object).sort(cmpUtf8).map((k) => [k, sortKeys((o as Record<string, unknown>)[k])]))
        : o;
  const withArb = (f: (a: any) => void): Pins => {
    const d = JSON.parse(JSON.stringify(synth));
    f(d.arb_sepolia);
    return parsePinsOverride(new TextEncoder().encode(JSON.stringify(sortKeys(d))));
  };
  const judge = async (p: Pins): Promise<string> => {
    const { ArbFinalKind } = await load();
    try {
      new ArbFinalKind().verify(p, legOf(v), evidenceOf(FINAL3, v));
      return 'accepted';
    } catch (e) {
      return (e as FinalityStateError).canonical();
    }
  };

  it('pre-BoLD: the leg block at the genesis block is pre_bold_block, one above it is judged (N-1 fails, N passes)', async () => {
    const n = 400_000_000;
    expect(await judge(withArb((a) => (a.bold_genesis_l2_block = n)))).toBe(`{"code":"pre_bold_block","fields":{"bold_genesis_l2_block":"${n}","n":"${n}"}}`);
    expect(await judge(withArb((a) => (a.bold_genesis_l2_block = n + 1)))).toBe(`{"code":"pre_bold_block","fields":{"bold_genesis_l2_block":"${n + 1}","n":"${n}"}}`);
    expect(await judge(withArb((a) => (a.bold_genesis_l2_block = n - 1)))).toBe('accepted');
  });

  it('max_header_chain: a spine of exactly the pinned length is judged, one more is header_chain_exceeds_bound{needed, max}', async () => {
    const A = await load();
    const spine = A.decodeEvidence(
      (await import('../../../src/proof-v2/finality/codec.js')).decodeContainer(evidenceOf(FINAL3, v), (await import('../../../src/proof-v2/finality/codec.js')).defaultLimits()).body,
      A.boundsFor(64, 16384, A.loadArbFinalPins(embeddedPins())),
    ).l2Spine.length;
    expect(spine).toBe(4);
    expect(await judge(withArb((a) => (a.max_header_chain = spine)))).toBe('accepted');
    expect(await judge(withArb((a) => (a.max_header_chain = spine - 1)))).toBe(`{"code":"header_chain_exceeds_bound","fields":{"max":"${spine - 1}","needed":"${spine}"}}`);
  });
});
