import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { keccak256, toHex, rlpEncodeUint, verifyExecutionProof, executionComponentOf, checkAgainstHeader, decodeReceipt, bytesFrom } from '../src/execution-proof.js';

// A REAL execution proof: the insurer's 1.5 tUSDC claim on Base Sepolia, block 46437431, as the
// validator persisted it on 2026-09-05 (raw trie nodes, leaf receipt, header roots).
const bundle = JSON.parse(readFileSync(new URL('./fixtures/execution-proof-base-46437431.json', import.meta.url), 'utf8'));
const LEDGER = '0x41bc4283624ff703a6e15b1c2aafae95a5eb335e';
const CLAIM_PAID = '0x81eb79acc6a0ef94dfb507ea35363f86d0d190b46f4d608dc4c1d7480a7c7cbc';
const ORDER = '0xc4991b4ad6558b23196559052a784a2050efbb31c153a751607feefd92473ad6';

describe('keccak-256 and RLP', () => {
  it('matches the known vectors', () => {
    expect(toHex(keccak256(new Uint8Array(0)))).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(toHex(keccak256(Buffer.from('abc')))).toBe('0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    expect(toHex(keccak256(Buffer.from('Transfer(address,address,uint256)')))).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  });
  it('encodes trie keys the way go-ethereum does', () => {
    expect(toHex(rlpEncodeUint(0))).toBe('0x80');
    expect(toHex(rlpEncodeUint(23))).toBe('0x17');
    expect(toHex(rlpEncodeUint(128))).toBe('0x8180');
    expect(toHex(rlpEncodeUint(300))).toBe('0x82012c');
  });
});

describe('verifyExecutionProof on the real Base receipt', () => {
  const c = executionComponentOf(bundle)!;
  it('finds component 5', () => { expect(c.tx_hash).toBe('0x591707ddd9c0292196f0671b48f8ec71c696f5c7c97ca9d39a629ead652d5d48'); });

  it('walks the receipts trie to the receipt the bundle shows, and finds ClaimPaid for the order', () => {
    const v = verifyExecutionProof(c, { address: LEDGER, topic0: CLAIM_PAID, topic1: ORDER });
    expect(v.error).toBeUndefined();
    expect(v.ok).toBe(true);
    expect(v.transactionIndex).toBe(23);
    expect(v.receiptsRoot).toBe(c.receipts_root);
    expect(v.receipt!.status).toBe(1);
    expect(v.receipt!.logs.map((l) => l.topics[0])).toContain(CLAIM_PAID);
    expect(v.expectedLogFound).toBe(true);
    expect(v.caveats.length).toBe(2);
  });

  it('refuses a tampered root, a tampered receipt, and a missing node', () => {
    const badRoot = { ...c, receipt_inclusion_proof: { ...c.receipt_inclusion_proof!, expected_root: '0x' + '11'.repeat(32) }, receipts_root: '0x' + '11'.repeat(32) };
    expect(verifyExecutionProof(badRoot).ok).toBe(false);
    expect(verifyExecutionProof(badRoot).error).toMatch(/missing the node/);

    const raw = bytesFrom(c.raw_receipt!); raw[raw.length - 1] ^= 1;
    const badReceipt = { ...c, raw_receipt: toHex(raw) };
    expect(verifyExecutionProof(badReceipt).error).toMatch(/different receipt/);

    const fewer = { ...c, receipt_inclusion_proof: { ...c.receipt_inclusion_proof!, proof_nodes: c.receipt_inclusion_proof!.proof_nodes!.slice(0, -1) } };
    expect(verifyExecutionProof(fewer).ok).toBe(false);
  });

  it('reports the expected log as absent when a different order is asked for', () => {
    const v = verifyExecutionProof(c, { address: LEDGER, topic0: CLAIM_PAID, topic1: '0x' + 'ab'.repeat(32) });
    expect(v.ok).toBe(true); expect(v.expectedLogFound).toBe(false);
  });

  it('says so when the bundle carries no proof', () => {
    const v = verifyExecutionProof({ ...c, receipt_inclusion_proof: undefined });
    expect(v.ok).toBe(false); expect(v.error).toMatch(/no receipt inclusion proof/);
  });

  it('closes the caveat against a header', () => {
    const v = verifyExecutionProof(c);
    expect(checkAgainstHeader(v, { receiptsRoot: c.receipts_root, hash: c.block_hash, number: c.block_number }).ok).toBe(true);
    const r = checkAgainstHeader(v, { receiptsRoot: '0x' + '22'.repeat(32) });
    expect(r.ok).toBe(false); expect(r.reasons[0]).toMatch(/receipts root differs/);
  });

  it('decodes the receipt the way the bundle lists its logs', () => {
    const d = decodeReceipt(bytesFrom(c.raw_receipt!));
    expect(d.logs.length).toBe(c.logs!.length);
    expect(d.logs[d.logs.length - 1].address.toLowerCase()).toBe(c.logs![c.logs!.length - 1].address.toLowerCase());
  });
});
