/**
 * BindProofV21 (validator pkg/intentcert/bind_v21.go): the binding of a verified evidence 2.1 report to the intent it is evidence of.
 *
 * The verifier proves pages; the binding requires every page the intent's governing set needs (docs/proof/G1_CROSS_PARTITION.md
 * D1(a)-(f)) to be among the proven pages, at its own partition and block, with the role that says why - and a report with anything
 * unproven is not a verified S3 at all. A governing fact the report cannot show is a named state carrying the partition and block it was
 * judged at.
 */
import { VerifyError, equal, toHex } from '../proof-v2/bytes.js';
import { canonicalAccSpelling } from '../proof-v2/govroot-v3.js';
import { AccUrl, DELEGATION_DEPTH_LIMIT, formatKeyPageUrl, goEqualFold, goStringCompare } from './acc.js';
import { executorFloorAt, normalizeExecutorPartition, baikonurEnabled } from './executor.js';
import { goHex } from './gojson.js';
import {
  accountUrl,
  additionalAuthorities,
  authoritiesOf,
  bigOf,
  bodyType,
  headerAuthorities,
  initiatorOf,
  isFullAccount,
  KeyPage,
  principalOf,
  requireAuthorization,
  signatureDidInitiate,
  signerOf,
  txnHash,
  type WireNode,
} from './model.js';
import { decodeSigHex, decodeTxnHex, requireSig } from './sig.js';
import { canonicalRoles, NamedState, refusal21, Role, State, type PageRole } from './states.js';
import type { ProvenPage, Report21 } from './xtypes.js';
import { payerOf } from './acc.js';
import { delegatorPages } from './model.js';
import { liteTokenDelegate as liteDelegate } from './verify21.js';

const canon = canonicalAccSpelling;

export interface SignatureRef {
  signer: string;
  block: number;
}
export interface VoteRef {
  authority: string;
  origin: string;
  block: number;
}
export interface ArrivalRef {
  page: string;
  origin: string;
  path: string[];
  block: number;
}

/**
 * GoverningFacts are the facts of an intent that decide which pages its proof must have proven (D1(a)-(f)), read from the intent's own
 * vote evidence. Every URL is in canonical spelling.
 */
export interface GoverningFacts {
  principal: string;
  type: number;
  /** The hash of the transaction the vote evidence carries: the binding requires it to be the transaction the report proved. */
  txHash: Uint8Array;
  authorities: { url: string; disabled: boolean }[];
  headerAuthorities: string[];
  initiators: string[];
  initiatorPath: string[];
  signatures: SignatureRef[];
  votes: VoteRef[];
  arrivals: ArrivalRef[];
}

/** G0's fields the binding reads (proof.G0Result). */
export interface G0Result {
  entryHashExec: string;
  receiptStart: string;
  execWitness: string;
  execMBI: number;
}
/** G1's field the binding reads (proof.G1Result.AuthoritySnapshot.Page). */
export interface G1Result {
  authoritySnapshotPage: string;
}

// --------------------------------------------------------------------------------------------------------------------------------
// the facts of the intent's vote evidence (govvote.Evidence)

/** The members of a govvote.Evidence the facts read. */
export interface VoteEvidenceView {
  account: string;
  /** Hex of the governed transaction's binary encoding. */
  transaction: string;
  authorities: { url: string; disabled: boolean }[];
  extra: string[];
  signatures: { signer: string; block: number; signature: string }[];
  votes: { authority: string; origin: string; block: number }[];
  arrivals: { page: string; origin: string; path: string[]; block: number }[];
}

function appendOnce(list: string[], seen: Set<string>, u: string): void {
  const c = canon(u);
  if (c === '' || seen.has(c)) return;
  seen.add(c);
  list.push(c);
}

/**
 * GoverningFactsFromVoteEvidence reads GoverningFacts from an intent's vote evidence. The initiating signature is the one the transaction
 * header's initiator hash names (SignatureDidInitiate); evidence that holds none cannot say which pages initiated and paid, and is refused by
 * name (g1_initiator_page_unproven) rather than read as having no initiator.
 */
