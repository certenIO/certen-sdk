/**
 * The rolling Sepolia ledger of V2_SPEC_S7 4.3 (the twin of pkg/finality/ledger.go and ledgerlinks.go): one anchor per sync-committee
 * period, each derived from its predecessor by a verified light-client link. The single primitive is ledgerStep (a step of the walk,
 * judged by ethl1.verifyFinalizedHead); extendPins applies it to the entries an extension file appends, and verifyLedger re-derives the whole
 * ledger from its root pin (the offline form of `proofverify --pins-selfcheck`). No function here does I/O: the caller supplies the link
 * bytes (a Map from a period to the bytes of finality-pins-links/<period>.ssz).
 */
import { sha256 } from '@noble/hashes/sha2';
import { JNum, JObj, parseGoJson, type JVal } from '../../s3/jsonx.js';
import { JsonError } from '../../s3/gojson.js';
import { EMBEDDED_LINKS_BASE64 } from './pins-links-embedded.js';
import {
  CodeEvidenceMalformed,
  ethl1PinsFrom,
  hashTreeRootSyncCommitteeChecked,
  verifyBootstrapAnchor,
  verifyFinalizedHead,
  Layout as L1Layout,
  ProfileLC,
  type LC,
} from './ethl1/index.js';
import * as lcssz from './ethsepolia/lcssz.js';
import { parsePinsExtension, type AnchorPin, type EthSepoliaPins, type Pins } from './pins.js';
import { Code, FinalityStateError, LedgerReason, PinsReason, hexLower, newState, pinsCorrupt, type Fields } from './state.js';
import { ChainSepolia } from './table.js';

/** The link files of a ledger by period. */
export type LedgerLinks = ReadonlyMap<bigint, Uint8Array>;

/** finality_ledger_extension_invalid{period, reason[, inner...]}. */
export function ledgerExtensionInvalid(period: bigint, reason: string, extra: Fields = {}): FinalityStateError {
  return newState(Code.LedgerExtensionBad, { period, reason, ...extra });
}

/** The link files embedded with the pins file, by period (Go EmbeddedLedgerLinks). */
export function embeddedLedgerLinks(): Map<bigint, Uint8Array> {
  const out = new Map<bigint, Uint8Array>();
  for (const [period, b64] of Object.entries(EMBEDDED_LINKS_BASE64)) out.set(BigInt(period), Uint8Array.from(Buffer.from(b64, 'base64')));
  return out;
}

/**
 * The 32 bytes of a "0x"-prefixed hex string, as Go's `rootOf` reads them: the pairs before the first invalid one, copied into a zero root
 * (a validated pins file never holds anything else).
 */
function rootOf(h: string): Uint8Array {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(32);
  for (let i = 0; i < Math.min(32, s.length >> 1); i++) {
    const pair = s.slice(2 * i, 2 * i + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) break;
    out[i] = parseInt(pair, 16);
  }
  return out;
}

const eqBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The L1 head verifier's layout of a light-client object layout (the one conversion, shared by the ledger and the kind). */
export const l1Layout = (l: lcssz.Layout): number => (l === lcssz.Gloas ? L1Layout.Gloas : L1Layout.Electra);

/**
 * Builds the light-client part that judges one ledger step: the walk starts at pred (a committee_root anchor with the committee body
 * predBody, or, when pred is a block_root pin, with the bootstrap in predBootstrap), applies `link` (the LightClientUpdate attested in
 * pred's period that carries the next sync committee) and ends with that same update's finality projection, signed by the same
 * committee. Walking the link is what makes ethl1 enforce the candidate's committee_root: "a committee learned from a link is labelled
 * attested_period + 1" (5.2 step 3). Throws an LcsszError for a link that is not a light-client update.
 */
export function ledgerStepLC(pred: AnchorPin, predBody: Uint8Array | undefined, predBootstrap: Uint8Array | undefined, link: Uint8Array): LC {
  const ll = lcssz.layoutOfUpdate(link);
  const final = lcssz.updateToFinalityUpdate(ll, link);
  const lc: Omit<LC, 'anchorKind' | 'anchorRoot' | 'anchorBody'> = {
    profile: ProfileLC,
    anchorPeriod: pred.period,
    links: [{ layout: l1Layout(ll), ssz: link }],
    finalUpdate: { layout: l1Layout(lcssz.layoutOfFinalityUpdate(final)), ssz: final },
  };
  if (pred.blockRoot !== '') {
    const boot = predBootstrap ?? new Uint8Array(0);
    return { ...lc, anchorKind: 2, anchorRoot: rootOf(pred.blockRoot), anchorBody: { layout: l1Layout(lcssz.layoutOfBootstrap(boot)), ssz: boot } };
  }
  return { ...lc, anchorKind: 1, anchorRoot: rootOf(pred.committeeRoot), anchorBody: { layout: L1Layout.None, ssz: predBody ?? new Uint8Array(0) } };
}

