import { createHash } from 'node:crypto';
import { govRootV4FromHashes, pageCounts, type PagesRootPage, type VoteWire } from '../../src/s3/govroot-v4.js';
import { bindProofV21, type G0Result, type G1Result, type GoverningFacts } from '../../src/s3/bind-v21.js';
import { BindError } from '../../src/s3/consensus.js';
import { proofV2Root } from '../../src/s3/proofroot.js';
import { decodeAccount, accountUrl } from '../../src/s3/model.js';
import { NamedState, type PageRole } from '../../src/s3/states.js';
import type { PageChainX } from '../../src/s3/chains.js';
import type { ProvenPage, Report21 } from '../../src/s3/xtypes.js';

/**
 * The scenarios of the Go-written intent corpus (cmd/xtsgen intent): a report, its evidence, the governing inputs, run in one of three modes
 * (bind: BindProofV21 over the facts; root: the 2.1 branch of ProofV2Root; govroot: GovRootV4FromPortable alone). The adapter reads the
 * scenario the way the Go program's types do: an absent or null member is its zero value.
 */
type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const a = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
const bo = (v: unknown): boolean => v === true;
const strs = (v: unknown): string[] => a(v).map(s);
const unhex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
/** The report's hashes are [32]byte in Go: the hex the scenario spells (any case) is the value; the report holds it lower-case. */
const hash = (v: unknown): string => s(v).toLowerCase();

export interface RootOut {
  v: 'ok' | 'named' | 'plain';
  root?: string;
  pagesRoot?: string;
  votesRoot?: string;
  slots?: Record<string, string>;
  bind?: boolean;
  state?: { code: string; partition: string; block: number; detail: string };
  msg?: string;
}

function chainOf(v: unknown): PageChainX {
  const c = o(v);
  return { url: s(c.url), bound: bo(c.bound), mainHeight: n(c.mainHeight) };
}

function provenOf(v: unknown): ProvenPage {
  const p = o(v);
  return { url: s(p.url), partition: s(p.partition), block: n(p.block), roles: strs(p.roles) as PageRole[], declared: strs(p.declared) as PageRole[] };
}

const entryOf = (v: unknown): { code: string; partition: string; block: number; detail: string } => {
  const e = o(v);
  return { code: s(e.code), partition: s(e.partition), block: n(e.block), detail: s(e.detail) };
};

export function reportOf(r: J): Report21 {
  return {
    incarnation: hash(r.incarnation),
    majors: 0,
    certifiedBlock: n(r.certifiedBlock),
    certifiedRoot: hash(r.certifiedRoot),
    checkBlock: 0,
    partition: s(r.partition),
    anchorBlock: n(r.anchorBlock),
    pages: a(r.pages).map((h) => {
      const state = unhex(s(h));
      return { account: decodeAccount(state), state };
    }),
    pageChains: a(r.pageChains).map(chainOf),
    proven: a(r.proven).map(provenOf),
    setVerdict: s(r.setVerdict) as Report21['setVerdict'],
    validators: 0,
    threshold: 0,
    version: '2.1',
    tag: '',
    unproven: a(r.unproven).map(entryOf),
    routingHeight: 0,
    authorizationMode: '',
    disclosures: a(r.disclosures).map(entryOf),
    arrivals: [],
    txHash: hash(r.txHash),
    anchorTxHash: hash(r.anchorTxHash),
    anchorStateRoot: hash(r.anchorStateRoot),
    anchorRootChainAnchor: hash(r.anchorRootChainAnchor),
    accumulateSetRoot: hash(r.accumulateSetRoot),
  };
}

function indexProof(v: unknown): { position: number; entry: string; receipt: string } {
  const p = o(v);
  return { position: n(p.position), entry: s(p.entry), receipt: s(p.receipt) };
}
function arrival(v: unknown): { before?: ReturnType<typeof indexProof>; at: ReturnType<typeof indexProof> } {
  const x = o(v);
  return { ...(x.before && typeof x.before === 'object' ? { before: indexProof(x.before) } : {}), at: indexProof(x.at) };
}
function hop(v: unknown): VoteWire['hops'][number] {
  const h = o(v);
  return { page: s(h.page), message: s(h.message), signature: s(h.signature), block: n(h.block), receipt: s(h.receipt), ...(h.arrival && typeof h.arrival === 'object' ? { arrival: arrival(h.arrival) } : {}) };
}
export function voteOf(v: unknown): VoteWire {
  const x = o(v);
  const t = o(x.transport);
  const p = x.produced && typeof x.produced === 'object' ? o(x.produced) : undefined;
  return {
    authority: s(x.authority),
    origin: s(x.origin),
    vote: s(x.vote),
    cause: s(x.cause),
    transport: { kind: s(t.kind), source: s(t.source), destination: s(t.destination), number: n(t.number) },
    message: s(x.message),
    receipt: s(x.receipt),
    hops: a(x.hops).map(hop),
    counted: a(x.counted).map(hop),
    ...(p ? { produced: { account: s(p.account), chain: s(p.chain), message: s(p.message), receipt: s(p.receipt), arrival: arrival(p.arrival), sequenced: s(p.sequenced) } } : {}),
  };
}

