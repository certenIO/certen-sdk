/**
 * ethtx.ts against go-ethereum v1.17.7: real Sepolia batcher blob transactions from the Go vector evidence (sender = the batcher the Go
 * verifier proves from SystemConfig), go-ethereum's own known-answer transactions (the EIP-155 Vitalik vectors, the EIP-2718 access list
 * transaction hash, the cmd/evm type-2 transactions), signed transactions of every type built here with an independent signing-hash
 * construction, and every refusal class of UnmarshalBinary and of the Prague signer's Sender.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  EthTxError, concatBytes, decodeTx, encodeAccessListTx, encodeDynamicFeeTx, encodeLegacyTx, encodeSetCodeTx, rlpBytes, rlpList, rlpUint,
  senderOf, sigHashOf, TX_ACCESS_LIST, TX_BLOB, TX_DYNAMIC_FEE, TX_LEGACY, TX_SET_CODE,
} from '../../../src/proof-v2/finality/baseposted/ethtx.js';

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(here, '..', '..', 'fixtures', 'finality', 'base_posted1', 'evidence');

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => Uint8Array.from(s.replace(/^0x/, '').match(/../g) ?? [], (h) => parseInt(h, 16));
const addrOf = (priv: Uint8Array): string => hex(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).slice(12));

// ---- the real transactions of the vector evidence (CFE1 container, wire.go) ----

function frameTxs(ev: Uint8Array): { l1Block: bigint; index: number; raw: Uint8Array; blobs: number }[] {
  const dv = new DataView(ev.buffer, ev.byteOffset, ev.byteLength);
  let p = 0;
  const u32 = (): number => ((p += 4), dv.getUint32(p - 4));
  const u64 = (): bigint => ((p += 8), dv.getBigUint64(p - 8));
  const skip = (n: number): void => void (p += n);
  const lp = (): Uint8Array => {
    const n = u32();
    p += n;
    return ev.subarray(p - n, p);
  };
  skip(4); // CFE1
  lp(); // kind
  skip(8 + 1 + 8 + 32);
  lp(); // lc profile
  skip(1 + 8 + 32);
  skip(1);
  lp(); // anchor body
  const links = u32();
  for (let i = 0; i < links; i++) {
    skip(1);
    lp();
  }
  skip(1);
  lp(); // final update
  const spine = u32();
  for (let i = 0; i < spine; i++) lp();
  skip(16);
  const n = u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    const l1Block = u64();
    const index = u32();
    const raw = Uint8Array.from(lp());
    const blobs = u32();
    for (let j = 0; j < blobs; j++) {
      lp();
      skip(96);
    }
    out.push({ l1Block, index, raw, blobs });
  }
  return out;
}

describe('the real Sepolia batcher transactions of the Go vector evidence', () => {
  const BATCHER = 'fc56e7272eebbba5bc6c544e159483c4a38f8ba3';
  const INBOX = 'ff00000000000000000000000000000000084532';
  for (const file of ['valid_a.bin', 'valid_b.bin']) {
    it(`${file}: every frame transaction is a type-3 transaction to the inbox signed by the proven batcher`, () => {
      const txs = frameTxs(readFileSync(join(EVIDENCE, file)));
      expect(txs.length).toBeGreaterThan(0);
      for (const t of txs) {
        const tx = decodeTx(t.raw);
        expect(tx.type).toBe(TX_BLOB);
        expect(hex(tx.to!)).toBe(INBOX);
        expect(tx.blobHashes.length).toBe(t.blobs);
        expect(tx.blobHashes.every((h) => h.length === 32 && h[0] === 1)).toBe(true);
        expect(tx.chainId).toBe(11155111n);
        expect(hex(senderOf(tx, 11155111n))).toBe(BATCHER);
        // another chain id is refused, never recovered
        expect(() => senderOf(tx, 1n)).toThrow(EthTxError);
        expect(() => senderOf(tx, 11155112n)).toThrow(EthTxError);
      }
    });
  }
  it('a bit flipped anywhere in the signed fields recovers a different key or is refused', () => {
    const raw = frameTxs(readFileSync(join(EVIDENCE, 'valid_a.bin')))[0]!.raw;
    for (const at of [10, 20, 40, 60, 100]) {
      const m = Uint8Array.from(raw);
      m[at] = m[at]! ^ 1;
      let r = 'refused';
      try {
        r = hex(senderOf(decodeTx(m), 11155111n));
      } catch (e) {
        expect(e).toBeInstanceOf(EthTxError);
      }
      expect(r).not.toBe(BATCHER);
    }
  });
});

// ---- go-ethereum known answers ----

describe('go-ethereum known-answer transactions', () => {
  // core/types/transaction_signing_test.go TestEIP155SigningVitalik (chain id 1)
  const vitalik: [string, string][] = [
    ['f864808504a817c800825208943535353535353535353535353535353535353535808025a0044852b2a670ade5407e78fb2863c51de9fcb96542a07186fe3aeda6bb8a116da0044852b2a670ade5407e78fb2863c51de9fcb96542a07186fe3aeda6bb8a116d', 'f0f6f18bca1b28cd68e4357452947e021241e9ce'],
    ['f864018504a817c80182a410943535353535353535353535353535353535353535018025a0489efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bcaa0489efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6', '23ef145a395ea3fa3deb533b8a9e1b4c6c25d112'],
    ['f864028504a817c80282f618943535353535353535353535353535353535353535088025a02d7c5bef027816a800da1736444fb58a807ef4c9603b7848673f7e3a68eb14a5a02d7c5bef027816a800da1736444fb58a807ef4c9603b7848673f7e3a68eb14a5', '2e485e0c23b4c3c542628a5f672eeab0ad4888be'],
    ['f865038504a817c803830148209435353535353535353535353535353535353535351b8025a02a80e1ef1d7842f27f2e6be0972bb708b9a135c38860dbe73c27c3486c34f4e0a02a80e1ef1d7842f27f2e6be0972bb708b9a135c38860dbe73c27c3486c34f4de', '82a88539669a3fd524d669e858935de5e5410cf0'],
    ['f865048504a817c80483019a28943535353535353535353535353535353535353535408025a013600b294191fc92924bb3ce4b969c1e7e2bab8f4c93c3fc6d0a51733df3c063a013600b294191fc92924bb3ce4b969c1e7e2bab8f4c93c3fc6d0a51733df3c060', 'f9358f2538fd5ccfeb848b64a96b743fcc930554'],
    ['f865058504a817c8058301ec309435353535353535353535353535353535353535357d8025a04eebf77a833b30520287ddd9478ff51abbdffa30aa90a8d655dba0e8a79ce0c1a04eebf77a833b30520287ddd9478ff51abbdffa30aa90a8d655dba0e8a79ce0c1', 'a8f7aba377317440bc5b26198a363ad22af1f3a4'],
    ['f866068504a817c80683023e3894353535353535353535353535353535353535353581d88025a06455bf8ea6e7463a1046a0b52804526e119b4bf5136279614e0b1e8e296a4e2fa06455bf8ea6e7463a1046a0b52804526e119b4bf5136279614e0b1e8e296a4e2d', 'f1f571dc362a0e5b2696b8e775f8491d3e50de35'],
    ['f867078504a817c807830290409435353535353535353535353535353535353535358201578025a052f1a9b320cab38e5da8a8f97989383aab0a49165fc91c737310e4f7e9821021a052f1a9b320cab38e5da8a8f97989383aab0a49165fc91c737310e4f7e9821021', 'd37922162ab7cea97c97a87551ed02c9a38b7332'],
    ['f867088504a817c8088302e2489435353535353535353535353535353535353535358202008025a064b1702d9298fee62dfeccc57d322a463ad55ca201256d01f62b45b2e1c21c12a064b1702d9298fee62dfeccc57d322a463ad55ca201256d01f62b45b2e1c21c10', '9bddad43f934d313c2b79ca28a432dd2b7281029'],
    ['f867098504a817c809830334509435353535353535353535353535353535353535358202d98025a052f8f61201b2b11a78d6e866abc9c3db2ae8631fa656bfe5cb53668255367afba052f8f61201b2b11a78d6e866abc9c3db2ae8631fa656bfe5cb53668255367afb', '3c24d7329e92f84f08556ceb6df1cdb0104ca49f'],
  ];
  vitalik.forEach(([raw, addr], i) => {
    it(`EIP-155 Vitalik vector ${i}: protected legacy, chain id 1`, () => {
      const tx = decodeTx(unhex(raw));
      expect(tx.type).toBe(TX_LEGACY);
      expect(hex(senderOf(tx, 1n))).toBe(addr);
      expect(() => senderOf(tx, 2n)).toThrow(EthTxError); // the signer's chain id differs from the one V encodes
    });
  });

  it('the EIP-2718 access list transaction: signing hash and sender', () => {
    const raw = unhex('01f8630103018261a894b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a825544c001a0c9519f4f2b30335884581971573fadf60c6204f59a911df35ee8a540456b2660a032f1e8e2c5dd761f9e4f88f41c8310aeaba26a8bfcdacfedfa12ec3862d37521');
    const tx = decodeTx(raw);
    expect(tx.type).toBe(TX_ACCESS_LIST);
    expect(hex(sigHashOf(tx, 1n))).toBe('49b486f0ec0a60dfbbca2d30cb07c9e8ffb2a2ff41f29a1ab6737475f6ff69f3');
    expect(hex(tx.to!)).toBe('b94f5374fce5edbc8e2a8697c15331677e6ebf0b');
    expect(hex(tx.data)).toBe('5544');
    expect(tx.nonce).toBe(3n);
    expect(tx.gas).toBe(25000n);
    expect(senderOf(tx, 1n)).toHaveLength(20);
  });

  it('EIP-2930 signing hashes of go TestEIP2930Signer (chain id in the hash is the signer one)', () => {
    // an unsigned tx with ChainID c and nonce 1, everything else zero: [c, 1, 0, 0, to=nil, 0, "", []], V R S = 0
    const body = (c: bigint): Uint8Array =>
      concatBytes([Uint8Array.of(1), rlpList([rlpUint(c), rlpUint(1n), rlpUint(0n), rlpUint(0n), rlpBytes(new Uint8Array(0)), rlpUint(0n), rlpBytes(new Uint8Array(0)), rlpList([]), rlpUint(0n), rlpUint(0n), rlpUint(0n)])]);
    expect(hex(sigHashOf(decodeTx(body(1n)), 1n))).toBe('846ad7672f2a3a40c1f959cd4a8ad21786d620077084d84c8d7c077714caa139');
    expect(hex(sigHashOf(decodeTx(body(2n)), 2n))).toBe('367967247499343401261d718ed5aa4c9486583e4d89251afce47f4a33c33362');
  });

  it('cmd/evm testdata 13: the two EIP-1559 transactions are sent by an account of that fixture alloc (nonce 1)', () => {
    // alloc.json holds exactly two externally owned accounts with nonce 1: a94f5374... and d02d72e0...; a wrong recovery would give neither
    const want = 'd02d72e067e77158444ef2020ff2d325f929b363';
    for (const raw of [
      '02f864010180820fa08284d09411111111111111111111111111111111111111118080c001a0b7dfab36232379bb3d1497a4f91c1966b1f932eae3ade107bf5d723b9cb474e0a06261c359a10f2132f126d250485b90cf20f30340801244a08ef6142ab33d1904',
      '02f864010280820fa08284d09411111111111111111111111111111111111111118080c080a0d4ec563b6568cd42d998fc4134b36933c6568d01533b5adf08769270243c6c7fa072bf7c21eac6bbeae5143371eef26d5e279637f3bd73482b55979d76d935b1e9',
    ]) {
      const tx = decodeTx(unhex(raw));
      expect(tx.type).toBe(TX_DYNAMIC_FEE);
      expect(hex(senderOf(tx, 1n))).toBe(want);
    }
  });
});

// ---- signed transactions of every type, hashes built independently of sigHashOf ----

const PRIV = unhex('b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291');
const SENDER = addrOf(PRIV);
const N = secp256k1.CURVE.n;
const TO = unhex('b94f5374fce5edbc8e2a8697c15331677e6ebf0b');
const noList = rlpList([]);
const ACCESS = rlpList([rlpList([rlpBytes(TO), rlpList([rlpBytes(new Uint8Array(32).fill(7))])])]);
const AUTH = rlpList([rlpList([rlpUint(1n), rlpBytes(TO), rlpUint(5n), rlpUint(1n), rlpUint(9n), rlpUint(10n)])]);
const HASHES = rlpList([rlpBytes(Uint8Array.from([1, ...new Uint8Array(31).fill(3)]))]);

interface Sig {
  v?: bigint;
  r?: bigint;
  s?: bigint;
}

/** items: the signed fields; typ 0 legacy (cid: EIP-155 chain id or null). Returns the raw consensus bytes. */
function build(typ: number, items: Uint8Array[], cid: bigint | null, over: Sig = {}): Uint8Array {
  let pre: Uint8Array;
  if (typ === 0) pre = rlpList(cid === null ? items : [...items, rlpUint(cid), rlpUint(0n), rlpUint(0n)]);
  else pre = concatBytes([Uint8Array.of(typ), rlpList(items)]);
  const sig = secp256k1.sign(keccak_256(pre), PRIV, { lowS: true });
  let v: bigint;
  if (typ === 0) v = cid === null ? 27n + BigInt(sig.recovery!) : 35n + 2n * cid + BigInt(sig.recovery!);
  else v = BigInt(sig.recovery!);
  const tail = [rlpUint(over.v ?? v), rlpUint(over.r ?? sig.r), rlpUint(over.s ?? sig.s)];
  const body = rlpList([...items, ...tail]);
  return typ === 0 ? body : concatBytes([Uint8Array.of(typ), body]);
}

