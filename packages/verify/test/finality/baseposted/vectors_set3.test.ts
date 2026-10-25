/**
 * The parity oracle of finality_base_posted3: 21 binding and channel-timeout cases (validator 42083c43 at pv2/rb11-d2-fix, manifest
 * f0b6acb4...3d92): every deposit transaction must be type 0x7e and no batch transaction may be one or empty, and the channel timeout is 50
 * from Granite and 300 before it, selected per frame by the timestamp of the L1 block holding that frame. The world of a case is the
 * synthetic world of synth.ts (the twin of the Go synth_test.go): a calldata batcher transaction per frame, the L1 block n timed
 * l1_time_base + n, the case's stream, deposits, L2 timestamp, parent hash and transaction list, and the case's three timeout pins.
 */
import { describe, expect, it } from 'vitest';
import { verifyChannel } from '../../../src/proof-v2/finality/baseposted/verify.js';
import { trieRoot } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { makeSynth } from './synth.js';
import { canonicalOutcome, checkSetIdentity, expectRegistered, expectedOf, setReader, unhexStrict, type Expect } from './vectors_set23.js';

const DIR = 'base_posted3';
const rd = setReader(DIR);
const PINNED = 'f0b6acb4cbf3c43459999cfe2a0f67ab7c166c5ca1877740e4529fbfd7c63d92';

interface BindingCase {
  format: string;
  id: string;
  pins: Record<string, string>;
  l1_time_base: string;
  frame_l1_blocks: string[];
  stream: string;
  l2: { timestamp: string; parent_hash: string; txs: string[] };
  deposits: string[];
  expect: Expect;
}

const m = JSON.parse(rd('manifest.json').toString('utf8')) as { cases: string[] };

describe('finality_base_posted3 identity', () => {
  it('the manifest is the Go-written one, lists exactly the files on disk, and holds 21 cases', () => {
    const mm = checkSetIdentity(DIR, PINNED, 'certen-base-posted-binding-set/1', 'finality_base_posted3', [
      'README.md',
      'generator/gen3.py',
      ...m.cases.map((c) => `cases/${c}.json`),
    ]);
    expect(mm.cases.length).toBe(21);
  });
});

describe('finality_base_posted3 cases', () => {
  let okCases = 0;
  let refusals = 0;
  for (const id of m.cases) {
    it(id, () => {
      const c = JSON.parse(rd(`cases/${id}.json`).toString('utf8')) as BindingCase;
      expect(c.id).toBe(id);
      expect(c.format).toBe('certen-base-posted-binding/1');
      expect(c.l1_time_base).toBe('1790000000');
      const blocks = c.frame_l1_blocks.map((b) => BigInt(b));
      const s = makeSynth({ compression: 'zlib', nFrames: blocks.length, frameBlocks: blocks, rawStream: unhexStrict(c.stream) });
      s.bp.channelTimeout = BigInt(c.pins.channel_timeout!);
      s.bp.graniteTime = BigInt(c.pins.granite_time!);
      s.bp.channelTimeoutGranite = BigInt(c.pins.channel_timeout_granite!);
      s.body.deposits = c.deposits.map(unhexStrict);
      const l2h = {
        ...s.l2,
        timestamp: BigInt(c.l2.timestamp),
        parentHash: unhexStrict(c.l2.parent_hash),
        transactionRoot: trieRoot(c.l2.txs.map(unhexStrict)),
      };
      // the Go synthetic world judges under a zero FinalizedHead (slot 0, epoch 0)
      const out = canonicalOutcome(() => verifyChannel(s.bp, s.body, s.covered, l2h, { slot: 0n, epoch: 0n }));
      expect(out).toBe(expectedOf(c.expect));
      expectRegistered(id, c.expect);
      if (c.expect.result === 'ok') okCases++;
      else refusals++;
    });
  }
  it('covers accepted and refused cases of both kinds', () => {
    expect(okCases).toBeGreaterThanOrEqual(5);
    expect(refusals).toBeGreaterThanOrEqual(12);
  });
});
