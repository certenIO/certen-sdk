/**
 * The parity oracle of finality_base_posted4: 8 streamed-channel cases (validator pv2/rb12-specq1, R12-SPEC-Q1). The sequencing window is judged on the
 * completing frame alone (epoch_num + sequence_window_size) and a frame below the batch epoch is not refused, as OP derivation has no lower bound.
 * The world of a case is the synthetic world of synth.ts, as for finality_base_posted3.
 */
import { describe, expect, it } from 'vitest';
import { verifyChannel } from '../../../src/proof-v2/finality/baseposted/verify.js';
import { trieRoot } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { makeSynth } from './synth.js';
import { canonicalOutcome, checkSetIdentity, expectRegistered, expectedOf, setReader, unhexStrict, type Expect } from './vectors_set23.js';

const DIR = 'base_posted4';
const rd = setReader(DIR);
const PINNED = '674fb621616b1627d7e589ddac9e42655a994aa984838dd8f1f535f61323d817';

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

describe('finality_base_posted4 identity', () => {
  it('the manifest is the Go-written one, lists exactly the files on disk, and holds 8 cases', () => {
    const mm = checkSetIdentity(DIR, PINNED, 'certen-base-posted-binding-set/1', 'finality_base_posted4', [
      'README.md',
      'generator/gen4.py',
      ...m.cases.map((c) => `cases/${c}.json`),
    ]);
    expect(mm.cases.length).toBe(8);
  });
});

describe('finality_base_posted4 cases', () => {
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
    expect(okCases).toBe(5);
    expect(refusals).toBe(3);
  });
});
