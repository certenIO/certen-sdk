// The CLI layer of the S8 contract-identity verifier (twin of cmd/proofverify/contract_identity.go, WP-S8-CLI): the six headline rows of Freeze item 6 as one
// line of text and one exit code, the strict reader of the portable `contractIdentity` member (certen-contract-identity/1) and the judge that joins them.
//
//   0   VERIFIED         contract identity: VERIFIED at <level> (registry <via>)
//   5   not applicable   contract identity: not applicable (<reason>)
//   10  verified core    contract identity: verified core, <N> open: <part>:<reason>, ...   (NEVER printed, counted or exit-coded as verified)
//   20  PENDING          contract identity: PENDING (state root not authenticated; <N> findings)
//   30  UNPROVEN         contract identity: UNPROVEN: <parts>
//   40  REFUSED          contract identity: REFUSED: <first refusal state>
//   2   usage / internal proofverify: <error>  (an input that cannot form a container, a verifier error: never a Report)
//
// The text and the exit codes are the Go tool's byte for byte; the S7 phase runs first and combineExit joins the two (an S7 FAILED wins, then a non-zero S8
// code, then S7's). Nothing here judges a container: that is the verifier's, and what cannot be established is a named state in its report.
import { sha256 } from '@noble/hashes/sha2';
import { foldEqual } from '../../s3/fold.js';
import { legBinding } from '../finality/addendum.js';
import { readHeader } from '../finality/rlpheader.js';
import { canonical, toHex, type CanonValue } from './canon.js';
import { defaultIdentityLimits, unrecognised } from './codec.js';
import type { LegContext } from './context.js';
import * as N from './names.js';
import type { Headline, OpenEntry, Report } from './report.js';
import { must, tooLarge, type StateError } from './states.js';

/** The format string of the portable member. */
export const CI_MEMBER_FORMAT = 'certen-contract-identity/1';
/** The bound on a container, read from the text of the member before any byte is decoded. */
export const MAX_CONTAINER_BYTES: number = defaultIdentityLimits().maxContainerBytes;

/** The exit codes of the headline rows (Freeze item 6) and of a usage or internal error. */
export const EXIT_CI = { verified: 0, usage: 2, notApplicable: 5, verifiedCore: 10, pending: 20, unproven: 30, refused: 40 } as const;
/** The exit code of an S7 FAILED in proofverify. */
export const EXIT_S7_FAILED = 1;

/** A headline that does not carry what its row prints: nothing is printed in its place. */
export class ContractIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractIdentityError';
  }
}
/** A member that cannot form a container. */
export class CiMemberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CiMemberError';
  }
}

/** The exit codes joined: an S7 FAILED wins (the leg's own evidence is wrong), then any non-zero S8 code, then S7's. */
export function combineExit(s7: number, s8: number): number {
  if (s7 === EXIT_S7_FAILED) return EXIT_S7_FAILED;
  if (s8 !== EXIT_CI.verified) return s8;
  return s7;
}

/** StateError.Error(): `code{k=<canonical value>,...}` with the keys sorted. */
export function stateText(s: StateError): string {
  const keys = Object.keys(s.fields).sort();
  const parts = keys.map((k) => {
    let c: string;
    try {
      c = canonical(s.fields[k] as CanonValue);
    } catch {
      c = '?';
    }
    return `${k}=${c}`;
  });
  return `${s.code}{${parts.join(',')}}`;
}

/** `<part>:<reason>`; an S6 non-proof state is `s6_link:s6_not_proven(<state>)`. */
function openEntryText(o: OpenEntry): string {
  let reason = o.state.reason;
  if (o.part === N.JudgedS6Link && o.state.code === N.CodeNotChecked) {
    const s = o.state.fields['state'];
    if (typeof s === 'string') reason = `s6_not_proven(${s})`;
  }
  if (reason === '') reason = o.state.code;
  return `${o.part}:${reason}`;
}

