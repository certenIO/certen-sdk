/**
 * govRoot v4 (validator docs/proof/G1_CROSS_PARTITION.md D4/D7, rules v15; conventions of docs/proof/GOVROOT_V3.md; pkg/intentcert/
 * govroot_v4.go and pkg/execution/contracts/govroot_v4.go): the per-intent commitment over a proof v2 of evidence 2.1. It is govRoot v3 with the G1
 * slot widened to commit what 2.1 proves beyond 2.0 - every page with the partition and block it is proven at and the roles that put it in
 * the governing set, and the authority votes copied from the principal's proven signature chain - and with G2 under its own tag. The
 * other slots commit the same facts in the same bytes as v3; the root's domain, certen:govroot:v4, is what separates the two roots.
 *
 * The votes root commits an explicit canonical field encoding (EncodeVoteV4: length-prefixed fields in a fixed order, versioned by the
 * tag), not a serialisation of any structure, so a later change to a document's JSON form cannot move a committed root.
 */
import { VerifyError, equal, fail, merkleHashList, sha256, toHex } from '../proof-v2/bytes.js';
import { canonicalAccSpelling, G1_HISTORICAL_UNAVAILABLE, GOVROOT_V3_TAGS, govRootV3SlotHash, hashUrlString } from '../proof-v2/govroot-v3.js';
import { keccak256 } from '../proof-v2/accumulate.js';
import { encodeNode } from '../sigtypes/wire.js';
import { goHex, goHexError } from './gojson.js';
import { app } from './bytebuf.js';
import { importEvidence, type Arrival, type Evidence, type Hop, type IndexProof, type Vote } from './evidence.js';
import { accountUrl, type WireNode } from './model.js';
import { canonicalRoles, DOMAIN_GOVROOT_V4, State, VERSION_21 } from './states.js';
import type { ProvenPage, Report21 } from './xtypes.js';
import { goStringCompare } from './acc.js';
import type { Rec } from '../proof-v2/shapes.js';

export { DOMAIN_GOVROOT_V4 as GOVROOT_V4_DOMAIN } from './states.js';

/** The slot tags of govRoot v4 that differ from v3: G1 widened, and G2 over the v4 G1 slot under its own tag. */
export const GOVROOT_V4_TAGS = { g1: 'certen:g1:v4', g2: 'certen:g2:v4' } as const;

/** The vote record domain: every committed vote record starts with it, so a different layout is a different tag. */
export const VOTE_RECORD_TAG_V4 = 'certen:g1:v4:vote:';

const canon = canonicalAccSpelling;
const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

function u64be(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}
const zero32 = new Uint8Array(32);
const cat = (...p: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(p));

/** GovRootV4G1: keccak256("certen:g1:v4:" || g1Sha256 || pagesRoot || votesRoot). */
export function govRootV4G1(g1Sha256: Uint8Array, pagesRoot: Uint8Array, votesRoot: Uint8Array): Uint8Array {
  return govRootV3SlotHash(GOVROOT_V4_TAGS.g1, cat(g1Sha256, pagesRoot, votesRoot));
}

/** GovRootV4G2: the G2 slot over the v4 G1 slot, under certen:g2:v4. */
export function govRootV4G2(g2Sha256: Uint8Array, g1Slot: Uint8Array): Uint8Array {
  return govRootV3SlotHash(GOVROOT_V4_TAGS.g2, cat(g2Sha256, g1Slot));
}

/** The ten slots, hex32, in the order the root folds them. */
export interface GovRootV4Slots {
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

/** ComputeAccumulateGovRootV4: keccak256(bytes32("certen:govroot:v4") || the ten slots), every slot required. */
export function computeGovRootV4(slots: GovRootV4Slots): string {
  const domain = new Uint8Array(32);
  domain.set(Buffer.from(DOMAIN_GOVROOT_V4));
  const parts: Uint8Array[] = [domain];
  for (const [name, v] of [
    ['L1', slots.l1], ['L2', slots.l2], ['L3', slots.l3], ['L4', slots.l4], ['G0', slots.g0], ['G1', slots.g1], ['G2', slots.g2],
    ['key page', slots.keyPage], ['key book', slots.keyBook], ['operation id', slots.operationId],
  ] as const) {
    const b = typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v) ? new Uint8Array(Buffer.from(v, 'hex')) : undefined;
    if (!b || equal(b, zero32)) fail(`govRoot v4: the ${name} slot is required`);
    parts.push(b);
  }
  return toHex(keccak256(cat(...parts)));
}

