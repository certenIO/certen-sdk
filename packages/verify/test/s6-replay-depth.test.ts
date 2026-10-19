import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeReplayGuardEvidence, judgeS6Replay, S6ReplayError } from '../src/index.js';
import type { S6Settlement, S6Verdict } from '../src/index.js';
import { JsonError } from '../src/s3/gojson.js';
import { GO_JSON_MAX_DEPTH, parseGoJson } from '../src/s3/jsonx.js';

/**
 * RB10-C3: the nesting depth of S6 replay evidence (independent review V-R10C2 D1). Go reads the evidence document with a
 * json.Decoder.Token() pass (pkg/ethproof replaydecode.go parseJSONValue) that has no depth limit; the 10000-container
 * limit belongs to the scanner json.Unmarshal uses, which only ever sees a document that already passed the schema check
 * and so is never deep. A document of any depth is therefore read in full and refused at the first unknown field / wrong
 * type (or at a duplicate key anywhere), exactly as a shallow one is. The TypeScript verifier must say the same: no
 * RangeError, no malformed_json for depth, the same reason as Go.
 *
 * The inputs are the reviewer's (V-R10C2.md, evidence `{"version":"certen:s6-replay:v1","zzz":` + N x `[` + N x `]` + `}` on
 * s6replay1 vector 001's settlement; `headers` replaced by an N-deep array; a 10005-deep unknown field followed by a
 * duplicate `version`) and the verdicts are Go's at certen-validator pkg/ethproof 7ad629d (s6replay1.Judge); the further
 * shapes (deep objects, deep `proof`, unterminated and mismatched deep documents, deep trailing garbage, deep duplicates)
 * were judged by Go at the same commit in a throwaway test and are pinned below with Go's verdict.
 */
const vector = JSON.parse(readFileSync(new URL('./fixtures/s6replay1/001_valid_at_settlement_block.json', import.meta.url), 'utf8')) as {
  settlement: S6Settlement;
  evidence: string;
};
const settlement = vector.settlement;
const base = vector.evidence;

const VERSION = '{"version":"certen:s6-replay:v1"';
const nest = (n: number): string => '['.repeat(n) + ']'.repeat(n);
const nestObj = (n: number, leaf: string): string => '{"a":'.repeat(n) + leaf + '}'.repeat(n);

const refused = (reason: string): S6Verdict => ({ result: 'refused', state: 's6_replay_unproven', reason, beforeVerified: false, established: [] });

type Probe = { name: string; evidence: string; go: S6Verdict };

/** The vector's evidence with its empty `"headers":[]` member replaced by `value`. */
const swapHeadersWith = (value: string): string => {
  const at = base.indexOf('"headers":[]');
  if (at < 0) throw new Error('vector 001 has no empty headers member');
  return base.slice(0, at) + `"headers":${value}` + base.slice(at + '"headers":[]'.length);
};
const swapHeaders = (n: number): string => swapHeadersWith(nest(n));