const legacyItems = (to: Uint8Array | null = TO): Uint8Array[] => [rlpUint(7n), rlpUint(1000n), rlpUint(21000n), to === null ? rlpBytes(new Uint8Array(0)) : rlpBytes(to), rlpUint(5n), rlpBytes(Uint8Array.of(1, 2, 3))];
const fee = (c: bigint): Uint8Array[] => [rlpUint(c), rlpUint(7n), rlpUint(2n), rlpUint(9n), rlpUint(60000n)];

const CASES: { name: string; typ: number; items: Uint8Array[]; cid: bigint | null; ok: boolean }[] = [
  { name: 'legacy, EIP-155 protected', typ: 0, items: legacyItems(), cid: 11155111n, ok: true },
  { name: 'legacy, contract creation (to empty)', typ: 0, items: legacyItems(null), cid: 11155111n, ok: true },
  { name: 'legacy, unprotected (V 27/28, homestead path)', typ: 0, items: legacyItems(), cid: null, ok: true },
  { name: 'EIP-2930', typ: 1, items: [rlpUint(11155111n), rlpUint(7n), rlpUint(1000n), rlpUint(21000n), rlpBytes(TO), rlpUint(5n), rlpBytes(Uint8Array.of(1)), ACCESS], cid: 11155111n, ok: true },
  { name: 'EIP-1559', typ: 2, items: [...fee(11155111n).slice(0, 1), rlpUint(7n), rlpUint(2n), rlpUint(9n), rlpUint(60000n), rlpBytes(TO), rlpUint(5n), rlpBytes(new Uint8Array(0)), ACCESS], cid: 11155111n, ok: true },
  { name: 'EIP-1559, contract creation', typ: 2, items: [rlpUint(11155111n), rlpUint(7n), rlpUint(2n), rlpUint(9n), rlpUint(60000n), rlpBytes(new Uint8Array(0)), rlpUint(5n), rlpBytes(new Uint8Array(0)), noList], cid: 11155111n, ok: true },
  { name: 'EIP-4844', typ: 3, items: [rlpUint(11155111n), rlpUint(7n), rlpUint(2n), rlpUint(9n), rlpUint(60000n), rlpBytes(TO), rlpUint(5n), rlpBytes(new Uint8Array(0)), ACCESS, rlpUint(3n), HASHES], cid: 11155111n, ok: true },
  { name: 'EIP-7702', typ: 4, items: [rlpUint(11155111n), rlpUint(7n), rlpUint(2n), rlpUint(9n), rlpUint(60000n), rlpBytes(TO), rlpUint(5n), rlpBytes(new Uint8Array(0)), ACCESS, AUTH], cid: 11155111n, ok: true },
];

