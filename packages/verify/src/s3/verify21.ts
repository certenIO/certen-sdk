/**
 * Verifying evidence 2.1 (validator xverify.go; docs/proof/G1_CROSS_PARTITION.md D1, D2, D2a, D4, D5, D6).
 *
 * A governing page can live on a partition other than the transaction's. Each such page is proven at ITS partition's block B_Y: its
 * receipt must end at the StateTreeAnchor of that partition's anchor, and the anchor, a transaction the Directory executed, is proven into
 * the same certified Directory root as the transaction. Nothing a document says about where a page lives is trusted: the partition is
 * DERIVED from the anchor message's Source, the derived partition is checked against the network's routing table (proven into the
 * certified state tree root), and the roles that say why each page is among the proven pages are re-derived from the proven states and
 * compared.
 */
import { equal, receiptValid, sha256, toHex, VerifyError } from '../proof-v2/bytes.js';
import { AccUrl, DELEGATION_DEPTH_LIMIT, formatKeyPageUrl, goEqualFold, goLower, goStringCompare } from './acc.js';
import { decodeAnchor21, partitionOfAnchor } from './directory.js';
import type { Evidence, PageState, PartitionAnchorX } from './evidence.js';
import {
  checkExecutorVersion,
  isOwnLedger,
  refuseExecutorOverride,
  refuseUpdateAccountAuthInherited,
  type XAnchor,
} from './executor.js';
import { goHex } from './gojson.js';
import {
  accountUrl,
  authoritiesOf,
  bodyType,
  decodeAccount,
  delegatorPages,
  isFullAccount,
  nodesOf,
  requireAuthorization,
  urlOf,
  KeyPage,
  type WireNode,
} from './model.js';
import { allHops, carriedTransaction, headerAuthorityURLs, initiatorPages } from './roles.js';
import { decodeSigHex } from './sig.js';
import { canonicalRoles, DOMAIN_G1_V4, KNOWN_ROLES, refusal21, Role, State, stateEntry, VERSION_21, type PageRole } from './states.js';
import { boundChain, deriveArrival, evaluateTimeline, foldTimelines, inChain, normURL, timelineEngaged, verifyProductions, type TimelineStates } from './timeline.js';
import type { ProvenAcct, Report21, XIn } from './xtypes.js';
import { checkEvidenceBudget } from './budget.js';
import { routePartition } from './routing.js';
import { verifyRoutingProof, type RoutingTable } from './setcheck.js';
import { pageChains, type PageChainX } from './chains.js';
import { normalizeAccURL } from './govvote.js';
import type { Rec } from '../proof-v2/shapes.js';

const lk = (u: AccUrl): string => u.key;

/** The roles whose justification can be a fact outside the evidence (declaredRoles). */
const DECLARED_ROLES: ReadonlySet<PageRole> = new Set<PageRole>([Role.HeaderAuthority, Role.InitiatorSigner, Role.CertifiedKeyPage]);

/** verifyAnchor21 checks one partition anchor of the Anchors map: of either kind, proven into the certified root. key is the claimed partition. */
export function verifyAnchor21(key: string, a: PartitionAnchorX, certRoot: Uint8Array): XAnchor {
  let pa;
  try {
    pa = decodeAnchor21(a.message);
  } catch (e) {
    throw new VerifyError(`anchors[${key}]: ${(e as Error).message}`);
  }
  const id = partitionOfAnchor(pa);
  const derived = pa.body.source!.toString();
  const block = pa.body.minorBlockIndex;
  if (!goEqualFold(key, derived)) throw refusal21(State.ForeignPartitionMismatch, id, block, `url anchors[${key}]: claimed ${key}, derived ${derived}`);
  const r = a.receipt;
  if (pa.tx.length !== 32 || !equal(r.start, pa.tx) || !equal(r.anchor, certRoot) || !receiptValid(r)) {
    throw refusal21(State.PartitionAnchorUnavailable, id, block, 'the receipt does not prove the anchor transaction into the certified Directory root');
  }
  return { source: derived, id, block, stateRoot: new Uint8Array(pa.body.stateTreeAnchor) };
}

