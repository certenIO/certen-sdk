/**
 * The evidence budget (validator xbudget.go): evidence travels in ONE consensus transaction, so a governing set whose encoded evidence does
 * not fit is the named state g1_closure_exceeds_budget, never a truncated closure.
 *
 * The measure is the length of Go's json.Marshal of the Evidence document - the form consensus carries - so this module writes that
 * document exactly as encoding/json does (field order, omitempty, HTML-safe string escapes, sorted map keys, every binary value as the
 * hex of the bytes Accumulate's marshaller writes for it) and counts the bytes. Every binary encoding it needs is computed from the
 * portable JSON the way Go's Import computes it, at import (a record that does not marshal is refused there).
 */
import { toHex } from '../proof-v2/bytes.js';
import type { CheckAccount } from './setcheck.js';
import type { Arrival, ChainRoot, Evidence, Hop, IndexProof, PageState, PartitionAnchorX, Production, Vote } from './evidence.js';
import type { Rcpt } from './rcpt.js';
import type { XAnchor } from './executor.js';
import { list, struct, str, u64 } from './gojson.js';
import { refusal21, State } from './states.js';
import { CertifyCode, CertifyState } from './certify.js';

/** ConsensusTxLimit is the largest transaction CERTEN's consensus engine accepts by default (CometBFT max_tx_bytes). */
export const CONSENSUS_TX_LIMIT = 1 << 20;
/**
 * CertificateReserve is what the rest of the intent certificate (R) may take of that transaction: the largest measured R (258,469) plus the vote
 * evidence of a closure of 8 pages (V-E A4: at least 320 KiB).
 */
export const CERTIFICATE_RESERVE = 320 << 10;
/** MaxEvidenceBytes is the budget of the encoded evidence document. */
export const MAX_EVIDENCE_BYTES = CONSENSUS_TX_LIMIT - CERTIFICATE_RESERVE;
/** FixedEvidenceBytes is the largest fixed part (everything but the pages, votes and transaction) of the ANCHORED form, budgeted for BUDGETED_VALIDATORS validators. */
export const FIXED_EVIDENCE_BYTES = 40_000;
/** ValidatorSignatureBytes is one validator's signature entry in a record (measured: 165). */
export const VALIDATOR_SIGNATURE_BYTES = 165;
/** BudgetedValidators is the validator count FixedEvidenceBytes is budgeted for; the measurement was taken at MeasuredValidators. */
export const BUDGETED_VALIDATORS = 16;
export const MEASURED_VALIDATORS = 3;
/** RestFlatBytes is the largest R measured in production (258,469): the part of R that does not grow with the closure. */
export const REST_FLAT_BYTES = 260_000;
/** VoteEvidenceBytesPerPage is the largest vote evidence per closure page measured on the live intents (7,503), rounded up. */
export const VOTE_EVIDENCE_BYTES_PER_PAGE = 7_600;

// The evidence 2.0 values. A 2.0 document still holds the minor-root runs since the last major, so its fixed part is the 760,000 the old constant
// measured, and it is judged against the 96 KiB reserve it always had (RB9-F5 invariant 2): nothing on the 2.0 path tightens or loosens.
/** CertificateReserve20 is the reserve evidence 2.0 was judged with. */
export const CERTIFICATE_RESERVE_20 = 96 << 10;
/** MaxEvidenceBytes20 is the evidence 2.0 budget (950,272). */
export const MAX_EVIDENCE_BYTES_20 = CONSENSUS_TX_LIMIT - CERTIFICATE_RESERVE_20;
/** FixedEvidenceBytes20 is the fixed part measured on a real 2.0 evidence (731,778 bytes, rounded up). */
export const FIXED_EVIDENCE_BYTES_20 = 760_000;

/** CertificateEstimate is the size of the whole certificate for an evidence of evidenceBytes and a closure of pages pages. */
export const certificateEstimate = (evidenceBytes: number, pages: number): number => evidenceBytes + REST_FLAT_BYTES + VOTE_EVIDENCE_BYTES_PER_PAGE * pages;

/** certificate_budget{size,limit}: the whole certificate does not fit the path (the same decision as the transaction path's tx_too_large), judged at where. */
function certificateBudget(size: number, where: string, why: string): CertifyState {
  return new CertifyState(CertifyCode.CertificateBudget, [String(size), String(CONSENSUS_TX_LIMIT)], `: judged at ${where}: ${why}`);
}

