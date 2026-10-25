// The TypeScript vector runner: no world builder. For each vector of a published set it reads <id>.inputs.json, <id>.container.hex,
// manifest.<sha>.json, extension.<sha>.json and <id>.expected.json, resolves step 0 itself (the RESULT of a vector whose manifest does not
// load is the refused headline of that framework state), runs the verifier and compares with `expected` as Go's RunSet / MatchExpected do.
import { expect } from 'vitest';
import {
  earlyReport, embeddedPin, loadMaterialised, manifestHash, matchExpected, prelude, resolveManifest,
  type Expected, type Manifest, type Report, type Verifier,
} from '../../src/proof-v2/identity/index.js';
import { setFiles, vectorIds } from './fixtures.js';

export interface VectorResult { id: string; outcome: 'pass' | 'fail' | 'not_run'; detail: string }
const td = new TextDecoder();

/** Steps 0 and 1 only: the verifier a package starts from. When the prelude does not decide the vector it needs the steps. */
export const preludeVerifier: Verifier = (ctx, container, m: Manifest): Report => {
  const p = prelude(ctx, container, m);
  if (p.refusal) return earlyReport(ctx, m, p.refusal);
  throw new Error('contractidentity: new verifier: the steps of this vector are not registered');
};

export interface RunSetOptions {
  /** The files of the set when the caller already holds them (the mutation gate runs a set many times). */
  files?: ReadonlyMap<string, Uint8Array>;
  /** Stop after the first vector that does not pass (the kill gate asks only whether some vector fails). */
  stopAtFirstFail?: boolean;
  /** Run only these vector ids of the set. */
  ids?: readonly string[];
}

export function runSet(name: string, verify: Verifier | undefined, onReport?: (id: string, report: Report) => void, opts: RunSetOptions = {}): VectorResult[] {
  const files = opts.files ?? setFiles(name);
  const out: VectorResult[] = [];
  for (const id of vectorIds(files)) {
    if (opts.ids && !opts.ids.includes(id)) continue;
    if (!verify) { out.push({ id, outcome: 'not_run', detail: 'no verifier' }); continue; }
    const expected = JSON.parse(td.decode(files.get(`${id}.expected.json`))) as Expected;
    // a loader rule: <id>.expected.json is exactly the `expected` of <id>.json
    expect(JSON.parse(td.decode(files.get(`${id}.json`))).expected, `${name}/${id}: expected.json differs from the vector file`).toEqual(expected);
    let report: Report;
    try {
      const inputs = loadMaterialised(td.decode(files.get(`${id}.inputs.json`)), files);
      const r = resolveManifest(inputs);
      if (r.refusal) { const sha = manifestHash(inputs.manifestRaw); report = earlyReport(inputs.ctx, { sha256: sha, source: sha === embeddedPin() ? 'embedded' : 'override:' + sha } as Manifest, r.refusal); }
      else report = verify(inputs.ctx, inputs.container, r.manifest!);
    } catch (e) {
      out.push({ id, outcome: 'fail', detail: `verifier error: ${(e as Error).message}` });
      if (opts.stopAtFirstFail) return out;
      continue;
    }
    onReport?.(id, report);
    const why = matchExpected(expected, report);
    out.push(why === undefined ? { id, outcome: 'pass', detail: '' } : { id, outcome: 'fail', detail: why });
    if (why !== undefined && opts.stopAtFirstFail) return out;
  }
  return out;
}
