/**
 * G1's authority vote: the replay of a key page's history and the vote model that decides, as Accumulate's executor does, which
 * authorities voted on a transaction, through which page, on which keys (validator liteclient/proof/govvote: replay.go, genesis.go,
 * initiator.go, model.go). There is one replay and one vote model; this is the TypeScript half, and it reaches the same decisions.
 *
 * Every fact here is one the chain recorded: a signature or a delegated vote on the signature chain of the page that received it, with the
 * block it was recorded in (on that page's own partition). Each page is judged in the states it could have held during that block; the
 * signer version, which the executor required to match, picks among them. A recorded fact this model cannot reconcile with the page's
 * replayed history is NOT a rejection - the network accepted it, so the disagreement is ours: the vote is reported as unevaluable.
 */
import { equal } from '../proof-v2/bytes.js';
import { canonicalAccSpelling } from '../proof-v2/govroot-v3.js';
import { AccUrl, parseKeyPageUrl } from './acc.js';
import {
  KeyPage,
  allowedTransactionBit,
  bigOf,
  bodyOf,
  bytesOf,
  headerOf,
  nodeOf,
  nodesOf,
  principalOf,
  urlOf,
  signerOf,
  voteName,
  transactionTypeName,
  VoteType,
  type KeySpec,
  type WireNode,
} from './model.js';
import { payerOf } from './acc.js';
import { metadataHash, publicKeyHash } from '../sigtypes/verify.js';

/** CanonicalAccSpelling: trimmed, lower case, no trailing slash. */
export const normalizeAccURL = canonicalAccSpelling;

/** short: the first 16 characters of a hash. */
const short = (h: string): string => (h.length > 16 ? h.slice(0, 16) : h);

export const DELEGATION_DEPTH_LIMIT = 20;

// --------------------------------------------------------------------------------------------------------------------------------
// replay (replay.go)

/** What initiated a transaction: the payer of the initiating credit payment and, when the payer is the page, the key's hash. */
export interface Initiator {
  payer: AccUrl;
  keyHash?: Uint8Array;
}

/** One transaction on a key page's main chain, as the replay reads it. */
export interface ReplayEvent {
  entryHash: string;
  localBlock: number;
  txn: WireNode;
  /** Required for UpdateKey. */
  initiator?: Initiator;
}

/** The replay refusing an event: a transaction it cannot apply as the executor did. It is never a fact about the page. */
export class ReplayError extends Error {}

export type Effect = 'none' | 'authority';

function divergence(ev: ReplayEvent, detail: string): ReplayError {
  const body = bodyOf(ev.txn);
  return new ReplayError(
    `replay diverges from execution at ${body ? transactionTypeName(Number(bigOf(body, 'type'))) : '?'} ${short(ev.entryHash)} (block ${ev.localBlock}): ${detail} - the executor applied this transaction without error, so a replay that cannot is not the page's history`,
  );
}

interface KeySpecParams {
  keyHash: Uint8Array;
  delegate?: AccUrl;
}

const paramsOf = (n: WireNode | undefined): KeySpecParams => ({ keyHash: n ? bytesOf(n, 'keyHash') : new Uint8Array(0), delegate: n ? urlOf(n, 'delegate') : undefined });
const isEmptyParams = (k: KeySpecParams): boolean => k.keyHash.length === 0 && !k.delegate;

/** findKeyPageEntry mirrors update_key_page.go: the entry by key hash, else by delegate. */
function findKeyPageEntry(page: KeyPage, search: KeySpecParams): { index: number; spec: KeySpec } | undefined {
  let hit: { index: number; spec: KeySpec } | undefined;
  if (search.keyHash.length > 0) hit = page.entryByKeyHash(search.keyHash);
  if (!hit && search.delegate) hit = page.entryByDelegate(search.delegate);
  return hit;
}

function requireKeyHash(h: Uint8Array): void {
  if (h.length === 0) throw new Error('public key hash is missing');
  if (h.length > 32) throw new Error('public key hash is too long to be a hash');
}

/** replayUpdateKey mirrors update_key.go updateKey, less its book check. */
function replayUpdateKey(page: KeyPage, old: KeySpecParams, next: KeySpecParams, preserveDelegate: boolean): void {
  const o = findKeyPageEntry(page, old);
  if (!o) throw new Error('entry to be updated not found on the key page');
  const n = findKeyPageEntry(page, next);
  if (n && o.index !== n.index) throw new Error('cannot have duplicate entries on key page');
  const entry = o.spec;
  entry.publicKeyHash = next.keyHash;
  if (next.delegate || !preserveDelegate) entry.delegate = next.delegate ?? null;
  // Relocate the entry, keeping the page sorted.
  page.removeKeySpecAt(o.index);
  page.addKeySpec(entry);
}