export function governingFactsFromVoteEvidence(ev: VoteEvidenceView): GoverningFacts {
  let txn: WireNode;
  try {
    txn = decodeTxnHex(ev.transaction);
  } catch (e) {
    const m = (e as Error).message;
    if (m === 'a transaction is not hex') throw new VerifyError('proof v2 binding: the governed transaction is not hex');
    if (m === 'a transaction has no body or principal') throw new VerifyError('proof v2 binding: the governed transaction has no body or principal');
    throw new VerifyError(`proof v2 binding: the governed transaction does not decode: ${m.replace(/^a transaction does not decode: /, '')}`);
  }
  const principal = principalOf(txn)!;
  if (canon(ev.account) !== canon(principal.toString())) {
    throw new VerifyError(`proof v2 binding: the vote evidence is for ${ev.account}, its transaction's principal is ${principal}`);
  }
  const f: GoverningFacts = {
    principal: canon(ev.account),
    type: bodyType(txn),
    txHash: txnHash(txn),
    authorities: ev.authorities.map((a) => ({ url: canon(a.url), disabled: a.disabled })),
    headerAuthorities: [],
    initiators: [],
    initiatorPath: [],
    signatures: [],
    votes: [],
    arrivals: [],
  };
  const seen = new Set<string>();
  for (const a of headerAuthorities(txn)) appendOnce(f.headerAuthorities, seen, a.toString());
  for (const a of additionalAuthorities(txn)) appendOnce(f.headerAuthorities, seen, a.toString());
  for (const a of ev.extra) appendOnce(f.headerAuthorities, seen, a);

  let initiated = false;
  const initSeen = new Set<string>();
  const pathSeen = new Set<string>();
  const init = initiatorOf(txn);
  ev.signatures.forEach((s, i) => {
    f.signatures.push({ signer: canon(s.signer), block: s.block });
    const raw = goHex(s.signature);
    if (!raw || raw.length === 0) throw new VerifyError(`proof v2 binding: signature ${i} is not hex`);
    let sig: WireNode;
    try {
      sig = requireSig(decodeSigHex(s.signature));
    } catch (e) {
      throw new VerifyError(`proof v2 binding: signature ${i} does not decode: ${(e as Error).message}`);
    }
    if (!signatureDidInitiate(sig, init)) return;
    initiated = true;
    // The payer, as the credit payment names it (a lite token address pays as its lite identity), and the key page that signed; the
    // delegators of a delegated signature are the path.
    const signer = signerOf(sig);
    if (signer) appendOnce(f.initiators, initSeen, payerOf(signer).toString());
    appendOnce(f.initiators, initSeen, s.signer);
    for (const d of delegatorPages(sig)) appendOnce(f.initiatorPath, pathSeen, d.toString());
  });
  if (!initiated) {
    throw new NamedState(State.InitiatorPageUnproven, '', 0, 'the vote evidence holds no signature the transaction header\'s initiator names, so the pages that initiated and paid are unknown');
  }
  for (const v of ev.votes) f.votes.push({ authority: canon(v.authority), origin: canon(v.origin), block: v.block });
  for (const a of ev.arrivals) f.arrivals.push({ page: canon(a.page), origin: canon(a.origin), path: a.path.map(canon), block: a.block });
  return f;
}

// --------------------------------------------------------------------------------------------------------------------------------
// the binding

interface ProvenView {
  acct: WireNode;
  proof: ProvenPage;
}

const has = (p: ProvenView, r: PageRole): boolean => p.proof.roles.includes(r);
const declared = (p: ProvenView, r: PageRole): boolean => p.proof.declared.includes(r);

/** The detail of a role the page does not prove: when the page records it only as declared, it says so. */
function missing(p: ProvenView, r: PageRole): string {
  if (declared(p, r)) return `is recorded as ${r} but only declared, not proven (the document does not carry what justifies it)`;
  return `is proven (roles [${p.proof.roles.join(' ')}]) but not as ${r}`;
}

const ns = (code: string, partition: string, block: number, detail: string): NamedState => refusal21(code, partition, block, detail);