/** The CLI line and exit code of a headline. A headline that does not carry what its row prints throws ContractIdentityError. */
export function renderContractIdentity(h: Headline): { line: string; exit: number } {
  const p = 'contract identity: ';
  switch (h.kind) {
    case N.HeadlineVerified:
      if (!h.judgedAtLevel || !h.registryLink) throw new ContractIdentityError(`a verified headline names no judged level or registry link (level "${h.judgedAtLevel ?? ''}", registry "${h.registryLink ?? ''}")`);
      return { line: `${p}VERIFIED at ${h.judgedAtLevel} (registry ${h.registryLink})`, exit: EXIT_CI.verified };
    case N.HeadlineNotApplicable: {
      if (!h.notApplicable) throw new ContractIdentityError('a not_applicable headline carries no state');
      const reason = h.notApplicable.reason === '' ? h.notApplicable.code : h.notApplicable.reason;
      return { line: `${p}not applicable (${reason})`, exit: EXIT_CI.notApplicable };
    }
    case N.HeadlineVerifiedCore: {
      const open = h.open ?? [];
      if (open.length === 0) throw new ContractIdentityError('a verified_core headline carries no open entry');
      const texts = open.map((o) => {
        if (!o.state) throw new ContractIdentityError(`an open entry of part ${o.part} carries no state`);
        return openEntryText(o);
      });
      return { line: `${p}verified core, ${open.length} open: ${texts.join(', ')}`, exit: EXIT_CI.verifiedCore };
    }
    case N.HeadlinePending:
      return { line: `${p}PENDING (state root not authenticated; ${(h.findings ?? []).length} findings)`, exit: EXIT_CI.pending };
    case N.HeadlineUnproven:
      if (h.parts.length === 0) throw new ContractIdentityError('an unproven headline names no part');
      return { line: `${p}UNPROVEN: ${h.parts.join(', ')}`, exit: EXIT_CI.unproven };
    case N.HeadlineRefused:
      if (!h.first) throw new ContractIdentityError('a refused headline names no first refusal');
      return { line: `${p}REFUSED: ${stateText(h.first)}`, exit: EXIT_CI.refused };
  }
  throw new ContractIdentityError(`unknown headline kind "${h.kind}"`);
}

// ---- the container digest (Q2 item 4): a storage-consistency check under D0, never authority ----

const DIGEST_DOMAIN = 'certen:contract-identity:v1';
const lp = (b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length, false);
  out.set(b, 4);
  return out;
};
const cat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) (out.set(x, o), (o += x.length));
  return out;
};
/** SHA-256(lp(domain) || lp(d0) || lp(SHA-256(container))) under D0 = legBinding(chain, number, hash). */
export function digestOf(chain: bigint, number: bigint, hash: Uint8Array, container: Uint8Array): Uint8Array {
  return sha256(cat([lp(new TextEncoder().encode(DIGEST_DOMAIN)), lp(legBinding(chain, number, hash)), lp(sha256(container))]));
}

// ---- the strict reader ----

type Node =
  | { k: 'object'; members: [string, Node, string][] }
  | { k: 'array'; items: Node[] }
  | { k: 'string'; v: string; raw: string }
  | { k: 'number'; raw: string }
  | { k: 'lit'; raw: string };

const WS = new Set([' ', '\t', '\n', '\r']);
const NUM = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const MAX_DEPTH = 512;

