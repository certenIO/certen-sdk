import { describe, expect, it } from 'vitest';
import { evidenceJson } from '../../src/s3/budget.js';
import { importEvidence } from '../../src/s3/evidence.js';
import { judgeDocument, readS3, readS3Json, sha256hex, type Judged, type ReportSummary, type StateView } from './s3.js';

/**
 * The Go-written mutation corpus of the evidence 2.1 vectors (cmd/xtsgen mutations; the program is test/fixtures/s3/gen/xtsgen.go.txt).
 *
 * Each mutation is a list of patches applied to the JSON tree of a base document (a shared vector or the real Kermit document), and the
 * verdict the validator's proofv2.VerifyPortable gave the patched document: verified with a report, a named state with its partition and
 * block, or a plain refusal; and the length of the evidence document the import produced (the evidence budget's measure). The TypeScript
 * verifier must reach every one of them. A mutation on which Go panics or is not deterministic is not in the file.
 */
export interface Patch {
  path: (string | number)[];
  op: 'set' | 'setNumber' | 'delete' | 'rename' | 'swap' | 'dup' | 'insert' | 'dropIndex';
  value?: unknown;
  hasValue?: boolean;
  to?: string;
  i?: number;
  j?: number;
}
export interface Expect {
  v: 'verified' | 'named' | 'plain';
  state?: StateView;
  msg?: string;
  summary?: ReportSummary;
  evLen: number;
}
export interface Mutation {
  id: string;
  base: number;
  op: string;
  patches: Patch[];
  expect: Expect;
}
export interface MutationFile {
  format: string;
  description: string;
  source: string;
  bases: string[];
  baseExpect: Expect[];
  mutations: Mutation[];
  skipped: { panics: number; flaky: number };
}

type J = Record<string, unknown> & unknown[];
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function walk(root: unknown, path: (string | number)[]): unknown {
  let cur = root;
  for (const k of path) cur = (cur as Record<string | number, unknown>)[k];
  return cur;
}

/** The marker setNumber writes into the tree; numberText turns the serialised marker into the number's own decimal text. */
export const NUMBER_MARK = '\u0001NUM:';
export const numberText = (text: string): string => text.replace(/"\\u0001NUM:(\d+)"/g, '$1');

/** The patch semantics of cmd/xtsgen (apply): a path addresses object keys and array indices of the document's JSON tree. */
export function applyPatch(root: unknown, patch: Patch): unknown {
  // the Go program writes the root's (empty) path as null
  const p: Patch = { ...patch, path: patch.path ?? [] };
  // a number written by its decimal text (exact beyond 2^53): the tree holds a marker that numberText() replaces in the serialised document
  if (p.op === 'setNumber') return applyPatch(root, { path: p.path, op: 'set', value: NUMBER_MARK + p.to!, hasValue: true });
  if (p.path.length === 0 && p.op === 'set') return p.value === undefined ? null : clone(p.value);
  switch (p.op) {
    case 'set':
    case 'delete':
    case 'rename': {
      const parent = walk(root, p.path.slice(0, -1)) as J;
      const last = p.path[p.path.length - 1]!;
      if (p.op === 'set') (parent as Record<string | number, unknown>)[last] = clone(p.value === undefined ? null : p.value);
      else if (p.op === 'delete') delete (parent as Record<string | number, unknown>)[last];
      else {
        (parent as Record<string, unknown>)[p.to!] = (parent as Record<string | number, unknown>)[last];
        delete (parent as Record<string | number, unknown>)[last];
      }
      return root;
    }
    default: {
      const arr = walk(root, p.path) as unknown[];
      const gp = walk(root, p.path.slice(0, -1)) as Record<string | number, unknown>;
      const last = p.path[p.path.length - 1]!;
      // the Go program omits a zero index (omitempty)
      const i = p.i ?? 0;
      const j = p.j ?? 0;
      let out: unknown[];
      if (p.op === 'swap') {
        out = [...arr];
        [out[i], out[j]] = [out[j]!, out[i]!];
      } else if (p.op === 'dup') out = [...arr.slice(0, i + 1), clone(arr[i]), ...arr.slice(i + 1)];
      else if (p.op === 'insert') out = [...arr.slice(0, i), clone(p.value), ...arr.slice(i)];
      else out = [...arr.slice(0, i), ...arr.slice(i + 1)];
      gp[last] = out;
      return root;
    }
  }
}

