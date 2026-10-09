/**
 * govRoot v3 (certen-validator docs/proof/GOVROOT_V3.md): the per-intent commitment over the proof v2 levels, built
 * from a verified report. The slot layout and root mirror pkg/execution/contracts/govroot_v3.go; the slot inputs, the
 * pages root and every refusal mirror pkg/intentcert/govroot_v3.go. Every slot is required; nothing is left silently
 * zero.
 */
import { account, encodeObject, keccak256 } from './accumulate.js';
import { equal, fail, merkleHashList, sha256, toHex } from './bytes.js';
import { rec, type Rec } from './shapes.js';
import type { Report } from './verify.js';

/** The 32-byte, zero-padded domain of govRoot v3. */
export const GOVROOT_V3_DOMAIN = 'certen:govroot:v3';

/** The govRoot v3 slot tags. None is used anywhere else: v2 already uses certen:g{0,1,2}:v2 for different bytes. */
export const GOVROOT_V3_TAGS = {
  l1: 'certen:l1:v3',
  l2: 'certen:l2:v3',
  l3: 'certen:l3:v3',
  l4: 'certen:l4gov:v3',
  g0: 'certen:g0:v3',
  g1: 'certen:g1:v3',
  g2: 'certen:g2:v3',
} as const;

/** The one G1 refusal of govRoot v3: no pages were captured as of the transaction's block. */
export const G1_HISTORICAL_UNAVAILABLE = 'g1_historical_unavailable';

/**
 * govRoot v3's inputs that are not proof facts, as a portable proof's govRootV3Inputs block carries them (Go
 * proofv2.PortableGovRootV3Inputs): sha256 of each governance level's canonical v2 JSON, hex32, and the key page, key
 * book and operation id (hex32).
 */
export interface GovRootV3Inputs {
  g0Hash: string;
  g1Hash: string;
  g2Hash: string;
  keyPageUrl: string;
  keyBookUrl: string;
  operationId: string;
}

/** The ten slots, hex32, in the order the root folds them (Go AccumulateGovRootInputs under v3). */
export interface GovRootV3Slots {
  l1: string;
  l2: string;
  l3: string;
  l4: string;
  g0: string;
  g1: string;
  g2: string;
  keyPage: string;
  keyBook: string;
  operationId: string;
}

export interface GovRootV3 {
  root: string;
  pagesRoot: string;
  slots: GovRootV3Slots;
}