describe('signed transactions of every type', () => {
  for (const c of CASES) {
    it(`${c.name}: decode, to/data/type, sender`, () => {
      const raw = build(c.typ, c.items, c.cid);
      const tx = decodeTx(raw);
      expect(tx.type).toBe(c.typ);
      expect(hex(senderOf(tx, 11155111n))).toBe(SENDER);
      expect(tx.nonce).toBe(7n);
      if (c.typ === 3) expect(tx.blobHashes.map(hex)).toEqual([hex(Uint8Array.from([1, ...new Uint8Array(31).fill(3)]))]);
      else expect(tx.blobHashes).toEqual([]);
      if (c.name.includes('creation')) expect(tx.to).toBeNull();
      else expect(hex(tx.to!)).toBe(hex(TO));
      // the wrong signer chain id: refused by every type (the unprotected legacy form carries none and recovers the same key)
      if (c.cid === null) expect(hex(senderOf(tx, 1n))).toBe(SENDER);
      else expect(() => senderOf(tx, 1n)).toThrow(EthTxError);
    });
  }

  it('the consensus encoders write exactly what the signed bytes are made of', () => {
    const f = { nonce: 7n, gas: 21000n, value: 5n };
    const withSig = (typ: number, items: Uint8Array[], cid: bigint | null): { raw: Uint8Array; v: bigint; r: bigint; s: bigint } => {
      const raw = build(typ, items, cid);
      const tx = decodeTx(raw);
      return { raw, v: tx.v, r: tx.r, s: tx.s };
    };
    {
      const { raw, v, r, s } = withSig(0, legacyItems(), 11155111n);
      expect(hex(encodeLegacyTx({ ...f, gasPrice: 1000n, to: TO, data: Uint8Array.of(1, 2, 3), v, r, s }))).toBe(hex(raw));
    }
    {
      const items = [rlpUint(11155111n), rlpUint(7n), rlpUint(1000n), rlpUint(21000n), rlpBytes(TO), rlpUint(5n), rlpBytes(Uint8Array.of(1)), ACCESS];
      const { raw, v, r, s } = withSig(1, items, 11155111n);
      expect(hex(encodeAccessListTx({ chainId: 11155111n, nonce: 7n, gasPrice: 1000n, gas: 21000n, to: TO, value: 5n, data: Uint8Array.of(1), accessList: ACCESS, v, r, s }))).toBe(hex(raw));
    }
    {
      const items = [rlpUint(11155111n), rlpUint(7n), rlpUint(2n), rlpUint(9n), rlpUint(60000n), rlpBytes(TO), rlpUint(5n), rlpBytes(new Uint8Array(0)), ACCESS];
      const { raw, v, r, s } = withSig(2, items, 11155111n);
      expect(hex(encodeDynamicFeeTx({ chainId: 11155111n, nonce: 7n, gasTipCap: 2n, gasFeeCap: 9n, gas: 60000n, to: TO, value: 5n, data: new Uint8Array(0), accessList: ACCESS, v, r, s }))).toBe(hex(raw));
    }
    {
      const items = [rlpUint(11155111n), rlpUint(7n), rlpUint(2n), rlpUint(9n), rlpUint(60000n), rlpBytes(TO), rlpUint(5n), rlpBytes(new Uint8Array(0)), ACCESS, AUTH];
      const { raw, v, r, s } = withSig(4, items, 11155111n);
      expect(hex(encodeSetCodeTx({ chainId: 11155111n, nonce: 7n, gasTipCap: 2n, gasFeeCap: 9n, gas: 60000n, to: TO, value: 5n, data: new Uint8Array(0), accessList: ACCESS, authList: AUTH, v, r, s }))).toBe(hex(raw));
    }
  });

  it('a creation transaction is encoded with an empty `to`', () => {
    const raw = encodeLegacyTx({ nonce: 0n, gasPrice: 0n, gas: 0n, to: null, value: 0n, data: new Uint8Array(0), v: 27n, r: 1n, s: 1n });
    expect(hex(raw)).toBe('c98080808080801b0101');
    expect(decodeTx(raw).to).toBeNull();
  });
});

