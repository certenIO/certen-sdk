/**
 * The parity oracle of finality_base_posted2: eight decompressed-channel streams whose span batch declares per-block transaction counts that
 * wrap a uint64 sum (validator ac8dc5c9 at pv2/rb11-e2-posted, manifest 9ca77aab...8116). Each case is checked at the decode level
 * (decodeBatches: the batches it returns or a stream error) and at the verifier level (verifyChannel over a synthetic calldata channel
 * carrying exactly that stream), and neither may throw anything but a named state.
 */
import { describe, expect, it } from 'vitest';
import { RlpError } from '../../../src/s6/rlp.js';
import { BatchFormatError, BatchStreamError, decodeBatches } from '../../../src/proof-v2/finality/baseposted/span.js';
import { verifyChannel } from '../../../src/proof-v2/finality/baseposted/verify.js';
import { makeSynth } from './synth.js';
import { canonicalOutcome, checkSetIdentity, expectRegistered, expectedOf, norm, setReader, unhexStrict, type Expect } from './vectors_set23.js';

const DIR = 'base_posted2';
const rd = setReader(DIR);
const PINNED = '9ca77aabe8b0cf5bb6e8f5adccefa88befd8c521d4c7f7bdb560fa420aaf8116';

interface StreamCase {
  format: string;
  id: string;
  params: { l2_genesis_time: string; l2_block_time: string; chain_id: string };
  stream: string;
  decode: { result: 'ok' | 'stream_error'; batches?: Record<string, unknown>[] };
  verifier: Expect;
}

const m = JSON.parse(rd('manifest.json').toString('utf8')) as { cases: string[] };

describe('finality_base_posted2 identity', () => {
  it('the manifest is the Go-written one, lists exactly the files on disk, and holds eight streams', () => {
    const mm = checkSetIdentity(DIR, PINNED, 'certen-base-posted-stream-set/1', 'finality_base_posted2', [
      'README.md',
      'generator/gen2.py',
      ...m.cases.map((c) => `streams/${c}.json`),
    ]);
    expect(mm.cases.length).toBe(8);
  });
});

describe('finality_base_posted2 streams', () => {
  const sp = { genesisTime: 1695768288n, blockTime: 2n, chainId: 84532n };
  let okCases = 0;
  let refusals = 0;
  for (const id of m.cases) {
    it(id, () => {
      const c = JSON.parse(rd(`streams/${id}.json`).toString('utf8')) as StreamCase;
      expect(c.id).toBe(id);
      expect(c.format).toBe('certen-base-posted-stream/1');
      expect(BigInt(c.params.l2_genesis_time)).toBe(sp.genesisTime);
      expect(BigInt(c.params.l2_block_time)).toBe(sp.blockTime);
      expect(BigInt(c.params.chain_id)).toBe(sp.chainId);
      const stream = unhexStrict(c.stream);
      // decode level
      let got: { result: string; batches?: Record<string, unknown>[] };
      try {
        const bs = decodeBatches(stream, sp);
        got = {
          result: 'ok',
          batches: bs.map((b) => ({
            type: String(b.type),
            epoch_num: String(b.epochNum),
            timestamp: String(b.timestamp),
            span_index: String(b.spanIndex),
            span_blocks: String(b.spanBlocks),
            parent_len: String(b.parentLen),
            epoch_len: String(b.epochLen),
            txs: b.txs.map((t) => `0x${Buffer.from(t).toString('hex')}`),
          })),
        };
      } catch (e) {
        if (!(e instanceof BatchFormatError || e instanceof BatchStreamError || e instanceof RlpError)) throw e;
        got = { result: 'stream_error' };
      }
      expect(norm(got)).toBe(norm(c.decode));
      // verifier level: the synthetic calldata channel of exactly this stream, judged against an L2 block at 1790000000
      const s = makeSynth({ compression: 'zlib', rawStream: stream });
      const out = canonicalOutcome(() => verifyChannel(s.bp, s.body, s.covered, s.l2, s.head));
      expect(out).toBe(expectedOf(c.verifier));
      expectRegistered(id, c.verifier);
      if (c.decode.result === 'ok') okCases++;
      else refusals++;
    });
  }
  it('covers both accepted and refused streams', () => {
    expect(okCases).toBeGreaterThanOrEqual(2);
    expect(refusals).toBeGreaterThanOrEqual(6);
  });
});