function u64be(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

/** Go's hex.DecodeString of exactly 32 bytes: no prefix, no whitespace. */
function strictHex32(s: unknown): Uint8Array | undefined {
  if (typeof s !== 'string' || !/^[0-9a-fA-F]{64}$/.test(s)) return undefined;
  return new Uint8Array(Buffer.from(s, 'hex'));
}

/** A report field the verifier set: 32 bytes of hex, refused by name when zero or absent. */
function reportHash(v: unknown, name: string): Uint8Array {
  const b = typeof v === 'string' ? strictHex32(v.toLowerCase().replace(/^0x/, '')) : undefined;
  if (!b || equal(b, new Uint8Array(32))) fail(`govRoot v3: the ${name} is required`);
  return b;
}

/** keccak256(tag || ":" || payload) (GovRootV3SlotHash). */
export function govRootV3SlotHash(tag: string, payload: Uint8Array): Uint8Array {
  return keccak256(Buffer.concat([Buffer.from(tag + ':'), payload]));
}

/**
 * Go's unicode.IsSpace, which strings.TrimSpace trims: JavaScript's trim() also trims U+FEFF and not U+0085, so it is
 * not used.
 */
const GO_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** strings.TrimSpace. */
function goTrimSpace(s: string): string {
  const cps = [...s];
  let a = 0;
  let b = cps.length;
  while (a < b && GO_SPACE.has(cps[a].codePointAt(0)!)) a++;
  while (b > a && GO_SPACE.has(cps[b - 1].codePointAt(0)!)) b--;
  return cps.slice(a, b).join('');
}

/**
 * govvote.CanonicalAccSpelling: trimmed, lower case, one trailing slash removed. Lower case is Go's strings.ToLower,
 * one code point at a time (unicode.ToLower), never JavaScript's context-sensitive full mapping: U+0130 lowers to "i"
 * as in Go, not to "i" with a combining dot.
 */
export function canonicalAccSpelling(u: string): string {
  let out = '';
  for (const ch of goTrimSpace(u)) out += ch.codePointAt(0) === 0x130 ? 'i' : ch.toLowerCase();
  return out.endsWith('/') ? out.slice(0, -1) : out;
}

/** contracts.HashURLString: keccak256(url), 32 zero bytes for an empty URL (which the root then refuses). */
export function hashUrlString(url: string): Uint8Array {
  if (url === '') return new Uint8Array(32);
  return keccak256(Buffer.from(url, 'utf8'));
}

/** ComputeAccumulateGovRootV3: keccak256(bytes32("certen:govroot:v3") || the ten slots), every slot required. */
export function computeGovRootV3(slots: GovRootV3Slots): string {
  const domain = new Uint8Array(32);
  domain.set(Buffer.from(GOVROOT_V3_DOMAIN));
  const parts: Uint8Array[] = [domain];
  // A fixed order, so the refusal names the same first missing slot as Go.
  for (const [name, v] of [
    ['L1', slots.l1], ['L2', slots.l2], ['L3', slots.l3], ['L4', slots.l4],
    ['G0', slots.g0], ['G1', slots.g1], ['G2', slots.g2],
    ['key page', slots.keyPage], ['key book', slots.keyBook], ['operation id', slots.operationId],
  ] as const) {
    const b = strictHex32(v);
    if (!b || equal(b, new Uint8Array(32))) fail(`govRoot v3: the ${name} slot is required`);
    parts.push(b);
  }
  return toHex(keccak256(Buffer.concat(parts)));
}

/**
 * GovRootV3FromPortable: govRoot v3 from a report verifyPortable returned for doc, with the governance hashes, key
 * page, key book and operation id read from doc's govRootV3Inputs block.
 */
export function govRootV3FromPortable(report: Report, doc: unknown): GovRootV3 {
  const d = doc && typeof doc === 'object' ? (doc as Rec) : {};
  const p = d.govRootV3Inputs;
  if (!p || typeof p !== 'object') fail('govRoot v3: the portable proof carries no govRootV3Inputs');
  const evidence = d.evidence && typeof d.evidence === 'object' ? (d.evidence as Rec) : {};
  return govRootV3(report, evidence.pages, p as GovRootV3Inputs);
}

/**
 * GovRootV3FromHashes: every slot built from the verified report. evidencePages are the portable evidence's pages the
 * report proved, read only for each page's state bytes.
 */
export function govRootV3(report: Report, evidencePages: unknown, inputs: GovRootV3Inputs): GovRootV3 {
  const h: Record<string, Uint8Array> = {};
  for (const name of ['g0Hash', 'g1Hash', 'g2Hash', 'operationId'] as const) {
    const b = strictHex32(inputs?.[name]);
    if (!b) fail(`govRoot v3: govRootV3Inputs.${name} is not 32 bytes of hex`);
    h[name] = b;
  }
  if (!report) fail('govRoot v3: no verified proof v2 report');
  // verifyPortable sets every one of these; a zero one is a report it did not produce.
  const txHash = reportHash(report.txHash, 'transaction hash');
  const anchorTxHash = reportHash(report.anchorTxHash, 'partition anchor transaction hash');
  const anchorStateRoot = reportHash(report.anchorStateRoot, 'partition state tree anchor');
  const certifiedRoot = reportHash(report.certifiedRoot, 'certified root chain anchor');
  const setRoot = reportHash(report.accumulateSetRoot, 'accumulate set root');
  const incarnation = reportHash(report.incarnation, 'incarnation');
  for (const [name, v] of [['G0 hash', h.g0Hash], ['G1 hash', h.g1Hash], ['G2 hash', h.g2Hash]] as const) {
    if (equal(v, new Uint8Array(32))) fail(`govRoot v3: the ${name} is required`);
  }
  if (!report.anchorBlock || !report.certifiedBlock) fail('govRoot v3: the report names no anchor block or certified block');
  // The L4 slot states the set was proven; any weaker verdict is a set check that failed, which fails closed.
  if (report.setVerdict !== 'verified') fail(`govRoot v3: the validator set check is ${report.setVerdict}, not verified`);
  const pagesRoot = pagesRootV3(report, evidencePages);

  const g1 = govRootV3SlotHash(GOVROOT_V3_TAGS.g1, Buffer.concat([h.g1Hash, pagesRoot]));
  const slots: GovRootV3Slots = {
    l1: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l1, Buffer.concat([txHash, anchorTxHash, u64be(report.anchorBlock)]))),
    l2: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l2, Buffer.concat([certifiedRoot, u64be(report.certifiedBlock)]))),
    l3: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l3, Buffer.concat([anchorStateRoot, u64be(report.anchorBlock)]))),
    l4: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l4, Buffer.concat([setRoot, incarnation, u64be(report.certifiedBlock)]))),
    g0: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.g0, Buffer.concat([h.g0Hash, txHash, certifiedRoot]))),
    g1: toHex(g1),
    g2: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.g2, Buffer.concat([h.g2Hash, g1]))),
    // As v2: in canonical spelling, since Accumulate URLs are case-insensitive and two validators naming one page two
    // ways must commit one govRoot.
    keyPage: toHex(hashUrlString(canonicalAccSpelling(String(inputs.keyPageUrl ?? '')))),
    keyBook: toHex(hashUrlString(canonicalAccSpelling(String(inputs.keyBookUrl ?? '')))),
    operationId: toHex(h.operationId),
  };
  return { root: computeGovRootV3(slots), pagesRoot: toHex(pagesRoot), slots };
}

