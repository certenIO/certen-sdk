// The strict decoder of the contract-identity container "CIE1" (twin of pkg/contractidentity codec.go Decode). It reads with the S7
// finality Reader and converts that Reader's states into the S8 evidence states (FORMAT.md, "Decode error fields"): the number
// inside evidence_malformed is the byte offset the failed read started at, never a position the decoder guessed.
import { keccak_256 } from '@noble/hashes/sha3';
import { Reader, cmpBytes, defaultLimits, type Limits as ReaderLimits } from '../finality/codec.js';
import { FinalityStateError } from '../finality/state.js';
import * as N from './names.js';
import { defaultVocabulary, malformed, must, tooLarge, StateError } from './states.js';

export const Magic = 'CIE1';
export const Kind = 'contract-identity/v1';
export const StatedState = 'contract_identity_unproven';
export const TagCaptured = 1;
export const TagStated = 2;
export const LinkSameBlock = 0;
export const LinkHops = 1;
export const LinkSpine = 2;

export interface Limits {
  maxContainerBytes: number; maxKindBytes: number; maxCodes: number; maxCodeBytes: number; maxNodes: number; maxNodeBytes: number;
  maxHeaderBytes: number; maxLeafBytes: number; maxAttestHops: number; maxAttestSpine: number; maxBlockTxs: number; maxBlockTxsBytes: number;
  maxFailures: number; maxText: number; maxValidators: number; maxString: number; maxBatchLegs: number; maxPKCList: number;
}
export const defaultIdentityLimits = (): Limits => ({
  maxContainerBytes: 4194304, maxKindBytes: 64, maxCodes: 16, maxCodeBytes: 262144, maxNodes: 16384, maxNodeBytes: 131072, maxHeaderBytes: 4096,
  maxLeafBytes: 131072, maxAttestHops: 16, maxAttestSpine: 4096, maxBlockTxs: 4096, maxBlockTxsBytes: 1048576, maxFailures: 64, maxText: 1024,
  maxValidators: 64, maxString: 1024, maxBatchLegs: 64, maxPKCList: 256,
});

export interface BlockRef { number: bigint; hash: Uint8Array }
export interface Code { address: Uint8Array; runtime: Uint8Array }
export interface ProviderFailure { host: string; error: string }
export interface Stated { state: string; reason: string; judgedBlock: bigint; judgedHash: Uint8Array; failures: ProviderFailure[]; detail: string }
export interface AttestProof {
  link: number; headerV: Uint8Array; headerVParent: Uint8Array; hopHeaders: Uint8Array[]; spine: Uint8Array[]; txIndex: number;
  txLeaf: Uint8Array; receiptLeaf: Uint8Array; blockTxs: Uint8Array[];
}
export interface Part { tag: number; stated?: Stated; attest?: AttestProof }
export interface Container { chain: bigint; leg: BlockRef; codes: Code[]; settle: Part; attest: Part; nodes: Uint8Array[] }

const statedReasonRe = /^[a-z0-9_]{1,64}$/;
const baseOf = (part: string): string => (part.indexOf('.') < 0 ? part : part.slice(0, part.indexOf('.')));
const asciiNoNUL = (b: Uint8Array): boolean => b.every((c) => c !== 0 && c <= 0x7f);
const u64Field = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : 0);

/** evidence_unrecognised{kind, version}: version is the text after the last "/". */
export const unrecognised = (kind: string): StateError => must(N.CodeEvidenceUnrecognised, '', { kind, version: kind.slice(kind.lastIndexOf('/') + 1) });

class Decoder {
  readonly r: Reader;
  constructor(raw: Uint8Array, readonly total: number, maxText: number) {
    const lim: ReaderLimits = { ...defaultLimits(), maxStringBytes: maxText };
    this.r = new Reader(raw, lim);
  }
  off(): number { return this.total - this.r.left(); }

