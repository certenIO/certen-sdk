/**
 * Evidence 2.1 as the verifier holds it, and the import of a portable proof into it (validator pkg/proof/v2: evidence.go, page.go,
 * crosspartition.go, portable.go Import).
 *
 * The portable form carries Accumulate's JSON; Go's Import rebuilds every binary value from its JSON, so a decoding the document was
 * handed is never trusted, only reproduced. This import does the same with accumulate-sdk-opendlt's classes and encoder: an account
 * becomes its binary state, a receipt its binary encoding, a sequenced message its binary hash. Everything that Go converts at import
 * is converted here at import, so a malformed value is refused at the same point, as a plain error, before any named state is reached.
 */
import { equal, toHex } from '../proof-v2/bytes.js';
import { accountState } from './jsonwire.js';
import { importCheckAccount, type CheckAccount } from './setcheck.js';
import { JsonError, list, map, str, strList, struct, u64, u64big } from './gojson.js';
import { minorRootFromJson } from './minorroot.js';
import { importReceipt, importSequenced, type Rcpt, type SeqMsg } from './rcpt.js';
import type { PageRole } from './states.js';

export { importReceipt, importSequenced } from './rcpt.js';
export type { Rcpt, SeqMsg } from './rcpt.js';

export const PORTABLE_FORMAT = 'certen-proof-v2-accumulate-portable/1';

// --------------------------------------------------------------------------------------------------------------------------------
// the evidence

export interface IndexProof {
  position: number;
  /** The index chain entry, hex as the document gave it. */
  entry: string;
  receipt: Rcpt;
}
export interface Arrival {
  before?: IndexProof;
  at: IndexProof;
}
export interface Hop {
  page: string;
  message: string;
  signature: string;
  block: number;
  receipt: Rcpt;
  arrival?: Arrival;
}
export interface Production {
  account: string;
  chain: string;
  message: string;
  receipt: Rcpt;
  arrival: Arrival;
  /** The SequencedMessage the production carries (binary hex in Go's Evidence); empty when absent. */
  sequenced?: SeqMsg;
}
export interface Transport {
  kind: string;
  source: string;
  destination: string;
  number: number;
}
export interface Vote {
  authority: string;
  origin: string;
  vote: string;
  cause: string;
  transport: Transport;
  message: string;
  receipt: Rcpt;
  hops: Hop[] | undefined;
  counted: Hop[] | undefined;
  produced?: Production;
}
export interface HistoryEntry {
  transaction: string;
  initiator: string;
}
export interface PageHistory {
  /** undefined is Go's nil slice (absent or null). */
  entries: HistoryEntry[] | undefined;
  index: string[] | undefined;
}
export interface ChainRoot {
  name: string;
  /** undefined is Go's nil slice (absent or null). */
  pending: (string | null)[] | undefined;
  count: number;
  /** The restated count exactly (count is its nearest double above 2^53): Go compares the uint64. */
  countBig: bigint;
  anchor: string;
}
export interface PageState {
  url: string;
  /** The account's binary state (the SDK's re-encoding of the JSON). */
  state: Uint8Array;
  receipt: Rcpt;
  chains: ChainRoot[];
  pendingHash: string;
  chainError: string;
  partition: string;
  /** undefined is Go's nil slice (absent or null); an empty list is non-nil. */
  roles: string[] | undefined;
  history?: PageHistory;
  /** The raw JSON of the page's chain roots, as the existing set-check functions read them. */
  chainsJson: unknown;
}
export interface PartitionAnchorX {
  message: SeqMsg;
  receipt: Rcpt;
}
export interface AccountProof {
  accountUrl: string;
  /** The raw portable account (its JSON), for the set-check reader. */
  json: Record<string, unknown>;
}