/**
 * PagesRootV3: the proven pages sorted by canonical URL (Go string order: UTF-8 bytes), each record sha256(canonicalURL)
 * ‖ sha256(state) ‖ bound (1 byte) ‖ uint64(mainHeight), with bound 0 and mainHeight 0 for a page whose chains are
 * unbound; the root is the merkle hash of the sha256 of each record. The URL and chain facts are the report's; the state
 * bytes are the evidence's, re-encoded from its JSON, and must be exactly the encoding of the account the report proved.
 */
export function pagesRootV3(report: Report, evidencePages: unknown): Uint8Array {
  if (!report || !Array.isArray(evidencePages)) fail('govRoot v3: the pages root needs the verified report and its evidence');
  const pages = Array.isArray(report.pages) ? report.pages : [];
  if (pages.length === 0) fail(`govRoot v3: ${G1_HISTORICAL_UNAVAILABLE}: no pages were captured as of the transaction's block`);
  const chains = Array.isArray(report.pageChains) ? report.pageChains : [];
  if (chains.length !== pages.length || evidencePages.length !== pages.length) {
    fail(`govRoot v3: the report proves ${pages.length} pages with ${chains.length} chain results, the evidence carries ${evidencePages.length}`);
  }
  const recs = pages.map((proved, i) => {
    const acct = proved as { url?: unknown } | undefined;
    if (!acct || !acct.url) fail(`govRoot v3: page ${i} of the report has no account`);
    const u = canonicalAccSpelling(String(acct.url));
    const ep = rec(evidencePages[i], `govRoot v3: evidence page ${i}`);
    if (canonicalAccSpelling(String(chains[i].url)) !== u || canonicalAccSpelling(String(ep.url ?? '')) !== u) {
      fail(`govRoot v3: page ${i} is ${u} in the report, but its chains are ${chains[i].url} and its evidence ${String(ep.url)}`);
    }
    const state = encodeObject(account(ep.account, `govRoot v3: ${u}: state`));
    if (!equal(state, encodeObject(acct))) fail(`govRoot v3: ${u}: the evidence's state is not the account the report proved`);
    const bound = chains[i].bound ? 1 : 0;
    const height = chains[i].bound ? chains[i].mainHeight : 0;
    const entry = Buffer.concat([sha256(Buffer.from(u, 'utf8')), sha256(state), new Uint8Array([bound]), u64be(height)]);
    return { url: u, key: Buffer.from(u, 'utf8'), leaf: sha256(entry) };
  });
  recs.sort((a, b) => Buffer.compare(a.key, b.key));
  // Two pages under one canonical URL would make the order, and so the root, depend on capture order.
  for (let i = 1; i < recs.length; i++) {
    if (recs[i].url === recs[i - 1].url) fail(`govRoot v3: page ${recs[i].url} is captured twice`);
  }
  return merkleHashList(recs.map((r) => r.leaf));
}