function samePartition(a: string, c: string): boolean {
  const t = (s: string): string => s.trim().replace(/\/$/, '');
  return goEqualFold(t(a), t(c));
}

function hashOf(s: string, what: string): Uint8Array {
  const b = goHex(s.toLowerCase().replace(/^0x/, ''));
  if (!b || b.length !== 32) throw new VerifyError(`proof v2 binding: ${what} is not 32 bytes of hex`);
  return b;
}

/** bindG0: G0's execution entry, witness and block are the report's. */
export function bindG0(rep: Report21, g0: G0Result): void {
  const entry = hashOf(g0.entryHashExec, 'G0 entry_hash_exec');
  const start = hashOf(g0.receiptStart, 'G0 receipt.start');
  const witness = hashOf(g0.execWitness, 'G0 exec_witness');
  const tx = Buffer.from(rep.txHash, 'hex');
  const root = Buffer.from(rep.anchorRootChainAnchor, 'hex');
  if (!equal(entry, tx)) throw new VerifyError(`proof v2 binding: G0 proves entry ${toHex(entry)}, the report transaction ${rep.txHash}`);
  if (!equal(start, entry)) throw new VerifyError(`proof v2 binding: G0's receipt starts at ${toHex(start)}, not at its entry ${toHex(entry)}`);
  if (!equal(witness, root)) {
    throw new VerifyError(`proof v2 binding: G0's witness ${toHex(witness)} is not the root ${rep.anchorRootChainAnchor} of the partition anchor the report's receipt passes through`);
  }
  if (g0.execMBI <= 0 || g0.execMBI !== rep.anchorBlock) throw new VerifyError(`proof v2 binding: G0's execution block ${g0.execMBI} is not the partition anchor's block ${rep.anchorBlock}`);
}

/**
 * BindProofV2 requires the governance levels and the certified key page to be about exactly what the proof v2 report of evidence 2.0 proved: G0's
 * execution entry, witness and block are the report's, the key page G1 validated against is the certified key page, and it is one of the pages
 * the report proved. A report of evidence 2.1 is bound by BindProofV21 only.
 */
export function bindProofV2(rep: Report21, g0: G0Result, g1: G1Result, keyPageURL: string): void {
  if (rep.proven.length > 0) {
    throw new VerifyError(`proof v2 binding: the report is evidence 2.1 (${rep.proven.length} proven pages with partitions, blocks and roles); it is bound by BindProofV21 with the intent's governing facts, never by this rule`);
  }
  bindG0(rep, g0);
  const page = canon(keyPageURL);
  if (page === '' || page !== canon(g1.authoritySnapshotPage)) {
    throw new VerifyError(`proof v2 binding: the certified key page ${JSON.stringify(keyPageURL)} is not the page G1 validated against (${JSON.stringify(g1.authoritySnapshotPage)})`);
  }
  for (const a of rep.pages) {
    let u: string | undefined;
    try {
      u = canon(accountUrl(a.account).toString());
    } catch {
      u = undefined;
    }
    if (u === page) return;
  }
  throw new VerifyError(`proof v2 binding: the certified key page ${page} is not among the pages the report proved`);
}

class Binder {
  readonly pages = new Map<string, ProvenView>();
  constructor(
    readonly rep: Report21,
    readonly facts: GoverningFacts,
  ) {}