export interface Evidence {
  version: string;
  account: string;
  txHash: string;
  receipt: Rcpt;
  majors: number;
  certify: unknown[];
  /** The binary encoding of each certify run (api.MinorRootRecord.MarshalBinary), computed at import. */
  certifyBin: Uint8Array[];
  /** Per certify run: whether the receipts nested in the record decode (see MinorRoot.nestedDecodes). */
  certifyNested: boolean[];
  anchor: PartitionAnchorX;
  pages: PageState[];
  /** undefined is nil (absent or empty: Import copies only a non-empty map). */
  anchors?: Map<string, PartitionAnchorX>;
  votes: Vote[];
  transaction: string;
  /**
   * Evidence 2.1 only (RB9-F5): the links of the anchored minor-root items, certify first and then the set check's hops, and the genesis link. Read only
   * from a document whose version is 2.1; a 2.0 document ignores both members.
   */
  links: Rcpt[];
  genesisLink?: Rcpt;
  check: {
    majors: number;
    hops: unknown[];
    hopsBin: Uint8Array[];
    /** Per hop: whether the receipts nested in the record decode. */
    hopsNested: boolean[];
    incarnation: string;
    network: CheckAccount;
    globals: CheckAccount;
    routing?: CheckAccount;
  };
}

function importIndexProof(j: unknown, label: string): IndexProof {
  const s = struct(j, ['position', 'entry', 'receipt'], `IndexProof (${label})`);
  return { position: u64(s.position, `${label}.position`), entry: str(s.entry, `${label}.entry`), receipt: importReceipt(s.receipt, `${label}.receipt`) };
}

function importArrival(j: unknown, label: string): Arrival {
  const s = struct(j, ['before', 'at'], `Arrival (${label})`);
  const out: Arrival = { at: importIndexProof(s.at, `${label}.at`) };
  if (s.before !== undefined && s.before !== null) out.before = importIndexProof(s.before, `${label}.before`);
  return out;
}

function importHop(j: unknown, label: string): Hop {
  const s = struct(j, ['page', 'message', 'signature', 'block', 'receipt', 'arrival'], `PortableHop (${label})`);
  const hop: Hop = {
    page: str(s.page, `${label}.page`),
    message: str(s.message, `${label}.message`),
    signature: str(s.signature, `${label}.signature`),
    block: u64(s.block, `${label}.block`),
    receipt: importReceipt(s.receipt, `${label}.receipt`),
  };
  if (s.arrival !== undefined && s.arrival !== null) hop.arrival = importArrival(s.arrival, `${label}.arrival`);
  return hop;
}

function importHops(v: unknown, label: string, who: string): Hop[] | undefined {
  const l = list(v, label);
  return l?.map((h, i) => {
    try {
      return importHop(h, `${label}[${i}]`);
    } catch (e) {
      throw wrap(e, who);
    }
  });
}

/** A failure carries the vote it is about, as Go's `fmt.Errorf("vote of %s, hop %s: %w")` does; the class is unchanged. */
function wrap(e: unknown, who: string): Error {
  if (e instanceof Error) {
    const w = new (e.constructor as new (m: string) => Error)(`${who}: ${e.message}`);
    return w;
  }
  return new Error(`${who}: ${String(e)}`);
}

function importVote(j: unknown, i: number): Vote {
  const s = struct(j, ['authority', 'origin', 'vote', 'cause', 'transport', 'message', 'receipt', 'hops', 'counted', 'produced'], `PortableVote (votes[${i}])`);
  const authority = str(s.authority, `votes[${i}].authority`);
  const who = `vote of ${authority}`;
  const ts = struct(s.transport, ['kind', 'source', 'destination', 'number'], `VoteTransport (votes[${i}].transport)`);
  const v: Vote = {
    authority,
    origin: str(s.origin, `votes[${i}].origin`),
    vote: str(s.vote, `votes[${i}].vote`),
    cause: str(s.cause, `votes[${i}].cause`),
    transport: { kind: str(ts.kind, 'transport.kind'), source: str(ts.source, 'transport.source'), destination: str(ts.destination, 'transport.destination'), number: u64(ts.number, 'transport.number') },
    message: str(s.message, `votes[${i}].message`),
    receipt: wrapCall(() => importReceipt(s.receipt, `votes[${i}].receipt`), who),
    hops: importHops(s.hops, `votes[${i}].hops`, who),
    counted: importHops(s.counted, `votes[${i}].counted`, who),
  };
  if (s.produced !== undefined && s.produced !== null) {
    v.produced = wrapCall(() => {
      const p = struct(s.produced, ['account', 'chain', 'message', 'receipt', 'arrival', 'sequenced'], `PortableProduction (votes[${i}].produced)`);
      const pr: Production = {
        account: str(p.account, 'produced.account'),
        chain: str(p.chain, 'produced.chain'),
        message: str(p.message, 'produced.message'),
        receipt: importReceipt(p.receipt, 'produced.receipt'),
        arrival: importArrival(p.arrival, 'produced.arrival'),
      };
      if (p.sequenced !== undefined && p.sequenced !== null) pr.sequenced = importSequenced(p.sequenced, 'sequenced message');
      return pr;
    }, `${who}, production`);
  }
  return v;
}