/** One JSON value of the text, refusing what Go's decoder refuses: a trailing token, a malformed string or number. Objects keep their members in order. */
function parseNode(text: string): Node {
  let i = 0;
  const skip = (): void => {
    while (i < text.length && WS.has(text[i]!)) i++;
  };
  const value = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new CiMemberError('nesting too deep');
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const members: [string, Node, string][] = [];
      skip();
      if (text[i] === '}') return (i++, { k: 'object', members });
      for (;;) {
        skip();
        if (text[i] !== '"') throw new CiMemberError('not a JSON object');
        const keyStart = i;
        const key = str();
        const keyRaw = text.slice(keyStart, i);
        skip();
        if (text[i++] !== ':') throw new CiMemberError('expected ":" after an object key');
        members.push([key, value(depth + 1), keyRaw]);
        skip();
        const d = text[i++];
        if (d === '}') return { k: 'object', members };
        if (d !== ',') throw new CiMemberError('expected "," or "}" in an object');
      }
    }
    if (c === '[') {
      i++;
      skip();
      const items: Node[] = [];
      if (text[i] === ']') return (i++, { k: 'array', items });
      for (;;) {
        items.push(value(depth + 1));
        skip();
        const d = text[i++];
        if (d === ']') return { k: 'array', items };
        if (d !== ',') throw new CiMemberError('expected "," or "]" in an array');
      }
    }
    if (c === '"') {
      const at = i;
      const v = str();
      return { k: 'string', v, raw: text.slice(at, i) };
    }
    for (const lit of ['true', 'false', 'null']) if (text.startsWith(lit, i)) return (i += lit.length, { k: 'lit', raw: lit });
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (!m) throw new CiMemberError(c === undefined ? 'unexpected end of JSON input' : `invalid character ${JSON.stringify(c)} looking for the beginning of a value`);
    i += m[0].length;
    return { k: 'number', raw: m[0] };
  };
  const str = (): string => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) throw new CiMemberError('unterminated string');
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch (e) {
      throw new CiMemberError(`invalid string: ${(e as Error).message}`);
    }
  };
  const root = value(0);
  skip();
  if (i < text.length) throw new CiMemberError('trailing data after the object');
  return root;
}

/** One JSON object into its members, refusing a duplicate key and a value that is not a single object. */
function strictObject(text: string): Map<string, Node> {
  const n = parseNode(text);
  if (n.k !== 'object') throw new CiMemberError('not a JSON object');
  const out = new Map<string, Node>();
  for (const [k, v] of n.members) {
    if (out.has(k)) throw new CiMemberError(`duplicate key ${JSON.stringify(k)}`);
    out.set(k, v);
  }
  return out;
}

function onlyKeys(m: Map<string, Node>, ...allowed: string[]): void {
  for (const k of m.keys()) if (!allowed.includes(k)) throw new CiMemberError(`unknown key ${JSON.stringify(k)}`);
}

/** The text of a node, token for token: keys, strings and numbers are written as they were read (escapes included) and members keep their order and their duplicates, so a strict reader still sees them. */
function textOf(n: Node): string {
  switch (n.k) {
    case 'object':
      return `{${n.members.map(([, v, kr]) => `${kr}:${textOf(v)}`).join(',')}}`;
    case 'array':
      return `[${n.items.map(textOf).join(',')}]`;
    default:
      return n.raw;
  }
}

/**
 * The text of the LAST top-level member of a JSON object whose key is `name` (matched exactly, else case-insensitively, as encoding/json matches a struct field) and, with `path`, of the
 * member below it: a duplicate key on the way down is refused. undefined: absent or null. Throws CiMemberError when the text is not one JSON object.
 */
export function memberText(input: string, name: string, ...path: string[]): string | undefined {
  const root = parseNode(input);
  if (root.k !== 'object') throw new CiMemberError('not a JSON object');
  let found: Node | undefined;
  for (const [k, v] of root.members) if (k === name || foldEqual(name, k)) found = v;
  for (const key of path) {
    if (found === undefined || found.k !== 'object') return undefined;
    const hits = found.members.filter(([k]) => k === key);
    if (hits.length > 1) throw new CiMemberError(`duplicate key ${JSON.stringify(key)}`);
    found = hits[0]?.[1];
  }
  return found === undefined || (found.k === 'lit' && found.raw === 'null') ? undefined : textOf(found);
}