/** verifyPage checks one page against the block's state root and returns the account as proven, and what is proven about its chains. */
function verifyPage(p: PageState, stateRoot: Uint8Array): { acct: WireNode; pc: PageChainX } {
  const r = p.receipt;
  if (!equal(r.start, sha256(p.state))) throw new VerifyError(`${p.url}: the receipt does not start at the state's hash`);
  if (!equal(r.anchor, stateRoot)) throw new VerifyError(`${p.url}: the receipt ends at ${toHex(r.anchor)}, not the block's state root ${toHex(stateRoot)}`);
  if (!receiptValid(r)) throw new VerifyError(`${p.url}: the receipt does not validate`);
  let acct: WireNode;
  try {
    acct = decodeAccount(p.state);
  } catch (e) {
    throw new VerifyError(`${p.url}: ${(e as Error).message}`);
  }
  if (!goEqualFold(accountUrl(acct).toString(), p.url)) throw new VerifyError(`the proven state is ${accountUrl(acct)}, not ${p.url}`);
  const pc = pageChains(p.url, p.chains, p.pendingHash, p.chainError, r);
  return { acct, pc };
}

/** The state of the principal's authority set: derived roles of each page (derivedRoles). */
interface DerivedRoles {
  want: Map<string, Set<PageRole>>;
  /** The evidence carries the transaction: header-authority is derived, not declared. */
  header: boolean;
  /** The evidence carries the initiating signature: initiator-signer is derived, not declared. */
  initiator: boolean;
}

const provesRole = (d: DerivedRoles, r: PageRole): boolean => (r === Role.HeaderAuthority ? d.header : r === Role.InitiatorSigner ? d.initiator : false);

/**
 * verify21 verifies the 2.1 members of ev. rep already holds the transaction, the spine and the transaction's partition anchor.
 */