function wrapCall<T>(f: () => T, who: string): T {
  try {
    return f();
  } catch (e) {
    throw wrap(e, who);
  }
}

function importPage(j: unknown, i: number): PageState {
  const s = struct(j, ['url', 'account', 'receipt', 'chains', 'pendingHash', 'chainError', 'partition', 'roles', 'history'], `PortablePage (pages[${i}])`);
  const url = str(s.url, `pages[${i}].url`);
  const state = accountState(s.account, `page ${url}`);
  const roles = strList(s.roles, `pages[${i}].roles`);
  const chains = importChains(s.chains, `pages[${i}].chains`);
  const page: PageState = {
    url,
    state,
    receipt: importReceipt(s.receipt, `pages[${i}].receipt`),
    chains,
    chainsJson: s.chains,
    pendingHash: str(s.pendingHash, `pages[${i}].pendingHash`),
    chainError: str(s.chainError, `pages[${i}].chainError`),
    partition: str(s.partition, `pages[${i}].partition`),
    roles,
  };
  if (s.history !== undefined && s.history !== null) {
    const h = struct(s.history, ['entries', 'index'], `PageHistory (pages[${i}].history)`);
    page.history = {
      entries: list(h.entries, 'history.entries')?.map((e, k) => {
        const es = struct(e, ['transaction', 'initiator'], `HistoryEntry (history.entries[${k}])`);
        return { transaction: str(es.transaction, 'history.entries.transaction'), initiator: str(es.initiator, 'history.entries.initiator') };
      }),
      index: strList(h.index, 'history.index'),
    };
  }
  return page;
}

/** proof.ChainRoot from its JSON: name, pending (a list of 32-byte hex or null), count, anchor. */
export function importChains(v: unknown, label: string): ChainRoot[] {
  const l = list(v, label) ?? [];
  return l.map((c, i) => {
    const s = struct(c, ['name', 'pending', 'count', 'anchor'], `ChainRoot (${label}[${i}])`);
    const pl = list(s.pending, `${label}[${i}].pending`);
    return {
      name: str(s.name, `${label}[${i}].name`),
      pending: pl?.map((p, k) => (p === null ? null : str(p, `${label}[${i}].pending[${k}]`))),
      count: u64(s.count, `${label}[${i}].count`),
      countBig: u64big(s.count, `${label}[${i}].count`),
      anchor: str(s.anchor, `${label}[${i}].anchor`),
    };
  });
}

function importAnchorX(j: unknown, label: string): PartitionAnchorX {
  const s = struct(j, ['message', 'receipt'], `PortableAnchor (${label})`);
  if (s.message === undefined) throw new JsonError('anchor message: unexpected end of JSON input'); // an absent json.RawMessage is not JSON at all
  return { message: importSequenced(s.message, 'anchor message'), receipt: importReceipt(s.receipt, `${label}.receipt`) };
}

/** An imported portable proof: the pin, the genesis, the major blocks and the evidence. */
export interface Imported {
  pin: string;
  genesis: Record<string, unknown>;
  majors: unknown[];
  evidence: Evidence;
  govRootInputs: unknown;
}

/** portable.go Import (the evidence part; the genesis and the archive are read by the shared 2.0 code). */
/**
 * Import of a portable document's evidence. With held, a refusal of the set check's accounts (network, globals, routing) is not thrown but kept in
 * held.refusal and the account left out: the 2.0 verifier reports its stages in order and the set check is the last of them (portable20.ts).
 */