/** CheckCertificateFits judges the whole certificate before it is signed: the estimate must be inside ConsensusTxLimit, else certificate_budget{size,limit}. */
export function checkCertificateFits(evidenceBytes: number, pages: number, where: string): void {
  const size = certificateEstimate(evidenceBytes, pages);
  if (size > CONSENSUS_TX_LIMIT) {
    throw certificateBudget(
      size,
      where,
      `the evidence is ${evidenceBytes} bytes and the rest of the transaction is estimated at ${size - evidenceBytes} (${REST_FLAT_BYTES} flat + ${VOTE_EVIDENCE_BYTES_PER_PAGE} per page x ${pages} pages): ${size - CONSENSUS_TX_LIMIT} bytes over the ${CONSENSUS_TX_LIMIT} the consensus path accepts (tx_too_large)`,
    );
  }
}

/** UpdateWindowsBytes is what the signature entries of k update-bearing windows take at V validators. */
export const updateWindowsBytes = (k: number, validators: number): number => k * validators * VALIDATOR_SIGNATURE_BYTES;

/** MaxUpdateWindows is the largest number of update windows whose signatures, at V validators, fit MaxEvidenceBytes beside the fixed part and otherBytes; 0 when none does. */
export function maxUpdateWindows(validators: number, otherBytes: number): number {
  const room = MAX_EVIDENCE_BYTES - FIXED_EVIDENCE_BYTES - otherBytes;
  if (validators <= 0 || room < updateWindowsBytes(1, validators)) return 0;
  return Math.floor(room / updateWindowsBytes(1, validators));
}

/** CheckUpdateWindows refuses, by certificate_budget{size,limit}, a certify of k update windows at V validators whose signature entries alone are over the evidence budget (the k x V bound). */
export function checkUpdateWindows(k: number, validators: number, otherBytes: number, suffix = ''): void {
  const sig = updateWindowsBytes(k, validators);
  const ev = FIXED_EVIDENCE_BYTES + otherBytes + sig;
  if (ev > MAX_EVIDENCE_BYTES) {
    throw certificateBudget(
      ev + CERTIFICATE_RESERVE,
      'the update windows',
      `k=${k} windows x validators=${validators} x ${VALIDATOR_SIGNATURE_BYTES} bytes = ${sig} bytes of signature entries with the ${FIXED_EVIDENCE_BYTES}-byte fixed part and ${otherBytes} other bytes is over the ${MAX_EVIDENCE_BYTES}-byte evidence budget (largest k at this V: ${maxUpdateWindows(validators, otherBytes)}; tx_too_large)`,
    );
  }
}

/**
 * CheckAssembledBudget is the builder's pre-sign check on an assembled evidence 2.1: its links are one update window each (the k of the k x V bound,
 * at the report's validator count), and its encoding with the rest of the transaction, scaled by its pages, must fit the path limit.
 */
export function checkAssembledBudget(ev: Evidence, validators: number, partition: string, block: number): void {
  const where = `${partition} block ${block}`;
  checkUpdateWindows(ev.links.length, validators, 0, ` (${where})`);
  checkCertificateFits(utf8Length(evidenceJson(ev)), ev.pages.length, where);
}

// --------------------------------------------------------------------------------------------------------------------------------
// Go's encoding/json, for the shapes of an Evidence

/** The text encoding/json writes for a Go string (HTML escaping on, Go 1.22+ short escapes for \b and \f). */
export function goJsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else if (ch === '<' || ch === '>' || ch === '&') out += `\\u${c.toString(16).padStart(4, '0')}`;
    else if (c === 0x2028 || c === 0x2029) out += `\\u${c.toString(16)}`;
    else if (c >= 0xd800 && c <= 0xdfff) out += '�'; // a lone surrogate: Go decoded it as U+FFFD
    else out += ch;
  }
  return `${out}"`;
}

const hexJson = (b: Uint8Array): string => `"${toHex(b)}"`;
const strJson = goJsonString;

/** A struct as encoding/json writes it: members in order, an omitted member not at all. */
function obj(members: (string | undefined)[]): string {
  return `{${members.filter((m): m is string => m !== undefined).join(',')}}`;
}
const member = (name: string, value: string): string => `${strJson(name)}:${value}`;
const opt = (name: string, value: string | undefined): string | undefined => (value === undefined ? undefined : member(name, value));
const arr = (items: string[]): string => `[${items.join(',')}]`;

