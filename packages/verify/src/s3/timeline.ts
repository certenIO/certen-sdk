/**
 * The certified timeline of evidence 2.1 (validator xtimeline.go; docs/proof/PROOF_V2.md 5.2 "Refined 2026-10-05" steps 2-5). A page
 * "as of B_Y" can only be the END of the history that judged a counted signature, so for every page that carries a PageHistory the
 * verifier
 *
 *  1. folds the history's main-chain entry hashes to the main chain root proven at B_Y (step 2: no entry inserted, omitted or reordered)
 *     and the main-index chain to its proven root, which gives every entry's block;
 *  2. replays the entries from the page's genesis with the executor's rules and requires the replay to end in the proven state (step 3);
 *  3. derives each counted signature's exact arrival block from the page's signature-index chain (step 4) - never from a claim;
 *  4. runs the vote model on that certified timeline and requires its result to equal every recorded vote's Origin and Vote, and the
 *     principal's authorities to be ready (step 5).
 *
 * Anything it cannot establish is a named state with the partition and block it was judged at: a refusal when the evidence contradicts it,
 * an Unproven entry of the report when the evidence is silent.
 */
import { equal, MerkleState, receiptValid, sha256, toHex, VerifyError } from '../proof-v2/bytes.js';
import { AccUrl, goEqualFold, goLower, LEDGER, partitionUrl, SYNTHETIC } from './acc.js';
import type { ChainRoot, Evidence, IndexProof, Arrival, PageState, Production, Rcpt, Vote } from './evidence.js';
import type { XAnchor } from './executor.js';
import { decodeReceiptBin } from './certify.js';
import { goHex } from './gojson.js';
import {
  type AccountAuthority,
  type ArrivalFact,
  type Facts,
  type RecordedVote,
  type SigFact,
  genesisPage,
  initiatorOf as initiatorOfSig,
  normalizeAccURL,
  replay,
  States,
  VoteUnevaluable,
  evaluate,
  type ReplayEvent,
  type Timeline,
} from './govvote.js';
import {
  KeyPage,
  bigOf,
  bodyOf,
  bodyType,
  holdUntilOf,
  isAuthoritySignature,
  nodeOf,
  nodesOf,
  principalOf,
  requireAuthorization,
  signatureHash,
  signerVersionOf,
  txnHash,
  unwrapSignature,
  urlOf,
  urlsOf,
  voteName,
  voteOf,
  headerAuthorities,
  additionalAuthorities,
  type WireNode,
} from './model.js';
import { allHops, carriedTransaction } from './roles.js';
import { decodeSigHex, decodeTxnHex, requireSig, verifyKeySignature } from './sig.js';
import { authorityDiff } from './executor.js';
import { refusal21, State, stateEntry } from './states.js';
import { MODE_ALL_AUTHORITIES_DISABLED, MODE_AUTHORITIES_REQUIRED, type ProvenAcct, type Report21, type XIn } from './xtypes.js';
import { decodeObject } from '../sigtypes/wire.js';

const lk = (u: AccUrl): string => u.key;

/** unboundRefusal: a page whose chains are not bound at the block. */
export function unboundRefusal(pa: ProvenAcct, p: PageState): NamedStateError {
  let code: string = State.ChainUnboundPending;
  const note = pa.chain.note ?? '';
  const i = note.indexOf(':');
  if (i > 0 && note.startsWith('g1_')) code = note.slice(0, i);
  return refusal21(code, pa.anchor.id, pa.anchor.block, `${p.url}: its chains are not bound at the block (${note})`);
}
type NamedStateError = ReturnType<typeof refusal21>;

/** boundChain returns the named chain among a page's bound chains. */
export function boundChain(p: PageState, name: string): ChainRoot | undefined {
  return p.chains.find((c) => c.name === name);
}

/**
 * foldMatches folds entries into a merkle state and requires it to be exactly the chain's proven state: the same height and the same
 * pending hashes, so no entry was inserted, omitted or reordered.
 */
export function foldMatches(entries: Uint8Array[], c: ChainRoot): boolean {
  if (entries.length !== c.count) return false;
  const st = new MerkleState();
  for (const e of entries) st.addEntry(e);
  const cp = c.pending ?? [];
  const n = Math.max(st.pending.length, cp.length);
  for (let i = 0; i < n; i++) {
    const a = i < st.pending.length ? st.pending[i] : null;
    let b: Uint8Array | null = null;
    if (i < cp.length && cp[i] !== null) {
      const d = goHex(cp[i]!);
      if (!d) return false;
      b = d;
    }
    if ((a?.length ?? 0) === 0 && (b?.length ?? 0) === 0) continue;
    if (!a || !b || !equal(a, b)) return false;
  }
  return true;
}