// --------------------------------------------------------------------------------------------------------------------------------
// the votes root

/** A vote as the evidence document spells it: hex members are hex strings of the bytes they encode (EncodeVoteV4 commits the bytes). */
export interface VoteWire {
  authority: string;
  origin: string;
  vote: string;
  cause: string;
  transport: { kind: string; source: string; destination: string; number: number };
  message: string;
  receipt: string;
  hops: HopWire[];
  counted: HopWire[];
  produced?: { account: string; chain: string; message: string; receipt: string; arrival: ArrivalWire; sequenced: string };
}
export interface IndexProofWire {
  position: number;
  entry: string;
  receipt: string;
}
export interface ArrivalWire {
  before?: IndexProofWire;
  at: IndexProofWire;
}
export interface HopWire {
  page: string;
  message: string;
  signature: string;
  block: number;
  receipt: string;
  arrival?: ArrivalWire;
}

const indexProofWire = (p: IndexProof): IndexProofWire => ({ position: p.position, entry: p.entry, receipt: toHex(p.receipt.bin) });
const arrivalWire = (a: Arrival): ArrivalWire => ({ ...(a.before ? { before: indexProofWire(a.before) } : {}), at: indexProofWire(a.at) });
const hopWire = (h: Hop): HopWire => ({ page: h.page, message: h.message, signature: h.signature, block: h.block, receipt: toHex(h.receipt.bin), ...(h.arrival ? { arrival: arrivalWire(h.arrival) } : {}) });

/** The wire spelling of an imported vote (Go's Evidence form: receipts and the sequenced message as hex of their binary encodings). */
export function voteWire(v: Vote): VoteWire {
  return {
    authority: v.authority,
    origin: v.origin,
    vote: v.vote,
    cause: v.cause,
    transport: v.transport,
    message: v.message,
    receipt: toHex(v.receipt.bin),
    hops: (v.hops ?? []).map(hopWire),
    counted: (v.counted ?? []).map(hopWire),
    ...(v.produced
      ? { produced: { account: v.produced.account, chain: v.produced.chain, message: v.produced.message, receipt: toHex(v.produced.receipt.bin), arrival: arrivalWire(v.produced.arrival), sequenced: v.produced.sequenced ? toHex(v.produced.sequenced.bin) : '' } }
      : {}),
  };
}

class VoteWriter {
  b: number[] = [];
  err: Error | undefined;
  u64(v: number | bigint): void {
    app(this.b, u64be(v));
  }
  u32(v: number): void {
    const x = new Uint8Array(4);
    new DataView(x.buffer).setUint32(0, v);
    app(this.b, x);
  }
  flag(v: boolean): void {
    this.b.push(v ? 1 : 0);
  }
  /** A length-prefixed string exactly as recorded. */
  str(s: string): void {
    const u = utf8(s);
    this.u32(u.length);
    app(this.b, u);
  }
  /** A length-prefixed URL in canonical spelling (lower case, no trailing slash). */
  url(s: string): void {
    this.str(canon(s));
  }
  /** The bytes a hex member encodes, length-prefixed; an empty member is the zero-length field, a member that is not hex is an error. */
  hex(name: string, s: string): void {
    const raw = goHex(s);
    if (!raw && !this.err) this.err = new VerifyError(`${name} is not hex: ${goHexError(s)}`);
    // hex.DecodeString returns the bytes decoded before an error too, but a record with an error is never committed: the length it wrote is moot.
    const r = raw ?? new Uint8Array(0);
    this.u32(r.length);
    app(this.b, r);
  }
  indexProof(name: string, p: IndexProofWire): void {
    this.u64(p.position);
    this.hex(`${name}.entry`, p.entry);
    this.hex(`${name}.receipt`, p.receipt);
  }
  arrival(name: string, a: ArrivalWire): void {
    this.flag(a.before !== undefined);
    if (a.before) this.indexProof(`${name}.before`, a.before);
    this.indexProof(`${name}.at`, a.at);
  }
  hops(name: string, hops: HopWire[]): void {
    this.u32(hops.length);
    hops.forEach((h, i) => {
      const n = `${name}[${i}]`;
      this.url(h.page);
      this.hex(`${n}.message`, h.message);
      this.hex(`${n}.signature`, h.signature);
      this.u64(h.block);
      this.hex(`${n}.receipt`, h.receipt);
      this.flag(h.arrival !== undefined);
      if (h.arrival) this.arrival(`${n}.arrival`, h.arrival);
    });
  }
}