export function verify21(ev: Evidence, rep: Report21, inn: XIn): void {
  rep.version = ev.version;
  rep.tag = DOMAIN_G1_V4;
  const x = inn.x;
  if (ev.pages.length === 0) throw refusal21(State.CompletenessUnproven, x.id, x.block, 'evidence 2.1 carries no page');
  // The evidence travels in one consensus transaction: a closure over the budget is a named state.
  checkEvidenceBudget(ev, x);
  // A transaction whose executor replaces the default authorization rule is not judged by it. A carried transaction that does not decode or
  // does not match is refused by its own name later.
  let ctxn: WireNode | undefined;
  let cerr = false;
  try {
    ctxn = carriedTransaction(ev, x);
  } catch {
    cerr = true;
  }
  if (!cerr && ctxn) refuseExecutorOverride(ctxn, x);

  // 1. Anchors: the transaction's own, and one per other partition, each proven into the certified root; the partition of each is derived
  // from the message.
  const anchors = new Map<string, XAnchor>([[x.source.toLowerCase(), x]]);
  // Go ranges over the map of anchors in random order, so which of several defective anchors it names first changes from run to run. The
  // order here is the keys' (bytewise), the same on every validator and every run: a document with two defective anchors is refused either
  // way, and the state named is the first in that order.
  const byKey = [...(ev.anchors ?? [])].sort(([p], [q]) => goStringCompare(p, q));
  for (const [k, a] of byKey) {
    if (goEqualFold(k, x.source)) {
      if (!equal(a.message.bin, ev.anchor.message.bin) || !equal(a.receipt.bin, ev.anchor.receipt.bin)) {
        throw refusal21(State.ForeignPartitionMismatch, x.id, x.block, `url anchors[${k}]: the entry for the transaction's partition differs from its anchor`);
      }
      continue;
    }
    const xa = verifyAnchor21(k, a, inn.certRoot);
    if (anchors.has(xa.source.toLowerCase())) throw refusal21(State.ForeignPartitionMismatch, xa.id, xa.block, `url anchors[${k}]: two anchors for one partition`);
    anchors.set(xa.source.toLowerCase(), xa);
  }

  // 2. The routing table, proven into the certified state tree root the set check is bound to.
  let table: RoutingTable | undefined;
  let routingHeight = 0;
  if (!ev.check.routing) {
    rep.unproven.push(stateEntry(State.RoutingUnproven, x.id, x.block, 'the evidence carries no routing proof: Partition == route(URL) is unchecked'));
  } else {
    let v;
    try {
      v = verifyRoutingProof(ev.check.routing, inn.setRoot);
    } catch (e) {
      throw new VerifyError(`set check: routing: ${(e as Error).message}`);
    }
    table = v.table;
    routingHeight = v.height;
    rep.routingHeight = v.height;
    if (v.height !== 1) {
      rep.unproven.push(
        stateEntry(State.RoutingHistoryUnproven, x.id, x.block, `the routing table was rewritten after genesis (main chain height ${v.height}): what it was at each partition block is not proven`),
      );
    }
  }

  // 3. Every page against ITS partition's state root, chains bound there, partition derived and routed.
  const byURL = new Map<string, ProvenAcct>();
  ev.pages.forEach((p, i) => {
    const claimed = p.partition;
    const xa = anchors.get(claimed.toLowerCase());
    if (!xa) {
      if (claimed === '') throw refusal21(State.ForeignPartitionMismatch, x.id, x.block, `url ${p.url}: claimed none, derived ${x.source}`);
      throw refusal21(State.PartitionAnchorUnavailable, claimed, 0, `${p.url} claims a partition the evidence holds no anchor for`);
    }
    if (claimed !== xa.source) throw refusal21(State.ForeignPartitionMismatch, xa.id, xa.block, `url ${p.url}: claimed ${claimed}, derived ${xa.source}`);
    let acct: WireNode;
    let pc: PageChainX;
    try {
      ({ acct, pc } = verifyPage(p, xa.stateRoot));
    } catch (e) {
      if (!equal(p.receipt.anchor, xa.stateRoot)) {
        throw refusal21(State.PageBlockMismatch, xa.id, xa.block, `${p.url}: ${(e as Error).message}`);
      }
      throw new VerifyError(`page: ${(e as Error).message}`);
    }
    const own = isOwnLedger(acct, xa); // a partition's own system ledger is addressed by its partition, not routed by the table
    const url = accountUrl(acct);
    if (table && !own) {
      let routed: string;
      try {
        routed = routePartition(table, url.toString());
      } catch (e) {
        throw new VerifyError(`page ${p.url}: ${(e as Error).message}`);
      }
      if (!goEqualFold(routed, xa.id)) {
        if (routingHeight === 1) {
          throw refusal21(State.RoutingMismatch, xa.id, xa.block, `url ${p.url}: the routing table sends it to ${routed}, its anchor names ${xa.id}`);
        }
      }
    }
    if (byURL.has(lk(url))) throw new VerifyError(`page ${p.url} is proven twice`);
    byURL.set(lk(url), { i, acct, url, anchor: xa, chain: pc, page: p });
    rep.pages.push({ account: acct, state: p.state });
    rep.pageChains.push(pc);
  });

  // The principal was read after the transaction executed; an UpdateAccountAuth that gave an account its first authorities cannot be
  // judged against the set the executor required.
  let ctxn2: WireNode | undefined;
  try {
    ctxn2 = carriedTransaction(ev, x);
  } catch {
    ctxn2 = undefined;
  }
  if (ctxn2) {
    const pu = AccUrl.parse(ev.account);
    if (pu) {
      const pa = byURL.get(lk(pu));
      if (pa && isFullAccount(pa.acct)) refuseUpdateAccountAuthInherited(ctxn2, authoritiesOf(pa.acct), x);
    }
  }

  // 4. The governing set, re-derived from the proven states - and from every state a page with a certified history passed through, so a
  // delegate entry removed after a counted signature arrived still puts its book in the set; the recorded roles must equal it.
  checkExecutorVersion(byURL);
  const tl = foldTimelines(ev, byURL);
  const derived = deriveRoles(ev, byURL, anchors, tl, x, inn.network);
  const initiatorNotCarried: string[] = [];
  ev.pages.forEach((p, i) => {
    const acct = rep.pages[i]!.account;
    const pa = byURL.get(lk(accountUrl(acct)))!;
    const recorded = new Set<string>();
    for (const r of p.roles ?? []) {
      try {
        canonicalRoles([r]);
      } catch (e) {
        throw refusal21(State.RoleMismatch, pa.anchor.id, pa.anchor.block, `url ${p.url}: ${(e as Error).message}`);
      }
      recorded.add(r);
    }
    if (recorded.size === 0) throw refusal21(State.RoleMismatch, pa.anchor.id, pa.anchor.block, `url ${p.url}: the page records no role`);
    const want = derived.want.get(lk(accountUrl(acct))) ?? new Set<PageRole>();
    const roles: PageRole[] = [];
    const declared: PageRole[] = [];
    for (const r of KNOWN_ROLES) {
      if (DECLARED_ROLES.has(r) && !provesRole(derived, r)) {
        if (recorded.has(r)) {
          declared.push(r);
          if (r === Role.InitiatorSigner) initiatorNotCarried.push(p.url);
        }
      } else if (recorded.has(r) && !want.has(r)) {
        throw refusal21(State.RoleMismatch, pa.anchor.id, pa.anchor.block, `url ${p.url}: role ${r} is claimed but the proven states do not justify it`);
      } else if (!recorded.has(r) && want.has(r)) {
        throw refusal21(State.RoleMismatch, pa.anchor.id, pa.anchor.block, `url ${p.url}: role ${r} is justified by the proven states but not recorded`);
      } else if (recorded.has(r)) roles.push(r);
    }
    if (roles.length === 0 && declared.length === 0) throw refusal21(State.RoleMismatch, pa.anchor.id, pa.anchor.block, `url ${p.url}: no recorded role is justified`);
    rep.proven.push({ url: p.url, partition: pa.anchor.source, block: pa.anchor.block, roles, declared });
  });
  if (initiatorNotCarried.length > 0 && ev.transaction !== '') {
    rep.unproven.push(
      stateEntry(
        State.InitiatorSignatureNotCarried,
        x.id,
        x.block,
        `${initiatorNotCarried.join(', ')} records the role initiator-signer but the evidence carries no signature that initiated the transaction: the role is a recorded fact, listed as declared`,
      ),
    );
  }

  // 5. The counted signatures are members of their pages' signature chains at their pages' own B_Y.
  verifyVoteMembership(ev, inn, byURL, anchors);

  // 6. The certified timeline: every carried history was folded to its proven chain root and replayed (step 4 above); when the evidence
  // carries all the votes need, each counted signature's arrival is derived and the vote model run on it.
  const { engaged, why } = timelineEngaged(ev, tl);
  if (!engaged) {
    let detail = 'the votes are not re-evaluated (readiness, thresholds, per-arrival page states): this report proves the pages, not that the transaction was authorized';
    if (tl.size > 0 || ev.transaction !== '') detail += `; the timeline is not complete: ${why}`;
    rep.unproven.push(stateEntry(State.CompletenessUnproven, x.id, x.block, detail));
    return;
  }
  const auths = principalAuthorities(ev, byURL);
  const ti = { ev, rep, x: inn, byURL, auths, anchor: anchors };
  evaluateTimeline(ti, tl);
  verifyProductions(ti);
}