/** applyKeyPageOperation mirrors checkOperation followed by executeOperation. */
function applyKeyPageOperation(page: KeyPage, principal: AccUrl, op: WireNode): void {
  switch (op.cls) {
    case 'AddKeyOperation': {
      const entry = paramsOf(nodeOf(op, 'entry'));
      if (isEmptyParams(entry)) throw new Error('cannot add an empty entry');
      if (entry.delegate && entry.delegate.parentOf(principal)) throw new Error('self-delegation is not allowed');
      if (findKeyPageEntry(page, entry)) throw new Error('cannot have duplicate entries on key page');
      page.addKeySpec({ publicKeyHash: entry.keyHash, lastUsedOn: 0n, delegate: entry.delegate ?? null });
      return;
    }
    case 'RemoveKeyOperation': {
      const entry = paramsOf(nodeOf(op, 'entry'));
      if (isEmptyParams(entry)) throw new Error('cannot remove an empty entry');
      const hit = findKeyPageEntry(page, entry);
      if (!hit) throw new Error('entry to be removed not found on the key page');
      const parsed = parseKeyPageUrl(page.url);
      if (!parsed) throw new Error('principal is not a key page');
      if (page.keys.length === 1 && parsed.index === 1) throw new Error('cannot delete last key of the highest priority page of a key book');
      page.removeKeySpecAt(hit.index);
      // The thresholds follow the key count down.
      const n = BigInt(page.keys.length);
      if (page.acceptThreshold > n) page.acceptThreshold = n;
      if (page.rejectThreshold > n) page.rejectThreshold = n;
      if (page.responseThreshold > n) page.responseThreshold = n;
      return;
    }
    case 'UpdateKeyOperation': {
      const oldE = paramsOf(nodeOf(op, 'oldEntry'));
      const newE = paramsOf(nodeOf(op, 'newEntry'));
      if (isEmptyParams(oldE)) throw new Error('cannot update: old entry is empty');
      if (isEmptyParams(newE)) throw new Error('cannot update: new entry is empty');
      if (newE.delegate && newE.delegate.parentOf(principal)) throw new Error('self-delegation is not allowed');
      replayUpdateKey(page, oldE, newE, false);
      return;
    }
    case 'SetThresholdKeyPageOperation': {
      const t = bigOf(op, 'threshold');
      if (t === 0n) throw new Error('cannot require 0 signatures on a key page');
      page.setThreshold(t);
      return;
    }
    case 'SetRejectThresholdKeyPageOperation': {
      const t = bigOf(op, 'threshold');
      if (t >= BigInt(page.keys.length)) throw new Error(`cannot require ${t} rejections on a key page with ${page.keys.length} keys`);
      page.rejectThreshold = t;
      return;
    }
    case 'SetResponseThresholdKeyPageOperation': {
      const t = bigOf(op, 'threshold');
      if (t >= BigInt(page.keys.length)) throw new Error(`cannot require ${t} responses on a key page with ${page.keys.length} keys`);
      page.responseThreshold = t;
      return;
    }
    case 'UpdateAllowedKeyPageOperation': {
      const allow = enumList(op, 'allow');
      const deny = enumList(op, 'deny');
      for (const t of [...allow, ...deny]) {
        if (allowedTransactionBit(t) === undefined) throw new Error(`transaction type ${transactionTypeName(t)} cannot be (dis)allowed`);
      }
      let bl = page.blacklist ?? 0n;
      for (const t of allow) bl &= ~(1n << BigInt(allowedTransactionBit(t)!));
      for (const t of deny) bl |= 1n << BigInt(allowedTransactionBit(t)!);
      page.blacklist = bl === 0n ? null : bl;
      return;
    }
  }
  throw new Error(`invalid operation: ${op.cls}`);
}

function enumList(n: WireNode, name: string): number[] {
  const v = n.fields.get(name);
  return Array.isArray(v) ? v.filter((x): x is bigint => typeof x === 'bigint').map((x) => Number(x)) : [];
}

