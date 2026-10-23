/**
 * The pure helpers of the kind against Go-judged known answers (AfterStateHash, AssertionHash, ConfigHash, NodeSlot, ConfigSlot, StatusOf and the
 * L2 spine rule over crafted headers, including the uint64 wrap edges no live evidence reaches), and the real owner force-confirmation fixture
 * (finality_arb_force1) through the classifier.
 */
import { describe, expect, it } from 'vitest';
import { embeddedPins } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { bytesOfHex, load, readIn } from './vectorset.js';
import { KAT_HASHES, KAT_SPINES } from './kat.js';

const hx = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('hash helpers against Go known answers', () => {
  it('AfterStateHash, AssertionHash, ConfigHash, NodeSlot, ConfigSlot and StatusOf equal Go on 12 inputs incl. the 0, 1, 2^63 and 2^64-1 edges', async () => {
    const A = await load();
    expect(KAT_HASHES.length).toBe(12);
    for (const k of KAT_HASHES) {
      const after = {
        blockHash: bytesOfHex(k.AfterBlockHash),
        sendRoot: bytesOfHex(k.AfterSendRoot),
        inboxPosition: BigInt(k.AfterInbox),
        positionInMessage: BigInt(k.AfterPos),
        machineStatus: k.AfterMachine,
        endHistoryRoot: bytesOfHex(k.AfterEnd),
      };
      expect(hx(A.afterStateHash(after))).toBe(k.AfterStateHash);
      const assertion = A.assertionHash(bytesOfHex(k.Parent), after, bytesOfHex(k.SeqAcc));
      expect(hx(assertion)).toBe(k.AssertionHash);
      const cfg = {
        wasmModuleRoot: bytesOfHex(k.Wasm),
        requiredStake: bytesOfHex(k.Stake),
        challengeManager: bytesOfHex(k.Manager),
        confirmPeriodBlocks: BigInt(k.ConfirmPeriod),
        nextInboxPosition: BigInt(k.NextInbox),
      };
      expect(hx(A.configHash(cfg))).toBe(k.ConfigHash);
      expect(hx(A.nodeSlot(assertion, BigInt(k.AssertionsSlot)))).toBe(k.NodeSlot);
      expect(hx(A.configSlot(assertion, BigInt(k.AssertionsSlot), BigInt(k.ConfigOffset)))).toBe(k.ConfigSlot);
      expect(String(A.statusOf(bytesOfHex(k.Word), BigInt(k.Shift)))).toBe(k.Status);
    }
  });

  it('statusOf reads the byte at the shift: shift 0 is the last byte, 248 the first, and a wider word keeps only 8 bits', async () => {
    const A = await load();
    const w = new Uint8Array(32);
    w[31] = 0x07;
    w[0] = 0x09;
    expect(A.statusOf(w, 0n)).toBe(7);
    expect(A.statusOf(w, 248n)).toBe(9);
    const x = new Uint8Array(32);
    x[30] = 0x01;
    x[31] = 0xff;
    expect(A.statusOf(x, 0n)).toBe(255);
    expect(A.statusOf(x, 8n)).toBe(1);
    expect(A.statusOf(x, 1n)).toBe(255);
  });

  it('w32 puts a uint64 in the last eight bytes and wraps above 2^64', async () => {
    const A = await load();
    expect(hx(A.w32(1n))).toBe(`${'00'.repeat(31)}01`);
    expect(hx(A.w32((1n << 64n) - 1n))).toBe(`${'00'.repeat(24)}${'ff'.repeat(8)}`);
    expect(hx(A.w32(1n << 64n))).toBe('00'.repeat(32));
  });
});

describe('verifyL2Spine against Go known answers', () => {
  it.each(KAT_SPINES.map((s) => [s.Name, s] as const))('%s', async (_name, s) => {
    const A = await load();
    const e = { l2Spine: (s.Spine ?? []).map(bytesOfHex), after: { blockHash: bytesOfHex(s.After) } as never };
    const leg = { chain: 421614n, number: BigInt(s.LegNum), hash: bytesOfHex(s.LegHash), headerRlp: s.LegHdr === '' ? undefined : bytesOfHex(s.LegHdr) };
    let got: string;
    try {
      got = `ok|${A.verifyL2Spine(e as never, leg)}`;
    } catch (err) {
      got = err instanceof FinalityStateError ? err.canonical() : `ERROR ${String(err)}`;
    }
    expect(got).toBe(s.Expect);
  });

  it('the Go-judged cases cover every named outcome of the rule', () => {
    const kinds = new Set(KAT_SPINES.map((s) => (s.Expect.startsWith('ok') ? 'ok' : (JSON.parse(s.Expect) as { fields: Record<string, string> }).fields.reason ?? (JSON.parse(s.Expect) as { fields: Record<string, string> }).fields.field)));
    for (const k of ['ok', 'parent_hash_mismatch', 'number_gap', 'spine_empty', 'spineLastNumber', 'spineLastHash', 'spineLastHeader', 'header_not_rlp_list', 'header_trailing_bytes']) {
      expect(kinds.has(k), k).toBe(true);
    }
  });
});