const probes: Probe[] = [];
for (const n of [6000, 9000, 9998, 9999, 10000, 20000]) {
  probes.push({ name: `unknown field ${n}-deep array`, evidence: `${VERSION},"zzz":${nest(n)}}`, go: refused('unknown_field') });
}
for (const n of [9990, 19990]) {
  probes.push({ name: `headers ${n}-deep array`, evidence: swapHeaders(n), go: refused('wrong_type') });
}
probes.push({
  name: 'unknown field 10005-deep array then a duplicate version',
  evidence: `${VERSION},"zzz":${nest(10005)},"version":"x"}`,
  go: refused('malformed_json'),
});
// The shapes the reviewer's table does not name, each judged by Go at 7ad629d.
for (const n of [10001, 50000]) {
  probes.push({ name: `unknown field ${n}-deep object chain`, evidence: `${VERSION},"zzz":${nestObj(n, '1')}}`, go: refused('unknown_field') });
}
probes.push({ name: 'headers an array holding a 12000-deep object chain', evidence: swapHeadersWith(`[${nestObj(12000, '1')}]`), go: refused('wrong_type') });
probes.push({ name: 'proof a 15000-deep array', evidence: `${VERSION},"proof":${nest(15000)}}`, go: refused('wrong_type') });
probes.push({ name: 'state a 15000-deep object chain', evidence: `${VERSION},"state":${nestObj(15000, '1')}}`, go: refused('unknown_field') });
probes.push({
  name: 'duplicate key at the bottom of a 20000-deep object chain',
  evidence: `${VERSION},"zzz":${nestObj(20000, '{"k":1,"k":2}')}}`,
  go: refused('malformed_json'),
});
probes.push({
  name: 'duplicate key in a 20000-deep array chain',
  evidence: `${VERSION},"zzz":${'['.repeat(20000)}{"k":1,"k":2}${']'.repeat(20000)}}`,
  go: refused('malformed_json'),
});
probes.push({ name: '20000-deep unknown field, document unterminated', evidence: `${VERSION},"zzz":${'['.repeat(20000)}`, go: refused('malformed_json') });
probes.push({ name: '20000-deep unknown field closed with the wrong bracket', evidence: `${VERSION},"zzz":${'['.repeat(20000)}}`, go: refused('malformed_json') });
probes.push({ name: '20000-deep unknown field, trailing garbage after the document', evidence: `${VERSION},"zzz":${nest(20000)}} x`, go: refused('malformed_json') });
probes.push({ name: 'unknown field a 1000000-deep array', evidence: `${VERSION},"zzz":${nest(1_000_000)}}`, go: refused('unknown_field') });
probes.push({ name: 'headers a 1000000-deep array', evidence: swapHeaders(1_000_000), go: refused('wrong_type') });
probes.push({ name: 'a 1000000-deep array is the whole document', evidence: nest(1_000_000), go: refused('wrong_type') });

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('S6 replay evidence of any nesting depth is judged as Go judges it (V-R10C2 D1)', () => {
  it('the base evidence is the unmodified vector 001 evidence and proves', () => {
    expect(sha(base)).toBe(sha(vector.evidence));
    expect(judgeS6Replay(settlement, bytes(base)).result).toBe('proven');
  });

  for (const p of probes) {
    it(`${p.name}: Go ${p.go.result}/${p.go.state}/${p.go.reason}`, () => {
      // judgeS6Replay must return a named verdict: an exception of any kind (a RangeError from the stack) fails here.
      const got = judgeS6Replay(settlement, bytes(p.evidence));
      expect(got).toEqual(p.go);
    });
  }

  it('decodeReplayGuardEvidence refuses a deep document with a named state, never another exception', () => {
    for (const [doc, reason] of [
      [`${VERSION},"zzz":${nest(9000)}}`, 'unknown_field'],
      [`${VERSION},"zzz":${nest(20000)}}`, 'unknown_field'],
      [`${VERSION},"zzz":${nest(200_000)},"version":"x"}`, 'malformed_json'],
    ] as const) {
      let err: unknown;
      try {
        decodeReplayGuardEvidence(bytes(doc));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(S6ReplayError);
      expect((err as S6ReplayError).state).toBe('s6_replay_unproven');
      expect((err as S6ReplayError).reason).toBe(reason);
    }
  });
});

describe('the depth limit of the shared JSON parser stays json.Unmarshal\'s for every other caller', () => {
  it('the default limit is Go\'s 10000 containers: 10000 deep is read, 10001 deep is refused', () => {
    expect(GO_JSON_MAX_DEPTH).toBe(10000);
    expect(() => parseGoJson(nest(10000))).not.toThrow();
    expect(() => parseGoJson(nest(10001))).toThrow(JsonError);
    expect(() => parseGoJson(nest(10001))).toThrow('exceeded max depth');
    expect(() => parseGoJson(nestObj(10000, '1'))).not.toThrow();
    expect(() => parseGoJson(nestObj(10001, '1'))).toThrow('exceeded max depth');
  });

  it('a caller that passes the escape map but no depth option keeps the limit', () => {
    expect(() => parseGoJson(nest(10001), new WeakMap())).toThrow('exceeded max depth');
  });

  it('an explicit maxDepth is honoured, and Infinity removes the limit', () => {
    expect(() => parseGoJson(nest(5), undefined, { maxDepth: 5 })).not.toThrow();
    expect(() => parseGoJson(nest(6), undefined, { maxDepth: 5 })).toThrow('exceeded max depth');
    expect(() => parseGoJson(nest(300_000), undefined, { maxDepth: Number.POSITIVE_INFINITY })).not.toThrow();
  });
});