/** The code of the light-client verifier's fault, "unknown" for any other error. */
function innerCode(err: unknown): string {
  return err instanceof FinalityStateError ? err.code : 'unknown';
}

/**
 * Verifies that `cand` is derived from `pred` by `link`: the sha256 of the link bytes is cand.linkSha256, the committee the link carries
 * hashes to cand.committeeRoot, and ethl1 accepts the walk (signatures of the predecessor's committee, at least 342 participants, the
 * next-committee branch, the period rules, the ledger label of the learned committee). It returns the learned committee's 24,624 bytes (the
 * body the next step starts from). An appended entry may not carry a block_root: it is derived by the one link file of its period, so there
 * is no bootstrap beside the file to judge a block_root by.
 */
export function ledgerStep(
  e: EthSepoliaPins,
  pred: AnchorPin,
  cand: AnchorPin,
  predBody: Uint8Array | undefined,
  predBootstrap: Uint8Array | undefined,
  link: Uint8Array | undefined,
): Uint8Array {
  if (cand.period !== BigInt.asUintN(64, pred.period + 1n)) throw ledgerExtensionInvalid(cand.period, LedgerReason.PeriodNotNext, { predecessor_period: pred.period });
  if (cand.blockRoot !== '') throw ledgerExtensionInvalid(cand.period, LedgerReason.BlockRootOnAppendedEntry);
  if (link === undefined || link.length === 0) throw ledgerExtensionInvalid(cand.period, LedgerReason.LinkMissing);
  const sum = sha256(link);
  if (hexLower(sum) !== cand.linkSha256) {
    throw ledgerExtensionInvalid(cand.period, LedgerReason.LinkSha256Mismatch, { want_sha256: rootOf(`0x${cand.linkSha256}`), got_sha256: sum });
  }
  let body: Uint8Array;
  try {
    body = lcssz.nextCommittee(lcssz.layoutOfUpdate(link), link);
  } catch (err) {
    if (!(err instanceof lcssz.LcsszError)) throw err;
    throw ledgerExtensionInvalid(cand.period, LedgerReason.LinkRefused, { inner: CodeEvidenceMalformed });
  }
  let rootOk = false;
  try {
    rootOk = eqBytes(hashTreeRootSyncCommitteeChecked(body), rootOf(cand.committeeRoot));
  } catch {
    rootOk = false;
  }
  if (!rootOk) throw ledgerExtensionInvalid(cand.period, LedgerReason.CommitteeRootMismatch);
  let lc: LC;
  try {
    lc = ledgerStepLC(pred, predBody, predBootstrap, link);
  } catch (err) {
    if (!(err instanceof lcssz.LcsszError)) throw err;
    throw ledgerExtensionInvalid(cand.period, LedgerReason.LinkRefused, { inner: CodeEvidenceMalformed });
  }
  try {
    verifyFinalizedHead(ethl1PinsFrom(e, [pred, cand]), lc);
  } catch (err) {
    throw ledgerExtensionInvalid(cand.period, LedgerReason.LinkRefused, { inner: innerCode(err) });
  }
  return Uint8Array.from(body);
}

/**
 * Re-establishes the committee body of an anchor from the bytes beside the file: the bootstrap for a block_root pin, the link that derived
 * the entry otherwise. The bytes must hash to the entry's linkSha256 and the committee to its root. For a block_root pin the bootstrap is
 * also judged as the kind-2 anchor of 5.2 step 2 (verifyBootstrapAnchor): the block_root is the root of the bootstrap's header, the header's
 * execution branch and the committee branch hold, and the header is in the entry's period; without that a ledger whose only entry is the
 * root pin would be "re-derived" from bytes nobody had checked against it.
 */
function committeeOf(e: EthSepoliaPins, a: AnchorPin, links: LedgerLinks): Uint8Array {
  const unavailable = (extra: Fields = {}): FinalityStateError => ledgerExtensionInvalid(a.period, LedgerReason.PredecessorCommitteeUnavailable, extra);
  const raw = links.get(a.period);
  if (raw === undefined) throw unavailable();
  if (hexLower(sha256(raw)) !== a.linkSha256) throw unavailable();
  let body: Uint8Array;
  try {
    body = a.blockRoot !== '' ? lcssz.bootstrapCommittee(lcssz.layoutOfBootstrap(raw), raw) : lcssz.nextCommittee(lcssz.layoutOfUpdate(raw), raw);
  } catch (err) {
    if (!(err instanceof lcssz.LcsszError)) throw err;
    throw unavailable();
  }
  let rootOk = false;
  try {
    rootOk = eqBytes(hashTreeRootSyncCommitteeChecked(body), rootOf(a.committeeRoot));
  } catch {
    rootOk = false;
  }
  if (!rootOk) throw unavailable();
  if (a.blockRoot !== '') {
    try {
      verifyBootstrapAnchor(ethl1PinsFrom(e, e.anchors), a.period, { layout: l1Layout(lcssz.layoutOfBootstrap(raw)), ssz: raw });
    } catch (err) {
      throw unavailable({ inner: innerCode(err) });
    }
  }
  return body;
}