export function applyPatches(base: unknown, ps: Patch[]): unknown {
  let root = clone(base);
  for (const p of ps) root = applyPatch(root, p);
  return root;
}

const baseCache = new Map<string, unknown>();
export function loadBase(name: string): unknown {
  if (!baseCache.has(name)) baseCache.set(name, readS3Json(name));
  return baseCache.get(name);
}

/** The evidence length of a document, or -1 when the evidence does not import. */
export function evidenceLength(doc: unknown): number {
  try {
    return Buffer.byteLength(evidenceJson(importEvidence(doc as Record<string, unknown>)), 'utf8');
  } catch {
    return -1;
  }
}

/** The differences between Go's verdict and ours, empty when they agree on everything the corpus records. */
export function differences(want: Expect, got: Judged, doc: unknown): string[] {
  const out: string[] = [];
  const kind = got.verdict === 'verified' ? 'verified' : got.verdict;
  if (kind !== want.v) {
    out.push(`Go ${want.v}${want.state ? ` ${want.state.code}{${want.state.partition},${want.state.block}}` : ''}${want.v === 'plain' ? ` (${want.msg})` : ''}; here ${kind}${got.verdict === 'named' ? ` ${got.state.code}{${got.state.partition},${got.state.block}}` : ''}${got.verdict === 'plain' ? ` (${got.message})` : ''}`);
    return out;
  }
  if (want.v === 'named' && got.verdict === 'named') {
    if (JSON.stringify(got.state) !== JSON.stringify(want.state)) out.push(`Go ${JSON.stringify(want.state)}; here ${JSON.stringify(got.state)}`);
  }
  if (want.v === 'verified' && got.verdict === 'verified') {
    for (const k of Object.keys(want.summary!) as (keyof ReportSummary)[]) {
      if (JSON.stringify(got.summary[k]) !== JSON.stringify(want.summary![k])) out.push(`report.${k}: Go ${JSON.stringify(want.summary![k]).slice(0, 300)}; here ${JSON.stringify(got.summary[k]).slice(0, 300)}`);
    }
  }
  if (want.evLen >= 0) {
    const l = evidenceLength(doc);
    if (l !== want.evLen) out.push(`evidence length: Go ${want.evLen}; here ${l}`);
  }
  return out;
}

/**
 * One shard of the corpus (of `total`): the shards are separate test files so the suite runs them in parallel; every mutation is in
 * exactly one shard. `chunk` mutations make a test, so a slow machine is never a failed one.
 */
export function defineShard(index: number, total: number, hash: string, chunk = 25): void {
  const raw = readS3('go-written/mutations.json');
  const file = JSON.parse(raw.toString('utf8')) as MutationFile;
  const mine = file.mutations.filter((_, i) => i % total === index);
  describe(`mutations of the evidence 2.1 vectors, against Go (shard ${index + 1} of ${total})`, () => {
    it('is the file the Go program wrote', () => {
      expect(sha256hex(raw)).toBe(hash);
      expect(file.format).toBe('certen:s3-mutations:v1');
    });
    for (let c = 0; c < mine.length; c += chunk) {
      const part = mine.slice(c, c + chunk);
      it(`reaches Go's verdict on ${part.length} mutations (${c + 1}-${c + part.length})`, () => {
        const wrong: string[] = [];
        for (const m of part) {
          const doc = applyPatches(loadBase(file.bases[m.base]!), m.patches);
          const got = judgeDocument(doc);
          const d = differences(m.expect, got, doc);
          if (d.length > 0) wrong.push(`${m.id} [${m.op}]: ${d.join(' | ')}`);
        }
        expect(wrong).toEqual([]);
      });
    }
  });
}