describe('signature refusals (the Prague signer, homestead rules)', () => {
  const items = CASES[4]!.items;
  const typed = (o: Sig): Uint8Array => build(2, items, 11155111n, o);
  const legacy = (o: Sig, cid: bigint | null = 11155111n): Uint8Array => build(0, legacyItems(), cid, o);
  const refused = (raw: Uint8Array, chain = 11155111n): void => expect(() => senderOf(decodeTx(raw), chain)).toThrow(EthTxError);
  const sig = (): { r: bigint; s: bigint } => {
    const t = decodeTx(build(2, items, 11155111n));
    return { r: t.r, s: t.s };
  };

  it('a high s (above N/2) is refused, the low twin recovers', () => {
    const { r, s } = sig();
    refused(typed({ s: N - s }));
    expect(hex(senderOf(decodeTx(typed({ s })), 11155111n))).toBe(SENDER);
    // exactly N/2 passes the range rule (the signature then recovers some other key, never the sender)
    expect(hex(senderOf(decodeTx(typed({ s: N >> 1n })), 11155111n))).not.toBe(SENDER);
    // exactly N/2 is allowed by the rule (s > N/2 is refused); N/2+1 is refused
    const half = N >> 1n;
    expect(() => senderOf(decodeTx(typed({ s: half + 1n })), 11155111n)).toThrow(EthTxError);
    void r;
  });
  it('r or s of 0, r or s of N or above are refused', () => {
    const { r, s } = sig();
    refused(typed({ r: 0n }));
    refused(typed({ s: 0n }));
    refused(typed({ r: N }));
    refused(typed({ r: N + r }));
    refused(typed({ s: N }));
    void s;
  });
  it('typed V must be 0 or 1', () => {
    for (const v of [2n, 27n, 28n, 35n, 255n, 256n, 1n << 200n]) refused(typed({ v }));
    const t = decodeTx(typed({}));
    expect(t.v === 0n || t.v === 1n).toBe(true);
  });
  it('a legacy EIP-155 V of the other parity recovers another key (or none), never the sender', () => {
    const t = decodeTx(legacy({}));
    const other = t.v % 2n === 0n ? t.v + 1n : t.v - 1n;
    let r = 'refused';
    try {
      r = hex(senderOf(decodeTx(legacy({ v: other })), 11155111n));
    } catch (e) {
      expect(e).toBeInstanceOf(EthTxError);
    }
    expect(r).not.toBe(SENDER);
  });
  it('a typed V flipped to the other parity recovers another key (or none), never the sender', () => {
    const t = decodeTx(typed({}));
    const flipped = typed({ v: t.v === 0n ? 1n : 0n });
    let r = 'refused';
    try {
      r = hex(senderOf(decodeTx(flipped), 11155111n));
    } catch (e) {
      expect(e).toBeInstanceOf(EthTxError);
    }
    expect(r).not.toBe(SENDER);
  });
  it('a typed transaction of another chain id is refused', () => {
    refused(build(2, [rlpUint(1n), ...items.slice(1)], 1n), 11155111n);
    expect(hex(senderOf(decodeTx(build(2, [rlpUint(1n), ...items.slice(1)], 1n)), 1n))).toBe(SENDER);
  });
  it('legacy: a protected V of another chain, unprotected V other than 27/28, V 0/1, V of a byte or wider are refused', () => {
    refused(legacy({}, 1n)); // signed for chain 1, judged by 11155111
    refused(legacy({ v: 29n }, null));
    refused(legacy({ v: 26n }, null));
    refused(legacy({ v: 0n }, null));
    refused(legacy({ v: 1n }, null));
    refused(legacy({ v: 34n }));
    refused(legacy({ v: 35n }));
    refused(legacy({ v: 34n + 2n * 11155111n }));
    refused(legacy({ v: 1n << 70n }));
    refused(legacy({ v: 255n }, null));
  });
  it('legacy: V of 27 and 28 recover under the homestead rules, and a high s is refused there too', () => {
    const t = decodeTx(legacy({}, null));
    expect(hex(senderOf(t, 11155111n))).toBe(SENDER);
    refused(legacy({ s: N - t.s }, null));
    refused(legacy({ r: 0n }, null));
    refused(legacy({ s: 0n }, null));
    refused(legacy({ r: 0n }));
    refused(legacy({ s: N - t.s }));
  });
  it('the legacy EIP-155 V is derived through uint64 arithmetic (a V below 35 wraps and matches no chain)', () => {
    for (const v of [29n, 30n, 33n, 34n]) refused(legacy({ v }));
  });
  it('a key that cannot be recovered (r is not an x coordinate) is refused', () => {
    // search an r below N with no point on the curve
    let r = 2n;
    for (; r < 100n; r++) {
      try {
        new secp256k1.Signature(r, 5n, 0).recoverPublicKey(new Uint8Array(32).fill(1));
      } catch {
        break;
      }
    }
    expect(r).toBeLessThan(100n);
    refused(typed({ r, s: 5n }));
  });
});