/** The value of a JSON document as Go's json.Unmarshal into interface{} makes it: numbers are float64 (an out-of-range one is an error). */
type GoValue = null | boolean | string | number | GoValue[] | Map<string, GoValue>;

class NotDecodable extends Error {}

const wellFormed = (s: string): string => s.replace(/[�-�](?![�-�])|(?<![�-�])[�-�]/g, '�');

/**
 * json.Unmarshal into interface{}, with an explicit stack: a document nested to Go's limit (10,000 containers, which parseGoJson enforces) is
 * converted, never a RangeError (audit N-2). Go's decoder reads a repeated key of an object into the same map entry: the later value wins.
 */
function goValue(root: JVal): GoValue {
  type Slot = { dst: GoValue[] | Map<string, GoValue>; key: string | number };
  const put = (slot: Slot | undefined, v: GoValue): GoValue => {
    if (slot === undefined) return v;
    if (slot.dst instanceof Map) slot.dst.set(slot.key as string, v);
    else slot.dst[slot.key as number] = v;
    return v;
  };
  let result: GoValue = null;
  type Work = { src: JVal; slot: Slot | undefined };
  const work: Work[] = [{ src: root, slot: undefined }];
  while (work.length > 0) {
    const { src, slot } = work.pop()!;
    if (src === null || typeof src === 'boolean') {
      const r = put(slot, src);
      if (slot === undefined) result = r;
    } else if (typeof src === 'string') {
      const r = put(slot, wellFormed(src));
      if (slot === undefined) result = r;
    } else if (src instanceof JNum) {
      const n = Number(src.lit);
      if (!Number.isFinite(n)) throw new NotDecodable();
      const r = put(slot, n);
      if (slot === undefined) result = r;
    } else if (Array.isArray(src)) {
      const out: GoValue[] = new Array<GoValue>(src.length).fill(null);
      const r = put(slot, out);
      if (slot === undefined) result = r;
      // pushed in reverse so that the members are converted in document order
      for (let i = src.length - 1; i >= 0; i--) work.push({ src: src[i]!, slot: { dst: out, key: i } });
    } else if (src instanceof JObj) {
      const m = new Map<string, GoValue>();
      const r = put(slot, m);
      if (slot === undefined) result = r;
      for (let i = src.pairs.length - 1; i >= 0; i--) work.push({ src: src.pairs[i]![1], slot: { dst: m, key: wellFormed(src.pairs[i]![0]) } });
    } else {
      throw new NotDecodable();
    }
  }
  return result;
}

/** reflect.DeepEqual of two decoded documents, with an explicit stack (no recursion). */
function deepEqual(x: GoValue, y: GoValue): boolean {
  const work: [GoValue, GoValue][] = [[x, y]];
  while (work.length > 0) {
    const [a, b] = work.pop()!;
    if (a === b) continue;
    if (a instanceof Map) {
      if (!(b instanceof Map) || a.size !== b.size) return false;
      for (const [k, p] of a) {
        const q = b.get(k);
        if (q === undefined) return false;
        work.push([p, q]);
      }
    } else if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) work.push([a[i]!, b[i]!]);
    } else {
      return false;
    }
  }
  return true;
}

/** Whether two pins files are identical outside eth_sepolia.anchors (a file that is not decodable as Go reads it is never equal). */
export function nonLedgerEqual(a: Uint8Array, b: Uint8Array): boolean {
  const strip = (raw: Uint8Array): GoValue | undefined => {
    let m: GoValue;
    try {
      const doc = parseGoJson(raw);
      if (!(doc instanceof JObj)) return undefined;
      m = goValue(doc);
    } catch (err) {
      if (err instanceof JsonError || err instanceof NotDecodable) return undefined;
      throw err;
    }
    const es = (m as Map<string, GoValue>).get('eth_sepolia');
    if (es instanceof Map) es.delete('anchors');
    return m;
  };
  const ma = strip(a);
  const mb = strip(b);
  return ma !== undefined && mb !== undefined && deepEqual(ma, mb);
}

const sameAnchor = (a: AnchorPin, b: AnchorPin): boolean =>
  a.period === b.period &&
  a.committeeRoot === b.committeeRoot &&
  a.blockRoot === b.blockRoot &&
  a.wspEpochs === b.wspEpochs &&
  a.linkSha256 === b.linkSha256 &&
  a.derivedBy.length === b.derivedBy.length &&
  a.derivedBy.every((x, i) => x === b.derivedBy[i]);