export function importEvidence(doc: Record<string, unknown>, held?: { refusal?: Error }): Evidence {
  const e = struct(doc.evidence, ['version', 'account', 'txHash', 'receipt', 'majors', 'certify', 'anchor', 'pages', 'anchors', 'votes', 'transaction', 'links', 'genesisLink', 'check'], 'PortableEvidence');
  const anchorS = struct(e.anchor, ['message', 'receipt'], 'PortableEvidence.anchor');
  if (anchorS.message === undefined) throw new JsonError('anchor message: unexpected end of JSON input'); // an absent json.RawMessage is not JSON at all
  const ev: Evidence = {
    version: str(e.version, 'evidence.version'),
    account: str(e.account, 'evidence.account'),
    txHash: str(e.txHash, 'evidence.txHash'),
    receipt: importReceipt(e.receipt, 'receipt'),
    majors: u64(e.majors, 'evidence.majors'),
    certify: [],
    certifyBin: [],
    certifyNested: [],
    anchor: { message: importSequenced(anchorS.message, 'anchor message'), receipt: importReceipt(anchorS.receipt, 'anchor receipt') },
    pages: [],
    votes: [],
    links: [],
    transaction: str(e.transaction, 'evidence.transaction'),
    check: { majors: 0, hops: [], hopsBin: [], hopsNested: [], incarnation: '', network: undefined as unknown as CheckAccount, globals: undefined as unknown as CheckAccount },
  };
  const pages = list(e.pages, 'evidence.pages') ?? [];
  ev.pages = pages.map((p, i) => importPage(p, i));
  // Import copies a non-empty map only: an empty "anchors" object is the same document as none.
  const am = map(e.anchors, 'evidence.anchors');
  if (am && Object.keys(am).length > 0) {
    ev.anchors = new Map();
    for (const [k, a] of Object.entries(am)) {
      try {
        ev.anchors.set(k, importAnchorX(a, `anchors[${k}]`));
      } catch (err) {
        throw wrap(err, `anchor ${k}`);
      }
    }
  }
  ev.votes = (list(e.votes, 'evidence.votes') ?? []).map((v, i) => importVote(v, i));
  const c = struct(e.check, ['majors', 'hops', 'incarnation', 'network', 'globals', 'routing'], 'PortableCheck');
  ev.check.majors = u64(c.majors, 'check.majors');
  const certify = (list(e.certify, 'evidence.certify') ?? []).map((r, i) => minorRootFromJson(r, `certify run ${i}`));
  ev.certify = certify.map((m) => m.canonical);
  ev.certifyBin = certify.map((m) => m.bin);
  ev.certifyNested = certify.map((m) => m.nestedDecodes);
  if (ev.version === '2.1') {
    // portable.go Import: a 2.1 document's links member is a list of receipts (null: none), its genesis link one receipt (null: none).
    if (e.links !== undefined && e.links !== null) {
      if (!Array.isArray(e.links)) throw new JsonError(`links: json: cannot unmarshal ${jsonTypeName(e.links)} into Go value of type []json.RawMessage`);
      ev.links = e.links.map((l, i) => importReceipt(l, `link ${i}`));
    }
    if (e.genesisLink !== undefined && e.genesisLink !== null) ev.genesisLink = importReceipt(e.genesisLink, 'genesis link');
  }
  const hops = (list(c.hops, 'check.hops') ?? []).map((r, i) => minorRootFromJson(r, `set check hop ${i}`));
  ev.check.hops = hops.map((m) => m.canonical);
  ev.check.hopsBin = hops.map((m) => m.bin);
  ev.check.hopsNested = hops.map((m) => m.nestedDecodes);
  ev.check.incarnation = str(c.incarnation, 'check.incarnation');
  const account = (raw: unknown, cls: string, label: string): CheckAccount => {
    if (!held) return importCheckAccount(raw as Record<string, unknown>, cls, label);
    try {
      return importCheckAccount(raw as Record<string, unknown>, cls, label);
    } catch (err) {
      held.refusal ??= err as Error;
      return undefined as unknown as CheckAccount;
    }
  };
  ev.check.network = account(c.network, 'NetworkDefinition', 'set check network');
  ev.check.globals = account(c.globals, 'NetworkGlobals', 'set check globals');
  if (c.routing !== undefined && c.routing !== null) ev.check.routing = account(c.routing, 'RoutingTable', 'set check routing');
  return ev;
}

/** Whether two receipts are the same value (bytes). */
export const sameReceipt = (a: Rcpt, b: Rcpt): boolean => equal(a.bin, b.bin);

/** Hex of a hash, lower case. */
export const hex = (b: Uint8Array): string => toHex(b);

export type { PageRole };

/** The JSON type name Go's UnmarshalTypeError reports for a value of a decoded tree. */
function jsonTypeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'bool';
    default:
      return v !== null && typeof v === 'object' && 'lit' in (v as object) ? 'number' : 'object';
  }
}
