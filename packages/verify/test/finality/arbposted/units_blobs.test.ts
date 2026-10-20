/**
 * The blob leg of the kind (verifyBlobs, and verifyState with blobs): every blob of the live batch carries its own failure, a blob that
 * authenticates but does not hold an RLP payload is payload_undecodable, and the order of the versioned hashes matters.
 */
import { describe, expect, it } from 'vitest';
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { verifyBlobs } from '../../../src/proof-v2/finality/arbposted/verify.js';
import { decodeEvidence, defaultBounds, type Evidence } from '../../../src/proof-v2/finality/arbposted/wire.js';
import { evidenceOf, loadCase } from './vectorset.js';
import { makeSynth } from './synth.js';

const live = (): Evidence => decodeEvidence(decodeContainer(evidenceOf(loadCase('valid_live')), defaultLimits()).body, defaultBounds(defaultLimits()));
const MISMATCH = '{"code":"blob_commitment_mismatch","fields":{}}';
const refusal = (e: Pick<Evidence, 'blobs' | 'versionedHashes'>): string => {
  try {
    verifyBlobs(e);
  } catch (err) {
    if (err instanceof FinalityStateError) return err.canonical();
    throw err;
  }
  return 'ok';
};
const clone = (e: Evidence): Evidence => ({
  ...e,
  versionedHashes: e.versionedHashes.map((h) => Uint8Array.from(h)),
  blobs: e.blobs.map((b) => ({ raw: Uint8Array.from(b.raw), commitment: Uint8Array.from(b.commitment), proof: Uint8Array.from(b.proof) })),
});

describe('verifyBlobs over the three live blobs', () => {
  const base = live();
  it('authenticates the live blobs', () => {
    expect(base.blobs.length).toBe(3);
    expect(refusal(base)).toBe('ok');
  });
  it('a flipped proof, commitment or raw byte in ANY blob (the first included) is blob_commitment_mismatch', () => {
    for (let j = 0; j < 3; j++) {
      for (const part of ['proof', 'commitment', 'raw'] as const) {
        const e = clone(base);
        e.blobs[j]![part][part === 'raw' ? 40_000 : 7]! ^= 1;
        expect(refusal(e), `blob ${j} ${part}`).toBe(MISMATCH);
      }
    }
  });
  it('a versioned hash that is not sha256(commitment) with the version byte 0x01 is a mismatch, in any position; swapped hashes too', () => {
    for (let j = 0; j < 3; j++) {
      const e = clone(base);
      e.versionedHashes[j]![31] ^= 1;
      expect(refusal(e), `hash ${j}`).toBe(MISMATCH);
      const f = clone(base);
      f.versionedHashes[j]![0] = 0x02;
      expect(refusal(f), `version ${j}`).toBe(MISMATCH);
    }
    const sw = clone(base);
    [sw.versionedHashes[0], sw.versionedHashes[1]] = [sw.versionedHashes[1]!, sw.versionedHashes[0]!];
    expect(refusal(sw)).toBe(MISMATCH);
  });
  it('no blobs is nothing to check; one blob alone authenticates', () => {
    expect(refusal({ blobs: [], versionedHashes: [] })).toBe('ok');
    expect(refusal({ blobs: [base.blobs[0]!], versionedHashes: [base.versionedHashes[0]!] })).toBe('ok');
    expect(refusal({ blobs: [base.blobs[2]!, base.blobs[0]!], versionedHashes: [base.versionedHashes[2]!, base.versionedHashes[0]!] })).toBe('ok');
  });
});

describe('blob mode through verifyState', () => {
  const base = live();
  it('an authentic blob whose content is only the head of a longer RLP string is payload_undecodable, not a KZG failure', () => {
    const s = makeSynth({ blobs: [base.blobs[0]!] });
    try {
      s.run();
      throw new Error('accepted');
    } catch (e) {
      expect((e as FinalityStateError).canonical()).toBe('{"code":"l1_posted_content_not_found","fields":{"batch":"77","reason":"payload_undecodable"}}');
    }
  });
  it('a count of blobs that differs from the count of versioned hashes is blob_commitment_mismatch before any blob is read', () => {
    const s = makeSynth({ blobs: [base.blobs[0]!] });
    s.ev.blobs = [];
    // the stored accumulator was built over one versioned hash, which is still in the evidence
    expect(() => s.run()).toThrow(/blob_commitment_mismatch/);
  });
  it('an authentic blob with a flipped proof is refused as blob_commitment_mismatch, ahead of the payload', () => {
    const e = clone(base);
    e.blobs[0]!.proof[3]! ^= 1;
    const s = makeSynth({ blobs: [e.blobs[0]!] });
    expect(() => s.run()).toThrow(/blob_commitment_mismatch/);
  });
});