function factsOf(f: J): GoverningFacts {
  return {
    principal: s(f.principal),
    type: n(f.type),
    txHash: unhex(s(f.txHash)),
    authorities: a(f.authorities).map((x) => ({ url: s(o(x).url), disabled: bo(o(x).disabled) })),
    headerAuthorities: strs(f.headerAuthorities),
    initiators: strs(f.initiators),
    initiatorPath: strs(f.initiatorPath),
    signatures: a(f.signatures).map((x) => ({ signer: s(o(x).signer), block: n(o(x).block) })),
    votes: a(f.votes).map((x) => ({ authority: s(o(x).authority), origin: s(o(x).origin), block: n(o(x).block) })),
    arrivals: a(f.arrivals).map((x) => ({ page: s(o(x).page), origin: s(o(x).origin), path: strs(o(x).path), block: n(o(x).block) })),
  };
}

const SLOT_NAMES: Record<string, string> = { l1: 'L1', l2: 'L2', l3: 'L3', l4: 'L4', g0: 'G0', g1: 'G1', g2: 'G2', keyPage: 'keyPage', keyBook: 'keyBook', operationId: 'operationId' };

function refusal(e: unknown, bind: boolean): RootOut {
  const err = e instanceof Error ? e : new Error(String(e));
  const inner = err instanceof BindError && err.inner ? err.inner : err;
  const ns = inner instanceof NamedState ? inner : undefined;
  const out: RootOut = { v: ns ? 'named' : 'plain', msg: err.message };
  if (bind) out.bind = true;
  if (ns) out.state = ns.entry();
  return out;
}

/** The verdict of the TypeScript port on a scenario, in the Go program's shape. */
export function judgeCase(doc: unknown): RootOut {
  const c = o(doc);
  const mode = s(c.mode);
  const report = reportOf(o(c.report));
  const ev = o(c.evidence);
  const evPages = a(ev.pages).map(o);
  const pages: PagesRootPage[] = report.pages.map((p, i) => ({
    account: p.account,
    evidence: { url: s(evPages[i]?.url), state: s(evPages[i]?.state), partition: s(evPages[i]?.partition), roles: strs(evPages[i]?.roles) },
    chain: report.pageChains[i] ?? { url: '', bound: false, mainHeight: 0 },
    proven: report.proven[i] ?? { url: '', partition: '', block: 0, roles: [], declared: [] },
  }));
  void accountUrl;
  const counts = { chains: report.pageChains.length, proven: report.proven.length, evidence: evPages.length };
  void pageCounts;
  const votes = a(ev.votes).map(voteOf);
  const g0c = o(c.g0);
  const g0: G0Result = { entryHashExec: s(g0c.entryHashExec), receiptStart: s(g0c.receiptStart), execWitness: s(g0c.execWitness), execMBI: n(g0c.execMBI) };
  const g1: G1Result = { authoritySnapshotPage: s(c.g1Page) };
  const h = o(c.hashes);
  const inputs = { g0Hash: s(h.g0Hash), g1Hash: s(h.g1Hash), g2Hash: s(h.g2Hash), keyPageUrl: s(c.keyPage), keyBookUrl: s(c.keyBook), operationId: s(h.operationId) };
  const done = (r: { root: string; pagesRoot: string; votesRoot?: string; slots: object }): RootOut => {
    const slots: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.slots)) slots[SLOT_NAMES[k]!] = v as string;
    return { v: 'ok', root: r.root, pagesRoot: r.pagesRoot, ...(r.votesRoot !== undefined ? { votesRoot: r.votesRoot } : {}), slots };
  };
  try {
    switch (mode) {
      case 'govroot':
        return done(govRootV4FromHashes(report, s(ev.version), pages, counts, votes, inputs));
      case 'bind':
        bindProofV21(report, g0, g1, s(c.keyPage), s(c.keyBook), factsOf(o(c.facts)));
        return { v: 'ok' };
      case 'root': {
        const raw = c.voteEvidence === undefined ? undefined : JSON.stringify(c.voteEvidence);
        return done(proofV2Root({ report, version: s(ev.version), pages, counts, votes, g0, g1, keyPageUrl: s(c.keyPage), keyBookUrl: s(c.keyBook), voteEvidence: raw, inputs }));
      }
    }
  } catch (e) {
    return refusal(e, e instanceof BindError);
  }
  throw new Error(`unknown mode ${mode}`);
}

/** JSON with the members of every object in key order: two values are equal when this is. */
export function canonical(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) : x));
}

/** The fields on which the two verdicts differ (empty: they agree). */
export function intentDifferences(want: RootOut, got: RootOut): string[] {
  const out: string[] = [];
  const cmp = (name: string, x: unknown, y: unknown): void => {
    if (canonical(x) !== canonical(y)) out.push(`${name}: Go ${canonical(x)}; here ${canonical(y)}`);
  };
  cmp('v', want.v, got.v);
  cmp('bind', want.bind ?? false, got.bind ?? false);
  cmp('state', want.state, got.state);
  cmp('msg', want.msg, got.msg);
  cmp('root', want.root, got.root);
  cmp('pagesRoot', want.pagesRoot, got.pagesRoot);
  cmp('votesRoot', want.votesRoot, got.votesRoot);
  cmp('slots', want.slots, got.slots);
  return out;
}

