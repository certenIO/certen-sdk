import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AccUrl } from '../src/s3/acc.js';
import type { Evidence } from '../src/s3/evidence.js';
import type { XAnchor } from '../src/s3/executor.js';
import { headerOf, initiatorOf, signatureHash, signatureDidInitiate } from '../src/s3/model.js';
import { carriedInitiatorPages } from '../src/s3/roles.js';
import { decodeSigHex, decodeTxnHex } from '../src/s3/sig.js';
import { NamedState } from '../src/s3/states.js';
import type { ProvenAcct } from '../src/s3/xtypes.js';
import { metadataHash } from '../src/sigtypes/verify.js';

/**
 * carriedInitiatorPages on a delegation chain over the depth limit (xroles.go step 7, govsig.Verify: g1_delegation_depth_exceeded).
 *
 * The depth check cannot be reached through a whole document: a signature with 21 delegators is a different message, so its membership in the page's signature
 * chain would have to be re-proven. The function is run directly, with the member's arrival derivation replaced by the block the member claims (this is the ONLY
 * thing replaced: steps 1 to 5 of the function, the message hash, the did-initiate rule and the govsig verification itself are the real ones), on the Go-written
 * adversarial vector ed25519/adversarial/delegated-21 (a signature of 21 nested delegations) with the transaction's initiator set to that signature's metadata hash
 * so that it IS the initiating signature.
 */
vi.mock('../src/s3/timeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/s3/timeline.js')>();
  return { ...actual, deriveArrival: vi.fn(() => 64) };
});

interface SigVector {
  id: string;
  transaction?: string;
  signature: string;
  expect: { verdict: string };
}
const adversarial = JSON.parse(readFileSync(new URL('./fixtures/sigtypes/adversarial.json', import.meta.url), 'utf8')) as { vectors: SigVector[] };

describe('the initiating signature through more delegators than the protocol allows', () => {
  const v = adversarial.vectors.find((x) => x.id === 'ed25519/adversarial/delegated-21')!;
  it('is the vector the Go verifier refused for its depth', () => {
    expect(v.expect.verdict).toBe('refused:delegation_depth_exceeded');
  });

  it('is refused by name at the signer page: g1_delegation_depth_exceeded', () => {
    const txn = decodeTxnHex(v.transaction!);
    const sig = decodeSigHex(v.signature)!;
    // the signature IS the initiating signature of the transaction (the vector's transaction names another one)
    headerOf(txn)!.fields.set('initiator', metadataHash(sig));
    expect(signatureDidInitiate(sig, initiatorOf(txn))).toBe(true);

    const page = 'acc://pv2-erp-5.acme/book/1';
    const xa = { id: 'BVN3', block: 12_600_090, source: 'acc://bvn-BVN3.acme' } as unknown as XAnchor;
    const pa = { i: 0, anchor: xa, acct: {}, url: AccUrl.parse(page)!, chain: {}, page: {} } as unknown as ProvenAcct;
    const byURL = new Map<string, ProvenAcct>([[AccUrl.parse(page)!.key, pa]]);
    const ev = {
      pages: [{ url: page }],
      initiatingSignature: { page, message: Buffer.from(signatureHash(sig)).toString('hex'), signature: v.signature, block: 64, receipt: {}, arrival: { at: {} } },
    } as unknown as Evidence;
    const x1 = { id: 'BVN1', block: 12_600_050 } as unknown as XAnchor;

    let thrown: unknown;
    try {
      carriedInitiatorPages(ev, txn, byURL, new Map(), x1, 'DevNet');
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a signature through 21 delegators must be refused').toBeInstanceOf(NamedState);
    const ns = thrown as NamedState;
    expect({ code: ns.code, partition: ns.partition, block: ns.block }).toEqual({ code: 'g1_delegation_depth_exceeded', partition: 'BVN3', block: 12_600_090 });
  });
});
