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

/** ConsensusTxLimit is the largest transaction CERTEN's consensus engine accepts by default (CometBFT max_tx_bytes). */
export const CONSENSUS_TX_LIMIT = 1 << 20;
/** CertificateReserve is what the rest of the intent certificate may take of that transaction. */
export const CERTIFICATE_RESERVE = 96 << 10;
/** MaxEvidenceBytes is the budget of the encoded evidence document. */
export const MAX_EVIDENCE_BYTES = CONSENSUS_TX_LIMIT - CERTIFICATE_RESERVE;
/** FixedEvidenceBytes is the largest fixed part (everything but the pages, votes and transaction) measured on a real evidence. */
export const FIXED_EVIDENCE_BYTES = 760_000;

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

/** CheckClosureBudget: the early form of the same check the capture asks, before the document is built. */
export function checkClosureBudget(pages: PageState[], votes: Vote[], partition: string, block: number): void {
  let size = FIXED_EVIDENCE_BYTES;
  for (const p of pages) size += utf8Length(pageJson(p));
  size += utf8Length(votes.length === 0 ? 'null' : arr(votes.map(voteJson)));
  if (size > MAX_EVIDENCE_BYTES) {
    throw refusal21(
      State.ClosureExceedsBudget,
      partition,
      block,
      `pages=${pages.length} limit=${MAX_EVIDENCE_BYTES}: the pages and votes encode to ${size} bytes with the ${FIXED_EVIDENCE_BYTES}-byte fixed part, over the ${MAX_EVIDENCE_BYTES} bytes the consensus transaction limit (${CONSENSUS_TX_LIMIT}) leaves the evidence`,
    );
  }
}

export type { Rcpt };