describe('finality_arb_force1: the real owner force-confirmation (Sepolia block 9404699, tx 0x350518a9...)', () => {
  const fx = JSON.parse(readIn('arb_force1', 'fixture.json').toString('utf8')) as {
    k: { number: number; hash: string; transactions_root: string; receipts_root: string };
    tx_index: number;
    tx_hash: string;
    expect: string;
  };
  const tx = Uint8Array.from(readIn('arb_force1', 'tx.bin'));
  const rc = Uint8Array.from(readIn('arb_force1', 'receipt.bin'));
  const nb = readIn('arb_force1', 'nodes.bin');

  const nodes = (): Uint8Array[] => {
    const dv = new DataView(nb.buffer, nb.byteOffset, nb.length);
    const n = dv.getUint32(0, false);
    let off = 4;
    const out: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      const l = dv.getUint32(off, false);
      off += 4;
      out.push(Uint8Array.from(nb.subarray(off, off + l)));
      off += l;
    }
    expect(off).toBe(nb.length);
    return out;
  };

  const setup = async () => {
    const A = await load();
    const arb = A.loadArbFinalPins(embeddedPins());
    const r = A.decodeReceipt(rc);
    const confirmed = r.logs.find((l) => hx(l.address) === hx(arb.rollup) && hx(l.topics[0]!) === hx(arb.topic.confirmed))!;
    const forced = r.logs.some((l) => hx(l.address) === hx(arb.rollup) && hx(l.topics[0]!) === hx(arb.topic.forceConfirmed));
    expect(forced).toBe(true);
    const assertion = confirmed.topics[1]!;
    const kh = { transactionRoot: bytesOfHex(fx.k.transactions_root), receiptsRoot: bytesOfHex(fx.k.receipts_root) };
    const kb = { number: BigInt(fx.k.number), stateRoot: new Uint8Array(32) };
    const e = { confTxIndex: fx.tx_index, confTxRaw: tx, confReceiptRaw: rc, nodes: nodes() };
    const run = (over: Record<string, unknown> = {}, k2 = kh, a2 = assertion): string => {
      try {
        A.classifyConfirmation(arb, kb, k2, null, a2, { ...e, ...over });
        return 'accepted';
      } catch (err) {
        return err instanceof FinalityStateError ? err.canonical() : `ERROR ${String(err)}`;
      }
    };
    return { A, arb, assertion, kh, run, e };
  };

  it('is classified as confirmed_by_owner_force{force} by its log, byte for byte the fixture literal, with the transaction hash of the fixture', async () => {
    const { run, A } = await setup();
    expect(run()).toBe(fx.expect);
    expect(hx(A.txHashOf(tx))).toBe(fx.tx_hash.replace(/^0x/, ''));
  });

  it('a proof for another index, another receipts root or another assertion is not accepted as the same fact', async () => {
    const { run, kh, assertion } = await setup();
    expect(run({ confTxIndex: fx.tx_index + 1 })).toBe('{"code":"l1_tx_proof_invalid","fields":{"which":"tx"}}');
    const bad = { ...kh, receiptsRoot: Uint8Array.from(kh.receiptsRoot, (x, i) => (i === 0 ? x ^ 1 : x)) };
    expect(run({}, bad)).toBe('{"code":"l1_tx_proof_invalid","fields":{"which":"receipt"}}');
    const otherTx = { ...kh, transactionRoot: Uint8Array.from(kh.transactionRoot, (x, i) => (i === 31 ? x ^ 1 : x)) };
    expect(run({}, otherTx)).toBe('{"code":"l1_tx_proof_invalid","fields":{"which":"tx"}}');
    const other = Uint8Array.from(assertion, (x, i) => (i === 0 ? x ^ 1 : x));
    expect(JSON.parse(run({}, kh, other))).toMatchObject({ code: 'confirmation_path_unproven', fields: { reason: 'confirmation_log_missing' } });
  });

  it('a transaction leaf that differs from the carried raw bytes, and a receipt leaf likewise, are l1_tx_proof_invalid of their own part', async () => {
    const { run } = await setup();
    const t2 = Uint8Array.from(tx);
    t2[t2.length - 1] ^= 1;
    expect(run({ confTxRaw: t2 })).toBe('{"code":"l1_tx_proof_invalid","fields":{"which":"tx"}}');
    const r2 = Uint8Array.from(rc);
    r2[r2.length - 1] ^= 1;
    expect(run({ confReceiptRaw: r2 })).toBe('{"code":"l1_tx_proof_invalid","fields":{"which":"receipt"}}');
    expect(run({ nodes: [] })).toBe('{"code":"l1_tx_proof_invalid","fields":{"which":"tx"}}');
  });
});