/**
 * EncodeVoteV4 is the canonical encoding of one vote record that govRoot v4 commits (under VOTE_RECORD_TAG_V4). Fixed order, every field:
 *
 *     url(authority) ‖ url(origin) ‖ str(vote) ‖ url(cause)
 *     ‖ str(transport.kind) ‖ url(transport.source) ‖ url(transport.destination) ‖ u64(transport.number)
 *     ‖ hex(message) ‖ hex(receipt)
 *     ‖ u32(len hops) ‖ hop* ‖ u32(len counted) ‖ hop*
 *     ‖ flag(produced) ‖ [url(account) ‖ str(chain) ‖ hex(message) ‖ hex(receipt) ‖ arrival ‖ hex(sequenced)]
 *
 *     hop     = url(page) ‖ hex(message) ‖ hex(signature) ‖ u64(block) ‖ hex(receipt) ‖ flag(arrival) ‖ [arrival]
 *     arrival = flag(before) ‖ [indexproof] ‖ indexproof        indexproof = u64(position) ‖ hex(entry) ‖ hex(receipt)
 *
 * u64 is 8 bytes big-endian, u32 and the flag (1 byte, 0 or 1) as named; str and hex are a u32 big-endian length and the bytes (hex members
 * are committed as the bytes they encode, so the spelling of the hex does not matter); url is str of the lower-case spelling without a
 * trailing slash. An absent optional member is its flag 0 or the zero-length field - never omitted. sequenced is the binary SequencedMessage
 * the production carries (zero-length for an inline vote): it binds the production to the vote's message, so it is committed with it.
 */
export function encodeVoteV4(v: VoteWire): Uint8Array {
  const w = new VoteWriter();
  w.url(v.authority);
  w.url(v.origin);
  w.str(v.vote);
  w.url(v.cause);
  w.str(v.transport.kind);
  w.url(v.transport.source);
  w.url(v.transport.destination);
  w.u64(v.transport.number);
  w.hex('message', v.message);
  w.hex('receipt', v.receipt);
  w.hops('hops', v.hops);
  w.hops('counted', v.counted);
  w.flag(v.produced !== undefined);
  if (v.produced) {
    const p = v.produced;
    w.url(p.account);
    w.str(p.chain);
    w.hex('produced.message', p.message);
    w.hex('produced.receipt', p.receipt);
    w.arrival('produced.arrival', p.arrival);
    w.hex('produced.sequenced', p.sequenced);
  }
  if (w.err) throw w.err;
  return Uint8Array.from(w.b);
}

/**
 * VotesRootV4 commits the authority votes copied from the principal's proven signature chain: the merkle hash of the leaves
 * sha256(VOTE_RECORD_TAG_V4 ‖ EncodeVoteV4(vote)), the votes sorted by (authority, origin, message, leaf) in canonical spelling. An intent
 * with no recorded vote was authorized by nothing, and is refused by name; so is one vote recorded twice.
 */
