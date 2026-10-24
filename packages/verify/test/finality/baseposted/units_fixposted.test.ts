/**
 * RB12-TS-FIX-POSTED, base_posted: the blob binding of the signed batcher transaction (the twin of the Go gateb4_test.go
 * TestAValidBlobTripleThatTheTransactionDoesNotCommitToIsABlobMismatch) and the zlib channel header (FDICT with the empty dictionary: the twin of
 * Go's zlib.NewReader, which the audit V-RB12-TS-AUDIT-POSTED D2 measured as the one place the two verifiers disagreed on a channel).
 */
import { describe, expect, it } from 'vitest';
import { decodeContainer, defaultLimits, encodeContainer } from '../../../src/proof-v2/finality/codec.js';
import { ethl1PinsFrom } from '../../../src/proof-v2/finality/ethl1/index.js';
import { parsePinsOverride, sepoliaPins } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { BasePostedKind } from '../../../src/proof-v2/finality/baseposted/index.js';
import { decodeBody, encodeBody } from '../../../src/proof-v2/finality/baseposted/wire.js';
import { assertRegistered } from './regcheck.js';
import { bytesOfHex, read, readPins } from './vectorset.js';

const kind = new BasePostedKind();
const lim = defaultLimits();
const pins = parsePinsOverride(readPins('pins/main.json'));
const ep = ethl1PinsFrom(sepoliaPins(pins));
const leg = JSON.parse(read('legs/a.json').toString('utf8')) as { chain: string; number: string; hash: string; header: string };
const ref = { chain: BigInt(leg.chain), number: BigInt(leg.number), hash: bytesOfHex(leg.hash), headerRlp: bytesOfHex(leg.header) };
const evA = Uint8Array.from(read('evidence/valid_a.bin'));
const evB = Uint8Array.from(read('evidence/valid_b.bin'));
const legB = JSON.parse(read('legs/b.json').toString('utf8')) as typeof leg;

const stateOf = (fn: () => unknown): FinalityStateError | null => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FinalityStateError) {
      assertRegistered(e);
      return e;
    }
    throw e;
  }
  return null;
};

describe('the signed batcher transaction commits to every blob it is verified against', () => {
  const ca = decodeContainer(evA, lim);
  const cb = decodeContainer(evB, lim);
  const bodyA = decodeBody(ca.body, lim, ep, 32);
  const bodyB = decodeBody(cb.body, lim, ep, 32);

  it('the test assumption holds: both evidences carry distinct blobs in their first frame, and the unmodified evidence is accepted', () => {
    expect(bodyA.frames[0]!.blobs.length).toBeGreaterThan(0);
    expect(bodyB.frames[0]!.blobs.length).toBeGreaterThan(0);
    expect(Buffer.from(bodyA.frames[0]!.blobs[0]!.commitment).equals(Buffer.from(bodyB.frames[0]!.blobs[0]!.commitment))).toBe(false);
    expect(stateOf(() => kind.verify(pins, ref, evA))).toBeNull();
  });

  it('a valid blob triple (blob, commitment, KZG proof) of another channel is a blob_commitment_mismatch, not an acceptance', () => {
    const frames = bodyA.frames.map((f, i) => (i === 0 ? { ...f, blobs: f.blobs.map((b, j) => (j === 0 ? bodyB.frames[0]!.blobs[0]! : b)) } : f));
    const swapped = encodeContainer({ header: ca.header, body: encodeBody({ ...bodyA, frames }) });
    const e = stateOf(() => kind.verify(pins, ref, swapped));
    expect(e, 'a blob the transaction does not commit to was accepted').not.toBeNull();
    expect(e!.code).toBe('blob_commitment_mismatch');
    expect(e!.canonical()).toBe('{"code":"blob_commitment_mismatch","fields":{}}');
  });

  it('the substituted triple is itself valid: the evidence that carries it (B) is accepted, so only the transaction binding of A is wrong', () => {
    expect(stateOf(() => kind.verify(pins, { chain: BigInt(legB.chain), number: BigInt(legB.number), hash: bytesOfHex(legB.hash), headerRlp: bytesOfHex(legB.header) }, evB))).toBeNull();
  });

  it('the binding is per blob: any blob of any frame of A replaced by a valid blob of B is refused, whichever index it sits at', () => {
    const donor = bodyB.frames[0]!.blobs[0]!;
    let tried = 0;
    bodyA.frames.forEach((f, i) =>
      f.blobs.forEach((_, j) => {
        const frames = bodyA.frames.map((g, gi) => (gi === i ? { ...g, blobs: g.blobs.map((b, bj) => (bj === j ? donor : b)) } : g));
        const e = stateOf(() => kind.verify(pins, ref, encodeContainer({ header: ca.header, body: encodeBody({ ...bodyA, frames }) })));
        expect(e?.code, `frame ${i} blob ${j}`).toBe('blob_commitment_mismatch');
        tried++;
      }),
    );
    expect(tried).toBe(bodyA.frames.reduce((n, f) => n + f.blobs.length, 0));
    expect(tried).toBeGreaterThan(1);
  });
});