function indexProofJson(p: IndexProof): string {
  return obj([member('position', String(p.position)), member('entry', strJson(p.entry)), member('receipt', hexJson(p.receipt.bin))]);
}
function arrivalJson(a: Arrival): string {
  return obj([opt('before', a.before ? indexProofJson(a.before) : undefined), member('at', indexProofJson(a.at))]);
}
function hopJson(h: Hop): string {
  return obj([
    member('page', strJson(h.page)),
    member('message', strJson(h.message)),
    member('signature', strJson(h.signature)),
    member('block', String(h.block)),
    member('receipt', hexJson(h.receipt.bin)),
    opt('arrival', h.arrival ? arrivalJson(h.arrival) : undefined),
  ]);
}
function productionJson(p: Production): string {
  return obj([
    member('account', strJson(p.account)),
    member('chain', strJson(p.chain)),
    member('message', strJson(p.message)),
    member('receipt', hexJson(p.receipt.bin)),
    member('arrival', arrivalJson(p.arrival)),
    opt('sequenced', p.sequenced ? hexJson(p.sequenced.bin) : undefined),
  ]);
}
export function voteJson(v: Vote): string {
  const t = v.transport;
  return obj([
    member('authority', strJson(v.authority)),
    member('origin', strJson(v.origin)),
    member('vote', strJson(v.vote)),
    opt('cause', v.cause !== '' ? strJson(v.cause) : undefined),
    member(
      'transport',
      obj([member('kind', strJson(t.kind)), opt('source', t.source !== '' ? strJson(t.source) : undefined), opt('destination', t.destination !== '' ? strJson(t.destination) : undefined), opt('number', t.number !== 0 ? String(t.number) : undefined)]),
    ),
    member('message', strJson(v.message)),
    member('receipt', hexJson(v.receipt.bin)),
    opt('hops', v.hops && v.hops.length > 0 ? arr(v.hops.map(hopJson)) : undefined),
    opt('counted', v.counted && v.counted.length > 0 ? arr(v.counted.map(hopJson)) : undefined),
    opt('produced', v.produced ? productionJson(v.produced) : undefined),
  ]);
}

function chainRootJson(c: ChainRoot): string {
  return obj([
    member('name', strJson(c.name)),
    member('pending', c.pending === undefined ? 'null' : arr(c.pending.map((p) => (p === null ? 'null' : strJson(p))))),
    member('count', String(c.count)),
    member('anchor', strJson(c.anchor)),
  ]);
}
const chainsJson = (cs: ChainRoot[] | undefined): string => (cs === undefined ? 'null' : arr(cs.map(chainRootJson)));

export function pageJson(p: PageState): string {
  return obj([
    member('url', strJson(p.url)),
    member('state', hexJson(p.state)),
    member('receipt', hexJson(p.receipt.bin)),
    opt('chains', p.chains.length > 0 ? chainsJson(p.chains) : undefined),
    opt('pendingHash', p.pendingHash !== '' ? strJson(p.pendingHash) : undefined),
    opt('chainError', p.chainError !== '' ? strJson(p.chainError) : undefined),
    opt('partition', p.partition !== '' ? strJson(p.partition) : undefined),
    opt('roles', p.roles && p.roles.length > 0 ? arr(p.roles.map(strJson)) : undefined),
    opt(
      'history',
      p.history
        ? obj([
            member(
              'entries',
              p.history.entries === undefined ? 'null' : arr(p.history.entries.map((e) => obj([member('transaction', strJson(e.transaction)), opt('initiator', e.initiator !== '' ? strJson(e.initiator) : undefined)]))),
            ),
            member('index', p.history.index === undefined ? 'null' : arr(p.history.index.map(strJson))),
          ])
        : undefined,
    ),
  ]);
}

function anchorJson(a: PartitionAnchorX): string {
  return obj([member('message', hexJson(a.message.bin)), member('receipt', hexJson(a.receipt.bin))]);
}

/** proof.AccountStateProof as encoding/json writes it, from its portable form. */
function accountProofJson(a: CheckAccount): string {
  const rc = a.receipt;
  const raw = (a.json.stateReceipt ?? {}) as Record<string, unknown>;
  const entries = list(struct(raw, ['start', 'anchor', 'localBlock', 'entries'], 'chained_proof.Receipt').entries, 'entries');
  return obj([
    member('accountUrl', strJson(a.accountUrl)),
    member('accountState', hexJson(a.state)),
    member(
      'stateReceipt',
      obj([
        member('start', strJson(rc.start)),
        member('anchor', strJson(rc.anchor)),
        member('localBlock', String(u64(struct(raw, ['start', 'anchor', 'localBlock', 'entries'], 'chained_proof.Receipt').localBlock, 'localBlock'))),
        member('entries', entries === undefined ? 'null' : arr(rc.entries.map((e) => obj([member('hash', strJson(e.hash)), member('right', e.right ? 'true' : 'false')])))),
      ]),
    ),
    member('chains', rawChainsJson(a.json.chains)),
    member('secondaryHash', strJson(a.secondaryHash)),
    member('pendingHash', strJson(a.pendingHash)),
  ]);
}

function rawChainsJson(v: unknown): string {
  const l = list(v, 'chains');
  if (l === undefined) return 'null';
  return arr(
    l.map((c) => {
      const s = struct(c, ['name', 'pending', 'count', 'anchor'], 'ChainRoot');
      const pl = list(s.pending, 'pending');
      return obj([
        member('name', strJson(str(s.name, 'name'))),
        member('pending', pl === undefined ? 'null' : arr(pl.map((p) => (p === null ? 'null' : strJson(str(p, 'pending')))))),
        member('count', String(u64(s.count, 'count'))),
        member('anchor', strJson(str(s.anchor, 'anchor'))),
      ]);
    }),
  );
}