export function votesRootV4(votes: VoteWire[]): Uint8Array {
  if (votes.length === 0) fail('govRoot v4: the evidence records no authority vote, so nothing authorized the intent');
  const leaves = votes.map((v, i) => {
    let enc: Uint8Array;
    try {
      enc = encodeVoteV4(v);
    } catch (e) {
      throw new VerifyError(`govRoot v4: vote ${i}: ${(e as Error).message}`);
    }
    return { authority: canon(v.authority), origin: canon(v.origin), message: v.message.toLowerCase(), h: sha256(cat(utf8(VOTE_RECORD_TAG_V4), enc)) };
  });
  const order = (a: string, b: string): number => goStringCompare(a, b);
  leaves.sort((a, b) => order(a.authority, b.authority) || order(a.origin, b.origin) || order(a.message, b.message) || Buffer.compare(a.h, b.h));
  for (let i = 1; i < leaves.length; i++) {
    if (equal(leaves[i]!.h, leaves[i - 1]!.h)) fail(`govRoot v4: the vote of ${leaves[i]!.authority} by ${leaves[i]!.origin} is recorded twice`);
  }
  return merkleHashList(leaves.map((l) => l.h));
}

// --------------------------------------------------------------------------------------------------------------------------------
// the pages root

/** How many chain results, (partition, block, roles) records and evidence pages accompany the report's pages. */
export interface PageCounts {
  chains: number;
  proven: number;
  evidence: number;
}

/** One proven page of a 2.1 report with the evidence's claims about it. */
export interface PagesRootPage {
  /** The proven account (the report's page) and its URL as the report spells it. */
  account: WireNode;
  /** What the evidence carries for the page, in the order of the report. */
  evidence: { url: string; state: string; partition: string; roles: string[] | undefined };
  chain: { url: string; bound: boolean; mainHeight: number };
  proven: ProvenPage;
}

export function pageCounts(rep: Report21, ev: Evidence): PageCounts {
  return { chains: rep.pageChains.length, proven: rep.proven.length, evidence: ev.pages.length };
}

/** The pages of a verified 2.1 report and of the evidence it was verified from. */
export function pagesRootInputs(rep: Report21, ev: Evidence): PagesRootPage[] {
  return rep.pages.map((p, i) => ({
    account: p.account,
    evidence: { url: ev.pages[i]?.url ?? '', state: ev.pages[i] ? toHex(ev.pages[i]!.state) : '', partition: ev.pages[i]?.partition ?? '', roles: ev.pages[i]?.roles },
    chain: rep.pageChains[i] ? { url: rep.pageChains[i]!.url, bound: rep.pageChains[i]!.bound, mainHeight: rep.pageChains[i]!.mainHeight } : { url: '', bound: false, mainHeight: 0 },
    proven: rep.proven[i] ?? { url: '', partition: '', block: 0, roles: [], declared: [] },
  }));
}

/**
 * PagesRootV4 commits the proven pages: sorted by canonical URL, each record is
 *
 *     sha256(canonicalURL) ‖ sha256(state) ‖ bound (1 byte) ‖ uint64(mainHeight) ‖ sha256(canonicalPartition) ‖ uint64(block) ‖ sha256(roles)
 *
 * with bound 0 and mainHeight 0 for a page whose chains are unbound, canonicalPartition the partition's lower-case spelling, and roles the
 * page's roles in canonical order joined with ",". The root is the merkle hash of the sha256 of each record. The report lists the partition,
 * block and roles of every page, the evidence carries the same and the state bytes; any disagreement between the two, a page with no
 * partition, block or role, or a page proven twice is refused by name.
 */