/**
 * deriveRoles re-derives, from the proven accounts alone, why each page must be among the proven pages (D1(a), (b), (d), (e)), and
 * requires every page it needs to be present: every page 1..PageCount of every book, every account on the principal's inheritance chain,
 * every delegate book to the depth limit, every page a counted vote names.
 */
function deriveRoles(ev: Evidence, byURL: Map<string, ProvenAcct>, anchors: Map<string, XAnchor>, tl: TimelineStates, x: XAnchor, network: string): DerivedRoles {
  void anchors;
  const out = new Map<string, Set<PageRole>>();
  const dr: DerivedRoles = { want: out, header: false, initiator: false };
  // The transaction the evidence carries derives header-authority (and, with the initiating signature, initiator-signer).
  const txn = carriedTransaction(ev, x);
  const headerSet = new Set<string>();
  let headerURLs: AccUrl[] = [];
  if (txn) {
    headerURLs = headerAuthorityURLs(txn);
    dr.header = true;
    for (const h of headerURLs) {
      if (!byURL.has(lk(h))) throw refusal21(State.HeaderAuthorityMissing, x.id, x.block, `the transaction requires the authority ${h}, which has no proven pages`);
      headerSet.add(lk(h));
    }
  }
  const add = (u: AccUrl, r: PageRole): void => {
    let s = out.get(lk(u));
    if (!s) {
      s = new Set();
      out.set(lk(u), s);
    }
    s.add(r);
  };
  const get = (u: AccUrl, why: string): ProvenAcct => {
    const pa = byURL.get(lk(u));
    if (!pa) throw refusal21(State.CompletenessUnproven, '', 0, `${u} is ${why} but is not among the proven pages`);
    return pa;
  };

  // (a) The principal and the accounts its authority set is inherited through.
  const auths = principalAuthorities(ev, byURL, (u) => add(u, Role.PrincipalChain));

  // (b), (c), (d) The books at level 0: every listed authority (enabled or not), every book a page declares as a header authority, and -
  // when every listed authority is disabled - the authority of each counted vote.
  const roots = new Map<string, { book: PageRole; page: PageRole }>();
  const order: AccUrl[] = [];
  const addRoot = (u: AccUrl, b: PageRole, p: PageRole): void => {
    if (!roots.has(lk(u))) order.push(u);
    roots.set(lk(u), { book: b, page: p });
  };
  let allDisabled = true;
  const listed = new Set<string>();
  for (const a of auths) {
    listed.add(lk(a.url));
    if (!a.disabled) allDisabled = false;
    addRoot(a.url, Role.AuthorityBook, Role.AuthorityPage);
  }
  // The all-authorities-disabled rule (the executor accepts any authority's vote then) is not the rule of a transaction type that requires
  // authorization (UpdateAccountAuth); evaluateTimeline applies the same carve-out, so the pages a document needs are derived by the rule that
  // judges its votes: the authority of a vote outside the list is not a root there (RB9-K-F1, a vector of xpartition6). Without the transaction
  // its type is not known and the rule stands.
  if (txn && requireAuthorization(bodyType(txn))) allDisabled = false;
  // The books the carried transaction names are roots whether or not they are listed authorities (their header-authority role is added when
  // each is expanded). Without a transaction the role is only a recorded fact and the books the pages record are expanded.
  for (const h of headerURLs) if (!roots.has(lk(h))) addRoot(h, Role.HeaderAuthority, Role.HeaderAuthority);
  if (!txn) {
    for (const p of ev.pages) {
      for (const r of p.roles ?? []) {
        if (r === Role.HeaderAuthority) {
          const u = AccUrl.parse(p.url);
          if (u && byURL.get(lk(u))!.acct.cls === 'KeyBook' && !roots.has(lk(u))) addRoot(u, Role.HeaderAuthority, Role.HeaderAuthority);
        }
      }
    }
  }
  for (const v of ev.votes) {
    const a = AccUrl.parse(v.authority);
    if (!a) throw new VerifyError(`vote authority ${JSON.stringify(v.authority)}: not a URL`);
    if (!listed.has(lk(a)) && allDisabled && !roots.has(lk(a))) addRoot(a, Role.Voter, Role.Voter);
  }

  // Expand each book with every page 1..PageCount; follow the delegate entries breadth first, a book by its shortest path; the Delegate
  // entries of a page in a book at level 20 are not followed (a signature passes through at most 20 delegators).
  const queue: { u: AccUrl; level: number }[] = [];
  const expanded = new Set<string>();
  const expand = (u: AccUrl, level: number, bookRole: PageRole, pageRole: PageRole): void => {
    const pa = get(u, 'a key book of the governing set');
    expanded.add(lk(u));
    const pages: AccUrl[] = [];
    switch (pa.acct.cls) {
      case 'LiteIdentity':
        add(u, bookRole);
        add(u, pageRole);
        if (headerSet.has(lk(u))) add(u, Role.HeaderAuthority);
        return;
      case 'KeyBook': {
        add(u, bookRole);
        if (headerSet.has(lk(u))) add(u, Role.HeaderAuthority);
        const count = pa.acct.fields.get('pageCount');
        const n = typeof count === 'bigint' ? count : 0n;
        for (let i = 0n; i < n; i++) pages.push(formatKeyPageUrl(u, i));
        break;
      }
      default:
        throw new VerifyError(`authority ${u} is ${pa.acct.cls}, not a key book`);
    }
    for (const pu of pages) {
      const pp = byURL.get(lk(pu));
      if (!pp) {
        throw refusal21(State.BookPageCountUnproven, pa.anchor.id, pa.anchor.block, `${u} proves PageCount ${pages.length} but its page ${pu} is not among the proven pages`);
      }
      add(pu, pageRole);
      if (headerSet.has(lk(u))) add(pu, Role.HeaderAuthority);
      if (pp.acct.cls !== 'KeyPage') throw new VerifyError(`${pu} is ${pp.acct.cls}, not a key page`);
      const kp = KeyPage.from(pp.acct);
      for (const ks of kp.keys) if (ks.delegate && level < DELEGATION_DEPTH_LIMIT) queue.push({ u: ks.delegate, level: level + 1 });
      // The delegates the page held at any earlier state of its certified history (the delegation a counted signature went through may be
      // gone by B_Y).
      for (const st of tl.get(normalizeAccURL(pu.toString()))?.states ?? []) {
        for (const ks of st.page.keys) if (ks.delegate && level < DELEGATION_DEPTH_LIMIT) queue.push({ u: ks.delegate, level: level + 1 });
      }
    }
  };
  for (const u of order) {
    const rq = roots.get(lk(u))!;
    expand(u, 0, rq.book, rq.page);
  }
  while (queue.length > 0) {
    const it = queue.shift()!;
    if (expanded.has(lk(it.u))) continue;
    expand(it.u, it.level, Role.DelegateBook, Role.DelegatePage);
  }

  // (d), (f) Every page a counted vote names: its origin page, every page its cause chain passes through, every page in the delegator path
  // of its key signature.
  for (const v of ev.votes) {
    const origin = AccUrl.parse(v.origin);
    if (!origin) throw new VerifyError(`vote origin ${JSON.stringify(v.origin)}: not a URL`);
    if (!goEqualFold(v.origin, v.authority)) {
      get(origin, "named by a counted vote's origin");
      add(origin, Role.Voter);
    }
    for (const h of allHops(v)) {
      const hp = AccUrl.parse(h.page);
      if (!hp) throw new VerifyError(`vote hop page ${JSON.stringify(h.page)}: not a URL`);
      get(hp, "on a counted vote's cause chain");
      add(hp, Role.Voter);
    }
    if (v.produced && !goEqualFold(v.produced.account, ev.account)) {
      const pu = AccUrl.parse(v.produced.account);
      if (!pu) throw new VerifyError(`vote of ${v.authority}: production account ${JSON.stringify(v.produced.account)}: not a URL`);
      get(pu, "named by a counted vote's production proof");
      add(pu, Role.SyntheticChain);
    }
    if ((v.hops?.length ?? 0) > 0) {
      const keySig = v.hops![v.hops!.length - 1]!;
      let sig: WireNode | null;
      try {
        sig = decodeSigHex(keySig.signature);
      } catch (e) {
        throw new VerifyError(`vote of ${v.authority}: key signature: ${(e as Error).message}`);
      }
      const path = sig ? delegatorPages(sig) : [];
      if (path.length > DELEGATION_DEPTH_LIMIT) {
        throw refusal21(State.DelegationDepthExceeded, '', 0, `the vote of ${v.authority} was signed through ${path.length} delegators, the limit is ${DELEGATION_DEPTH_LIMIT}`);
      }
      for (const d of path) {
        get(d, 'in the delegator path of a counted vote');
        add(d, Role.Voter);
      }
    }
  }

  // A partition's system ledger proven at the partition's block carries the executor version in force there.
  for (const pa of byURL.values()) if (isOwnLedger(pa.acct, pa.anchor)) add(accountUrl(pa.acct), Role.SystemLedger);

  // (f) The initiator's pages, from the initiating signature when the evidence carries it.
  if (txn) {
    const { pages, found } = initiatorPages(ev, txn, byURL, network);
    if (found) {
      dr.initiator = true;
      for (const ip of pages) {
        if (!byURL.has(lk(ip))) {
          throw refusal21(State.InitiatorPageUnproven, x.id, x.block, `${ip} initiated the transaction (or is in the path of the signature that did) but is not among the proven pages`);
        }
        add(ip, Role.InitiatorSigner);
      }
    }
  }
  return dr;
}

