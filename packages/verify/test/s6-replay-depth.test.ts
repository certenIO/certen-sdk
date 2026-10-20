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

/** sha256 of each probe's evidence bytes as the Go throwaway test (pkg/ethproof 7ad629d, s6replay1.Judge) judged them: the TypeScript
 * probe must be the same bytes, or its verdict says nothing about Go's. */
const GO_SHA256: Record<string, string> = {
  'unknown field 6000-deep array': '054b28a819b141db2981ce4da4823e512b05c1542871e0c14d5e399782a4206c',
  'unknown field 9000-deep array': '2c32860db636655441be5a846283a162980bcdb831a2d4d251dec2d7f5fb8c42',
  'unknown field 9998-deep array': 'd065ce073597936fa2278731c46453858216412c70728e540e2630504c9b14c4',
  'unknown field 9999-deep array': 'd527f9a851c8f6eb808beab29360f42fcf0029373c27328889e98177446cbcf6',
  'unknown field 10000-deep array': '7c274000c52e4bee4c2a2c887b91e742b72db2efecdcbe8189afd3ac9be0f1fd',
  'unknown field 20000-deep array': '43e02bf67e3ac9858e70bbdf40007470805e2a021d269c61e313168ae736a28a',
  'headers 9990-deep array': 'b889a722d2106cd3f632a9f71bd11691c6b403bffeef48213e9592581561ee0a',
  'headers 19990-deep array': '752ced5df4d186c16d525e1887cc55aed9f9560cc95004a9bcf109b8265c8691',
  'unknown field 10005-deep array then a duplicate version': '8d538a6afb92573ee90dcd623e86864d9a3de147cb6b2e913d02090210508f14',
  'unknown field 10001-deep object chain': 'bc16382e2d808ebf592f75b386e9dc88f7db27fe2f6184f2f062c09c02476dd7',
  'unknown field 50000-deep object chain': '0c20654908d9bda3ccdf3ea149dd5d4f9cfe19d462c8d9dbe9bba6a51a06bac3',
  'headers an array holding a 12000-deep object chain': '62d92b741a21454b130ffcf1bbfd80256cdb7635e16922c890fb719debba2efa',
  'proof a 15000-deep array': '7d252b5d90c03ce11e2a403694ce4d8aa89eb53e056cf69dd2e655be68c7ee98',
  'state a 15000-deep object chain': '554b9df57468256207aa441b5e1ad700573c6cbafb87e64008887ec3280878bb',
  'duplicate key at the bottom of a 20000-deep object chain': 'fa29c12d9ee35799c62622ad92ba757135bdd4ad6accb0f70d889884621edb44',
  'duplicate key in a 20000-deep array chain': '4ca66fd0d7565ef47aae4c9a1c659a33347c2e9e8539a9299937a40513e44ea9',
  '20000-deep unknown field, document unterminated': '4119110f8f3509d94a374bd27179fef71ac92ba4fc7f5174a5bf36b7f4ecd9cc',
  '20000-deep unknown field closed with the wrong bracket': 'f40f565333212cfb5a1f01b77b9d18ab71b9dd6c9c36d765a2e187dee4224fcd',
  '20000-deep unknown field, trailing garbage after the document': 'ef3555b0b108b2542087e059bf16590a3f02ddd8340a298ef784a7159c6f61c3',
  'unknown field a 1000000-deep array': '8cf4b540c1044a5624416dda003179d921605f48096f42b1c582b488806111bd',
  'headers a 1000000-deep array': 'dbba0467731817a3d5879275bece7edf12de628043f82901c2da77178a615941',
  'a 1000000-deep array is the whole document': 'd3f611065be2714144ee27f93911a8c710790700e3d1548bd9095f29f6237b88',
};

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('S6 replay evidence of any nesting depth is judged as Go judges it (V-R10C2 D1)', () => {
  it('the base evidence is the unmodified vector 001 evidence and proves', () => {
    expect(sha(base)).toBe('99f771ca0f4867771e6cdec267ba026dc887ef8653eda68634753016e630a5fb');
    expect(judgeS6Replay(settlement, bytes(base)).result).toBe('proven');
  });

  for (const p of probes) {
    it(`${p.name}: Go ${p.go.result}/${p.go.state}/${p.go.reason}`, () => {
      expect(sha(p.evidence)).toBe(GO_SHA256[p.name]);
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