export function pagesRootV4(pages: PagesRootPage[], counts: PageCounts): Uint8Array {
  if (pages.length === 0) fail(`govRoot v4: ${G1_HISTORICAL_UNAVAILABLE}: no pages were captured as of the transaction's block`);
  if (counts.chains !== pages.length || counts.evidence !== pages.length || counts.proven !== pages.length) {
    fail(`govRoot v4: the report proves ${pages.length} pages with ${counts.chains} chain results and ${counts.proven} (partition, block, roles) records, the evidence carries ${counts.evidence}`);
  }
  const recs = pages.map((pg, i) => {
    const u = canon(accountUrl(pg.account).toString());
    const pp = pg.proven;
    if (canon(pg.chain.url) !== u || canon(pg.evidence.url) !== u || canon(pp.url) !== u) {
      fail(`govRoot v4: page ${i} is ${u} in the report, but its chains are ${pg.chain.url}, its evidence ${pg.evidence.url} and its proven record ${pp.url}`);
    }
    const partition = canon(pp.partition);
    if (partition === '') fail(`govRoot v4: ${u}: ${State.ForeignPartitionMismatch}: the page is proven with no partition`);
    if (pp.block === 0) fail(`govRoot v4: ${u}: ${State.PageBlockMismatch}: the page is proven with no block`);
    // The roles recorded for the page: those the verifier proved and those it could only declare.
    let roles: string[];
    try {
      roles = canonicalRoles([...pp.roles, ...pp.declared]);
    } catch (e) {
      throw new VerifyError(`govRoot v4: ${u}: ${(e as Error).message}`);
    }
    if (roles.length === 0) fail(`govRoot v4: ${u}: the page is proven with no role, so nothing says why it is in the governing set`);
    if (canon(pg.evidence.partition) !== partition) fail(`govRoot v4: ${u}: the report proves it on ${pp.partition}, the evidence claims ${pg.evidence.partition}`);
    let evRoles: string[] | undefined;
    try {
      evRoles = canonicalRoles(pg.evidence.roles ?? []);
    } catch {
      evRoles = undefined;
    }
    if (!evRoles || evRoles.length !== roles.length || evRoles.some((r, k) => r !== roles[k])) {
      fail(`govRoot v4: ${u}: the report records roles [${roles.join(' ')}], the evidence [${(pg.evidence.roles ?? []).join(' ')}]`);
    }
    const stateBytes = goHex(pg.evidence.state);
    if (!stateBytes) fail(`govRoot v4: ${u}: state: ${goHexError(pg.evidence.state)}`);
    const proven = encodeNode(pg.account);
    if (!equal(stateBytes, proven)) fail(`govRoot v4: ${u}: the evidence's state is not the account the report proved`);
    const bound = pg.chain.bound ? 1 : 0;
    const height = pg.chain.bound ? pg.chain.mainHeight : 0;
    const rec = cat(sha256(utf8(u)), sha256(stateBytes), Uint8Array.of(bound), u64be(height), sha256(utf8(partition)), u64be(pp.block), sha256(utf8(roles.join(','))));
    return { url: u, leaf: sha256(rec) };
  });
  recs.sort((a, b) => goStringCompare(a.url, b.url));
  for (let i = 1; i < recs.length; i++) {
    if (recs[i]!.url === recs[i - 1]!.url) fail(`govRoot v4: page ${recs[i]!.url} is captured twice`);
  }
  return merkleHashList(recs.map((r) => r.leaf));
}

// --------------------------------------------------------------------------------------------------------------------------------
// the root

/** The inputs govRoot v4 commits beyond the verified report: the governance levels' hashes and the key page, key book and operation id. */
export interface GovRootV4Inputs {
  g0Hash: string;
  g1Hash: string;
  g2Hash: string;
  keyPageUrl: string;
  keyBookUrl: string;
  operationId: string;
}

export interface GovRootV4 {
  root: string;
  pagesRoot: string;
  votesRoot: string;
  slots: GovRootV4Slots;
}

/** What the root reads of a verified 2.1 report. */
export interface GovRootReport {
  txHash: string;
  anchorTxHash: string;
  anchorStateRoot: string;
  certifiedRoot: string;
  accumulateSetRoot: string;
  incarnation: string;
  anchorBlock: number;
  certifiedBlock: number;
  setVerdict: string;
}

function strictHex32(s: unknown): Uint8Array | undefined {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s) ? new Uint8Array(Buffer.from(s, 'hex')) : undefined;
}

