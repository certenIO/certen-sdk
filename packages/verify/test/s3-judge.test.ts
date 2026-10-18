import { describe, expect, it } from 'vitest';
import { defineChunks, readCorpus } from './helpers/s3-corpus.js';
import { judgeScenario, type JudgeScenario, type JudgeVerdict } from './helpers/s3-judge.js';

/**
 * The Go-written corpus of consensus.judgeProofV2 (judge-cases.json, written by the scratch generator test/fixtures/s3/gen/xts_judge_test.go.txt
 * run in pkg/consensus): the order in which a v3 certificate's proof v2 is judged - missing, the version against the activation in force, the
 * verifier (handed the evidence-2.0 view when the document does not claim 2.1), the one validator set, then the binding and the root together.
 * The verifier is injected on both sides; which refusal, its wording, the document the verifier was handed and the govRoot are Go's.
 */
const HASH = 'd2c15319eecbfab5cdc88a7573db9635cfe4a0d0e9d74069e959f49fa64e5716';

interface File {
  format: string;
  base: Record<string, unknown>;
  hashes: Record<string, string>;
  cases: (JudgeScenario & { expect: JudgeVerdict })[];
}
const file = readCorpus<File>('go-written/judge-cases.json', HASH);

const canon = (v: JudgeVerdict): string => JSON.stringify({ kind: v.kind, msg: v.msg ?? '', verifyInput: v.verifyInput ?? '', called: v.called, govRoot: v.govRoot ?? '' });

describe('judgeProofV2, against Go', () => {
  it('has the shape the Go program wrote', () => {
    expect(file.format).toBe('certen-sdk/s3-judge-corpus/v1');
    const kinds = new Set(file.cases.map((c) => c.expect.kind));
    // every refusal consensus names, and a certified intent
    expect(kinds.size).toBeGreaterThanOrEqual(7);
    expect(kinds.has('ok')).toBe(true);
  });
  defineChunks(
    'scenarios',
    file.cases.map((c, i) => ({ id: `${i}: ${c.name} (claims ${JSON.stringify(c.claim)}, ${c.required ? 'required' : 'not required'})`, c })),
    ({ c }) => {
      const { expect: want, ...sc } = c;
      const got = judgeScenario(file.base, file.hashes, sc);
      return canon(want) === canon(got) ? [] : [`Go ${canon(want).slice(0, 700)}; here ${canon(got).slice(0, 700)}`];
    },
    20,
  );
});
