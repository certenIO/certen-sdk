import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `certen proof verify-identity <@document> --outcome-file <file>` (WP-S8-CLI, TypeScript half): the contract identity (S8) of a leg on its own exit path,
 * 0 / 5 / 10 / 20 / 30 / 40 / 2 as the Go tool's table, one line per row. `certen proof verify` is not touched: its options are the three it had, and its own suite
 * (proof-verify.test.ts) is unchanged. The positive path (VERIFIED) needs a producer-exported outcome file and member, which this suite does not carry.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');
const run = promisify(execFile);
const fixture = JSON.parse(readFileSync(join(HERE, '..', '..', 'verify', 'test', 'fixtures', 'finality', 'doc_report1', 'settlements', 'outcome_84532.json'), 'utf8')) as {
  chain: number;
  settlement: { block_hash: string; block_header_rlp: string; tx_hash: string; tx_inclusion_proof: { leaf_index: number; leaf_value: string; proof_nodes: string[] }; receipt_inclusion_proof: { leaf_value: string; proof_nodes: string[] } };
};
const b64hex = (s: string): string => '0x' + Buffer.from(s, 'base64').toString('hex');

/** The block number of an RLP-encoded header: item 8 of its list. */
function headerNumber(headerHex: string): number {
  const b = Buffer.from(headerHex.slice(2), 'hex');
  let o = 1 + (b[0]! - 0xf7); // a header is a long list (0xf8..0xff)
  for (let i = 0; i < 8; i++) {
    const t = b[o]!;
    o += t < 0x80 ? 1 : t < 0xb8 ? 1 + (t - 0x80) : t < 0xc0 ? 1 + (t - 0xb7) + Number(BigInt('0x' + b.subarray(o + 1, o + 1 + (t - 0xb7)).toString('hex'))) : 1;
  }
  const t = b[o]!;
  return t < 0x80 ? t : Number(BigInt('0x' + b.subarray(o + 1, o + 1 + (t - 0x80)).toString('hex')));
}

const word = (n: number): string => '0x' + n.toString(16).padStart(2, '0').repeat(32);
function outcome(over: (e: Record<string, any>) => void = () => undefined): string {
  const s = fixture.settlement;
  const e: Record<string, any> = {
    chainId: fixture.chain,
    anchor: { batchRoot: word(1), batchOperationId: word(2), accumulateSetRoot: word(3), incarnation: word(4), certenSetRoot: word(5) },
    quorum: { thresholdNumerator: 2, thresholdDenominator: 3, validators: [{ address: '0x' + '11'.repeat(20), votingPower: '10', blsPublicKey: 'ab'.repeat(96) }] },
    member: {
      leaf: { status: 1, tx: s.tx_hash, blockNumber: headerNumber(s.block_header_rlp), blockHash: s.block_hash },
      adiUrl: 'acc://example.acme',
      transaction: {
        header: s.block_header_rlp, index: s.tx_inclusion_proof.leaf_index, transaction: b64hex(s.tx_inclusion_proof.leaf_value), transactionProof: s.tx_inclusion_proof.proof_nodes.map(b64hex),
        receipt: b64hex(s.receipt_inclusion_proof.leaf_value), receiptProof: s.receipt_inclusion_proof.proof_nodes.map(b64hex),
      },
    },
  };
  over(e);
  return JSON.stringify(e);
}

const dir = mkdtempSync(join(tmpdir(), 'certen-verify-identity-'));
let n = 0;
const file = (text: string): string => {
  const p = join(dir, `f${n++}.json`);
  writeFileSync(p, text);
  return p;
};
async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const r = await run(process.execPath, [CLI, ...args], { env: { ...process.env, NO_COLOR: '1' } });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === 'number' ? x.code : -1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
}

describe('certen proof verify-identity', () => {
  it('states its own exit codes in its help, and the 5 that is not proof verify\'s NO_EVIDENCE', async () => {
    const r = await cli('proof', 'verify-identity', '--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain('--outcome-file');
    expect(r.out).toContain('5 here is "not applicable"');
    expect(r.out).toContain('NO_EVIDENCE');
  });

  it('leaves `certen proof verify` with the three options it had', async () => {
    const r = await cli('proof', 'verify', '--help');
    expect(r.code).toBe(0);
    for (const o of ['--rpc', '--expect', '--govroot']) expect(r.out).toContain(o);
    expect(r.out).not.toContain('outcome-file');
    expect(r.out).not.toContain('contract-identity');
  });

  it('refuses a proof id or link, a missing outcome file and an unreadable file, each as proofverify: <error> with exit 2 (or a usage error)', async () => {
    const doc = file('{}');
    const a = await cli('proof', 'verify-identity', '11111111-2222-4333-8444-555555555555', '--outcome-file', file(outcome()));
    expect([a.code, a.out.startsWith('proofverify: verify-identity takes a portable proof document file')]).toEqual([2, true]);
    const b = await cli('proof', 'verify-identity', `@${doc}`);
    expect(b.code).not.toBe(0);
    const c = await cli('proof', 'verify-identity', `@${doc}`, '--outcome-file', join(dir, 'missing.json'));
    expect([c.code, c.out.startsWith('proofverify: ')]).toEqual([2, true]);
    const d = await cli('proof', 'verify-identity', `@${join(dir, 'missing.json')}`, '--outcome-file', file(outcome()));
    expect([d.code, d.out.startsWith('proofverify: ')]).toEqual([2, true]);
  });

  it('judges a document against the real settlement: the S7 report first, then one S8 row, and it never exits 0 without a member the verifier accepts', async () => {
    const out = file(outcome());
    for (const [doc, code, text] of [
      ['{}', undefined, 'contract identity: '],
      ['{"contractIdentity":null}', undefined, 'contract identity: '],
      ['{"contractIdentity":{"format":"certen-contract-identity/2"}}', 40, 'contract identity: REFUSED: contract_identity_evidence_unrecognised{'],
      ['{"contractIdentity":{"format":"certen-contract-identity/1","x":1}}', 2, 'proofverify: contractIdentity member'],
    ] as const) {
      const r = await cli('proof', 'verify-identity', `@${file(doc)}`, '--outcome-file', out);
      expect(r.code, `${doc}\n${r.out}\n${r.err}`).not.toBe(0);
      if (code !== undefined) expect(r.code, `${doc}
${r.out}`).toBe(code);
      expect(r.out, doc).toContain(text);
      expect(r.out, doc).not.toContain('VERIFIED at');
    }
  });

  it('an outcome evidence that settles nothing or is not an outcome evidence is exit 2 with no report', async () => {
    for (const bad of ['{', outcome((e) => { e['member'].leaf.status = 3; }), outcome((e) => { e['member'].leaf.blockNumber += 1; })]) {
      const r = await cli('proof', 'verify-identity', `@${file('{}')}`, '--outcome-file', file(bad));
      expect([r.code, r.out.startsWith('proofverify: '), r.out.includes('contract identity:')]).toEqual([2, true, false]);
    }
  });

  it('a document that is not one JSON object ends with the finality phase FAILED (exit 1) and no S8 row', async () => {
    const r = await cli('proof', 'verify-identity', `@${file('[1]')}`, '--outcome-file', file(outcome()));
    expect([r.code, r.out.includes('contract identity')]).toEqual([1, false]);
  });
});
