/**
 * Timing of the largest valid vector (the live batch: LC finality, a 16-header spine, Bridge proofs, three 128 KiB blobs under one batched
 * KZG check, a 573-segment brotli payload). The numbers are printed for the check-in; the assertion is a generous ceiling only, so a slow
 * shared machine does not make the suite flaky.
 */
import { describe, expect, it } from 'vitest';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { ArbPostedKind, verifyBlobs } from '../../../src/proof-v2/finality/arbposted/verify.js';
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { decodeEvidence, defaultBounds } from '../../../src/proof-v2/finality/arbposted/wire.js';
import { evidenceOf, loadCase, read, refOf } from './vectorset.js';

describe('verify time of the largest valid vector', () => {
  it('judges the live batch (3 blobs) well inside the ceiling; prints the split', () => {
    const c = loadCase('valid_live');
    const pins = parsePinsOverride(read(c.pins));
    const ref = refOf(c.leg);
    const ev = evidenceOf(c);
    const kind = new ArbPostedKind();
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const v = kind.verify(pins, ref, ev);
      times.push(performance.now() - t0);
      expect(v.fields.blobs).toBe(3n);
    }
    const body = decodeEvidence(decodeContainer(ev, defaultLimits()).body, defaultBounds(defaultLimits()));
    const k0 = performance.now();
    verifyBlobs(body);
    const kzg = performance.now() - k0;
    const sorted = [...times].sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log(`arbposted valid_live verify ms: first ${times[0]!.toFixed(0)} (cold: setup load + first batch), min ${sorted[0]!.toFixed(0)}, median ${sorted[2]!.toFixed(0)}, max ${sorted[4]!.toFixed(0)}; blob check alone ${kzg.toFixed(0)} ms`);
    expect(sorted[2]!).toBeLessThan(15_000);
  });
});
