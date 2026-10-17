import { readFileSync } from 'node:fs';
import { decodeSignature, decodeTransaction, verdictOf, verifyKeySignature, type VerifyEnv, type WireNode } from '../../src/sigtypes/index.js';

/**
 * The shared sigtypes conformance vectors (Go-written; byte-identical copies in test/fixtures/sigtypes) and the TypeScript
 * judgement of one: sigfixture.Judge in the validator (liteclient/proof/govsig/sigfixture), step for step - decode the binary
 * signature and the transaction, verify under Accumulate's rule, then require the key hash to be an entry of the signer page
 * the vector states.
 */
export const fixtureDir = new URL('../fixtures/sigtypes/', import.meta.url);
export const readFixture = (name: string): Buffer => readFileSync(new URL(name, fixtureDir));

export interface Expect {
  verdict: string;
  keyHash?: string;
  form?: string;
  ethRule?: string;
  innerType?: string;
  delegators?: string[];
  vote?: string;
}
export interface Vector {
  id: string;
  source: string;
  kind: string;
  type: string;
  description: string;
  transaction?: string;
  txHash: string;
  signature: string;
  signatureJson: Record<string, unknown> | null;
  networkName?: string;
  where?: { partition: string; block: number };
  page?: { entries: string[] };
  expect: Expect;
}
export interface Manifest {
  format: string;
  files: { name: string; sha256: string; vectors: number }[];
  manifestHash: string;
  sources: Record<string, number>;
  vectors: number;
}

export const manifest = JSON.parse(readFixture('manifest.json').toString('utf8')) as Manifest;
export const vectors: Vector[] = manifest.files.flatMap((f) => (JSON.parse(readFixture(f.name).toString('utf8')) as { vectors: Vector[] }).vectors);
export const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

export interface Judged {
  verdict: string;
  keyHash?: string;
  form?: string;
  ethRule?: string;
  innerType?: string;
  delegators?: string[];
  error?: unknown;
}

export function judge(v: Vector): Judged {
  let sig: WireNode;
  let txn: WireNode | undefined;
  try {
    sig = decodeSignature(fromHex(v.signature));
    if (v.transaction) txn = decodeTransaction(fromHex(v.transaction));
  } catch (error) {
    return { verdict: verdictOf(error), error };
  }
  const env: VerifyEnv = { txHash: fromHex(v.txHash), transaction: txn, networkName: v.networkName, where: v.where };
  try {
    const r = verifyKeySignature(sig, env);
    const keyHash = toHex(r.keyHash);
    const out: Judged = { verdict: 'accepted', keyHash, form: r.form, ethRule: r.ethRule, innerType: r.innerType, delegators: r.delegators };
    if (v.page && !v.page.entries.some((e) => e.toLowerCase() === keyHash)) return { ...out, verdict: 'refused:key_not_on_page' };
    return out;
  } catch (error) {
    return { verdict: verdictOf(error), error };
  }
}