  /** index builds the proven-page table, requiring rep.proven to describe exactly rep.pages, each page once, with a partition, a block and known roles. */
  index(): void {
    const rep = this.rep;
    if (rep.proven.length === 0 || rep.proven.length !== rep.pages.length) {
      throw ns(State.CompletenessUnproven, '', 0, `the report proves ${rep.pages.length} pages and lists ${rep.proven.length} proven (partition, block, roles) records: evidence 2.1 lists every page`);
    }
    rep.pages.forEach((pg, i) => {
      const pp = { ...rep.proven[i]! };
      const u = canon(accountUrl(pg.account).toString());
      if (canon(pp.url) !== u) throw ns(State.PageBlockMismatch, pp.partition, pp.block, `proven page ${i} is ${pp.url}, the report's page is ${u}`);
      if (this.pages.has(u)) throw new VerifyError(`proof v2 binding: page ${u} is proven twice`);
      if (pp.partition.trim() === '') throw ns(State.ForeignPartitionMismatch, '', pp.block, `${u} is proven with no partition`);
      if (pp.block === 0) throw ns(State.PageBlockMismatch, pp.partition, 0, `${u} is proven with no block`);
      try {
        pp.roles = canonicalRoles(pp.roles);
      } catch (e) {
        throw new VerifyError(`proof v2 binding: ${u}: ${(e as Error).message}`);
      }
      this.pages.set(u, { acct: pg.account, proof: pp });
    });
  }

  /** executorVersions derives g1_executor_version_unsupported from the pinned activation table for every (partition, block) judged at. */
  executorVersions(): void {
  const seen = new Set<string>();
    const check = (partition: string, block: number, what: string): void => {
      const key = `${normalizeExecutorPartition(partition)}|${block}`;
      if (seen.has(key)) return;
      seen.add(key);
      const floor = executorFloorAt(partition, block);
      if (floor === undefined) {
        throw ns(State.ExecutorVersionUnsupported, partition, block, `${what}: the executor version governing block ${block} of ${partition} is not established by the pinned activation table (an unknown partition, or a block at or before its activation)`);
      }
      if (!baikonurEnabled(floor)) {
        throw ns(State.ExecutorVersionUnsupported, partition, block, `${what}: the pinned table proves executor version ${floor} on ${partition}, before Baikonur (6)`);
      }
    };
    check(this.rep.partition, this.rep.anchorBlock, 'the transaction');
    const keys = [...this.pages.keys()].sort(goStringCompare);
    for (const u of keys) {
      const p = this.pages.get(u)!;
      check(p.proof.partition, p.proof.block, u);
      if (p.acct.cls === 'SystemLedger') {
        const floor = executorFloorAt(p.proof.partition, p.proof.block)!;
        const v = bigOf(p.acct, 'executorVersion');
        if (v < BigInt(floor)) {
          throw ns(State.ExecutorVersionUnsupported, p.proof.partition, p.proof.block, `${u} proves executor version ${v} at block ${p.proof.block} of ${p.proof.partition}, the pinned table proves at least ${floor}: the ledger page disagrees with the pinned table`);
        }
      }
    }
  }

  /**
   * certifiedPage justifies the role the verifier can only declare. The certified key page (G1's page) must be proven, recorded as
   * certified-key-page, a page of the book the certificate declares, and a page of the governing set: it proves at least one other role.
   */
  certifiedPage(page: string, keyBookURL: string): void {
    const p = this.pages.get(page);
    if (!p) throw ns(State.CertifiedPageUnproven, '', 0, `the certified key page ${page} is not among the pages the report proved`);
    if (!has(p, Role.CertifiedKeyPage) && !declared(p, Role.CertifiedKeyPage)) {
      throw ns(State.CertifiedPageUnproven, p.proof.partition, p.proof.block, `the certified key page ${page} is proven (roles [${p.proof.roles.join(' ')}], declared [${p.proof.declared.join(' ')}]) but not recorded as ${Role.CertifiedKeyPage}`);
    }
    const book = canon(keyBookURL);
    if (book === '') throw ns(State.CertifiedPageUnproven, p.proof.partition, p.proof.block, `the certificate declares no key book for the certified key page ${page}`);
    let own: string;
    switch (p.acct.cls) {
      case 'KeyPage': {
        const pu = AccUrl.parse(page);
        if (!pu) throw new VerifyError(`proof v2 binding: the certified key page ${JSON.stringify(page)}: not a URL`);
        const [parent, ok] = pu.parent();
        if (!ok) throw ns(State.CertifiedPageUnproven, p.proof.partition, p.proof.block, `the certified key page ${page} has no book`);
        own = canon(parent.toString());
        break;
      }
      case 'LiteIdentity':
        own = page; // a lite identity is its own book and page
        break;
      default:
        throw ns(State.CertifiedPageUnproven, p.proof.partition, p.proof.block, `the certified key page ${page} is ${p.acct.cls}, not a key page`);
    }
    if (own !== book) throw ns(State.CertifiedPageUnproven, p.proof.partition, p.proof.block, `the certified key page ${page} is a page of ${own}, the certificate declares the book ${book}`);
    for (const r of p.proof.roles) if (r !== Role.CertifiedKeyPage) return;
    throw ns(State.CertifiedPageUnproven, p.proof.partition, p.proof.block, `the certified key page ${page} proves no role of the governing set (roles [${p.proof.roles.join(' ')}]): it is not a page the intent depends on`);
  }