describe('rlp encoding helpers', () => {
  it('integers and byte strings are written in their canonical shortest form', () => {
    expect(hex(rlpUint(0n))).toBe('80');
    expect(hex(rlpUint(127n))).toBe('7f');
    expect(hex(rlpUint(128n))).toBe('8180');
    expect(hex(rlpUint(256n))).toBe('820100');
    expect(hex(rlpBytes(Uint8Array.of(0x7f)))).toBe('7f');
    expect(hex(rlpBytes(Uint8Array.of(0x80)))).toBe('8180');
    expect(hex(rlpBytes(new Uint8Array(0)))).toBe('80');
    expect(hex(rlpBytes(new Uint8Array(55)).subarray(0, 1))).toBe('b7');
    expect(hex(rlpBytes(new Uint8Array(56)).subarray(0, 2))).toBe('b838');
    expect(hex(rlpBytes(new Uint8Array(256)).subarray(0, 3))).toBe('b90100');
    expect(hex(rlpList([rlpBytes(new Uint8Array(54))]).subarray(0, 1))).toBe('f7');
    expect(hex(rlpList([rlpBytes(new Uint8Array(55))]).subarray(0, 2))).toBe('f838');
    expect(hex(rlpList([]))).toBe('c0');
  });
  it('a negative integer is refused', () => {
    expect(() => rlpUint(-1n)).toThrow(EthTxError);
  });
});