const U64_MAX = (1n << 64n) - 1n;
function u64(n: Node | undefined, name: string): bigint {
  if (!n) throw new CiMemberError(`missing ${name}`);
  if (n.k !== 'number' || !/^(?:0|[1-9][0-9]*)$/.test(n.raw)) throw new CiMemberError(`${name}: not an unsigned integer`);
  const v = BigInt(n.raw);
  if (v > U64_MAX) throw new CiMemberError(`${name}: ${n.raw} overflows uint64`);
  return v;
}
function text(n: Node | undefined, name: string): string {
  if (!n || n.k !== 'string') throw new CiMemberError(`${name} is not a string`);
  return n.v;
}

function hexField(s: string, name: string, want: number): Uint8Array {
  if (!s.startsWith('0x')) throw new CiMemberError(`${name} is not 0x-prefixed hex`);
  const h = s.slice(2);
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new CiMemberError(`${name} is not hex`);
  if (want > 0 && h.length / 2 !== want) throw new CiMemberError(`${name} is ${h.length / 2} bytes, want ${want}`);
  if (h.length === 0) throw new CiMemberError(`${name} is empty`);
  const out = new Uint8Array(h.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = parseInt(h.slice(2 * k, 2 * k + 2), 16);
  return out;
}

/** The decoded portable member. */
export interface CiMember { chain: bigint; number: bigint; hash: Uint8Array; container: Uint8Array; digest: Uint8Array }

/**
 * parseCIMember reads the member strictly and checks it against the leg being judged. It returns exactly one of: the member; a refusal state (a version
 * this verifier does not know, a container above the bound, a leg that is not the Settlement's); or it throws CiMemberError (a member that cannot form a
 * container). The container itself is judged by the verifier, never here. The digest is a storage-consistency check under D0, recomputed from the leg and
 * never read as authority.
 */
export function parseCIMember(raw: string, ctx: LegContext): { member: CiMember } | { refusal: StateError } {
  const top = strictObject(raw);
  const fmtNode = top.get('format');
  if (!fmtNode || fmtNode.k !== 'string') throw new CiMemberError('format is not a string');
  const format = fmtNode.v;
  if (format !== CI_MEMBER_FORMAT) {
    if (!/^[\x20-\x7e]{1,64}$/.test(format)) throw new CiMemberError(`format is not a printable ASCII string of 1 to ${defaultIdentityLimits().maxKindBytes} bytes`);
    return { refusal: unrecognised(format) };
  }
  onlyKeys(top, 'format', 'leg', 'evidence', 'digest');
  for (const k of ['leg', 'evidence', 'digest']) if (!top.has(k)) throw new CiMemberError(`missing ${k}`);
  let leg: Map<string, Node>;
  try {
    leg = strictObject(textOf(top.get('leg')!));
    onlyKeys(leg, 'chain', 'blockNumber', 'blockHash');
  } catch (e) {
    throw new CiMemberError(`leg: ${(e as Error).message}`);
  }
  for (const f of ['chain', 'blockNumber', 'blockHash']) if (!leg.has(f)) throw new CiMemberError(`leg: missing ${f}`);
  const chain = u64(leg.get('chain'), 'leg.chain');
  const number = u64(leg.get('blockNumber'), 'leg.blockNumber');
  const hash = hexField(text(leg.get('blockHash'), 'leg.blockHash'), 'leg.blockHash', 32);
  const evidence = text(top.get('evidence'), 'evidence');
  const digestText = text(top.get('digest'), 'digest');
  // the bound is read from the text, before any byte is decoded or allocated
  if (evidence.startsWith('0x')) {
    const bytes = Math.floor((evidence.length - 2 + 1) / 2);
    if (bytes > MAX_CONTAINER_BYTES) return { refusal: tooLarge(N.PartContainer, bytes, MAX_CONTAINER_BYTES) };
  }
  const container = hexField(evidence, 'evidence', 0);
  const digest = hexField(digestText, 'digest', 32);
  // the leg the member names is the leg the Settlement proves
  if (ctx.settlement && ctx.settlement.header.length > 0) {
    let number0: bigint | undefined;
    try {
      number0 = readHeader(ctx.settlement.header).number;
    } catch {
      number0 = undefined;
    }
    if (number0 !== undefined) {
      if (chain !== ctx.chain) return { refusal: must(N.CodeBlockMismatch, '', { field: 'chain', want: ctx.chain, got: chain }) };
      if (number !== number0) return { refusal: must(N.CodeBlockMismatch, '', { field: 'number', want: number0, got: number }) };
      if (toHex(hash) !== toHex(ctx.settlement.blockHash)) return { refusal: must(N.CodeBlockMismatch, '', { field: 'hash', want: '0x' + toHex(ctx.settlement.blockHash), got: '0x' + toHex(hash) }) };
    }
  }
  const want = digestOf(chain, number, hash, container);
  if (toHex(want) !== toHex(digest)) throw new CiMemberError(`digest 0x${toHex(digest)} is not the container's digest under the leg (0x${toHex(want)})`);
  return { member: { chain, number, hash, container, digest } };
}

/** True when the report judged no part at all because the file carried no container: every part is unproven{part:all, reason:no_evidence_in_file}. */
function noEvidenceOnly(rep: Report): boolean {
  return rep.parts.length > 0 && rep.parts.every((p) => p.status === 'unproven' && p.state !== undefined && p.state.reason === N.RowUnprovenNoEvidenceInFile && p.state.fields['part'] === N.UnprovenPartAll);
}

/** What the flag prints and the exit code it adds to the run. */
export interface CiOutcome { text: string; exit: number }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * judgeContractIdentity judges a leg's contract identity and returns the one line of its row. `member` is the raw `contractIdentity` member of the portable
 * document; undefined, null or JSON null is an absent member, which the verifier judges as unproven{all} (no_evidence_in_file). `verify` is the verifier
 * of the leg: it receives the container (undefined for an absent member) and returns the report. A verifier error, a thrown value and a member that cannot
 * form a container are exit 2 with `proofverify: <error>`: never a Report.
 */
export function judgeContractIdentity(member: string | Uint8Array | null | undefined, ctx: LegContext, verify: (container: Uint8Array | undefined) => Report): CiOutcome {
  const usage = (msg: string): CiOutcome => ({ text: `proofverify: ${msg}\n`, exit: EXIT_CI.usage });
  const body = typeof member === 'string' ? member : member === undefined || member === null ? '' : new TextDecoder().decode(member);
  const t = body.trim();
  let container: Uint8Array | undefined;
  if (t !== '' && t !== 'null') {
    let parsed: ReturnType<typeof parseCIMember>;
    try {
      parsed = parseCIMember(t, ctx);
    } catch (e) {
      if (e instanceof CiMemberError) return usage(`contractIdentity member: ${e.message}`);
      return usage(`contract identity verifier panicked: ${messageOf(e)}`);
    }
    if ('refusal' in parsed) {
      const r = renderContractIdentity({ kind: N.HeadlineRefused, parts: [], first: parsed.refusal });
      return { text: r.line + '\n', exit: r.exit };
    }
    container = parsed.member.container;
  }
  let rep: Report;
  try {
    rep = verify(container);
  } catch (e) {
    return usage(`contract identity verifier: ${messageOf(e)}`);
  }
  let h = rep.headline;
  if (h.kind === N.HeadlineUnproven && noEvidenceOnly(rep)) h = { ...h, parts: [N.UnprovenPartAll] };
  try {
    const r = renderContractIdentity(h);
    return { text: r.line + '\n', exit: r.exit };
  } catch (e) {
    return usage(`contract identity report: ${messageOf(e)}`);
  }
}