/** chainAnchor is the bound root of the named chain of a page, when its chains are bound. */
function chainAnchor(pa: ProvenAcct, p: PageState, name: string): Uint8Array {
  if (!pa.chain.bound) {
    let code: string = State.ChainUnboundPending;
    const note = pa.chain.note ?? '';
    const i = note.indexOf(':');
    if (i > 0 && note.startsWith('g1_')) code = note.slice(0, i);
    throw refusal21(code, pa.anchor.id, pa.anchor.block, `${p.url}: its chains are not bound at the block (${note})`);
  }
  const c = boundChain(p, name);
  // The first chain of that name: Go returns the first match with a non-zero count.
  for (const cc of p.chains) {
    if (cc.name === name && cc.count > 0) {
      const b = goHex(cc.anchor);
      if (!b || b.length !== 32) throw new VerifyError(`${p.url}: chain ${name} has no 32-byte root`);
      return b;
    }
  }
  void c;
  throw refusal21(State.BlockBeforeArrival, pa.anchor.id, pa.anchor.block, `${p.url} has no ${name} chain at the block`);
}

/**
 * verifyVoteMembership checks what the vote records can be checked for without re-evaluating the vote. Each vote is a member of the
 * principal's signature chain at the transaction's block, its transport names proven partitions, and every signature on its cause chain is
 * a member of its page's signature chain at that page's own B_Y. A message that is a member of a chain bound at B_Y arrived at or before
 * B_Y, so a document whose B_Y precedes a counted signature's arrival cannot produce the membership: that is g1_block_before_signature.
 */