describe('UnmarshalBinary refusals', () => {
  const T2 = CASES[4]!.items;
  const good2 = build(2, T2, 11155111n);
  const bad = (raw: Uint8Array): void => expect(() => decodeTx(raw)).toThrow(EthTxError);
  const set = (raw: Uint8Array, at: number, v: number): Uint8Array => {
    const m = Uint8Array.from(raw);
    m[at] = v;
    return m;
  };

  it('empty input, one byte, and every unsupported envelope type', () => {
    bad(new Uint8Array(0));
    bad(Uint8Array.of(2));
    bad(Uint8Array.of(0x01));
    for (const t of [0, 5, 6, 0x7e, 0x7f]) bad(concatBytes([Uint8Array.of(t), good2.subarray(1)]));
  });
  it('a legacy transaction must be an RLP list (a string above 0x7f is not)', () => {
    bad(Uint8Array.of(0x80));
    bad(concatBytes([Uint8Array.of(0x83), Uint8Array.of(1, 2, 3)]));
  });
  it('trailing bytes after a transaction are refused, for legacy and typed', () => {
    bad(concatBytes([good2, Uint8Array.of(0)]));
    bad(concatBytes([build(0, legacyItems(), 11155111n), Uint8Array.of(0)]));
  });
  it('field counts are exact: one item too few or too many', () => {
    for (const [typ, items, cid] of [[0, legacyItems(), 11155111n], [1, CASES[3]!.items, 11155111n], [2, T2, 11155111n], [3, CASES[6]!.items, 11155111n], [4, CASES[7]!.items, 11155111n]] as const) {
      const raw = build(typ, items, cid);
      const body = typ === 0 ? raw : raw.subarray(1);
      const pre = typ === 0 ? new Uint8Array(0) : Uint8Array.of(typ);
      // decode the list, drop or add one item, re-encode
      const parts = splitItems(body);
      bad(concatBytes([pre, rlpList(parts.slice(0, -1))]));
      bad(concatBytes([pre, rlpList([...parts, rlpUint(0n)])]));
    }
  });
  it('non-canonical integers: a leading zero byte, a single byte below 0x80 wrapped, a 9-byte uint64', () => {
    const base = splitItems(good2.subarray(1));
    const withItem = (i: number, item: Uint8Array): Uint8Array => concatBytes([Uint8Array.of(2), rlpList(base.map((b, j) => (j === i ? item : b)))]);
    bad(withItem(1, Uint8Array.of(0x82, 0x00, 0x07))); // nonce 0x0007
    bad(withItem(1, Uint8Array.of(0x00))); // nonce as the byte 0x00
    bad(withItem(1, Uint8Array.of(0x81, 0x07))); // a single byte below 0x80 wrapped
    bad(withItem(1, concatBytes([Uint8Array.of(0x89), new Uint8Array(9).fill(1)]))); // nonce wider than 8 bytes
    bad(withItem(4, concatBytes([Uint8Array.of(0x89), new Uint8Array(9).fill(1)]))); // gas wider than 8 bytes
    bad(withItem(0, Uint8Array.of(0x82, 0x00, 0x01))); // big.Int with a leading zero
    bad(withItem(3, rlpList([]))); // a list where an integer belongs
  });
  it('`to` is empty or exactly 20 bytes (not 19, not 21, not an empty list) for legacy, 2930 and 1559', () => {
    const base = splitItems(good2.subarray(1));
    const withTo = (item: Uint8Array): Uint8Array => concatBytes([Uint8Array.of(2), rlpList(base.map((b, j) => (j === 5 ? item : b)))]);
    bad(withTo(rlpBytes(new Uint8Array(19).fill(1))));
    bad(withTo(rlpBytes(new Uint8Array(21).fill(1))));
    bad(withTo(rlpList([])));
    bad(withTo(rlpUint(1n)));
    expect(decodeTx(withTo(rlpBytes(new Uint8Array(0)))).to).toBeNull();
  });
  it('blob and set-code transactions need a 20-byte `to` (an empty one is refused)', () => {
    for (const c of [CASES[6]!, CASES[7]!]) {
      const raw = build(c.typ, c.items, c.cid);
      const parts = splitItems(raw.subarray(1));
      bad(concatBytes([Uint8Array.of(c.typ), rlpList(parts.map((b, j) => (j === 5 ? rlpBytes(new Uint8Array(0)) : b)))]));
    }
  });
  it('uint256 fields are at most 32 bytes (the chain id of a blob tx; a 2930 chain id is a big.Int and may be wider)', () => {
    const parts = splitItems(build(3, CASES[6]!.items, 11155111n).subarray(1));
    bad(concatBytes([Uint8Array.of(3), rlpList(parts.map((b, j) => (j === 0 ? rlpBytes(new Uint8Array(33).fill(1)) : b)))]));
    const p2 = splitItems(build(2, T2, 11155111n).subarray(1));
    const wide = decodeTx(concatBytes([Uint8Array.of(2), rlpList(p2.map((b, j) => (j === 0 ? rlpBytes(new Uint8Array(33).fill(1)) : b)))]));
    expect(wide.chainId).toBeGreaterThan(1n << 256n);
    expect(() => senderOf(wide, 11155111n)).toThrow(EthTxError);
  });
  it('access list shape: tuples of exactly [address(20), [hash(32)...]]', () => {
    const base = splitItems(good2.subarray(1));
    const withAcl = (acl: Uint8Array): Uint8Array => concatBytes([Uint8Array.of(2), rlpList(base.map((b, j) => (j === 8 ? acl : b)))]);
    bad(withAcl(rlpBytes(TO))); // a string
    bad(withAcl(rlpList([rlpBytes(TO)]))); // a tuple that is not a list
    bad(withAcl(rlpList([rlpList([rlpBytes(TO)])]))); // one element
    bad(withAcl(rlpList([rlpList([rlpBytes(TO), rlpList([]), rlpList([])])]))); // three elements
    bad(withAcl(rlpList([rlpList([rlpBytes(TO.subarray(1)), rlpList([])])]))); // 19-byte address
    bad(withAcl(rlpList([rlpList([rlpBytes(TO), rlpList([rlpBytes(new Uint8Array(31))])])]))); // 31-byte key
    bad(withAcl(rlpList([rlpList([rlpBytes(TO), rlpBytes(new Uint8Array(32))])]))); // keys not a list
    expect(decodeTx(withAcl(rlpList([rlpList([rlpBytes(TO), rlpList([])])]))).type).toBe(2);
  });
  it('blob hashes are a list of 32-byte strings', () => {
    const parts = splitItems(build(3, CASES[6]!.items, 11155111n).subarray(1));
    const withHashes = (h: Uint8Array): Uint8Array => concatBytes([Uint8Array.of(3), rlpList(parts.map((b, j) => (j === 10 ? h : b)))]);
    bad(withHashes(rlpList([rlpBytes(new Uint8Array(31))])));
    bad(withHashes(rlpBytes(new Uint8Array(32))));
    expect(decodeTx(withHashes(rlpList([]))).blobHashes).toEqual([]);
  });
  it('authorization list shape: [chainId, address(20), nonce, yParity (one byte), r, s]', () => {
    const parts = splitItems(build(4, CASES[7]!.items, 11155111n).subarray(1));
    const withAuth = (a: Uint8Array): Uint8Array => concatBytes([Uint8Array.of(4), rlpList(parts.map((b, j) => (j === 9 ? a : b)))]);
    bad(withAuth(rlpBytes(TO)));
    bad(withAuth(rlpList([rlpList([rlpUint(1n), rlpBytes(TO), rlpUint(5n), rlpUint(1n), rlpUint(9n)])]))); // five items
    bad(withAuth(rlpList([rlpList([rlpUint(1n), rlpBytes(TO), rlpUint(5n), rlpUint(1n), rlpUint(9n), rlpUint(10n), rlpUint(11n)])]))); // seven items
    bad(withAuth(rlpList([rlpList([rlpUint(1n), rlpBytes(TO), rlpUint(5n), rlpUint(256n), rlpUint(9n), rlpUint(10n)])]))); // y parity wider than a byte
    bad(withAuth(rlpList([rlpList([rlpUint(1n), rlpBytes(TO.subarray(1)), rlpUint(5n), rlpUint(1n), rlpUint(9n), rlpUint(10n)])])));
    bad(withAuth(rlpList([rlpList([rlpBytes(new Uint8Array(33).fill(1)), rlpBytes(TO), rlpUint(5n), rlpUint(1n), rlpUint(9n), rlpUint(10n)])])));
    expect(decodeTx(withAuth(rlpList([]))).type).toBe(4);
  });
  it('a truncated or lengthened RLP header is refused', () => {
    bad(good2.subarray(0, good2.length - 1));
    bad(set(good2, 1, good2[1]! + 1));
  });

  // ---- the network encoding of a blob transaction (with its sidecar) is accepted by go's UnmarshalBinary ----
  const blobItems = splitItems(build(3, CASES[6]!.items, 11155111n).subarray(1));
  const blob = rlpBytes(new Uint8Array(131072));
  const c48 = rlpBytes(new Uint8Array(48).fill(2));
  it('network-encoded blob transaction, version 0 and 1 sidecars, decodes to the same transaction', () => {
    const inner = rlpList(blobItems);
    const plain = decodeTx(concatBytes([Uint8Array.of(3), inner]));
    const v0 = decodeTx(concatBytes([Uint8Array.of(3), rlpList([inner, rlpList([blob]), rlpList([c48]), rlpList([c48])])]));
    const v1 = decodeTx(concatBytes([Uint8Array.of(3), rlpList([inner, rlpUint(1n), rlpList([blob]), rlpList([c48]), rlpList([c48])])]));
    for (const t of [v0, v1]) {
      expect(hex(senderOf(t, 11155111n))).toBe(hex(senderOf(plain, 11155111n)));
      expect(t.blobHashes.map(hex)).toEqual(plain.blobHashes.map(hex));
    }
  });
  it('network-encoded blob transaction: unsupported version, wrong element sizes and counts are refused', () => {
    const inner = rlpList(blobItems);
    const wrap = (...x: Uint8Array[]): Uint8Array => concatBytes([Uint8Array.of(3), rlpList([inner, ...x])]);
    bad(wrap(rlpUint(2n), rlpList([blob]), rlpList([c48]), rlpList([c48]))); // version 2
    bad(wrap(rlpUint(0n), rlpList([blob]), rlpList([c48]), rlpList([c48]))); // version 0 is not written as a version item
    bad(wrap(rlpList([rlpBytes(new Uint8Array(131071))]), rlpList([c48]), rlpList([c48]))); // short blob
    bad(wrap(rlpList([blob]), rlpList([rlpBytes(new Uint8Array(47))]), rlpList([c48]))); // short commitment
    bad(wrap(rlpList([blob]), rlpList([c48]))); // three elements
    bad(wrap(rlpList([blob]), rlpList([c48]), rlpList([c48]), rlpList([c48]))); // five elements without a version byte
    bad(wrap(rlpBytes(new Uint8Array(0))));
    bad(concatBytes([Uint8Array.of(3), rlpList([])])); // nothing to split
    bad(concatBytes([Uint8Array.of(3), rlpList([inner])])); // no second element
  });
});

/** The raw items of one RLP list. */
function splitItems(list: Uint8Array): Uint8Array[] {
  let p = 0;
  const head = list[0]!;
  p = head < 0xf8 ? 1 : 1 + (head - 0xf7);
  const out: Uint8Array[] = [];
  while (p < list.length) {
    const b = list[p]!;
    let n: number;
    let hdr: number;
    if (b < 0x80) (hdr = 0), (n = 1);
    else if (b < 0xb8) (hdr = 1), (n = b - 0x80);
    else if (b < 0xc0) {
      const l = b - 0xb7;
      hdr = 1 + l;
      n = 0;
      for (let i = 0; i < l; i++) n = n * 256 + list[p + 1 + i]!;
    } else if (b < 0xf8) (hdr = 1), (n = b - 0xc0);
    else {
      const l = b - 0xf7;
      hdr = 1 + l;
      n = 0;
      for (let i = 0; i < l; i++) n = n * 256 + list[p + 1 + i]!;
    }
    const total = b < 0x80 ? 1 : hdr + n;
    out.push(list.slice(p, p + total));
    p += total;
  }
  return out;
}