interface IndexEntryX {
  source: number;
  block: number;
}

/** decodeIndexEntry: an index chain entry, the IndexEntry's binary encoding padded to 32 bytes. */
function decodeIndexEntry(h: string): { e: IndexEntryX; raw: Uint8Array } {
  const raw = goHex(h);
  if (!raw || raw.length !== 32) throw new VerifyError('an index chain entry is not 32 bytes of hex');
  let n: WireNode;
  try {
    n = decodeObject('IndexEntry', raw);
  } catch (e) {
    throw new VerifyError(`an index chain entry does not decode: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { e: { source: Number(bigOf(n, 'source')), block: Number(bigOf(n, 'blockIndex')) }, raw };
}

/** replayHistory folds and replays one page's history (PROOF_V2 5.2 steps 2-3) and returns every state the page's authority passed through. */
export function replayHistory(pa: ProvenAcct, p: PageState): States {
  const h = { entries: p.history!.entries ?? [], index: p.history!.index ?? [] };
  const id = pa.anchor.id;
  const blk = pa.anchor.block;
  if (!pa.chain.bound) throw unboundRefusal(pa, p);
  if (pa.acct.cls !== 'KeyPage') throw new VerifyError(`${p.url} carries a history but is ${pa.acct.cls}, not a key page`);
  const kp = KeyPage.from(pa.acct);
  const main = boundChain(p, 'main');
  const mainIdx = boundChain(p, 'main-index');
  if (!main || !mainIdx) throw refusal21(State.HistoryFoldMismatch, id, blk, `${p.url}: no main or main-index chain is bound at the block`);
  if (h.entries.length === 0) throw refusal21(State.HistoryFoldMismatch, id, blk, `${p.url}: the history carries no entry; the main chain holds ${main.count}`);
  const txns: WireNode[] = [];
  const hashes: Uint8Array[] = [];
  h.entries.forEach((e, i) => {
    let txn: WireNode;
    try {
      txn = decodeTxnHex(e.transaction);
    } catch (err) {
      throw new VerifyError(`${p.url}: history entry ${i}: ${(err as Error).message}`);
    }
    txns.push(txn);
    hashes.push(txnHash(txn));
  });
  if (!foldMatches(hashes, main)) {
    throw refusal21(State.HistoryFoldMismatch, id, blk, `${p.url}: the ${hashes.length} history entries do not fold to the main chain root proven at the block (height ${main.count})`);
  }
  const idxRaw: Uint8Array[] = [];
  const idx: IndexEntryX[] = [];
  h.index.forEach((s, i) => {
    try {
      const d = decodeIndexEntry(s);
      idx.push(d.e);
      idxRaw.push(d.raw);
    } catch (err) {
      throw new VerifyError(`${p.url}: main-index entry ${i}: ${(err as Error).message}`);
    }
  });
  if (!foldMatches(idxRaw, mainIdx)) {
    throw refusal21(State.HistoryFoldMismatch, id, blk, `${p.url}: the ${idx.length} main-index entries do not fold to the main-index root proven at the block (height ${mainIdx.count})`);
  }
  // Each main chain entry's block: the first index entry whose Source reaches it. The index must be strictly increasing and end at the chain's last entry.
  const blocks: number[] = new Array<number>(hashes.length).fill(0);
  let k = 0;
  for (let j = 0; j < hashes.length; j++) {
    while (k < idx.length && idx[k]!.source < j) k++;
    if (k === idx.length) throw refusal21(State.HistoryFoldMismatch, id, blk, `${p.url}: main chain entry ${j} lies after the main-index chain's last entry`);
    blocks[j] = idx[k]!.block;
  }
  for (let i = 1; i < idx.length; i++) {
    if (idx[i]!.source <= idx[i - 1]!.source || idx[i]!.block <= idx[i - 1]!.block) {
      throw refusal21(State.HistoryFoldMismatch, id, blk, `${p.url}: the main-index chain is not strictly increasing at entry ${i}`);
    }
  }
  if (idx.length === 0 || idx[idx.length - 1]!.source !== hashes.length - 1) {
    throw refusal21(State.HistoryFoldMismatch, id, blk, `${p.url}: the main-index chain does not end at the main chain's last entry`);
  }
  if (blocks[blocks.length - 1]! > blk) {
    throw refusal21(State.BlockBeforeArrival, id, blk, `${p.url}: a history entry was written in block ${blocks[blocks.length - 1]}, after the page's block`);
  }

  let genesis: KeyPage;
  try {
    genesis = genesisPage(p.url, txns[0]!);
  } catch (e) {
    throw refusal21(State.HistoryUnreplayable, id, blk, `${p.url}: genesis: ${(e as Error).message}`);
  }
  const events: ReplayEvent[] = [];
  for (let i = 1; i < txns.length; i++) {
    const ev: ReplayEvent = { entryHash: toHex(hashes[i]!), localBlock: blocks[i]!, txn: txns[i]! };
    if (bodyOf(txns[i]!)?.cls === 'UpdateKey') {
      try {
        const sig = requireSig(decodeSigHex(h.entries[i]!.initiator));
        ev.initiator = initiatorOfSig(txns[i]!, sig);
      } catch (err) {
        throw refusal21(State.HistoryUnreplayable, id, blk, `${p.url}: history entry ${i}: ${(err as Error).message}`);
      }
    }
    events.push(ev);
  }
  let replayed: ReturnType<typeof replay>;
  try {
    replayed = replay(genesis, blocks[0]!, events);
  } catch (e) {
    throw refusal21(State.HistoryUnreplayable, id, blk, `${p.url}: ${(e as Error).message}`);
  }
  const d = authorityDiff(replayed.head, kp);
  if (d !== '') throw refusal21(State.HistoryHeadMismatch, id, blk, `${p.url}: the replay ends in a page that differs from the proven one: ${d}`);
  return new States(replayed.states.map((r) => ({ block: r.block, page: r.page })));
}

/**
 * receiptPositions returns every position p < n whose receipt in a chain of n entries has r's shape. A receipt does not carry its entry's
 * position in anything it hashes, but the shape (which side each sibling is on) fixes it given the chain's height; a result of more than
 * one position, or none, means the position is not established. At most 64 peaks are tried, so the cost is O(log n).
 */
export function receiptPositions(entries: { right: boolean }[], n: number): number[] {
  if (n === 0) return [];
  const f = entries.map((e) => e.right);
  const heights: number[] = [];
  for (let h = 63; h >= 0; h--) if ((BigInt(n) >> BigInt(h)) & 1n) heights.push(h);
  const out: number[] = [];
  let start = 0n;
  for (let j = 0; j < heights.length; j++) {
    const h = heights[j]!;
    let want = h + j;
    const last = j === heights.length - 1;
    if (!last) want++;
    if (f.length === want) {
      let kk = h;
      let ok = true;
      if (!last) {
        ok = f[kk]!;
        kk++;
      }
      for (let i = 0; i < j && ok; i++) ok = !f[kk + i]!;
      if (ok) {
        let off = 0n;
        for (let i = 0; i < h; i++) if (!f[i]!) off |= 1n << BigInt(i);
        out.push(Number(start + off));
      }
    }
    start += 1n << BigInt(h);
  }
  return out;
}

function rootOf(c: ChainRoot): Uint8Array {
  const b = goHex(c.anchor);
  if (!b || b.length !== 32) throw new VerifyError(`chain ${c.name} has no 32-byte root`);
  return b;
}

/** checkIndexProof requires an index entry to be a member of the bound index chain at the position its receipt allows. */
function checkIndexProof(ip: IndexProof, ir: ChainRoot): IndexEntryX {
  const { e, raw } = decodeIndexEntry(ip.entry);
  const root = rootOf(ir);
  // decodeReceipt: the receipt is the one its binary form decodes to; one that does not decode refuses the index entry
  const r = decodeReceiptBin(ip.receipt.bin);
  if (r === undefined) throw new VerifyError('receipt: fields are out of order');
  if (!equal(r.start, raw) || !equal(r.anchor, root) || !receiptValid(r)) {
    throw new VerifyError(`the index entry ${ip.position} is not a member of the ${ir.name} chain bound at the block`);
  }
  const ps = receiptPositions(r.entries, ir.count);
  if (ps.length !== 1 || ps[0] !== ip.position) {
    throw new VerifyError(`the receipt of index entry ${ip.position} allows positions [${ps.join(' ')}] in a chain of ${ir.count}`);
  }
  return e;
}

/** inChain requires a receipt that starts at message (hex32) and ends at root. */
export function inChain(r: Rcpt, messageHex: string, root: Uint8Array): boolean {
  const msg = goHex(messageHex);
  if (!msg || msg.length !== 32) return false;
  // decodeReceipt: the receipt is the one its binary form decodes to; one that does not decode is not a membership
  const d = decodeReceiptBin(r.bin);
  if (d === undefined) return false;
  return equal(d.start, msg) && equal(d.anchor, root) && receiptValid(d);
}

/**
 * deriveArrival derives the block the entry msgHex (receipt into the named chain) was written in, from the chain's index chain: the
 * position of the entry is fixed by its receipt; the block is that of the index entry At, which must be the first whose Source reaches the
 * position (Before, adjacent to it, must not).
 */
export function deriveArrival(pa: ProvenAcct, p: PageState, chain: string, msgHex: string, rcpt: Rcpt, a: Arrival): number {
  const id = pa.anchor.id;
  const blk = pa.anchor.block;
  const bad = (m: string): NamedStateError => refusal21(State.ArrivalUnproven, id, blk, `${p.url} ${chain}: ${m}`);
  if (!pa.chain.bound) throw unboundRefusal(pa, p);
  const cr = boundChain(p, chain);
  const ir = boundChain(p, `${chain}-index`);
  if (!cr || !ir) throw bad(`no ${chain} or ${chain}-index chain is bound at the block`);
  const root = rootOf(cr);
  if (!inChain(rcpt, msgHex, root)) throw refusal21(State.BlockBeforeArrival, id, blk, `the entry is not a member of ${p.url}'s ${chain} chain at the block`);
  const ps = receiptPositions(decodeReceiptBin(rcpt.bin)!.entries, cr.count); // inChain has decoded it
  if (ps.length !== 1) throw bad(`the entry's receipt allows positions [${ps.join(' ')}] in a chain of ${cr.count}: the position is not established`);
  const pos = ps[0]!;
  let at: IndexEntryX;
  try {
    at = checkIndexProof(a.at, ir);
  } catch (e) {
    throw bad((e as Error).message);
  }
  if (at.source < pos || at.source >= cr.count) throw bad(`the index entry covers chain entries up to ${at.source}, which does not reach position ${pos} of ${cr.count}`);
  if (!a.before) {
    if (a.at.position !== 0) throw bad(`no previous index entry is given but the entry is index entry ${a.at.position}`);
  } else {
    let before: IndexEntryX;
    try {
      before = checkIndexProof(a.before, ir);
    } catch (e) {
      throw bad((e as Error).message);
    }
    if (a.before.position + 1 !== a.at.position) throw bad(`index entries ${a.before.position} and ${a.at.position} are not adjacent`);
    if (before.source >= pos) throw bad(`the previous index entry already covers position ${pos} (up to ${before.source}): the entry arrived earlier`);
    if (before.block >= at.block || before.source >= at.source) throw bad(`the index chain is not increasing between entries ${a.before.position} and ${a.at.position}`);
  }
  if (at.block > blk) throw refusal21(State.BlockBeforeArrival, id, blk, `${p.url}: the entry arrived in block ${at.block}, after the page's block`);
  return at.block;
}

/** normURL: the canonical spelling of a parsed URL. */
export const normURL = (u: AccUrl | undefined): string => (u ? normalizeAccURL(u.toString()) : '');

function parseVote(s: string): bigint | undefined {
  switch (s) {
    case 'accept':
      return 0n;
    case 'reject':
      return 1n;
    case 'abstain':
      return 2n;
    case 'suggest':
      return 3n;
  }
  return undefined;
}

/** The timeline map: canonical page spelling -> the page's certified states. */
export type TimelineStates = Map<string, States>;

/** foldTimelines replays every history the evidence carries (a carried history is always verified), and returns the states by page. */
export function foldTimelines(ev: Evidence, byURL: Map<string, ProvenAcct>): TimelineStates {
  const out: TimelineStates = new Map();
  for (const p of ev.pages) {
    if (!p.history) continue;
    const u = AccUrl.parse(p.url);
    if (!u) throw new VerifyError(`page ${p.url}: not a URL`);
    const pa = byURL.get(lk(u))!;
    out.set(normalizeAccURL(p.url), replayHistory(pa, p));
  }
  return out;
}

/**
 * timelineEngaged says whether the evidence carries everything the vote re-evaluation needs: the transaction, a history for every page a
 * counted signature was recorded on, and the arrival proof of every counted signature. When it does not, the votes are not re-evaluated
 * and the report says so by name.
 */
export function timelineEngaged(ev: Evidence, tl: TimelineStates): { engaged: boolean; why: string } {
  if (ev.transaction === '') return { engaged: false, why: 'the evidence carries no transaction, so the page blacklist and the required authorities are unknown' };
  if (ev.votes.length === 0) return { engaged: false, why: 'the evidence carries no vote' };
  for (const v of ev.votes) {
    if ((v.hops?.length ?? 0) === 0) return { engaged: false, why: `the vote of ${v.authority} carries no cause chain` };
    for (const h of allHops(v)) {
      if (!h.arrival) return { engaged: false, why: `the signature on ${h.page} carries no arrival proof` };
      if (!tl.has(normalizeAccURL(h.page))) return { engaged: false, why: `${h.page} carries no history` };
    }
  }
  return { engaged: true, why: '' };
}

/** What the timeline needs from the rest of the 2.1 verification. */
export interface TimelineIn {
  ev: Evidence;
  rep: Report21;
  x: XIn;
  byURL: Map<string, ProvenAcct>;
  auths: { url: AccUrl; disabled: boolean }[];
  anchor: Map<string, XAnchor>;
}

class StatesSource {
  constructor(private readonly tl: TimelineStates) {}
  timeline(page: string): Timeline {
    const st = this.tl.get(normalizeAccURL(page));
    if (!st) throw new VerifyError(`the evidence carries no certified history for ${page}`);
    return st;
  }
}

/** releasedAt is the block that produced a held transaction's vote (the release), derived from the vote's production proof, or 0. */
function releasedAt(inn: TimelineIn, txn: WireNode, v: Vote): number {
  if (holdUntilOf(txn) === 0n || !v.produced) return 0;
  const pr = v.produced;
  const au = AccUrl.parse(pr.account);
  if (!au) return 0;
  const pa = inn.byURL.get(lk(au));
  if (!pa) return 0;
  try {
    return deriveArrival(pa, inn.ev.pages[pa.i]!, pr.chain, pr.message, pr.receipt, pr.arrival);
  } catch {
    return 0;
  }
}

/** evaluateTimeline is steps 4-5: arrival blocks derived, vote model run on the certified timeline, result compared with every recorded vote, readiness required. */
export function evaluateTimeline(inn: TimelineIn, tl: TimelineStates): void {
  const { ev, rep } = inn;
  const xa = inn.x.x;
  let txn: WireNode;
  try {
    txn = decodeTxnHex(ev.transaction);
  } catch (e) {
    throw refusal21(State.TransactionMismatch, xa.id, xa.block, (e as Error).message);
  }
  const txHash = new Uint8Array(Buffer.from(ev.txHash, 'hex'));
  const th = txnHash(txn);
  if (!equal(th, txHash)) {
    throw refusal21(State.TransactionMismatch, xa.id, xa.block, `the carried transaction hashes to ${toHex(th.subarray(0, 8))}, not the transaction ${ev.txHash.slice(0, 16)}`);
  }
  const principal = principalOf(txn);
  if (!principal || !goEqualFold(principal.toString(), ev.account)) {
    throw refusal21(State.TransactionMismatch, xa.id, xa.block, `the carried transaction acts on ${principal}, not ${ev.account}`);
  }
  const typ = bodyType(txn);

  const facts: Facts = { txType: typ, sigs: [], arrivals: [], votes: [], holdUntil: holdUntilOf(txn) };
  const seen = new Set<string>();
  for (const v of ev.votes) {
    const vt = parseVote(v.vote);
    if (vt === undefined) throw new VerifyError(`vote of ${v.authority}: ${JSON.stringify(v.vote)} is not a vote`);
    for (const h of allHops(v)) {
      const hp = AccUrl.parse(h.page);
      if (!hp) throw new VerifyError(`vote hop page ${JSON.stringify(h.page)}: not a URL`);
      const pa = inn.byURL.get(lk(hp))!;
      const p = ev.pages[pa.i]!;
      const block = deriveArrival(pa, p, 'signature', h.message, h.receipt, h.arrival!);
      if (block !== h.block) {
        throw refusal21(State.ArrivalUnproven, pa.anchor.id, pa.anchor.block, `the signature on ${h.page} was claimed to arrive in block ${h.block}, its signature-index chain says ${block}`);
      }
      let sig: WireNode;
      try {
        sig = requireSig(decodeSigHex(h.signature));
      } catch (e) {
        throw refusal21(State.SignatureInvalid, pa.anchor.id, pa.anchor.block, `${h.page}: ${(e as Error).message}`);
      }
      if (toHex(signatureHash(sig)) !== h.message.toLowerCase()) {
        throw refusal21(State.SignatureInvalid, pa.anchor.id, pa.anchor.block, `the signature on ${h.page} is not the message its chain entry holds`);
      }
      rep.arrivals.push({ kind: 'signature', account: h.page, partition: pa.anchor.source, message: h.message, block });
      if (seen.has(h.message)) continue;
      seen.add(h.message);
      if (isAuthoritySignature(sig)) {
        const delegators = urlsOf(sig, 'delegator');
        if (delegators.length === 0 || normURL(delegators[0]) !== normalizeAccURL(h.page)) {
          throw refusal21(State.SignatureInvalid, pa.anchor.id, pa.anchor.block, `the delegated vote recorded on ${h.page} does not name it as its first delegator`);
        }
        const beyond = delegators.slice(1);
        const path = beyond.map((_, i) => normURL(beyond[beyond.length - 1 - i]));
        facts.arrivals.push({
          id: h.message,
          page: normalizeAccURL(h.page),
          authority: normURL(urlOf(sig, 'authority')),
          path,
          block,
          origin: normURL(urlOf(sig, 'origin')),
          vote: bigOf(sig, 'vote'),
        });
        continue;
      }
      const vs = verifyKeySignature(sig, txn, inn.x.network, pa, h.page, block);
      const ks = vs.inner;
      const signer = urlOf(ks, 'signer');
      if (normURL(signer) !== normalizeAccURL(h.page)) {
        throw refusal21(State.SignatureInvalid, pa.anchor.id, pa.anchor.block, `the signature on ${h.page} is by ${signer}`);
      }
      const { path } = unwrapSignature(sig, (u) => normalizeAccURL(u.toString()));
      facts.sigs.push({
        id: h.message,
        signer: normalizeAccURL(h.page),
        path,
        version: signerVersionOf(ks),
        keyHash: toHex(vs.keyHash),
        vote: voteOf(sig),
        block,
        partition: pa.anchor.id.toLowerCase(),
      });
    }
    facts.votes.push({ id: v.message, authority: normalizeAccURL(v.authority), origin: normalizeAccURL(v.origin), vote: vt, releasedAt: releasedAt(inn, txn, v) });
  }

  // The authorities the transaction requires (design D1, D3): the principal's enabled authorities (the disabled too when the type requires
  // authorization), plus the header's and the body's.
  const require = requireAuthorization(typ);
  let allDisabled = true;
  const listed = new Set<string>();
  const auths: AccountAuthority[] = [];
  for (const a of inn.auths) {
    listed.add(lk(a.url));
    if (!a.disabled || require) {
      allDisabled = false;
      auths.push({ url: normURL(a.url) });
    }
  }
  allDisabled = allDisabled && !require;
  rep.authorizationMode = allDisabled ? MODE_ALL_AUTHORITIES_DISABLED : MODE_AUTHORITIES_REQUIRED;
  const extra = new Set<string>();
  const extras: string[] = [];
  const addExtra = (u: AccUrl): void => {
    if (extra.has(lk(u))) return;
    extra.add(lk(u));
    if (!inn.byURL.has(lk(u))) {
      throw refusal21(State.HeaderAuthorityMissing, xa.id, xa.block, `the transaction requires the authority ${u}, which has no proven pages`);
    }
    extras.push(normURL(u));
  };
  for (const a of headerAuthorities(txn)) addExtra(a);
  for (const a of additionalAuthorities(txn)) addExtra(a);
  // Every recorded vote is reproduced, whether or not its authority is required: evaluate the voters too.
  const evalAuths: AccountAuthority[] = [...auths];
  const have = new Set<string>(evalAuths.map((a) => a.url));
  for (const e of extras) have.add(e);
  for (const v of facts.votes) {
    if (!have.has(v.authority)) {
      have.add(v.authority);
      evalAuths.push({ url: v.authority });
    }
  }
  let res: ReturnType<typeof evaluate>;
  try {
    res = evaluate(facts, new StatesSource(tl), ev.account, evalAuths, extras, false);
  } catch (e) {
    if (e instanceof VoteUnevaluable) throw refusal21(State.VoteNotReproduced, xa.id, xa.block, e.message);
    throw new VerifyError(`the vote model: ${e instanceof Error ? e.message : String(e)}`);
  }
  const byAuth = new Map(res.authorities.map((a) => [a.authority, a.vote]));
  for (const v of facts.votes) {
    const bv = byAuth.get(v.authority);
    if (!bv || !bv.voted || bv.by !== v.origin || bv.vote.toLowerCase() !== voteName(Number(v.vote)).toLowerCase()) {
      const got = bv?.voted ? `${bv.vote} by ${bv.by}` : 'no vote';
      throw refusal21(
        State.VoteNotReproduced,
        xa.id,
        xa.block,
        `the recorded vote of ${v.authority} (${voteName(Number(v.vote))} by ${v.origin}) is not reproduced on the certified timeline: ${got}`,
      );
    }
    if (!listed.has(goLower(v.authority.replace(/\/$/, ''))) && !extra.has(goLower(v.authority))) {
      if (!allDisabled) {
        throw refusal21(State.VoteNotReproduced, xa.id, xa.block, `the recorded vote of ${v.authority} is by an authority outside the principal's set while other authorities are enabled`);
      }
      rep.disclosures.push(
        stateEntry(
          State.AuthorityVoterOutsideList,
          xa.id,
          xa.block,
          `${v.authority} voted although every listed authority is disabled; the executor accepts any authority's vote then (sig_common.go:367-369)`,
        ),
      );
    }
  }
  // Readiness (transaction.go:194-218): each required authority voted accept; with every authority disabled the executor needs one recorded
  // vote and nothing more.
  for (const a of auths) {
    const bv = byAuth.get(a.url);
    if (!bv || !bv.voted || bv.vote !== 'accept') throw refusal21(State.AuthorityNotReady, xa.id, xa.block, `the authority ${a.url} did not vote accept on the certified timeline`);
  }
  for (const e of extras) {
    const bv = byAuth.get(e);
    if (!bv || !bv.voted || bv.vote !== 'accept') {
      throw refusal21(State.AuthorityNotReady, xa.id, xa.block, `the authority ${e} the transaction names did not vote accept on the certified timeline`);
    }
  }
  if (allDisabled && facts.votes.length === 0) throw refusal21(State.AuthorityNotReady, xa.id, xa.block, 'every authority is disabled and no authority voted');
}

/**
 * verifyProductions establishes, for each vote, the block that produced it (design D3, D6): the SequencedMessage's entry in the source
 * partition's synthetic ledger main chain (a sequenced vote), or the vote's own entry in the principal's signature chain (an inline one).
 * A vote with no production proof is the named state g1_vote_held when the transaction is held or the vote was sequenced.
 */
export function verifyProductions(inn: TimelineIn): void {
  const { ev, rep } = inn;
  let held = false;
  const ctxn = carriedTransaction(ev, inn.x.x);
  if (ctxn) held = holdUntilOf(ctxn) !== 0n;
  for (const v of ev.votes) {
    let srcID = inn.x.x.id;
    let srcBlock = inn.x.x.block;
    if (v.transport.kind === 'sequenced') {
      const a = inn.anchor.get(v.transport.source.toLowerCase());
      if (a) {
        srcID = a.id;
        srcBlock = a.block;
      }
    }
    if (!v.produced) {
      // The production is needed to place a vote only when the transaction is held. A sequenced vote without a production keeps the name the
      // shipped vectors pin whether or not the transaction is held; an inline vote on a transaction that is not held needs none.
      if (held || v.transport.kind === 'sequenced') {
        rep.unproven.push(
          stateEntry(
            State.VoteHeld,
            srcID,
            srcBlock,
            `the block that produced the vote of ${v.authority} is not established (a HoldUntil release may have produced it later than its signature arrived)`,
          ),
        );
      }
      continue;
    }
    const pr = v.produced;
    const au = AccUrl.parse(pr.account);
    if (!au) throw new VerifyError(`vote of ${v.authority}: production account ${JSON.stringify(pr.account)}: not a URL`);
    const pa = inn.byURL.get(lk(au));
    if (!pa) {
      throw refusal21(State.CompletenessUnproven, srcID, srcBlock, `${pr.account} records the production of the vote of ${v.authority} but is not among the proven pages`);
    }
    switch (v.transport.kind) {
      case 'inline':
        if (!goEqualFold(pr.account, ev.account) || pr.chain !== 'signature' || !goEqualFold(pr.message, v.message)) {
          throw refusal21(State.ArrivalUnproven, srcID, srcBlock, "an inline vote is produced where the principal's signature chain records it");
        }
        break;
      case 'sequenced': {
        const src = inn.anchor.get(v.transport.source.toLowerCase());
        if (!src) throw refusal21(State.PartitionAnchorUnavailable, v.transport.source, 0, 'no anchor for the partition that produced the vote');
        const want = partitionUrl(src.id).joinPath(SYNTHETIC);
        if (!goEqualFold(pr.account, want.toString()) || pr.chain !== 'main') {
          throw refusal21(State.ArrivalUnproven, src.id, src.block, `a sequenced vote is produced in ${want}'s main chain, not ${pr.account} ${pr.chain}`);
        }
        if (pa.acct.cls !== 'SyntheticLedger') throw refusal21(State.ArrivalUnproven, src.id, src.block, `${pr.account} is ${pa.acct.cls}, not a synthetic ledger`);
        if (!pr.sequenced) {
          rep.disclosures.push(
            stateEntry(
              State.VoteProductionUnbound,
              src.id,
              src.block,
              `the production of the vote of ${v.authority} names the synthetic ledger entry that holds it but the document does not carry the SequencedMessage that entry is the hash of: nothing ties the entry to the vote`,
            ),
          );
        } else bindSequenced(pr, v, src);
        break;
      }
    }
    const block = deriveArrival(pa, ev.pages[pa.i]!, pr.chain, pr.message, pr.receipt, pr.arrival);
    // A vote is produced after the signature that caused it arrived (the last hop is the vote's cause).
    for (const h of (v.hops ?? []).slice(0, Math.min(1, (v.hops ?? []).length))) {
      const hp = AccUrl.parse(h.page);
      const hpa = inn.byURL.get(lk(hp!))!;
      if (hpa.anchor.id === pa.anchor.id && block < h.block) {
        throw refusal21(State.BlockBeforeArrival, pa.anchor.id, pa.anchor.block, `the vote of ${v.authority} was produced in block ${block}, before the signature that caused it arrived in block ${h.block}`);
      }
    }
    rep.arrivals.push({ kind: 'produced', account: pr.account, partition: pa.anchor.source, message: pr.message, block });
  }
}

/**
 * bindSequenced requires a sequenced vote's production to be the vote (RB9 verifier round VA, DEF-4): the carried SequencedMessage hashes
 * to the synthetic ledger entry the production proves, wraps the SignatureMessage whose hash is the vote's Message, and names the vote's
 * transport (source, destination, number).
 */
export function bindSequenced(pr: Production, v: Vote, src: XAnchor): void {
  const bad = (m: string): NamedStateError => refusal21(State.ArrivalUnproven, src.id, src.block, m);
  const seq = pr.sequenced!;
  if (toHex(seq.hash) !== pr.message.toLowerCase()) {
    throw bad(`the production of the vote of ${v.authority}: the sequenced message hashes to ${toHex(seq.hash.subarray(0, 8))}, not to the synthetic ledger entry ${pr.message}`);
  }
  if (seq.kind !== 'signature') throw bad(`the production of the vote of ${v.authority}: the sequenced message wraps a ${seq.kind}, not a signature message`);
  if (!seq.sigHash || toHex(seq.sigHash) !== v.message.toLowerCase()) {
    throw bad(`the production of the vote of ${v.authority}: the sequenced message wraps the signature message ${seq.sigHash ? toHex(seq.sigHash.subarray(0, 8)) : ''}, not the vote ${v.message}`);
  }
  if (
    !seq.source ||
    !seq.destination ||
    !goEqualFold(seq.source.toString(), v.transport.source) ||
    !goEqualFold(seq.destination.toString(), v.transport.destination) ||
    seq.number !== BigInt(v.transport.number)
  ) {
    throw bad(
      `the production of the vote of ${v.authority}: the sequenced message is ${seq.source} -> ${seq.destination} #${seq.number}, the vote's transport is ${v.transport.source} -> ${v.transport.destination} #${v.transport.number}`,
    );
  }
}

void [KeyPage, nodeOf, nodesOf, sha256, LEDGER];
export type { Vote };
export type { SigFact, ArrivalFact, RecordedVote };
export { carriedTransaction };