  /** conv turns a Reader state into the S8 state; any other failure is rethrown. */
  conv(err: unknown, tooLargePart = ''): never {
    if (!(err instanceof FinalityStateError)) throw err;
    const f = err.fields;
    if (err.code === 'finality_evidence_too_large') {
      const part = tooLargePart !== '' ? tooLargePart : typeof f['part'] === 'string' ? f['part'] : '';
      throw tooLarge(part, u64Field(f['count']), u64Field(f['limit']));
    }
    if (err.code === 'finality_evidence_malformed') {
      const part = typeof f['part'] === 'string' ? f['part'] : '';
      const reason = f['reason'];
      const got = u64Field(f['got_len']);
      const want = u64Field(f['want_len']);
      if (reason === 'truncated' || reason === 'length_exceeds_remaining' || reason === 'count_exceeds_remaining') throw malformed(baseOf(part), N.MalformedTruncated, this.off(), got, want);
      if (reason === 'trailing_bytes') throw malformed(baseOf(part), N.MalformedTrailingBytes, this.off(), got, want);
    }
    throw malformed(N.PartContainer, N.MalformedTruncated, this.off(), this.total - this.off(), 0);
  }
  private wrap<T>(f: () => T, tl = ''): T { try { return f(); } catch (e) { return this.conv(e, tl); } }
  u8(p: string): number { return this.wrap(() => this.r.u8(p)); }
  u32(p: string): number { return this.wrap(() => this.r.u32(p)); }
  u64(p: string): bigint { return this.wrap(() => this.r.u64(p)); }
  fixed(p: string, n: number): Uint8Array { return this.wrap(() => this.r.fixed(p, n)); }
  lp(p: string, max: number): Uint8Array { return this.wrap(() => this.r.lp(p, max)); }
  count(p: string, limit: number): number { return this.wrap(() => this.r.count(p, limit, 0)); }
  str(p: string, tooLargePart: string, max: number): string {
    const v = this.wrap(() => this.r.lp(p, max), tooLargePart);
    if (!asciiNoNUL(v)) throw malformed(p, N.MalformedStringNotAscii, this.off(), 0, 0);
    return String.fromCharCode(...v);
  }
  headers(part: string, limit: number, maxBytes: number): Uint8Array[] {
    const n = this.count(part, limit);
    const out: Uint8Array[] = [];
    for (let i = 0; i < n; i++) out.push(this.lp(part, maxBytes));
    return out;
  }
  part(part: string, lim: Limits): Part {
    const tag = this.u8(part);
    if (tag === TagStated) return { tag, stated: this.stated(part, lim) };
    if (tag === TagCaptured) return part === N.PartSettle ? { tag } : { tag, attest: this.attest(lim) };
    throw malformed(part, N.MalformedUnknownPartTag, this.off(), 0, 0);
  }
  stated(part: string, lim: Limits): Stated {
    const state = this.str(part, N.PartFailures, lim.maxText);
    if (state !== StatedState) throw malformed(part, N.MalformedBadStatedState, this.off(), 0, 0);
    const reason = this.str(part, N.PartFailures, lim.maxText);
    if (!statedReasonRe.test(reason)) throw malformed(part, N.MalformedBadStatedReason, this.off(), 0, 0);
    const judgedBlock = this.u64(part);
    const judgedHash = this.fixed(part, 32);
    const nf = this.count(N.PartFailures, lim.maxFailures);
    const failures: ProviderFailure[] = [];
    for (let i = 0; i < nf; i++) failures.push({ host: this.str(part, N.PartFailures, lim.maxText), error: this.str(part, N.PartFailures, lim.maxText) });
    const detail = this.str(part, N.PartFailures, lim.maxText);
    return { state, reason, judgedBlock, judgedHash, failures, detail };
  }
  attest(lim: Limits): AttestProof {
    const link = this.u8(N.PartAttest);
    if (link > LinkSpine) throw malformed(N.PartAttest, N.MalformedUnknownLink, this.off(), 0, 0);
    const headerV = this.lp(N.PartAttest, lim.maxHeaderBytes);
    const headerVParent = this.lp(N.PartAttest, lim.maxHeaderBytes);
    const hopHeaders = link === LinkHops ? this.headers(N.PartHopHeaders, lim.maxAttestHops, lim.maxHeaderBytes) : [];
    const spine = link === LinkSpine ? this.headers(N.PartSpine, lim.maxAttestSpine, lim.maxHeaderBytes) : [];
    const txIndex = this.u32(N.PartAttest);
    const txLeaf = this.lp(N.PartAttest, lim.maxLeafBytes);
    const receiptLeaf = this.lp(N.PartAttest, lim.maxLeafBytes);
    const nt = this.count(N.PartBlockTxs, lim.maxBlockTxs);
    const blockTxs: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < nt; i++) {
      const t = this.lp(N.PartBlockTxs, lim.maxBlockTxsBytes);
      total += t.length;
      if (total > lim.maxBlockTxsBytes) throw tooLarge(N.PartBlockTxs, total, lim.maxBlockTxsBytes);
      blockTxs.push(t);
    }
    return { link, headerV, headerVParent, hopHeaders, spine, txIndex, txLeaf, receiptLeaf, blockTxs };
  }
}