/** GovRootV4FromHashes: every slot built from the verified 2.1 report and the evidence it was verified from. */
export function govRootV4FromHashes(rep: GovRootReport, version: string, pages: PagesRootPage[], counts: PageCounts, votes: VoteWire[], inputs: GovRootV4Inputs): GovRootV4 {
  // GovRootV4FromPortable reads the four hashes of the inputs block before the report is looked at; the evidence's version is the next refusal
  const h: Record<string, Uint8Array> = {};
  for (const name of ['g0Hash', 'g1Hash', 'g2Hash', 'operationId'] as const) {
    const b = strictHex32(inputs[name]);
    if (!b) fail(`govRoot v4: govRootV3Inputs.${name} is not 32 bytes of hex`);
    h[name] = b;
  }
  if (version !== VERSION_21) fail(`govRoot v4: the evidence is not version ${VERSION_21}`);
  const need: [string, Uint8Array | undefined][] = [
    ['transaction hash', strictHex32(rep.txHash)],
    ['partition anchor transaction hash', strictHex32(rep.anchorTxHash)],
    ['partition state tree anchor', strictHex32(rep.anchorStateRoot)],
    ['certified root chain anchor', strictHex32(rep.certifiedRoot)],
    ['accumulate set root', strictHex32(rep.accumulateSetRoot)],
    ['incarnation', strictHex32(rep.incarnation)],
  ];
  need.push(['G0 hash', h.g0Hash], ['G1 hash', h.g1Hash], ['G2 hash', h.g2Hash]);
  for (const [name, v] of need) if (!v || equal(v, zero32)) fail(`govRoot v4: the ${name} is required`);
  if (rep.anchorBlock === 0 || rep.certifiedBlock === 0) fail('govRoot v4: the report names no anchor block or certified block');
  if (rep.setVerdict !== 'verified') fail(`govRoot v4: the validator set check is ${rep.setVerdict}, not verified`);
  const pagesRoot = pagesRootV4(pages, counts);
  const votesRoot = votesRootV4(votes);
  const tx = strictHex32(rep.txHash)!;
  const anchorTx = strictHex32(rep.anchorTxHash)!;
  const stateRoot = strictHex32(rep.anchorStateRoot)!;
  const certRoot = strictHex32(rep.certifiedRoot)!;
  const setRoot = strictHex32(rep.accumulateSetRoot)!;
  const inc = strictHex32(rep.incarnation)!;
  const g1 = govRootV4G1(h.g1Hash!, pagesRoot, votesRoot);
  const slots: GovRootV4Slots = {
    l1: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l1, cat(tx, anchorTx, u64be(rep.anchorBlock)))),
    l2: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l2, cat(certRoot, u64be(rep.certifiedBlock)))),
    l3: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l3, cat(stateRoot, u64be(rep.anchorBlock)))),
    l4: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l4, cat(setRoot, inc, u64be(rep.certifiedBlock)))),
    g0: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.g0, cat(h.g0Hash!, tx, certRoot))),
    g1: toHex(g1),
    g2: toHex(govRootV4G2(h.g2Hash!, g1)),
    keyPage: toHex(hashUrlString(canon(String(inputs.keyPageUrl ?? '')))),
    keyBook: toHex(hashUrlString(canon(String(inputs.keyBookUrl ?? '')))),
    operationId: toHex(h.operationId!),
  };
  return { root: computeGovRootV4(slots), pagesRoot: toHex(pagesRoot), votesRoot: toHex(votesRoot), slots };
}

/**
 * GovRootV4FromPortable: govRoot v4 from the report verifyPortable21 returned for doc, with the governance hashes, key page, key book and
 * operation id read from the document's govRootV3Inputs block (the block's name is v3's; the version of the root computed from it is the
 * evidence's).
 */
export function govRootV4FromPortable(report: Report21, doc: unknown): GovRootV4 {
  const d = doc && typeof doc === 'object' ? (doc as Rec) : {};
  const p = d.govRootV3Inputs;
  if (!p || typeof p !== 'object') fail('govRoot v4: the portable proof carries no govRootV3Inputs');
  const ev = importEvidence(d);
  return govRootV4FromHashes(report, ev.version, pagesRootInputs(report, ev), pageCounts(report, ev), ev.votes.map(voteWire), p as GovRootV4Inputs);
}