/** Apply applies one main chain transaction to the page, as the executor applied it. */
export function applyEvent(page: KeyPage, ev: ReplayEvent): Effect {
  const txn = ev.txn;
  const principal = principalOf(txn);
  const body = bodyOf(txn);
  if (!body || !principal) throw new Error(`event ${short(ev.entryHash)} has no transaction`);
  if (!principal.equal(page.url)) {
    throw new ReplayError(`a ${transactionTypeName(Number(bigOf(body, 'type')))} on ${page.url}'s main chain names ${principal} as its principal`);
  }
  switch (body.cls) {
    case 'UpdateKeyPage': {
      // Applied to a copy and committed only if every operation succeeds, as the executor's state manager does.
      const next = page.copy();
      const ops = nodesOf(body, 'operation');
      for (let i = 0; i < ops.length; i++) {
        try {
          applyKeyPageOperation(next, principal, ops[i]!);
        } catch (e) {
          throw divergence(ev, `operation ${i} (${ops[i]!.cls}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      next.version += 1n;
      for (const k of next.keys) k.lastUsedOn = 0n;
      assign(page, next);
      return 'authority';
    }
    case 'UpdateKey': {
      if (!ev.initiator || !ev.initiator.payer) {
        throw new ReplayError(`updateKey ${short(ev.entryHash)}: its initiator is unknown, and the entry it rotates is the initiator's, so it cannot be replayed`);
      }
      const newKeyHash = bytesOf(body, 'newKeyHash');
      try {
        requireKeyHash(newKeyHash);
      } catch (e) {
        throw divergence(ev, (e as Error).message);
      }
      const next = page.copy();
      // update_key.go Execute: the delegate entry naming the payer, else the key that signed, when the payer is the page itself.
      const old: KeySpecParams = { keyHash: new Uint8Array(0) };
      const byDelegate = next.entryByDelegate(ev.initiator.payer);
      if (byDelegate) old.delegate = next.keys[byDelegate.index]!.delegate ?? undefined;
      else if (ev.initiator.payer.equal(next.url)) {
        if (!ev.initiator.keyHash || ev.initiator.keyHash.length === 0) {
          throw new ReplayError(`updateKey ${short(ev.entryHash)} was initiated by ${next.url}'s own key, but the initiating key is unknown`);
        }
        old.keyHash = ev.initiator.keyHash;
      } else throw divergence(ev, `initiator ${ev.initiator.payer} is neither the principal nor a delegate`);
      // "Do not update the key page version, do not reset LastUsedOn"
      try {
        replayUpdateKey(next, old, { keyHash: newKeyHash }, true);
      } catch (e) {
        throw divergence(ev, (e as Error).message);
      }
      assign(page, next);
      return 'authority';
    }
    case 'SyntheticDepositCredits':
    case 'BurnCredits':
      // Credit balance only.
      return 'none';
  }
  // Anything else on a page's main chain is a transaction this replay has not been taught, and cannot claim leaves the authority unchanged.
  throw new ReplayError(
    `a ${transactionTypeName(Number(bigOf(body, 'type')))} transaction (${short(ev.entryHash)}) is on ${page.url}'s main chain; the replay cannot show it leaves the page's authority unchanged`,
  );
}

function assign(dst: KeyPage, src: KeyPage): void {
  dst.url = src.url;
  dst.version = src.version;
  dst.acceptThreshold = src.acceptThreshold;
  dst.rejectThreshold = src.rejectThreshold;
  dst.responseThreshold = src.responseThreshold;
  dst.blockThreshold = src.blockThreshold;
  dst.keys = src.keys;
  dst.blacklist = src.blacklist;
}

/** State is one state of a page and the block it began at. */
export interface State {
  block: number;
  page: KeyPage;
}

/** States is every state a key page has been in, in chain order, and is what the vote model reads (a Timeline). */
export class States {
  constructor(readonly states: State[]) {}

  get length(): number {
    return this.states.length;
  }

  /** CandidatesDuring: the state the page entered the block in, and each state a change within the block produced. */
  candidatesDuring(block: number): KeyPage[] {
    const out: KeyPage[] = [];
    let entering: KeyPage | undefined;
    for (const st of this.states) {
      if (st.block < block) entering = st.page;
      else if (st.block === block) out.push(st.page);
    }
    return entering ? [entering, ...out] : out;
  }

  /** OfVersion: a state the page held at a version (every state of one version has the same thresholds and delegates). */
  ofVersion(v: bigint): KeyPage | undefined {
    return this.states.find((st) => st.page.version === v)?.page;
  }
}

export interface Replayed extends State {
  eventIndex: number;
}

/** Replay replays a page from its genesis state through its main chain events, and returns every state its authority passed through and the head. */
export function replay(genesis: KeyPage, genesisBlock: number, events: ReplayEvent[]): { states: Replayed[]; head: KeyPage } {
  const page = genesis.copy();
  const out: Replayed[] = [{ block: genesisBlock, page: page.copy(), eventIndex: -1 }];
  for (let i = 0; i < events.length; i++) {
    const effect = applyEvent(page, events[i]!);
    if (effect === 'authority') out.push({ block: events[i]!.localBlock, page: page.copy(), eventIndex: i });
  }
  return { states: out, head: page };
}

// --------------------------------------------------------------------------------------------------------------------------------
// genesis (genesis.go)

/** BookOfPage: acc://foo.acme/book/1 -> acc://foo.acme/book. */
export function bookOfPage(page: string): string {
  const p = normalizeAccURL(page);
  const i = p.lastIndexOf('/');
  if (i <= 0) return '';
  return p.slice(0, i);
}

/** GenesisPage is the key page a genesis transaction created, as the executor creates it; a genesis that did not create THAT page is refused. */
export function genesisPage(page: string, txn: WireNode): KeyPage {
  const body = bodyOf(txn);
  if (!body) throw new Error('no genesis transaction');
  const want = normalizeAccURL(page);
  const book = bookOfPage(want);
  const pageUrl = AccUrl.parse(want);
  if (!pageUrl) throw new Error(`key page url ${JSON.stringify(page)}: invalid`);
  switch (body.cls) {
    case 'SyntheticCreateIdentity': {
      for (const a of nodesOf(body, 'accounts')) {
        if (a.cls === 'KeyPage') {
          const u = urlOf(a, 'url');
          if (u && normalizeAccURL(u.toString()) === want) return KeyPage.from(a);
        }
      }
      throw new Error(`the syntheticCreateIdentity creates no key page ${want}`);
    }
    case 'CreateIdentity': {
      const kb = urlOf(body, 'keyBookUrl');
      if (!kb) throw new Error('createIdentity carries no keyBookUrl, so it created no key page');
      if (normalizeAccURL(kb.toString()) !== book || !want.endsWith('/1')) throw new Error(`createIdentity creates ${normalizeAccURL(kb.toString())}/1, not ${want}`);
      const keyHash = bytesOf(body, 'keyHash');
      if (keyHash.length === 0) throw new Error('createIdentity carries no keyHash');
      const kp = new KeyPage(pageUrl, 1n, 1n);
      kp.addKeySpec({ publicKeyHash: keyHash, lastUsedOn: 0n, delegate: null });
      return kp;
    }
    case 'CreateKeyBook': {
      const u = urlOf(body, 'url');
      if (!u || normalizeAccURL(u.toString()) !== book) throw new Error(`createKeyBook creates ${u ? u.toString() : '<nil>'}, which is not the book of ${want}`);
      if (!want.endsWith('/1')) throw new Error(`createKeyBook creates only page 1, but the target is ${want}`);
      const h = bytesOf(body, 'publicKeyHash');
      if (h.length === 0) throw new Error('createKeyBook carries no publicKeyHash');
      const kp = new KeyPage(pageUrl, 1n);
      kp.addKeySpec({ publicKeyHash: h, lastUsedOn: 0n, delegate: null });
      return kp;
    }
    case 'CreateKeyPage': {
      const principal = principalOf(txn);
      if (!principal || normalizeAccURL(principal.toString()) !== book) throw new Error(`createKeyPage acted on ${principal ? principal.toString() : '<nil>'}, not on ${book}, the book of ${want}`);
      const keys = nodesOf(body, 'keys');
      if (keys.length === 0) throw new Error('createKeyPage carries no keys');
      const kp = new KeyPage(pageUrl, 1n, 1n);
      for (const k of keys) {
        const kh = bytesOf(k, 'keyHash');
        const d = urlOf(k, 'delegate');
        if (kh.length === 0 && !d) throw new Error('createKeyPage key spec carries neither keyHash nor delegate');
        kp.addKeySpec({ publicKeyHash: kh, lastUsedOn: 0n, delegate: d ?? null });
      }
      return kp;
    }
  }
  throw new Error(`a ${transactionTypeName(Number(bigOf(body, 'type')))} transaction does not create a key page`);
}

// --------------------------------------------------------------------------------------------------------------------------------
// initiator (initiator.go)

/** InitiatorOf: what initiated txn, established from the initiating signature alone. */
export function initiatorOf(txn: WireNode, sig: WireNode): Initiator {
  const h = headerOf(txn);
  const initiatorHashField = h ? bytesOf(h, 'initiator') : new Uint8Array(32);
  if (!equal(metadataHash(sig), initiatorHashField.length === 32 ? initiatorHashField : new Uint8Array(32))) {
    throw new Error('the signature is not the one the transaction header commits to as its initiator');
  }
  const signer = signerOf(sig);
  if (!signer) throw new Error('the initiating signature names no signer');
  const payer = payerOf(signer);
  const out: Initiator = { payer };
  if (isKeySignature(sig)) out.keyHash = keyHashOf(sig);
  return out;
}

const KEY_CLASSES = new Set(['LegacyED25519Signature', 'ED25519Signature', 'RCD1Signature', 'BTCSignature', 'BTCLegacySignature', 'ETHSignature', 'RsaSha256Signature', 'EcdsaSha256Signature', 'TypedDataSignature']);
const isKeySignature = (s: WireNode): boolean => KEY_CLASSES.has(s.cls);

/** KeySignature.GetPublicKeyHash. */
function keyHashOf(sig: WireNode): Uint8Array | undefined {
  return publicKeyHash(sig.cls, bytesOf(sig, 'publicKey'));
}

// --------------------------------------------------------------------------------------------------------------------------------
// the vote model (model.go)

/** SigFact is one user signature, as the chain recorded it on its signer page. */
export interface SigFact {
  id: string;
  /** The signing page, normalised. */
  signer: string;
  /** Delegators, outermost first, normalised. */
  path: string[];
  version: bigint;
  /** Lower hex. */
  keyHash: string;
  vote: bigint;
  /** On the signer page's partition. */
  block: number;
  /** The partition the signer page lives on (lower case), carried for the signature types whose acceptance depends on the executor version. */
  partition?: string;
}

/** ArrivalFact is one delegated vote, as the chain recorded it on the delegator page that received it. */
export interface ArrivalFact {
  id: string;
  /** The delegator page, normalised. */
  page: string;
  /** The delegate book that voted, normalised. */
  authority: string;
  /** Delegators beyond Page, outermost first. */
  path: string[];
  block: number;
  /** The delegate's page that cast the vote, and the vote, as the network recorded them. */
  origin: string;
  vote: bigint;
}

/** RecordedVote is one authority's vote on the transaction as the network recorded it on the principal. */
export interface RecordedVote {
  id: string;
  authority: string;
  origin: string;
  vote: bigint;
  block?: number;
  /** For a vote of a transaction that was held, the block that PRODUCED the vote - the release; 0 when not established. */
  releasedAt: number;
}

export interface Facts {
  txType: number;
  sigs: SigFact[];
  arrivals: ArrivalFact[];
  votes: RecordedVote[];
  /** The transaction's HoldUntil minor block (0: not held). */
  holdUntil: bigint;
}

/** Timeline supplies a page's history: the states it may have been in during a block, and a state at a version. */
export interface Timeline {
  candidatesDuring(block: number): KeyPage[];
  ofVersion(v: bigint): KeyPage | undefined;
}

export interface TimelineSource {
  timeline(page: string): Timeline;
}

/** VoteUnevaluable reports a vote the chain records but this model could not re-establish. It is never a governance verdict. */
export class VoteUnevaluable extends Error {
  constructor(
    readonly page: string,
    readonly reason: string,
  ) {
    super(`the vote of ${page} could not be evaluated: ${reason}`);
  }
}

export interface CountedEntry {
  entry: string;
  vote: string;
  by: string;
  block: number;
}
export interface ExcludedMessage {
  by: string;
  reason: string;
}

export interface PageVote {
  page: string;
  path: string[];
  voted: boolean;
  vote: string;
  version: bigint;
  threshold: bigint;
  rejectThreshold: bigint;
  responseThreshold: bigint;
  decidedAt: number;
  counted: CountedEntry[];
  excluded: ExcludedMessage[];
  delegates: BookVote[];
  /** The vote's value. */
  voteType: bigint;
}

export interface BookVote {
  book: string;
  voted: boolean;
  vote: string;
  by: string;
  pages: PageVote[];
  voteType: bigint;
}

interface Contribution {
  entry: string;
  vote: bigint;
  by: string;
  block: number;
  ambiguous: boolean;
}

interface BookRecord {
  id: string;
  origin: string;
  vote: bigint;
  releasedAt: number;
}

interface PageDecision {
  through: number;
  version: bigint;
  state: KeyPage;
  counted: Map<string, Contribution>;
  excluded: ExcludedMessage[];
  delegates: BookVote[];
  voted: boolean;
  vote: bigint;
}

const pathEqual = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => normalizeAccURL(x) === normalizeAccURL(b[i]!));

/** pageIndex is a page's number within its book: acc://x.acme/book/2 -> 2 (the maximum for a non-number). */
function pageIndex(page: string): bigint {
  const i = page.lastIndexOf('/');
  const tail = page.slice(i + 1);
  return /^[0-9]+$/.test(tail) && BigInt(tail) <= 0xffffffffffffffffn ? BigInt(tail) : 0xffffffffffffffffn;
}

const ofVersion = (states: KeyPage[], v: bigint): KeyPage[] => states.filter((s) => s.version === v);

function blacklisted(p: KeyPage, typ: number): boolean {
  const bit = allowedTransactionBit(typ);
  return bit !== undefined && p.isBlacklisted(bit);
}

function decodeHash(s: string): Uint8Array {
  const t = s.toLowerCase().replace(/^0x/, '');
  if (t.length % 2 !== 0 || !/^[0-9a-f]*$/.test(t) || t.length === 0 || t.length > 64) throw new Error(`key hash ${JSON.stringify(s)} is not a hash`);
  return new Uint8Array(Buffer.from(t, 'hex'));
}

/** acceptThreshold is GetSignatureThreshold: an unset threshold means one. */
const acceptThreshold = (p: KeyPage): bigint => p.signatureThreshold;

/** decideVote mirrors SignerWillVote for one path. */
function decideVote(page: KeyPage, entries: Map<string, Contribution>): { vote: bigint; voted: boolean } {
  const votes = new Map<bigint, bigint>();
  let all = 0n;
  for (const c of entries.values()) {
    votes.set(c.vote, (votes.get(c.vote) ?? 0n) + 1n);
    all++;
  }
  const tAccept = acceptThreshold(page);
  let tReject = page.rejectThreshold;
  if (tReject === 0n) tReject = tAccept;
  if (all < page.responseThreshold) return { vote: 0n, voted: false };
  const accepts = votes.get(BigInt(VoteType.Accept)) ?? 0n;
  const rejects = votes.get(BigInt(VoteType.Reject)) ?? 0n;
  if (accepts >= tAccept) return { vote: BigInt(VoteType.Accept), voted: true };
  if (rejects >= tReject) return { vote: BigInt(VoteType.Reject), voted: true };
  const undecided = BigInt(page.keys.length) - all;
  const couldAccept = accepts + undecided >= tAccept;
  const couldReject = rejects + undecided >= tReject;
  if (!couldAccept && !couldReject) return { vote: BigInt(VoteType.Abstain), voted: true };
  return { vote: 0n, voted: false };
}

/** tally reduces contributions to one vote per entry: a later contribution for the same entry overwrites an earlier one. */
function tally(contribs: Contribution[], includeAmbiguous: boolean): Map<string, Contribution> {
  const out = new Map<string, Contribution>();
  for (const c of contribs) {
    if (c.ambiguous && !includeAmbiguous) continue;
    const prev = out.get(c.entry);
    if (prev && (prev.block > c.block || (prev.block === c.block && prev.by < c.by))) continue;
    out.set(c.entry, c);
  }
  return out;
}

/** sameBlockConflict refuses one entry recorded with different votes in the same block. */
function sameBlockConflict(page: string, contribs: Contribution[]): void {
  const seen = new Map<string, Contribution>();
  for (const c of contribs) {
    const k = `${c.entry}\u0000${c.block}`;
    const prev = seen.get(k);
    if (prev && prev.vote !== c.vote) {
      throw new VoteUnevaluable(
        page,
        `${c.entry} voted ${voteName(Number(prev.vote))} (${short(prev.by)}) and ${voteName(Number(c.vote))} (${short(c.by)}) in the same block ${c.block}; which one the page's set kept is not recorded`,
      );
    }
    seen.set(k, c);
  }
}

const recordBlocks = (direct: SigFact[], arrived: ArrivalFact[]): number[] => [...new Set([...direct.map((s) => s.block), ...arrived.map((a) => a.block)])].sort((a, b) => a - b);

function sortedEntries(m: Map<string, Contribution>): Contribution[] {
  return [...m.values()].sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
}

const ACCEPT = BigInt(VoteType.Accept);

class PageEvaluation {
  holding = new Map<string, number>();
  cands = new Map<string, number>();
  constructor(
    readonly m: VoteModel,
    readonly page: string,
    readonly path: string[],
    readonly depth: number,
    readonly tl: Timeline,
    readonly direct: SigFact[],
    readonly arrived: ArrivalFact[],
  ) {}

  /** decideThrough decides the page's vote on the records up to and including block b. */
  decideThrough(b: number): PageDecision {
    const { page, tl } = this;
    const direct = this.direct.filter((s) => s.block <= b);
    const arrived = this.arrived.filter((a) => a.block <= b);

    // The version the page's signature set stood at. A signature at a newer version replaces the set, so the newest version recorded so
    // far is the one the set held, and anything recorded at an older one was discarded.
    let v = 0n;
    for (const s of direct) if (s.version > v) v = s.version;
    const arrivalVersions: Set<bigint>[] = [];
    for (let i = 0; i < arrived.length; i++) {
      const a = arrived[i]!;
      const set = new Set<bigint>();
      for (const c of tl.candidatesDuring(a.block)) set.add(c.version);
      arrivalVersions.push(set);
      if (set.size === 0) throw new VoteUnevaluable(page, `the delegated vote ${short(a.id)} was recorded at block ${a.block}, before the page existed`);
      if (direct.length === 0) for (const ver of set) if (ver > v) v = ver;
    }

    const state = tl.ofVersion(v);
    if (!state) throw new VoteUnevaluable(page, `the chain records messages at version ${v}, a version its replayed history never reached`);
    const d: PageDecision = { through: b, version: v, state, counted: new Map(), excluded: [], delegates: [], voted: false, vote: 0n };

    const contribs: Contribution[] = [];
    for (const s of direct) {
      if (s.version < v) {
        d.excluded.push({ by: s.id, reason: `made at version ${s.version}; a signature at version ${v} replaced the page's signature set` });
        continue;
      }
      const { holding, cands } = this.keyHolding(s, v);
      contribs.push({ entry: `key:${s.keyHash.toLowerCase()}`, vote: s.vote, by: s.id, block: s.block, ambiguous: holding < cands });
    }

    for (let i = 0; i < arrived.length; i++) {
      const a = arrived[i]!;
      if (!arrivalVersions[i]!.has(v)) {
        d.excluded.push({ by: a.id, reason: `recorded while the page was not at version ${v}; a newer signature set replaced it` });
        continue;
      }
      const { holding, cands } = this.delegateHolding(a, v);
      // The delegate's vote, recomputed from its own signatures rather than taken from the record that it was cast.
      const inner = [...this.path, page];
      const dv = this.m.bookVote(a.authority, inner, this.depth + 1);
      if (!dv.voted) throw new VoteUnevaluable(page, `the chain records a vote by ${a.authority}, but its own signatures do not reach a vote`);
      contribs.push({ entry: `delegate:${normalizeAccURL(a.authority)}`, vote: dv.voteType, by: a.id, block: a.block, ambiguous: holding < cands });
      d.delegates.push(dv);
    }

    sameBlockConflict(page, contribs);

    // Decide with every ambiguous contribution counted and with none. If the two agree the vote stands; if they do not, which state the
    // page was in decides the vote and it is not ours to guess.
    const all = tally(contribs, true);
    const definite = tally(contribs, false);
    const withAll = decideVote(state, all);
    const withNone = decideVote(state, definite);
    if (withAll.voted !== withNone.voted || (withAll.voted && withAll.vote !== withNone.vote)) {
      throw new VoteUnevaluable(page, 'within one block the page held states that decide its vote differently, and which one each message saw is not recorded');
    }
    d.counted = all;
    d.voted = withAll.voted;
    d.vote = withAll.vote;
    return d;
  }

  /** keyHolding: how many states of the page at version v during s's block held s's key and allowed the transaction, and how many there were. */
  private keyHolding(s: SigFact, v: bigint): { holding: number; cands: number } {
    const ck = `${s.id}|${v}`;
    const h = this.holding.get(ck);
    if (h !== undefined) return { holding: h, cands: this.cands.get(ck)! };
    const cands = ofVersion(this.tl.candidatesDuring(s.block), v);
    if (cands.length === 0) {
      throw new VoteUnevaluable(this.page, `signature ${short(s.id)} is recorded at block ${s.block} at version ${v}, which the page did not hold during that block`);
    }
    let kh: Uint8Array;
    try {
      kh = decodeHash(s.keyHash);
    } catch (e) {
      throw new VoteUnevaluable(this.page, `signature ${short(s.id)}: ${(e as Error).message}`);
    }
    let holding = 0;
    for (const c of cands) {
      if (blacklisted(c, this.m.facts.txType)) continue;
      if (c.entryByKeyHash(kh)) holding++;
    }
    if (holding === 0) {
      throw new VoteUnevaluable(
        this.page,
        `signature ${short(s.id)} is recorded, but no state of the page at version ${v} during block ${s.block} both holds its key and allows a ${transactionTypeName(this.m.facts.txType)} - the network accepted what the replay cannot`,
      );
    }
    this.holding.set(ck, holding);
    this.cands.set(ck, cands.length);
    return { holding, cands: cands.length };
  }

  /** delegateHolding is keyHolding for a delegated vote: the states that carried an entry delegating to its authority. */
  private delegateHolding(a: ArrivalFact, v: bigint): { holding: number; cands: number } {
    const ck = `${a.id}|${v}`;
    const h = this.holding.get(ck);
    if (h !== undefined) return { holding: h, cands: this.cands.get(ck)! };
    const authority = AccUrl.parse(a.authority);
    if (!authority) throw new VoteUnevaluable(this.page, `delegated vote ${short(a.id)} names ${JSON.stringify(a.authority)}`);
    let holding = 0;
    const cands = ofVersion(this.tl.candidatesDuring(a.block), v);
    for (const c of cands) {
      if (blacklisted(c, this.m.facts.txType)) continue;
      if (c.entryByDelegate(authority)) holding++;
    }
    if (holding === 0) {
      throw new VoteUnevaluable(
        this.page,
        `the delegated vote of ${a.authority} is recorded at block ${a.block}, but the page at version ${v} then carries no entry delegating to it`,
      );
    }
    this.holding.set(ck, holding);
    this.cands.set(ck, cands.length);
    return { holding, cands: cands.length };
  }
}

class VoteModel {
  pages = new Map<string, PageVote>();
  books = new Map<string, BookVote>();
  constructor(
    readonly facts: Facts,
    readonly src: TimelineSource,
  ) {}

  private timelineOf(page: string): Timeline {
    try {
      return this.src.timeline(page);
    } catch (e) {
      throw new VoteUnevaluable(page, `its history could not be replayed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * bookVote returns a book's vote on a delegation path. A book votes with whichever of its pages decides first: the page is not chosen
   * here. It is the one the network names, and it is checked: replaying that page must reach the recorded vote, and no page of the book
   * may have decided in an earlier block, or the replay and the network disagree and the vote is not evaluated.
   */
  bookVote(bookIn: string, path: string[], depth: number): BookVote {
    const book = normalizeAccURL(bookIn);
    const key = `${book}|${path.join(',')}`;
    const hit = this.books.get(key);
    if (hit) return hit;

    // The pages of this book that could have voted on this path are the ones a fact names. A page with nothing recorded does not vote.
    const seen = new Set<string>();
    for (const s of this.facts.sigs) if (bookOfPage(s.signer) === book && pathEqual(s.path, path)) seen.add(s.signer);
    for (const a of this.facts.arrivals) if (bookOfPage(a.page) === book && pathEqual(a.path, path)) seen.add(a.page);
    const pages = [...seen].sort((a, b) => (pageIndex(a) < pageIndex(b) ? -1 : pageIndex(a) > pageIndex(b) ? 1 : 0));

    const rec = this.recordedBookVote(book, path);
    const bv: BookVote = { book, voted: false, vote: '', by: '', pages: [], voteType: 0n };

    if (!rec) {
      // No vote recorded: the book did not vote. Every page with records is evaluated so the evidence says what each recorded, and none of
      // them may have decided.
      for (const p of pages) {
        const pv = this.pageVote(p, path, depth);
        if (pv.voted) {
          throw new VoteUnevaluable(p, `its signatures decide ${book}'s vote (${pv.vote} at block ${pv.decidedAt}), but the network records no vote by ${book}`);
        }
        bv.pages.push(pv);
      }
      this.books.set(key, bv);
      return bv;
    }

    if (bookOfPage(rec.origin) !== book) {
      throw new VoteUnevaluable(rec.origin, `the network records ${book}'s vote as cast by ${rec.origin}, which is not one of its pages`);
    }
    const pv = this.pageVote(rec.origin, path, depth);
    if (!pv.voted || pv.voteType !== rec.vote) {
      const got = pv.voted ? pv.vote : 'no vote';
      throw new VoteUnevaluable(rec.origin, `the network records ${book}'s vote as ${voteName(Number(rec.vote))} cast by this page (${rec.id}), but replaying its signatures reaches ${got}`);
    }
    for (const p of pages) {
      if (p === rec.origin) continue;
      if (this.facts.holdUntil !== 0n && rec.releasedAt > 0) {
        // A held vote: core keeps one authority signature per authority while the transaction is held, and a page of the book that decided
        // before the release replaces the stored one when it is equal or lower in the book. So a higher page that decided first was
        // replaced - not a disagreement - and a LOWER page that decided before the release would have won: the recorded origin is impossible.
        const { decided, at } = this.pageDecidedBefore(p, path, depth, rec.releasedAt);
        if (decided && pageIndex(p) < pageIndex(rec.origin)) {
          throw new VoteUnevaluable(
            p,
            `its signatures decide ${book}'s vote at block ${at}, before the held vote was released at block ${rec.releasedAt}, and it is a lower page than ${rec.origin}: core keeps the lowest page's authority signature while a transaction is held, yet the network records ${rec.origin} as the page that cast it`,
          );
        }
        continue;
      }
      const { decided, at } = this.pageDecidedBefore(p, path, depth, pv.decidedAt);
      if (decided) {
        throw new VoteUnevaluable(
          p,
          `its signatures decide ${book}'s vote at block ${at}, before ${rec.origin} decided it at block ${pv.decidedAt}, yet the network records ${rec.origin} as the page that cast it`,
        );
      }
    }
    bv.pages.push(pv);
    bv.voted = true;
    bv.vote = pv.vote;
    bv.by = rec.origin;
    bv.voteType = pv.voteType;
    this.books.set(key, bv);
    return bv;
  }

  /** recordedBookVote is the vote the network recorded for book on path. More than one record naming different pages or votes is not a record of one vote. */
  private recordedBookVote(book: string, path: string[]): BookRecord | undefined {
    const recs: BookRecord[] = [];
    if (path.length === 0) {
      for (const v of this.facts.votes) {
        if (normalizeAccURL(v.authority) === book) recs.push({ id: v.id, origin: normalizeAccURL(v.origin), vote: v.vote, releasedAt: v.releasedAt });
      }
    } else {
      const at = path[path.length - 1]!;
      const beyond = path.slice(0, -1);
      for (const a of this.facts.arrivals) {
        if (normalizeAccURL(a.authority) === book && a.page === at && pathEqual(a.path, beyond)) {
          if (a.origin === '') throw new VoteUnevaluable(at, `the delegated vote ${short(a.id)} by ${book} names no originating page`);
          recs.push({ id: a.id, origin: normalizeAccURL(a.origin), vote: a.vote, releasedAt: 0 });
        }
      }
    }
    if (recs.length === 0) return undefined;
    for (const r of recs.slice(1)) {
      if (r.origin !== recs[0]!.origin || r.vote !== recs[0]!.vote) {
        throw new VoteUnevaluable(book, `the network records more than one vote by ${book} (${short(recs[0]!.id)} from ${recs[0]!.origin}, ${short(r.id)} from ${r.origin})`);
      }
    }
    return recs[0];
  }

  /** pageDecidedBefore reports whether page's records, on path, decide a vote in a block before b, and in which. */
  private pageDecidedBefore(page: string, path: string[], depth: number, b: number): { decided: boolean; at: number } {
    const direct = this.facts.sigs.filter((s) => s.signer === page && pathEqual(s.path, path) && s.block < b);
    const arrived = this.facts.arrivals.filter((a) => a.page === page && pathEqual(a.path, path) && a.block < b);
    if (direct.length === 0 && arrived.length === 0) return { decided: false, at: 0 };
    const tl = this.timelineOf(page);
    const evalr = new PageEvaluation(this, page, path, depth, tl, direct, arrived);
    for (const blk of recordBlocks(direct, arrived)) {
      const d = evalr.decideThrough(blk);
      if (d.voted) return { decided: true, at: blk };
    }
    return { decided: false, at: 0 };
  }

  /** pageVote returns a page's vote on a delegation path. */
  pageVote(pageIn: string, path: string[], depth: number): PageVote {
    const page = normalizeAccURL(pageIn);
    const key = `${page}|${path.join(',')}`;
    const hit = this.pages.get(key);
    if (hit) return hit;
    if (depth > DELEGATION_DEPTH_LIMIT) throw new VoteUnevaluable(page, `delegation deeper than Accumulate's limit of ${DELEGATION_DEPTH_LIMIT}`);

    const pv: PageVote = {
      page,
      path,
      voted: false,
      vote: '',
      version: 0n,
      threshold: 0n,
      rejectThreshold: 0n,
      responseThreshold: 0n,
      decidedAt: 0,
      counted: [],
      excluded: [],
      delegates: [],
      voteType: 0n,
    };
    const direct = this.facts.sigs.filter((s) => s.signer === page && pathEqual(s.path, path));
    const arrived = this.facts.arrivals.filter((a) => a.page === page && pathEqual(a.path, path));
    if (direct.length === 0 && arrived.length === 0) {
      this.pages.set(key, pv);
      return pv;
    }

    const tl = this.timelineOf(page);

    // The page votes the way Accumulate's page does: at the first block in which its active signature set reaches a decision, the set being
    // replaced whenever an entry at a newer version arrives. So the records are walked in block order and the vote is decided on each prefix.
    const evalr = new PageEvaluation(this, page, path, depth, tl, direct, arrived);
    let d: PageDecision | undefined;
    for (const b of recordBlocks(direct, arrived)) {
      d = evalr.decideThrough(b);
      if (d.voted) break;
    }
    const dd = d!;
    pv.version = dd.version;
    pv.threshold = acceptThreshold(dd.state);
    pv.rejectThreshold = dd.state.rejectThreshold;
    pv.responseThreshold = dd.state.responseThreshold;
    pv.excluded.push(...dd.excluded);
    for (const c of sortedEntries(dd.counted)) pv.counted.push({ entry: c.entry, vote: voteName(Number(c.vote)), by: c.by, block: c.block });
    pv.delegates = dd.delegates;
    if (dd.voted) {
      pv.voted = true;
      pv.vote = voteName(Number(dd.vote));
      pv.voteType = dd.vote;
      pv.decidedAt = dd.through;
      const after = (id: string, block: number): void => {
        pv.excluded.push({ by: id, reason: `recorded at block ${block}, after the page's vote was decided at block ${dd.through}; not part of the decision` });
      };
      for (const s of direct) if (s.block > dd.through) after(s.id, s.block);
      for (const a of arrived) if (a.block > dd.through) after(a.id, a.block);
    }
    this.pages.set(key, pv);
    return pv;
  }
}

