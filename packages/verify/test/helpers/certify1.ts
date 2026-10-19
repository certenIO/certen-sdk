import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CertifyState } from '../../src/s3/certify.js';
import { NamedState, verifyPortableAny, verifyPortableAnyBytes } from '../../src/s3/index.js';
import { summarize, type ReportSummary } from './s3.js';

/**
 * The judgement of a certify1 document (RB9-F5 anchored certify form), in the vocabulary of the Go-written manifest and the Go-judged corpus:
 * verified (a report summary), certify (a CertifyState: code and fields), named (a NamedState with its partition and block) or plain (any other
 * refusal; a port's own fault - a TypeError or RangeError - is a fault, never a refusal).
 */
/** THE pins: a re-sync of the suite is a copy of the files and a change of these hashes (and of the validator commit prefix) and nothing else. */
export const PINS = {
  validatorCommit: '2d98ff9',
  namesSha256: '2413c2baac002a4f5a0b34d1331d41079a1c50e8b4792e1263b690ed8df84878',
  suiteManifestSha256: '33be0bea5a1289b25f2071a1e365c33f9bdc0c4da98d515a372bd61d3c35ad38',
  liveLinksSha256: '98ba7ccd2e71a7631f836ad597dcab25df1e908a82aa82443daa0d729ae7b70f',
} as const;
export const dir = new URL('../fixtures/s3-f5/', import.meta.url);
export const read = (name: string): Buffer => readFileSync(new URL(name, dir));
export const sha256hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The part of a report both verifiers state; a 2.0 report has no routing, proven pages or unproven list. */
export interface CertSummary {
  version: string;
  tag: string;
  partition: string;
  anchorBlock: number;
  certifiedRoot: string;
  checkBlock: number;
  setVerdict: string;
  routingHeight: number;
  proven: ReportSummary['proven'];
  pagesBound: number;
  unproven: string[];
}

export type CertJudged =
  | { v: 'verified'; summary: CertSummary; full?: ReportSummary }
  | { v: 'certify'; code: string; fields: string[]; message: string }
  | { v: 'named'; code: string; partition: string; block: number; message: string }
  | { v: 'plain'; message: string }
  | { v: 'fault'; message: string };

/** The judgement of a document received as parsed JSON (the tree is re-serialised: see verifyPortableAny). */
export function judgeCertify(doc: unknown): CertJudged {
  return judgeWith(() => verifyPortableAny(doc));
}

/** The judgement of a document received as text: a number the document spells beyond 2^53 reaches the verifier exactly. */
export function judgeCertifyText(text: string): CertJudged {
  return judgeWith(() => verifyPortableAnyBytes(text));
}

function judgeWith(run: () => ReturnType<typeof verifyPortableAny>): CertJudged {
  try {
    const out = run();
    if (out.version === '2.0') {
      const r = out.report;
      return {
        v: 'verified',
        summary: {
          version: '',
          tag: '',
          partition: r.partition,
          anchorBlock: r.anchorBlock,
          certifiedRoot: r.certifiedRoot,
          checkBlock: r.checkBlock,
          setVerdict: r.setVerdict,
          routingHeight: 0,
          proven: [],
          pagesBound: r.pageChains.filter((c) => c.bound).length,
          unproven: [],
        },
      };
    }
    const full = summarize(out.report);
    return {
      v: 'verified',
      full,
      summary: {
        version: full.version,
        tag: full.tag,
        partition: full.partition,
        anchorBlock: full.anchorBlock,
        certifiedRoot: full.certifiedRoot,
        checkBlock: full.checkBlock,
        setVerdict: full.setVerdict,
        routingHeight: full.routingHeight,
        proven: full.proven.map((p) => ({ url: p.url, partition: p.partition, block: p.block, roles: p.roles, declared: p.declared })),
        pagesBound: full.pagesBound,
        unproven: full.unproven.map((u) => u.code),
      },
    };
  } catch (e) {
    if (e instanceof CertifyState) return { v: 'certify', code: e.code, fields: [...e.fields], message: e.message };
    if (e instanceof NamedState) return { v: 'named', code: e.code, partition: e.partition, block: e.block, message: e.message };
    if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError) return { v: 'fault', message: String(e) };
    return { v: 'plain', message: e instanceof Error ? e.message : String(e) };
  }
}
