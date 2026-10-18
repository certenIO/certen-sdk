import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { evidenceJson } from '../../src/s3/budget.js';
import { importEvidence } from '../../src/s3/evidence.js';
import { decodePortable } from '../../src/s3/gotree.js';
import { NamedState, verifyPortableAnyBytes } from '../../src/s3/index.js';
import { readS3, sha256hex, summarize, type ReportSummary, type StateView } from './s3.js';

/**
 * The Go-written byte-level corpus (cmd/xtsgen bytes): a portable document judged from its TEXT, so what a parsed tree cannot say is covered -
 * number literals, duplicate and fold-equivalent keys, hex with a newline, strings given for numbers, invalid UTF-8, whitespace. Each case is
 * a list of byte edits of a base file; the verdict is the validator's (json.Unmarshal into Portable, then VerifyPortable).
 */
export interface Edit {
  at: number;
  del?: number;
  ins?: string;
}
export interface BytesExpect {
  v: 'verified' | 'named' | 'plain';
  state?: StateView;
  msg?: string;
  summary?: Partial<ReportSummary>;
  evLen: number;
}
export interface BytesCase {
  id: string;
  base: number;
  op: string;
  edits: Edit[];
  expect: BytesExpect;
}
export interface BytesFile {
  format: string;
  bases: string[];
  baseExpect: BytesExpect[];
  cases: BytesCase[];
  skipped: { panics: number; flaky: number };
}

export function applyEdits(base: Uint8Array, edits: Edit[]): Buffer {
  let out = Buffer.from(base);
  for (const e of [...edits].sort((a, b) => b.at - a.at)) {
    out = Buffer.concat([out.subarray(0, e.at), Buffer.from(e.ins ?? '', 'base64'), out.subarray(e.at + (e.del ?? 0))]);
  }
  return out;
}

const baseCache = new Map<string, Buffer>();
export function baseBytes(name: string): Buffer {
  let b = baseCache.get(name);
  if (!b) {
    const raw = name.startsWith('proofv2/') ? readFixture(name) : readS3(name);
    b = name.endsWith('.gz') ? gunzipSync(raw) : raw;
    baseCache.set(name, b);
  }
  return b;
}

function readFixture(name: string): Buffer {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
}

const view = (s: { code: string; partition: string; block: number }): StateView => ({ code: s.code, partition: s.partition, block: s.block });

export type BytesJudged = { v: 'verified'; summary: Partial<ReportSummary> } | { v: 'named'; state: StateView; message: string } | { v: 'plain'; message: string };

/** The TypeScript verdict on the text of a document, in the vocabulary of the Go program. */
export function judgeBytes(text: Uint8Array): BytesJudged {
  try {
    const out = verifyPortableAnyBytes(text);
    if (out.version === '2.1') return { v: 'verified', summary: summarize(out.report) };
    const r = out.report;
    return {
      v: 'verified',
      summary: {
        version: '',
        tag: '',
        partition: r.partition,
        anchorBlock: r.anchorBlock,
        certifiedBlock: r.certifiedBlock,
        certifiedRoot: r.certifiedRoot,
        checkBlock: r.checkBlock,
        setVerdict: r.setVerdict,
        routingHeight: 0,
        validators: r.validators,
        threshold: r.threshold,
        txHash: r.txHash,
        anchorTxHash: r.anchorTxHash,
        anchorStateRoot: r.anchorStateRoot,
        accumulateSetRoot: r.accumulateSetRoot,
        pagesBound: r.pageChains.filter((c) => c.bound).length,
        pageChains: r.pageChains.map((c) => ({ url: c.url, bound: c.bound, mainHeight: c.mainHeight })),
        proven: [],
        unproven: [],
        disclosures: [],
        authorizationMode: '',
        arrivals: [],
      },
    };
  } catch (e) {
    if (e instanceof NamedState) return { v: 'named', state: view(e), message: e.message };
    return { v: 'plain', message: e instanceof Error ? e.message : String(e) };
  }
}

/** The length of the evidence document the import produces (the evidence budget's measure), -1 when it does not import. */
export function bytesEvidenceLength(text: Uint8Array): number {
  try {
    return Buffer.byteLength(evidenceJson(importEvidence(decodePortable(text))), 'utf8');
  } catch {
    return -1;
  }
}

export function bytesDifferences(want: BytesExpect, text: Uint8Array): string[] {
  const got = judgeBytes(text);
  const out: string[] = [];
  if (got.v !== want.v) {
    out.push(`Go ${want.v}${want.state ? ` ${want.state.code}{${want.state.partition},${want.state.block}}` : ''}${want.v === 'plain' ? ` (${want.msg})` : ''}; here ${got.v}${got.v === 'named' ? ` ${got.state.code}{${got.state.partition},${got.state.block}}` : ''}${got.v === 'plain' ? ` (${got.message})` : ''}`);
    return out;
  }
  if (want.v === 'named' && got.v === 'named' && JSON.stringify(got.state) !== JSON.stringify(want.state)) out.push(`Go ${JSON.stringify(want.state)}; here ${JSON.stringify(got.state)}`);
  if (want.v === 'verified' && got.v === 'verified') {
    for (const k of Object.keys(got.summary) as (keyof ReportSummary)[]) {
      if (JSON.stringify(got.summary[k]) !== JSON.stringify(want.summary![k])) out.push(`report.${k}: Go ${JSON.stringify(want.summary![k]).slice(0, 300)}; here ${JSON.stringify(got.summary[k]).slice(0, 300)}`);
    }
  }
  if (want.evLen >= 0) {
    const l = bytesEvidenceLength(text);
    if (l !== want.evLen) out.push(`evidence length: Go ${want.evLen}; here ${l}`);
  }
  return out;
}

/** One shard (of `total`) of the corpus; the shards are separate files so the suite runs them in parallel. */
export function defineBytesShard(index: number, total: number, hash: string, chunk = 25, corpus = 'go-written/bytes-cases.json.gz'): void {
  const raw = readS3(corpus);
  const file = JSON.parse(gunzipSync(raw).toString('utf8')) as BytesFile;
  const mine = file.cases.filter((_, i) => i % total === index);
  describe(`byte-level cases of the portable documents, against Go (shard ${index + 1} of ${total})`, () => {
    it('is the file the Go program wrote', () => {
      expect(sha256hex(raw)).toBe(hash);
      expect(file.format).toBe('certen-sdk/s3-bytes-corpus/v1');
    });
    for (let c = 0; c < mine.length; c += chunk) {
      const part = mine.slice(c, c + chunk);
      it(`reaches Go's verdict on ${part.length} cases (${c + 1}-${c + part.length})`, () => {
        const wrong: string[] = [];
        for (const k of part) {
          const d = bytesDifferences(k.expect, applyEdits(baseBytes(file.bases[k.base]!), k.edits));
          if (d.length > 0) wrong.push(`${k.id} [${k.op}]: ${d.join(' | ')}`);
        }
        expect(wrong).toEqual([]);
      });
    }
  });
}