/** Decode returns the container or THROWS the S8 state (a StateError) of the first defect; it never returns a partial container. */
export function decode(raw: Uint8Array, lim: Limits = defaultIdentityLimits()): Container {
  if (raw.length > lim.maxContainerBytes) throw tooLarge(N.PartContainer, raw.length, lim.maxContainerBytes);
  const d = new Decoder(raw, raw.length, lim.maxText);
  const magic = String.fromCharCode(...d.fixed(N.PartMagic, 4));
  if (magic !== Magic) throw malformed(N.PartMagic, N.MalformedBadMagic, 0, 0, 0);
  const kind = d.str(N.PartKind, '', lim.maxKindBytes);
  if (kind !== Kind) throw unrecognised(kind);
  const chain = d.u64(N.PartContainer);
  const number = d.u64(N.PartContainer);
  const hash = d.fixed(N.PartContainer, 32);
  const nc = d.count(N.PartCodes, lim.maxCodes);
  const codes: Code[] = [];
  for (let i = 0; i < nc; i++) {
    const address = d.fixed(N.PartCodes, 20);
    if (i > 0) {
      const c = cmpBytes(codes[i - 1]!.address, address);
      if (c === 0) throw malformed(N.PartCodes, N.MalformedCodesDuplicate, i, 0, 0);
      if (c > 0) throw malformed(N.PartCodes, N.MalformedCodesNotAscending, i, 0, 0);
    }
    codes.push({ address, runtime: d.lp(N.PartCodes, lim.maxCodeBytes) });
  }
  const settle = d.part(N.PartSettle, lim);
  const attest = d.part(N.PartAttest, lim);
  const nn = d.count(N.PartNodes, lim.maxNodes);
  const nodes: Uint8Array[] = [];
  let prev: Uint8Array = new Uint8Array(32);
  for (let i = 0; i < nn; i++) {
    const n = d.lp(N.PartNodes, lim.maxNodeBytes);
    const h = keccak_256(n);
    if (i > 0) {
      const c = cmpBytes(prev, h);
      if (c === 0) throw malformed(N.PartNodes, N.MalformedNodesDuplicate, i, 0, 0);
      if (c > 0) throw malformed(N.PartNodes, N.MalformedNodesNotAscending, i, 0, 0);
    }
    prev = h;
    nodes.push(n);
  }
  try { d.r.end(N.PartContainer); } catch (e) { d.conv(e); }
  return { chain, leg: { number, hash }, codes, settle, attest, nodes };
}

/** A Stated part whose reason is outside the six builder reasons is evidence_malformed{part, reason: unknown_stated_reason} (step 1c / 15). */
export function checkStatedReasons(c: Container): StateError | undefined {
  const v = defaultVocabulary();
  for (const [part, p] of [[N.PartSettle, c.settle], [N.PartAttest, c.attest]] as const) {
    if (p.tag === TagStated && p.stated && !v.check('stated_reason_builders', p.stated.reason)) return malformed(part, N.MalformedUnknownStatedReason, 0, 0, 0);
  }
  return undefined;
}