  /** checkBlocks: a page on the transaction's partition is proven at the report's anchor block. */
  checkBlocks(): void {
    for (const [u, p] of this.pages) {
      if (samePartition(p.proof.partition, this.rep.partition) && p.proof.block !== this.rep.anchorBlock) {
        throw ns(State.PageBlockMismatch, p.proof.partition, p.proof.block, `${u} is on the transaction's partition and must be proven at its anchor block ${this.rep.anchorBlock}`);
      }
    }
  }

  needRole(u: string, role: PageRole, code: string, what: string): void {
    u = canon(u);
    const p = this.pages.get(u);
    if (!p) throw ns(code, '', 0, `${what} ${u} is not among the pages the report proved`);
    if (!has(p, role)) throw ns(code, p.proof.partition, p.proof.block, `${what} ${u} ${missing(p, role)}`);
  }

  /** principalChain walks the principal's authority set over the proven states as the executor resolves it. */
  principalChain(): { url: string; disabled: boolean }[] {
    let cur = AccUrl.parse(this.facts.principal);
    if (!cur) throw new VerifyError(`proof v2 binding: the principal ${JSON.stringify(this.facts.principal)}: not a URL`);
    for (;;) {
      const u = canon(cur.toString());
      const p = this.pages.get(u);
      if (!p) throw ns(State.CompletenessUnproven, '', 0, `principal chain: ${u} is not among the pages the report proved`);
      if (!has(p, Role.PrincipalChain)) throw ns(State.CompletenessUnproven, p.proof.partition, p.proof.block, `principal chain: ${u} is proven (roles [${p.proof.roles.join(' ')}]) but not as principal-chain`);
      if (!samePartition(p.proof.partition, this.rep.partition)) {
        throw ns(State.ForeignPartitionMismatch, p.proof.partition, p.proof.block, `the principal chain account ${u} is proven on ${p.proof.partition}, the transaction executed on ${this.rep.partition}`);
      }
      const a = p.acct;
      if (a.cls === 'LiteIdentity') return [{ url: canon(accountUrl(a).toString()), disabled: false }];
      if (a.cls === 'LiteTokenAccount') {
        const d = liteDelegate(a);
        if (d) return [{ url: canon(d.toString()), disabled: false }];
        return [{ url: canon(accountUrl(a).rootIdentity().toString()), disabled: false }];
      }
      if (a.cls === 'LiteDataAccount') return [];
      if (isFullAccount(a)) {
        const auth = authoritiesOf(a);
        if (auth.length > 0) return auth.map((e) => ({ url: canon(e.url.toString()), disabled: e.disabled }));
        const [parent, ok] = cur.parent();
        if (!ok) throw ns(State.CompletenessUnproven, p.proof.partition, p.proof.block, `root identity ${u} lists no authority: its governing set cannot be derived`);
        cur = parent;
        continue;
      }
      throw new VerifyError(`proof v2 binding: the principal chain account ${u} is ${a.cls}, which is not governed by key books`);
    }
  }