function verifyVoteMembership(ev: Evidence, inn: XIn, byURL: Map<string, ProvenAcct>, anchors: Map<string, XAnchor>): void {
  if (ev.votes.length === 0) return;
  const x = inn.x;
  const principal = AccUrl.parse(ev.account);
  if (!principal) throw new VerifyError(`evidence account ${JSON.stringify(ev.account)}: not a URL`);
  const pp = byURL.get(lk(principal));
  if (!pp) throw refusal21(State.CompletenessUnproven, x.id, x.block, `the principal ${ev.account} is not among the proven pages`);
  for (const v of ev.votes) {
    switch (v.vote) {
      case 'accept':
      case 'reject':
      case 'abstain':
      case 'suggest':
        break;
      default:
        throw new VerifyError(`vote of ${v.authority}: ${JSON.stringify(v.vote)} is not a vote`);
    }
    switch (v.transport.kind) {
      case 'inline':
        break;
      case 'sequenced': {
        const src = anchors.get(v.transport.source.toLowerCase());
        if (!src) throw refusal21(State.PartitionAnchorUnavailable, v.transport.source, 0, `the vote of ${v.authority} was sequenced from a partition the evidence holds no anchor for`);
        if (!goEqualFold(v.transport.destination, x.source) || v.transport.number === 0) {
          throw refusal21(State.ForeignPartitionMismatch, src.id, src.block, `url vote of ${v.authority}: sequenced to ${v.transport.destination}, the transaction's partition is ${x.source}`);
        }
        break;
      }
      default:
        throw new VerifyError(`vote of ${v.authority}: transport ${JSON.stringify(v.transport.kind)}`);
    }
    const root = chainAnchor(pp, pp.page, 'signature');
    if (!inChain(v.receipt, v.message, root)) {
      throw refusal21(State.BlockBeforeArrival, x.id, x.block, `the vote of ${v.authority} is not a member of ${ev.account}'s signature chain at the transaction's block`);
    }
    for (const h of allHops(v)) {
      const hp = AccUrl.parse(h.page);
      if (!hp) throw new VerifyError(`vote hop page ${JSON.stringify(h.page)}: not a URL`);
      const pa = byURL.get(lk(hp));
      if (!pa) throw refusal21(State.CompletenessUnproven, x.id, x.block, `${h.page} is on a counted vote's cause chain but is not among the proven pages`);
      if (h.block > pa.anchor.block) throw refusal21(State.BlockBeforeArrival, pa.anchor.id, pa.anchor.block, `the signature on ${h.page} arrived in block ${h.block}, after the page's block`);
      const r2 = chainAnchor(pa, pa.page, 'signature');
      if (!inChain(h.receipt, h.message, r2)) {
        throw refusal21(State.BlockBeforeArrival, pa.anchor.id, pa.anchor.block, `the signature on ${h.page} is not a member of the page's signature chain at the block`);
      }
    }
  }
}