/** json.Marshal(ev) for the Evidence the import produced. */
export function evidenceJson(ev: Evidence): string {
  const anchors =
    ev.anchors && ev.anchors.size > 0
      ? obj(
          [...ev.anchors.entries()]
            .sort((a, b) => Buffer.compare(Buffer.from(a[0], 'utf8'), Buffer.from(b[0], 'utf8')))
            .map(([k, a]) => member(k, anchorJson(a))),
        )
      : undefined;
  return obj([
    member('version', strJson(ev.version)),
    member('account', strJson(ev.account)),
    member('txHash', strJson(ev.txHash)),
    member('receipt', hexJson(ev.receipt.bin)),
    member('majors', String(ev.majors)),
    member('certify', ev.certifyBin.length === 0 ? 'null' : arr(ev.certifyBin.map(hexJson))),
    member('anchor', anchorJson(ev.anchor)),
    opt('pages', ev.pages.length > 0 ? arr(ev.pages.map(pageJson)) : undefined),
    opt('anchors', anchors),
    opt('votes', ev.votes.length > 0 ? arr(ev.votes.map(voteJson)) : undefined),
    opt('transaction', ev.transaction !== '' ? strJson(ev.transaction) : undefined),
    opt('links', ev.links.length > 0 ? arr(ev.links.map((l) => hexJson(l.bin))) : undefined),
    opt('genesisLink', ev.genesisLink ? hexJson(ev.genesisLink.bin) : undefined),
    member(
      'check',
      obj([
        member('majors', String(ev.check.majors)),
        member('hops', ev.check.hopsBin.length === 0 ? 'null' : arr(ev.check.hopsBin.map(hexJson))),
        member(
          'set',
          obj([member('incarnation', strJson(ev.check.incarnation)), member('network', accountProofJson(ev.check.network)), member('globals', accountProofJson(ev.check.globals))]),
        ),
        opt('routing', ev.check.routing ? accountProofJson(ev.check.routing) : undefined),
      ]),
    ),
  ]);
}

const utf8Length = (s: string): number => Buffer.byteLength(s, 'utf8');

function budgetState(pages: number, size: number, x: XAnchor): never {
  throw refusal21(
    State.ClosureExceedsBudget,
    x.id,
    x.block,
    `pages=${pages} limit=${MAX_EVIDENCE_BYTES}: the encoded evidence is ${size} bytes, over the ${MAX_EVIDENCE_BYTES} bytes the consensus transaction limit (${CONSENSUS_TX_LIMIT}) leaves it`,
  );
}

/** CheckEvidenceBudget: the evidence as consensus carries it (JSON) must fit the transaction limit less the certificate's reserve. */
export function checkEvidenceBudget(ev: Evidence, x: XAnchor): void {
  const size = utf8Length(evidenceJson(ev));
  if (size > MAX_EVIDENCE_BYTES) budgetState(ev.pages.length, size, x);
}

/**
 * CheckClosureBudget: the early form of the same check the capture asks, before the document is built, for the document form the capture becomes
 * (version '2.0' or '2.1'; any other value is an error, never a default). Evidence 2.0 is judged exactly as it always was (the 2.0 fixed part and
 * reserve; nothing else is checked); evidence 2.1 with the anchored form's constants, and the whole certificate they imply must fit the path limit.
 */
export function checkClosureBudget(version: string, pages: PageState[], votes: Vote[], partition: string, block: number): void {
  let fixed: number;
  let limit: number;
  if (version === '2.0') [fixed, limit] = [FIXED_EVIDENCE_BYTES_20, MAX_EVIDENCE_BYTES_20];
  else if (version === '2.1') [fixed, limit] = [FIXED_EVIDENCE_BYTES, MAX_EVIDENCE_BYTES];
  else throw new Error(`closure budget: unknown evidence version ${JSON.stringify(version)} (judged at ${partition} block ${block})`);
  let size = fixed;
  for (const p of pages) size += utf8Length(pageJson(p));
  size += utf8Length(votes.length === 0 ? 'null' : arr(votes.map(voteJson)));
  if (size > limit) {
    throw refusal21(
      State.ClosureExceedsBudget,
      partition,
      block,
      `pages=${pages.length} limit=${limit}: the pages and votes encode to ${size} bytes with the ${fixed}-byte fixed part, over the ${limit} bytes the consensus transaction limit (${CONSENSUS_TX_LIMIT}) leaves the evidence`,
    );
  }
  if (version === '2.0') return;
  checkCertificateFits(size, pages.length, `${partition} block ${block}`);
}

export type { Rcpt };