  /** books requires every authority, header and outside-voter book and then, breadth first, every delegate book. */
  books(derived: { url: string; disabled: boolean }[]): void {
    const f = this.facts;
    // The union of the set the intent was judged against and the set the proven principal chain resolves to: both are required.
    const listed = new Set<string>();
    const auths: { url: string; disabled: boolean }[] = [];
    let allDisabled = !requireAuthorization(f.type);
    for (const a of [...f.authorities, ...derived]) {
      const u = canon(a.url);
      if (!a.disabled) allDisabled = false;
      if (listed.has(u)) continue;
      listed.add(u);
      auths.push({ url: u, disabled: a.disabled });
    }
    const named = new Set<string>(f.headerAuthorities.map(canon));
    const visited = new Set<string>();
    const queue: { book: string; level: number }[] = [];
    const expand = (u: string, level: number, bookRole: PageRole, pageRole: PageRole, miss: string): void => {
      const edges = this.book(u, level, bookRole, pageRole, miss);
      visited.add(u);
      queue.push(...edges);
    };
    for (const a of auths) expand(a.url, 0, Role.AuthorityBook, Role.AuthorityPage, State.AuthorityMissing);
    for (const h of f.headerAuthorities) expand(canon(h), 0, Role.HeaderAuthority, Role.HeaderAuthority, State.HeaderAuthorityMissing);
    // When every listed authority is disabled the executor accepts any authority's single vote: that voter's whole book is the authority
    // that decided, and it is proven.
    if (allDisabled) {
      for (const v of f.votes) {
        const a = canon(v.authority);
        if (listed.has(a) || named.has(a)) continue;
        expand(a, 0, Role.Voter, Role.Voter, State.AuthorityMissing);
      }
    }
    while (queue.length > 0) {
      const e = queue.shift()!;
      if (visited.has(e.book)) continue;
      // No executed signature can have passed through a book this deep: it is not required.
      if (e.level > DELEGATION_DEPTH_LIMIT) continue;
      const edges = this.book(e.book, e.level, Role.DelegateBook, Role.DelegatePage, State.DelegateEntryAbsent);
      visited.add(e.book);
      queue.push(...edges);
    }
  }

  /** book requires book u with bookRole and each of its pages with pageRole, and returns the delegation edges of its pages, one level further down. */
  book(u: string, level: number, bookRole: PageRole, pageRole: PageRole, miss: string): { book: string; level: number }[] {
    const p = this.pages.get(u);
    if (!p) throw ns(miss, '', 0, `the book ${u} (delegation level ${level}) is not among the pages the report proved`);
    if (!has(p, bookRole)) throw ns(miss, p.proof.partition, p.proof.block, `the book ${u} ${missing(p, bookRole)}`);
    switch (p.acct.cls) {
      case 'LiteIdentity':
        if (!has(p, pageRole)) throw ns(miss, p.proof.partition, p.proof.block, `${u} is its own page and ${missing(p, pageRole)}`);
        return [];
      case 'KeyBook': {
        // A header authority's or a delegate's missing page is that class's state; an authority's is the book's page count.
        const pageCode = miss !== State.AuthorityMissing ? miss : State.BookPageCountUnproven;
        const edges: { book: string; level: number }[] = [];
        const count = bigOf(p.acct, 'pageCount');
        const bookUrl = accountUrl(p.acct);
        for (let i = 0n; i < count; i++) {
          const pu = canon(formatKeyPageUrl(bookUrl, i).toString());
          const pg = this.pages.get(pu);
          if (!pg) throw ns(pageCode, p.proof.partition, p.proof.block, `page ${i + 1n} of ${count} of ${u} (${pu}) is not among the pages the report proved`);
          if (!has(pg, pageRole)) throw ns(pageCode, pg.proof.partition, pg.proof.block, `${pu} ${missing(pg, pageRole)}`);
          if (pg.acct.cls !== 'KeyPage') throw new VerifyError(`proof v2 binding: ${pu} is ${pg.acct.cls}, not a key page`);
          const kp = KeyPage.from(pg.acct);
          for (const ks of kp.keys) if (ks.delegate) edges.push({ book: canon(ks.delegate.toString()), level: level + 1 });
        }
        return edges;
      }
      default:
        throw new VerifyError(`proof v2 binding: ${u} is ${p.acct.cls}, not a key book`);
    }
  }

