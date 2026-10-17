import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeSignature, decodeTransaction, eip712Hash, transactionHash } from '../src/sigtypes/index.js';
import { readFixture } from './helpers/sigtypes.js';

/**
 * Byte-level mutations of the transactions in the EIP-712 body corpus, against Accumulate: for each, does the transaction decode
 * at all (Transaction.UnmarshalBinary), what is its hash, and what is the EIP-712 digest of the base vector's signature over it,
 * or does EIP712Hash refuse. The decoder and the port must agree with Accumulate on every one, in particular on the mutations it
 * accepts (a flipped bit that lands in a byte nothing reads, an appended unknown field) and on the ones it refuses (a URL that
 * does not parse, a field out of order, an enum that is not a value). The Go program that wrote it is
 * test/fixtures/sigtypes/eip712-tx-mutations.gen.go.txt; a mutation on which Go panics is not in the file.
 */
const raw = readFixture('eip712-tx-mutations.json');
const SHA256 = createHash('sha256').update(raw).digest('hex');
interface Mut {
  id: string;
  base: string;
  op: string;
  transaction: string;
  decodes: boolean;
  txHash?: string;
  hash?: string;
  refused?: boolean;
}
const file = JSON.parse(raw.toString('utf8')) as { format: string; mutations: Mut[] };
const bodies = JSON.parse(readFileSync(new URL('./fixtures/sigtypes/eip712-bodies.json', import.meta.url), 'utf8')) as { vectors: { id: string; signature: string }[] };
const sigOf = new Map(bodies.vectors.map((v) => [v.id, v.signature]));
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('mutations of the EIP-712 corpus\'s transactions, against Accumulate', () => {
  it('is the file the Go program wrote', () => {
    expect(SHA256).toBe('a9ee9ba4bf945894f6fdfa47a65badc212e1783d437f4de288c8ed54bd8a9c4b');
    expect(file.format).toBe('certen:eip712-tx-mutations:v1');
    expect(file.mutations.length).toBe(3737);
    expect(file.mutations.filter((m) => m.decodes).length).toBe(1533);
    expect(file.mutations.filter((m) => m.refused).length).toBe(242);
    expect(file.mutations.filter((m) => m.hash).length).toBe(1291);
  });

  it('decodes, hashes and digests every one as Accumulate does', () => {
    const wrong: string[] = [];
    for (const m of file.mutations) {
      const sig = decodeSignature(fromHex(sigOf.get(m.base)!))!;
      let decoded;
      try {
        decoded = decodeTransaction(fromHex(m.transaction));
      } catch {
        if (m.decodes) wrong.push(`${m.id} (${m.op}): Go decodes it, here it does not`);
        continue;
      }
      if (!m.decodes) {
        wrong.push(`${m.id} (${m.op}): Go refuses to decode it, here it decodes`);
        continue;
      }
      let h: string | undefined;
      try {
        h = toHex(transactionHash(decoded));
      } catch (e) {
        h = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (h !== m.txHash) wrong.push(`${m.id} (${m.op}): transaction hash Go ${m.txHash}, here ${h}`);
      let d: string | undefined;
      try {
        d = toHex(eip712Hash(decoded, sig));
      } catch {
        d = undefined;
      }
      if (m.refused ? d !== undefined : d !== m.hash) wrong.push(`${m.id} (${m.op}): digest Go ${m.refused ? 'refused' : m.hash}, here ${d ?? 'refused'}`);
    }
    expect(wrong).toEqual([]);
  });
});