/**
 * principalAuthorities resolves the principal's authority list as the executor does, walking the inheritance chain through the proven
 * accounts; onChain is called for each account on the walk. It requires every account it reads to be among the proven pages.
 */
export function principalAuthorities(ev: Evidence, byURL: Map<string, ProvenAcct>, onChain?: (u: AccUrl) => void): { url: AccUrl; disabled: boolean }[] {
  const principal = AccUrl.parse(ev.account);
  if (!principal) throw new VerifyError(`evidence account: ${JSON.stringify(ev.account)}: not a URL`);
  for (let cur = principal; ; ) {
    const pa = byURL.get(lk(cur));
    if (!pa) throw refusal21(State.CompletenessUnproven, '', 0, `${cur} is on the principal's inheritance chain but is not among the proven pages`);
    onChain?.(cur);
    const a = pa.acct;
    if (a.cls === 'LiteIdentity') return [{ url: accountUrl(a), disabled: false }];
    if (a.cls === 'LiteTokenAccount') {
      const d = liteTokenDelegate(a);
      if (d) return [{ url: d, disabled: false }];
      return [{ url: accountUrl(a).rootIdentity(), disabled: false }];
    }
    if (a.cls === 'LiteDataAccount') return [];
    if (isFullAccount(a)) {
      const auth = authoritiesOf(a);
      if (auth.length > 0) return auth;
      const [parent, ok] = cur.parent();
      if (!ok) throw refusal21(State.CompletenessUnproven, pa.anchor.id, pa.anchor.block, `root identity ${cur} lists no authority: the executor refuses it, so its governing set cannot be derived`);
      cur = parent;
      continue;
    }
    throw new VerifyError(`account ${cur} is ${a.cls}, which is not governed by key books`);
  }
}

/**
 * The delegate of a lite token account (protocol.LiteTokenAccount.Delegate, field 6): the SDK this verifier decodes with predates the field,
 * so it arrives as the object's extra data, which is read here as the field it is.
 */
export function liteTokenDelegate(a: WireNode): AccUrl | undefined {
  const x = a.extra;
  if (x.length < 2 || x[0] !== 6) return undefined;
  let len = 0;
  let shift = 0;
  let i = 1;
  for (; i < x.length && i < 6; i++) {
    const b = x[i]!;
    len |= (b & 0x7f) << shift;
    shift += 7;
    if (b < 0x80) {
      i++;
      break;
    }
  }
  const bytes = x.subarray(i, i + len);
  if (bytes.length !== len || len === 0) return undefined;
  return AccUrl.fromBinary(Buffer.from(bytes).toString('latin1'));
}

void [nodesOf, urlOf, goLower, normURL, deriveArrival];