// --------------------------------------------------------------------------------------------------------------------------------
// the facts of vote evidence

import { governingFactsFromVoteEvidence } from '../../src/s3/bind-v21.js';
import { decodeVoteEvidence } from '../../src/s3/voteevidence.js';
import { evidence20View, marshalEvidence, unmarshalCertifiedEvidence } from '../../src/s3/consensus.js';

export interface FactsOut {
  v: 'ok' | 'named' | 'plain' | 'decode';
  facts?: Record<string, unknown>;
  state?: { code: string; partition: string; block: number; detail: string };
  msg?: string;
}

const toHexBytes = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** json.Unmarshal(doc, &govvote.Evidence) then GoverningFactsFromVoteEvidence, on the TypeScript port. */
export function judgeFacts(text: string): FactsOut {
  let view;
  try {
    view = decodeVoteEvidence(text);
  } catch (e) {
    return { v: 'decode', msg: (e as Error).message };
  }
  try {
    const f = governingFactsFromVoteEvidence(view);
    return {
      v: 'ok',
      facts: {
        principal: f.principal,
        type: f.type,
        txHash: toHexBytes(f.txHash),
        authorities: f.authorities.map((x) => ({ url: x.url, disabled: x.disabled })),
        headerAuthorities: f.headerAuthorities,
        initiators: f.initiators,
        initiatorPath: f.initiatorPath,
        signatures: f.signatures.map((x) => ({ signer: x.signer, block: x.block })),
        votes: f.votes.map((x) => ({ authority: x.authority, origin: x.origin, block: x.block })),
        arrivals: f.arrivals.map((x) => ({ page: x.page, origin: x.origin, path: x.path, block: x.block })),
      },
    };
  } catch (e) {
    const err = e as Error;
    if (err instanceof NamedState) return { v: 'named', state: err.entry(), msg: err.message };
    return { v: 'plain', msg: err.message };
  }
}

export function factsDifferences(want: FactsOut, got: FactsOut): string[] {
  const out: string[] = [];
  const cmp = (name: string, x: unknown, y: unknown): void => {
    if (canonical(x) !== canonical(y)) out.push(`${name}: Go ${canonical(x).slice(0, 400)}; here ${canonical(y).slice(0, 400)}`);
  };
  cmp('v', want.v, got.v);
  if (want.v === 'decode' || got.v === 'decode') return out; // the class only: the message is the decoder's
  cmp('state', want.state, got.state);
  // the wording of a binary decoder's error is the decoder's: the refusal and the text up to "does not decode: " are compared
  const head = (m: string | undefined): string | undefined => (m === undefined ? m : m.includes(' does not decode: ') ? m.slice(0, m.indexOf(' does not decode: ') + ' does not decode: '.length) : m);
  cmp('msg', head(want.msg), head(got.msg));
  cmp('facts', want.facts, got.facts);
  return out;
}

// --------------------------------------------------------------------------------------------------------------------------------
// the decode of a certificate's proof v2

export interface DecodeOut {
  err?: string;
  ev?: string;
  view?: string;
  /** sha256 of ev and view: the large corpora record these in place of the documents. */
  evSha?: string;
  viewSha?: string;
}

/** proofv2.UnmarshalCertifiedEvidence and consensus.Evidence20View, as json.Marshal writes them. */
export function judgeDecode(text: string): DecodeOut {
  try {
    const ev = unmarshalCertifiedEvidence(text);
    return { ev: marshalEvidence(ev), view: marshalEvidence(evidence20View(ev)) };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

export function decodeDifferences(want: DecodeOut, got: DecodeOut): string[] {
  const out: string[] = [];
  if ((want.err !== undefined) !== (got.err !== undefined)) {
    out.push(`Go ${want.err !== undefined ? `error (${want.err})` : 'a document'}; here ${got.err !== undefined ? `error (${got.err})` : 'a document'}`);
    return out;
  }
  // both refuse: the decoder's wording (struct names, quoting) is the decoder's own and is not compared
  if (want.err !== undefined) return out;
  const around = (a: string, b: string): string => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return `first difference at ${i}: Go ...${a.slice(Math.max(0, i - 60), i + 80)}; here ...${b.slice(Math.max(0, i - 60), i + 80)}`;
  };
  const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
  if (want.ev !== undefined ? want.ev !== got.ev : want.evSha !== sha(got.ev!)) out.push(`ev: ${want.ev !== undefined ? around(want.ev, got.ev!) : `sha256 ${sha(got.ev!)}, Go ${want.evSha}`}`);
  if (want.view !== undefined ? want.view !== got.view : want.viewSha !== sha(got.view!)) out.push(`view: ${want.view !== undefined ? around(want.view, got.view!) : `sha256 ${sha(got.view!)}, Go ${want.viewSha}`}`);
  return out;
}