  /** voters requires the page behind every recorded vote and delegated arrival, and the blocks of the recorded votes. */
  voters(): void {
    const f = this.facts;
    for (const v of f.votes) {
      // A vote whose origin is its authority was decided by no page (the abstain of a missing authority): there is no page.
      if (v.origin !== '' && v.origin !== v.authority) this.needRole(v.origin, Role.Voter, State.CompletenessUnproven, 'the voter page');
      if (v.block > 0 && v.block > this.rep.anchorBlock) {
        throw ns(State.BlockBeforeArrival, this.rep.partition, this.rep.anchorBlock, `the vote of ${v.authority} was recorded in block ${v.block}, after the anchor block ${this.rep.anchorBlock} the principal is proven at`);
      }
    }
    for (const a of f.arrivals) {
      for (const p of [a.page, a.origin, ...a.path]) this.needRole(p, Role.Voter, State.CompletenessUnproven, 'the voter page of a delegated vote');
    }
  }

  /** arrivalBlocks requires, on each page's own partition, the block it is proven at not to precede a counted signature or delegated arrival it received. */
  arrivalBlocks(): void {
    const check = (page: string, block: number, what: string): void => {
      const p = this.pages.get(canon(page));
      if (!p || block <= 0) return;
      if (p.proof.block < block) {
        throw ns(State.BlockBeforeArrival, p.proof.partition, p.proof.block, `${what} arrived on ${page} in block ${block}, after the block ${p.proof.block} the page is proven at`);
      }
    };
    for (const s of this.facts.signatures) check(s.signer, s.block, 'a signature');
    for (const a of this.facts.arrivals) check(a.page, a.block, 'a delegated vote');
  }
}

/**
 * BindProofV21 is BindProofV2 for a report of evidence 2.1: the G0/G1 binding of BindProofV2, a report with nothing unproven, the
 * certified key page justified against the certificate's declared book, and every page of the governing set of D1(a)-(f) required among
 * the report's proven pages (each at its own partition and block) with its recorded role. Each missing class is refused by the named
 * state of crosspartition.go.
 */
export function bindProofV21(rep: Report21, g0: G0Result, g1: G1Result, keyPageURL: string, keyBookURL: string, facts: GoverningFacts): void {
  // A report that names anything it could not establish is not a verified S3: its own first named state is the refusal.
  if (rep.unproven.length > 0) {
    const first = rep.unproven[0]!;
    throw new NamedState(first.code, first.partition, first.block, first.detail);
  }
  // A disclosure is a verified fact, not a refusal, except one: a sequenced vote whose production does not carry the SequencedMessage is
  // not bound to the vote's message, so its arrival block is not established.
  for (const d of rep.disclosures) {
    if (d.code === State.VoteProductionUnbound) throw new NamedState(d.code, d.partition, d.block, d.detail);
  }
  bindG0(rep, g0);
  if (!equal(facts.txHash, Buffer.from(rep.txHash, 'hex'))) {
    throw ns(State.TransactionMismatch, rep.partition, rep.anchorBlock, `the governing facts are read from a transaction hashing to ${toHex(facts.txHash.subarray(0, 8))}, the report proved ${rep.txHash.slice(0, 16)}`);
  }
  const page = canon(keyPageURL);
  if (page === '' || page !== canon(g1.authoritySnapshotPage)) {
    throw new VerifyError(`proof v2 binding: the certified key page ${JSON.stringify(keyPageURL)} is not the page G1 validated against (${JSON.stringify(g1.authoritySnapshotPage)})`);
  }
  const b = new Binder(rep, facts);
  b.index();
  b.executorVersions();
  b.certifiedPage(page, keyBookURL);
  b.checkBlocks();
  const authorities = b.principalChain();
  b.books(authorities);
  b.voters();
  for (const p of facts.initiators) b.needRole(p, Role.InitiatorSigner, State.InitiatorPageUnproven, 'the initiating page');
  for (const p of facts.initiatorPath) b.needRole(p, Role.InitiatorSigner, State.InitiatorPageUnproven, 'a delegator of the initiating signature');
  b.arrivalBlocks();
}