/**
 * V2_SPEC_S7 4.3 "Extension without a verifier release": raw is a candidate file F' and p the base F. F' extends F iff all non-ledger
 * content is identical, F's anchors are a prefix of F''s, and every appended anchor is derived from its predecessor by the link named by its
 * linkSha256 (links maps a period to the bytes of finality-pins-links/<period>.ssz, and must also hold the bytes of the predecessor of the
 * first appended entry) and accepted by ethl1; an appended wspEpochs may not exceed the largest wspEpochs of F. The result carries
 * source "extension:<sha256 of raw>". Nothing is returned for a file that fails: finality_ledger_extension_invalid{period, reason} (or
 * finality_pins_corrupt for a file that does not parse).
 */
export function extendPins(p: Pins | null | undefined, raw: Uint8Array, links: LedgerLinks): Pins {
  if (p === null || p === undefined || p.ethSepolia === null) throw newState(Code.PinUnknown, { chain: ChainSepolia, kind: 'eth_sepolia' });
  const ext = parsePinsExtension(raw);
  if (ext.ethSepolia === null) throw ledgerExtensionInvalid(0n, LedgerReason.NonLedgerContentDiffers);
  if (p.raw === undefined) throw pinsCorrupt(PinsReason.BadValue, { key: 'raw' });
  if (!nonLedgerEqual(p.raw, raw)) throw ledgerExtensionInvalid(0n, LedgerReason.NonLedgerContentDiffers);
  const base = p.ethSepolia.anchors;
  const more = ext.ethSepolia.anchors;
  if (more.length < base.length) throw ledgerExtensionInvalid(0n, LedgerReason.BaseNotPrefix);
  for (let i = 0; i < base.length; i++) {
    if (!sameAnchor(base[i]!, more[i]!)) throw ledgerExtensionInvalid(base[i]!.period, LedgerReason.BaseNotPrefix, { index: BigInt(i) });
  }
  if (more.length === base.length) return ext;
  if (base.length === 0) throw ledgerExtensionInvalid(more[0]!.period, LedgerReason.PredecessorCommitteeUnavailable);
  let maxWsp = 0n;
  for (const a of base) if (a.wspEpochs > maxWsp) maxWsp = a.wspEpochs;
  const lastBase = base[base.length - 1]!;
  let predBody: Uint8Array | undefined = committeeOf(p.ethSepolia, lastBase, links);
  let predBootstrap: Uint8Array | undefined = lastBase.blockRoot !== '' ? links.get(lastBase.period) : undefined;
  for (let i = base.length; i < more.length; i++) {
    const cand = more[i]!;
    if (cand.wspEpochs > maxWsp) throw ledgerExtensionInvalid(cand.period, LedgerReason.WspWidened, { wsp_epochs: cand.wspEpochs, limit: maxWsp });
    const body = ledgerStep(ext.ethSepolia, more[i - 1]!, cand, predBody, predBootstrap, links.get(cand.period));
    predBody = body;
    predBootstrap = undefined;
  }
  return ext;
}

/**
 * Re-derives the whole ledger from its first entry, which must be a block_root pin whose bootstrap is links[anchors[0].period] (the root pin
 * of the annex) and is judged as the kind-2 anchor of that period even when it is the only entry, through every appended link (an appended
 * entry may not carry a block_root, block_root_on_appended_entry): the offline form of `proofverify --pins-selfcheck`.
 */
export function verifyLedger(p: Pins | null | undefined, links: LedgerLinks): void {
  if (p === null || p === undefined || p.ethSepolia === null || p.ethSepolia.anchors.length === 0) {
    throw newState(Code.PinUnknown, { chain: ChainSepolia, kind: 'eth_sepolia_ledger' });
  }
  const e = p.ethSepolia;
  const a = e.anchors;
  if (a[0]!.blockRoot === '') throw ledgerExtensionInvalid(a[0]!.period, LedgerReason.RootPinUnverifiable);
  let body: Uint8Array | undefined;
  try {
    body = committeeOf(e, a[0]!, links);
  } catch (err) {
    if (err instanceof FinalityStateError && 'inner' in err.fields) throw ledgerExtensionInvalid(a[0]!.period, LedgerReason.RootPinUnverifiable, { inner: err.fields.inner });
    if (err instanceof FinalityStateError) throw ledgerExtensionInvalid(a[0]!.period, LedgerReason.RootPinUnverifiable);
    throw err;
  }
  let boot: Uint8Array | undefined = links.get(a[0]!.period);
  for (let i = 1; i < a.length; i++) {
    const next = ledgerStep(e, a[i - 1]!, a[i]!, body, boot, links.get(a[i]!.period));
    body = next;
    boot = undefined;
  }
}