/** AccountAuthority is one entry of an account's authority set. */
export interface AccountAuthority {
  url: string;
  disabled?: boolean;
}

export interface AuthorityVote {
  authority: string;
  disabled: boolean;
  extra: boolean;
  vote: BookVote;
}

export interface AccountVote {
  account: string;
  authorities: AuthorityVote[];
  satisfied: boolean;
}

/**
 * Evaluate is the authority vote on a transaction: every authority account required (authorities, plus extra the transaction itself names;
 * disabled authorities count only when ignoreDisabled), each decided from facts over the page histories src supplies.
 */
export function evaluate(facts: Facts, src: TimelineSource, account: string, authorities: AccountAuthority[], extra: string[], ignoreDisabled: boolean): AccountVote {
  const m = new VoteModel(facts, src);
  const out: AccountVote = { account: normalizeAccURL(account), authorities: [], satisfied: true };
  const seen = new Set<string>();
  const require = (a: AccountAuthority, isExtra: boolean): void => {
    const u = normalizeAccURL(a.url);
    if (seen.has(u)) return;
    seen.add(u);
    const bv = m.bookVote(u, [], 0);
    out.authorities.push({ authority: u, disabled: !!a.disabled, extra: isExtra, vote: bv });
    if (!bv.voted || bv.voteType !== ACCEPT) out.satisfied = false;
  };
  if (authorities.length === 0) {
    throw new Error(`${out.account} has no authority set at execution, so there is nothing that could have authorized it`);
  }
  for (const a of authorities) {
    if (a.disabled && !ignoreDisabled) continue;
    require(a, false);
  }
  for (const e of extra) require({ url: e }, true);
  if (out.authorities.length === 0) {
    // Every authority is disabled and the type does not require authorization: core still requires one signature at least (voters
    // non-empty), which the caller checks against the recorded votes. A verdict here would be a guess.
    throw new Error(`every authority of ${out.account} is disabled; which signature satisfied it is not something this model decides`);
  }
  return out;
}
