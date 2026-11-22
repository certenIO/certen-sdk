/**
 * Offline verification of an agent-payment evidence pack, `certen.agent-evidence/v1` (the C5 record for an agent payment).
 *
 * Written from the transaction-controls specifications docs/agentic/EVIDENCE-AGT.md (sections 2 and 6), EXCEPTIONS.md (section 7),
 * AGENT-GRANT.md (section 3, mandateHash), docs/core/EVIDENCE.md (the C5 record) and DECISION.md (sections 2, 3, 7 and 9: request,
 * decision, exception and decision-log hashes). It imports no CERTEN code: a stranger holding only this package and a pack can check it.
 * Judged by the specification's vectors agent-evidence.json ae-01..ae-28 (test/agent-pack.test.ts).
 *
 * Input: `{ pack, grant, log: { logId, entries }, agentIntentHash? }`. Pure; every refusal names its reason and the element. What an
 * offline check cannot establish is listed by name in `notVerified`.
 */
import { sha256 } from '@noble/hashes/sha2';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

export type AgentPackVerdict =
  | {
      ok: true;
      requestHash: string;
      mandateHash: string;
      grantHash: string;
      policy: { version: string; hash: string };
      approvals: string[];
      exception: { hash: string; officers: string[] } | null;
      transaction: { requestHash: string; accTxHash: string; chainId: number };
      outcome: { status: string; destinationTx: string };
      timing: { approvedAt: number; relayedAt: number; delaySeconds: number; windowSeconds: number; defaultSeconds: number };
      verified: string[];
      notVerified: string[];
    }
  | { ok: false; reason: string; element: string; detail?: string };

export const AGENT_PACK_SCHEMA = 'certen.agent-evidence/v1';
/** WINDOWS.md section 1, DEC-2: (measured p90 proof cycle ~62 min + 15 min) rounded up to 15 min = 90 min */
export const DEC2_DEFAULT_WINDOW_SECONDS = 5400;
export const AGENT_PACK_NOT_VERIFIED = [
  'officers_roster_is_the_chains',
  'relay_time_source',
  'onchain_officer_signatures',
  'settlement',
  'grant_head_at_decision',
  'grant_still_in_force',
  'policy_content',
  'log_unpinned',
] as const;

const ELEMENTS = ['schema', 'record', 'mandate', 'request', 'decision', 'exception', 'timing'];
const RECORD_MEMBERS = ['instruction', 'policy', 'grant', 'approvals', 'transaction', 'outcome'];
const GRANT_MEMBERS = ['approvals', 'conditions', 'grantId', 'grantor', 'issuedAt', 'limits', 'priorHash', 'schema', 'scope', 'subject', 'validity', 'version'];
const REQUEST_KEYS = ['chainId', 'kind', 'source', 'target', 'beneficiary', 'asset', 'amount', 'executionCommitment', 'operationId', 'txHash'];
const ACTIONS = ['erc20.transfer', 'erc20.approve', 'native.transfer'];
const ENTRY_KEYS = ['seq', 'kind', 'at', 'payload', 'prev', 'hash'];
// DECISION.md section 9: the fifteen kinds (AGT-F135 / DE-109 added intervention.recorded, transaction-controls 0fffc72)
const KINDS = ['decision.issued', 'decision.consumed', 'approval.cast', 'ledger.reserve', 'ledger.settle', 'ledger.release', 'exception.consume', 'pause.set', 'pause.clear', 'recheck.result', 'outcome.recorded', 'grant.observed', 'binding.refused', 'policy.pinned', 'intervention.recorded'];
const MIN_REASON = 10;
const SEAT_NAME = /^seat:[a-z0-9][a-z0-9._-]{0,62}$/;
const OUTCOMES = ['executed', 'refused', 'failed', 'expired'];
const MAX_UINT256 = (1n << 256n) - 1n;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isHash = (v: unknown): v is string => isStr(v) && /^0x[0-9a-f]{64}$/.test(v);
const isAddr = (v: unknown): v is string => isStr(v) && /^0x[0-9a-f]{40}$/.test(v);
const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && !Object.is(v, -0);
const has = (o: unknown, k: string): boolean => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const exact = (o: unknown, req: string[], opt: string[] = []): o is Obj => isObj(o) && Object.keys(o).every((k) => req.includes(k) || opt.includes(k)) && req.every((k) => has(o, k));
const isUrl = (s: unknown): boolean => isStr(s) && /^acc:\/\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(s);
const isIdentity = (v: unknown): boolean => isStr(v) && (/^key:[0-9a-f]{64}$/.test(v) || (v.startsWith('adi:') && isUrl(v.slice(4))));
const isSeat = (v: unknown): boolean => isStr(v) && /^seat:[a-z0-9][a-z0-9._-]{0,62}$/.test(v);
const hostOf = (url: string): string | null => (url.startsWith('acc://') ? url.slice(6).split('/')[0]!.toLowerCase() : null);
const underAdi = (url: string, adi: string): boolean => { const h = hostOf(url); const s = hostOf(adi); return h !== null && s !== null && (h === s || h.endsWith('.' + s)); };

// ---- bytes, RFC 8785 and the length-prefixed tagged framing (EVIDENCE.md section 1) ----
const enc = new TextEncoder();
const utf8 = (s: string): Uint8Array => enc.encode(s);
const concat = (parts: Uint8Array[]): Uint8Array => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const lp = (b: Uint8Array): Uint8Array => { const h = new Uint8Array(4); new DataView(h.buffer).setUint32(0, b.length); return concat([h, b]); };
const tagged = (tag: string, ...fields: Uint8Array[]): Uint8Array => concat([lp(utf8(tag)), ...fields.map(lp)]);
const be64 = (n: number): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
const raw = (h: string): Uint8Array => { const s = h.slice(2); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return o; };
const hex = (b: Uint8Array): string => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sha = (b: Uint8Array): Uint8Array => sha256(b);

// The backslash is built from its code point so no tool or editor can rewrite the escape table.
const BS = String.fromCharCode(92);
const ESC: Record<number, string> = { 8: BS + 'b', 9: BS + 't', 10: BS + 'n', 12: BS + 'f', 13: BS + 'r', 34: BS + '"', 92: BS + BS };
function quote(s: string): string {
  let o = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ESC[c] !== undefined) o += ESC[c];
    else if (c < 0x20) o += BS + 'u' + c.toString(16).padStart(4, '0');
    else o += ch;
  }
  return o + '"';
}
/** RFC 8785 canonical JSON (keys in UTF-16 code unit order; numbers are safe integers in every CERTEN document) */
export function jcs(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('number_not_finite'); return JSON.stringify(v); }
  if (typeof v === 'string') return quote(v);
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v as Obj).sort().map((k) => quote(k) + ':' + jcs((v as Obj)[k])).join(',') + '}';
  throw new Error('unsupported_type');
}

export const mandateHashOf = (m: unknown): string => hex(sha(tagged('certen:mandate:v1', utf8(jcs(m)))));
export const exceptionHashOf = (x: unknown): string => hex(sha(tagged('certen:exception:v1', utf8(jcs(x)))));
const grantHashOf = (g: unknown): string => hex(sha(tagged('certen:grant:v1', utf8(jcs(g)))));
const genesisOf = (logId: string): string => hex(sha(tagged('certen:declog:d0/v1', utf8(logId))));
const entryHashOf = (e: Obj): string => hex(sha(tagged('certen:declog:v1', raw(e.prev), be64(e.seq), utf8(e.kind), sha(utf8(jcs(e.payload))), be64(e.at))));

export function requestHashOf(r: unknown): string | null {
  if (!exact(r, REQUEST_KEYS)) return null;
  if (!isInt(r.chainId, 1) || !ACTIONS.includes(r.kind) || !isAddr(r.source) || !isAddr(r.target) || !isAddr(r.beneficiary)) return null;
  if (!(r.asset === 'native' || isAddr(r.asset))) return null;
  if (!isStr(r.amount) || r.amount.length > 78 || !/^(0|[1-9][0-9]*)$/.test(r.amount) || BigInt(r.amount) > MAX_UINT256) return null;
  if (!isHash(r.executionCommitment) || !isHash(r.operationId) || !isHash(r.txHash)) return null;
  return hex(sha(tagged('certen:request:v1', be64(r.chainId), utf8(r.kind), raw(r.source), raw(r.target), raw(r.beneficiary), utf8(r.asset), utf8(r.amount), raw(r.executionCommitment), raw(r.operationId), raw(r.txHash))));
}

function payloadReadable(kind: string, p: Obj): boolean {
  const strs = (...ks: string[]) => ks.every((k) => has(p, k) && isStr(p[k]));
  if (kind === 'decision.issued') return strs('requestHash', 'decision', 'approver', 'nonce') && has(p, 'grantHash') && (p.grantHash === null || isStr(p.grantHash)) && has(p, 'policyHash') && (p.policyHash === null || isStr(p.policyHash));
  if (kind === 'approval.cast') return has(p, 'requestHash') !== has(p, 'exceptionHash') && strs('identity', 'book', 'vote') && isStr(has(p, 'requestHash') ? p.requestHash : p.exceptionHash);
  if (kind === 'decision.consumed') return strs('requestHash', 'nonce');
  if (kind === 'outcome.recorded') return strs('requestHash', 'status', 'destinationTx');
  const hashOrEmpty = (v: unknown) => v === '' || isHash(v);
  if (kind === 'binding.refused') return strs('requestHash', 'seat', 'reason') && (!has(p, 'nonce') || hashOrEmpty(p.nonce)) && (!has(p, 'txHash') || hashOrEmpty(p.txHash));
  if (kind === 'policy.pinned') return strs('seat', 'by', 'reason') && has(p, 'policyHash') && isHash(p.policyHash) && has(p, 'previous') && (p.previous === null || isHash(p.previous));
  if (kind === 'grant.observed') return strs('grantId', 'grantHash') && isInt(p.version, 1);
  // AGT-F135 (INTERVENTION.md, DE-109): a revoke, replace or cancel by reject vote, held by a named seat and person with a reason, bound to the Accumulate
  // transaction that IS the act; members beyond these are allowed (transaction-controls docs/core/vectors/lib/decision.mjs PAYLOAD_RULES)
  if (kind === 'intervention.recorded') {
    if (!strs('act', 'subject', 'seat', 'by', 'reason') || !has(p, 'txHash') || !isHash(p.txHash)) return false;
    const subject = p.subject as string;
    return ['revoke', 'replace', 'reject'].includes(p.act as string) && subject.length <= 512 && subject.startsWith('acc://') && subject.slice(6).split('/').every((x) => /^[a-z0-9][a-z0-9._-]*$/.test(x))
      && SEAT_NAME.test(p.seat as string) && (p.by as string).trim().length > 0 && (p.reason as string).trim().length >= MIN_REASON;
  }
  return true;
}

/** the decision log hash chain from its genesis (DECISION.md section 9) */
function chainProblem(logId: unknown, entries: unknown[]): string | null {
  if (!isStr(logId) || logId.length === 0 || logId.length > 256) return 'log_id_malformed';
  let prev = genesisOf(logId);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!exact(e, ENTRY_KEYS) || !isInt(e.seq, 1) || !isObj(e.payload) || !isHash(e.prev) || !isHash(e.hash) || !isStr(e.kind)) return `log_entry_malformed (entry ${i})`;
    // the specification's order and names (DECISION.md section 9; transaction-controls docs/core/vectors/lib/decision.mjs verifyLog): kind, payload, at,
    // genesis, sequence (a gap or out of order), prev, hash
    if (!KINDS.includes(e.kind)) return `log_kind_unknown (seq ${e.seq})`;
    if (!payloadReadable(e.kind, e.payload)) return `log_payload_invalid (seq ${e.seq})`;
    if (!isInt(e.at, 0)) return `log_at_invalid (seq ${e.seq})`;
    if (i === 0 && e.prev !== prev) return `log_genesis_mismatch (seq ${e.seq})`;
    if (e.seq !== i + 1) return `${entries.some((x) => isObj(x) && x.seq === i + 1) || e.seq < i + 1 ? 'log_seq_out_of_order' : 'log_seq_gap'} (seq ${e.seq})`;
    if (e.prev !== prev) return `log_prev_mismatch (seq ${e.seq})`;
    if (entryHashOf(e) !== e.hash) return `log_entry_hash_mismatch (seq ${e.seq})`;
    prev = e.hash;
  }
  return null;
}

function recordProblem(r: Obj): string | null {
  if (!exact(r, ['schema', 'instruction', 'policy', 'grant', 'approvals', 'transaction', 'outcome', 'logHead']) || r.schema !== 'certen.evidence-record/v1') return 'record';
  if (!exact(r.instruction, ['hash']) || !isHash(r.instruction.hash)) return 'instruction';
  if (!exact(r.policy, ['version', 'hash']) || !isStr(r.policy.version) || r.policy.version === '' || r.policy.version.length > 128 || !isHash(r.policy.hash)) return 'policy';
  if (!exact(r.grant, ['hash', 'version']) || !isHash(r.grant.hash) || !isInt(r.grant.version, 1)) return 'grant';
  if (!exact(r.transaction, ['requestHash', 'chainId', 'accTxHash']) || !isHash(r.transaction.requestHash) || !isInt(r.transaction.chainId, 1) || !isHash(r.transaction.accTxHash)) return 'transaction';
  if (!exact(r.outcome, ['status'], ['destinationTx']) || !OUTCOMES.includes(r.outcome.status) || (has(r.outcome, 'destinationTx') && !isStr(r.outcome.destinationTx))) return 'outcome';
  if (!exact(r.logHead, ['seq', 'hash']) || !isInt(r.logHead.seq, 1) || !isHash(r.logHead.hash)) return 'logHead';
  if (!Array.isArray(r.approvals) || !r.approvals.every((a: unknown) => exact(a, ['identity', 'book', 'at']) && isStr(a.identity) && isStr(a.book) && isInt(a.at, 0))) return 'approvals';
  return null;
}

function decisionProblem(d: unknown): string | null {
  if (!exact(d, ['schema', 'decision', 'requestHash', 'grantHash', 'policyHash', 'seat', 'approver', 'nonce', 'issuedAt', 'expiresAt', 'reason'])) return 'members';
  if (d.schema !== 'certen.decision/v1' || !['approve', 'deny'].includes(d.decision)) return 'schema or decision';
  if (!isHash(d.requestHash) || !(d.grantHash === null || isHash(d.grantHash)) || !isHash(d.policyHash) || !isHash(d.nonce) || !isSeat(d.seat) || !isIdentity(d.approver)) return 'hash, seat or approver';
  if (!isInt(d.issuedAt, 0) || !isInt(d.expiresAt, 0) || !isStr(d.reason) || d.reason.length > 4096) return 'time or reason';
  return null;
}

type Bad = { ok: false; reason: string; element: string; detail?: string };
const bad = (reason: string, element: string, detail?: string): Bad => (detail === undefined ? { ok: false, reason, element } : { ok: false, reason, element, detail });

/** The core C5 record against the Grant document, the decoded request, the decision record and the log (EVIDENCE.md section 2). */
function checkRecord(rec: Obj, g: Obj, logId: unknown, entries: unknown[], request: Obj, decision: Obj): { ok: true; requestHash: string; approvals: string[]; outcome: { status: string; destinationTx: string } } | { ok: false; reason: string } {
  const p = recordProblem(rec);
  if (p !== null) return { ok: false, reason: `evidence_record_malformed (${p})` };
  if (!exact(g, GRANT_MEMBERS) || g.schema !== 'certen.grant/v1' || !isInt(g.version, 1)) return { ok: false, reason: 'grant_malformed' };
  if (grantHashOf(g) !== rec.grant.hash) return { ok: false, reason: 'grant_hash_mismatch' };
  if (g.version !== rec.grant.version) return { ok: false, reason: 'grant_version_mismatch' };
  const requestHash: string = rec.transaction.requestHash;
  const h = requestHashOf(request);
  if (h === null) return { ok: false, reason: 'evidence_request_malformed' };
  if (h !== requestHash || request.chainId !== rec.transaction.chainId || request.txHash !== rec.transaction.accTxHash) return { ok: false, reason: 'evidence_request_mismatch' };
  const cp = chainProblem(logId, entries);
  if (cp !== null) return { ok: false, reason: `log_invalid: ${cp}` };
  const es = entries as Obj[];
  const headSeq: number = rec.logHead.seq;
  if (headSeq > es.length || es[headSeq - 1]!.hash !== rec.logHead.hash) return { ok: false, reason: 'log_head_mismatch' };
  const upto = (kind: string) => es.slice(0, headSeq).filter((e) => e.kind === kind && e.payload.requestHash === requestHash);
  const issued = upto('decision.issued');
  const last = issued[issued.length - 1];
  if (last === undefined || last.payload.decision !== 'approve') return { ok: false, reason: 'evidence_decision_missing' };
  const lp0 = last.payload;
  if (lp0.grantHash !== rec.grant.hash) return { ok: false, reason: 'evidence_grant_mismatch' };
  if (lp0.policyHash !== rec.policy.hash) return { ok: false, reason: 'evidence_policy_mismatch' };
  const dp = decisionProblem(decision);
  if (dp !== null) return { ok: false, reason: `evidence_decision_record_malformed (${dp})` };
  for (const [name, a, b] of [['requestHash', decision.requestHash, requestHash], ['grantHash', decision.grantHash, lp0.grantHash], ['policyHash', decision.policyHash, lp0.policyHash], ['decision', decision.decision, lp0.decision], ['approver', decision.approver, lp0.approver], ['nonce', decision.nonce, lp0.nonce]] as const) {
    if (a !== b) return { ok: false, reason: `evidence_decision_record_mismatch (${name})` };
  }
  const seen = new Set<string>();
  for (const a of rec.approvals as Obj[]) {
    if (!isIdentity(a.identity) || seen.has(a.identity)) return { ok: false, reason: 'evidence_identity_invalid' };
    seen.add(a.identity);
  }
  const votes = new Map<string, { approve: Obj | null; reject: boolean }>();
  for (const c of upto('approval.cast')) {
    if (!isIdentity(c.payload.identity)) return { ok: false, reason: 'evidence_identity_invalid' };
    const slot = votes.get(c.payload.identity) ?? { approve: null, reject: false };
    if (c.payload.vote === 'approve') slot.approve ??= c; else slot.reject = true;
    votes.set(c.payload.identity, slot);
  }
  const counted: string[] = [];
  for (const [identity, slot] of votes) {
    if (slot.approve !== null && slot.reject) return { ok: false, reason: 'evidence_approvals_mismatch (vote_conflict)' };
    if (slot.approve !== null) counted.push(identity);
  }
  const approvals = rec.approvals as Obj[];
  if (counted.length !== approvals.length || !approvals.every((a) => counted.includes(a.identity))) return { ok: false, reason: 'evidence_approvals_mismatch (identities)' };
  for (const a of approvals) {
    const c = votes.get(a.identity)!.approve!;
    if (c.payload.book !== a.book || c.at !== a.at) return { ok: false, reason: 'evidence_approvals_mismatch (book or at)' };
  }
  if (!approvals.some((a) => a.identity === lp0.approver)) return { ok: false, reason: 'evidence_approver_not_counted' };
  const outs = upto('outcome.recorded');
  const lo = outs[outs.length - 1];
  const dest: string = rec.outcome.destinationTx ?? '';
  if (lo === undefined || lo.payload.status !== rec.outcome.status || lo.payload.destinationTx !== dest) return { ok: false, reason: 'evidence_outcome_missing' };
  return { ok: true, requestHash, approvals: approvals.map((a) => a.identity as string), outcome: { status: rec.outcome.status, destinationTx: dest } };
}

function checkException(x: unknown, rec: Obj, grant: Obj, decision: Obj, requestHash: string, entries: Obj[]): { ok: true; hash: string; officers: string[] } | Bad {
  if (!isObj(x)) return bad('agent_evidence_element_missing', 'exception');
  for (const k of ['object', 'hash', 'officers', 'approvals', 'consumedAt']) if (!has(x, k)) return bad('agent_evidence_element_missing', `exception.${k}`);
  const o = x.object;
  if (!isObj(o) || !isHash(x.hash)) return bad('agent_evidence_exception_malformed', 'exception.object');
  if (exceptionHashOf(o) !== x.hash) return bad('agent_evidence_exception_hash_mismatch', 'exception.hash');
  if (o.schema !== 'certen.exception/v1' || o.grantHash !== rec.grant.hash) return bad('agent_evidence_exception_grant_mismatch', 'exception.object');
  if (!Array.isArray(x.officers) || x.officers.length === 0) return bad('agent_exception_officers_unreadable', 'exception.officers');
  const officerOf = new Map<string, string>();
  const names = new Set<string>();
  for (const of of x.officers as unknown[]) {
    if (!isObj(of) || !isStr(of.name) || of.name.trim() === '' || names.has(of.name) || !Array.isArray(of.identities) || of.identities.length === 0) return bad('agent_exception_officers_unreadable', 'exception.officers');
    names.add(of.name);
    for (const id of of.identities as unknown[]) { if (!isStr(id) || officerOf.has(id)) return bad('agent_exception_officers_unreadable', 'exception.officers'); officerOf.set(id, of.name); }
  }
  if (!Array.isArray(o.lifts) || o.lifts.length !== 1 || o.lifts[0] !== 'perTransaction') return bad('agent_exception_lift_not_per_payment', 'exception.object');
  if (!isInt(o.threshold, 0) || o.threshold < 2) return bad('agent_exception_threshold_below_two', 'exception.object');
  if (!Array.isArray(o.approvers)) return bad('agent_evidence_exception_malformed', 'exception.object');
  const approvers = o.approvers as unknown[];
  for (const a of approvers) if (!isStr(a) || !officerOf.has(a)) return bad('agent_exception_approver_not_officer', 'exception.object', String(a).slice(0, 80));
  for (const a of approvers as string[]) if (a.startsWith('adi:') && isStr(o.subject) && underAdi(a.slice(4), o.subject)) return bad('agent_exception_approver_is_agent', 'exception.object', a);
  if (new Set((approvers as string[]).map((a) => officerOf.get(a))).size < o.threshold) return bad('agent_exception_officers_too_few', 'exception.object');
  if (!isObj(o.validity) || !isInt(o.validity.notBefore) || !isInt(o.validity.notAfter) || !isObj(grant.validity) || o.validity.notAfter > grant.validity.notAfter) return bad('agent_exception_outlives_grant', 'exception.object');
  if (o.singleUse !== true) return bad('agent_evidence_exception_malformed', 'exception.object', 'singleUse');
  const sc = o.scope;
  if (!isObj(sc) || !(sc.kind === 'exact' ? sc.requestHash === requestHash : sc.kind === 'band')) return bad('agent_evidence_exception_scope_mismatch', 'exception.object');
  if (!(decision.issuedAt >= o.validity.notBefore && decision.issuedAt < o.validity.notAfter)) return bad('agent_evidence_exception_not_valid_at_approval', 'exception.object');
  const casts = entries.filter((e) => e.kind === 'approval.cast' && e.payload.exceptionHash === x.hash && approvers.includes(e.payload.identity));
  if (casts.some((e) => e.payload.vote === 'reject')) return bad('agent_evidence_exception_rejected', 'exception.approvals');
  const counted: Array<{ at: number; identity: string; officer: string }> = [];
  const seen = new Set<string>();
  for (const e of casts) {
    if (e.payload.vote !== 'approve') continue;
    const officer = officerOf.get(e.payload.identity)!;
    if (seen.has(officer)) continue;
    seen.add(officer);
    counted.push({ at: e.at, identity: e.payload.identity, officer });
  }
  if (!Array.isArray(x.approvals) || jcs(x.approvals) !== jcs(counted)) return bad('agent_evidence_exception_approvals_mismatch', 'exception.approvals');
  if (seen.size < o.threshold) return bad('agent_exception_officers_not_distinct', 'exception.approvals', `${seen.size} officers for threshold ${o.threshold}`);
  const ks = entries.filter((e) => e.kind === 'exception.consume' && e.payload.exceptionHash === x.hash);
  const lastApproval = Math.max(...counted.map((c) => c.at));
  if (ks.length !== 1 || ks[0]!.payload.requestHash !== requestHash || ks[0]!.at !== x.consumedAt || !(ks[0]!.at >= lastApproval)) return bad('agent_evidence_exception_consumption_mismatch', 'exception.consumedAt', `${ks.length} consume entries`);
  return { ok: true, hash: x.hash, officers: counted.map((c) => c.officer) };
}

function checkTiming(t: Obj, decision: Obj, requestHash: string, entries: Obj[]): { ok: true } | Bad {
  for (const k of ['approvedAt', 'relayedAt', 'delaySeconds', 'window']) if (!has(t, k)) return bad('agent_evidence_element_missing', `timing.${k}`);
  const w = t.window;
  if (!isObj(w) || !isInt(t.approvedAt) || !isInt(t.relayedAt) || !isInt(t.delaySeconds) || !isInt(w.issuedAt) || !isInt(w.expiresAt) || !isInt(w.seconds) || !isInt(w.defaultSeconds)) return bad('agent_evidence_timing_mismatch', 'timing', 'malformed');
  // EV-10 (EVIDENCE-AGT.md section 6, AGT-F125): the effective decision and outcome are the LAST entries for the request among those up to the
  // record's head (the caller passes only those); earlier ones are history (a reissued decision, an outcome appended when the destination is found)
  const forRequest = (kind: string) => entries.filter((e) => e.kind === kind && e.payload.requestHash === requestHash);
  const issued = forRequest('decision.issued').at(-1);
  const outcome = forRequest('outcome.recorded').at(-1);
  if (issued === undefined || issued.payload.decision !== 'approve') return bad('agent_evidence_timing_mismatch', 'timing.approvedAt', 'the last decision logged for the request is not an approval');
  if (issued.payload.nonce !== decision.nonce || issued.payload.issuedAt !== decision.issuedAt || issued.payload.expiresAt !== decision.expiresAt) return bad('agent_evidence_timing_mismatch', 'timing.approvedAt', 'the last decision logged for the request is not the pack decision');
  if (outcome === undefined || !isInt(outcome.payload.relayedAt)) return bad('agent_evidence_timing_mismatch', 'timing.relayedAt', 'no recorded relay time');
  if (t.approvedAt !== decision.issuedAt || t.approvedAt !== issued.at) return bad('agent_evidence_timing_mismatch', 'timing.approvedAt');
  if (t.relayedAt !== outcome.payload.relayedAt) return bad('agent_evidence_timing_mismatch', 'timing.relayedAt');
  if (t.delaySeconds !== t.relayedAt - t.approvedAt) return bad('agent_evidence_timing_mismatch', 'timing.delaySeconds');
  if (w.issuedAt !== decision.issuedAt || w.expiresAt !== decision.expiresAt || w.seconds !== w.expiresAt - w.issuedAt) return bad('agent_evidence_timing_mismatch', 'timing.window');
  if (w.defaultSeconds !== DEC2_DEFAULT_WINDOW_SECONDS) return bad('agent_evidence_timing_mismatch', 'timing.window.defaultSeconds');
  if (t.relayedAt < t.approvedAt) return bad('agent_evidence_relay_before_approval', 'timing.relayedAt');
  if (t.relayedAt >= w.expiresAt) return bad('agent_evidence_relay_outside_window', 'timing.relayedAt');
  return { ok: true };
}

/** Verify an agent-payment evidence pack offline. Unknown or unreadable input is a named refusal; a throw is never an acceptance. */
export function verifyAgentPack(input: unknown): AgentPackVerdict {
  try {
    if (!isObj(input) || !isObj(input.pack) || !isObj(input.grant) || !isObj(input.log) || !Array.isArray(input.log.entries)) return bad('agent_evidence_input_malformed', 'input');
    const pack: Obj = input.pack;
    const grant: Obj = input.grant;
    const entries: unknown[] = input.log.entries;
    for (const k of ELEMENTS) if (!has(pack, k)) return bad('agent_evidence_element_missing', k);
    if (pack.schema !== AGENT_PACK_SCHEMA) return bad('agent_evidence_schema_unknown', 'schema');
    const extra = Object.keys(pack).filter((k) => !ELEMENTS.includes(k));
    if (extra.length > 0) return bad('agent_evidence_element_unknown', extra[0]!);
    for (const k of ['record', 'mandate', 'request', 'decision', 'timing']) if (!isObj(pack[k])) return bad('agent_evidence_element_missing', k);
    const rec: Obj = pack.record;
    for (const k of RECORD_MEMBERS) if (!has(rec, k)) return bad('agent_evidence_element_missing', `record.${k}`);

    // the instruction binding (EVIDENCE-AGT section 2)
    if (!isObj(rec.instruction) || !isHash(rec.instruction.hash)) return bad('evidence_instruction_missing', 'record.instruction');
    const m: Obj = pack.mandate;
    if (m.schema !== 'certen.mandate/v1' || !isObj(m.grant) || !isHash(m.grant.hash) || !isInt(m.grant.version, 1)) return bad('evidence_mandate_malformed', 'mandate');
    if (input.agentIntentHash !== undefined && rec.instruction.hash === input.agentIntentHash) return bad('evidence_instruction_not_mandate', 'record.instruction');
    const mh = mandateHashOf(m);
    if (rec.instruction.hash !== mh) return bad('evidence_instruction_mismatch', 'record.instruction');

    // the core record
    const core = checkRecord(rec, grant, input.log.logId, entries, pack.request, pack.decision);
    if (!core.ok) return bad('agent_evidence_record_invalid', 'record', core.reason);
    const requestHash = core.requestHash;
    // the outcome: an EXECUTED payment names its Base Sepolia transaction, 0x + 64 lower-hex (EVIDENCE-AGT section 1, AGT-F116); other statuses may carry none
    if (rec.outcome.status === 'executed' && !isHash(rec.outcome.destinationTx)) return bad('agent_evidence_destination_missing', 'record.outcome.destinationTx', 'an executed outcome must name its destination transaction');
    if (m.grant.hash !== rec.grant.hash || m.grant.version !== rec.grant.version) return bad('agent_evidence_mandate_grant_mismatch', 'mandate');
    const es = entries as Obj[];

    // the exception, required above the Grant's per-payment limit
    const lim = Array.isArray(grant.limits) ? (grant.limits as unknown[]).find((l): l is Obj => isObj(l) && isObj(l.asset) && l.asset.chainId === pack.request.chainId && String(l.asset.token).toLowerCase() === String(pack.request.asset).toLowerCase()) : undefined;
    if (lim === undefined || !isStr(lim.perTransaction) || !/^[0-9]+$/.test(lim.perTransaction)) return bad('agent_evidence_limit_unreadable', 'request');
    const aboveCap = BigInt(pack.request.amount) > BigInt(lim.perTransaction);
    let exception: { hash: string; officers: string[] } | null = null;
    if (pack.exception === null) {
      if (aboveCap) return bad('agent_evidence_exception_missing', 'exception');
    } else {
      const ev = checkException(pack.exception, rec, grant, pack.decision, requestHash, es);
      if (!ev.ok) return ev;
      exception = { hash: ev.hash, officers: ev.officers };
    }

    const t: Obj = pack.timing;
    const tv = checkTiming(t, pack.decision, requestHash, es.slice(0, rec.logHead.seq));
    if (!tv.ok) return tv;

    return {
      ok: true,
      requestHash,
      mandateHash: mh,
      grantHash: rec.grant.hash,
      policy: { version: rec.policy.version, hash: rec.policy.hash },
      approvals: core.approvals,
      exception,
      transaction: { requestHash, accTxHash: rec.transaction.accTxHash, chainId: rec.transaction.chainId },
      outcome: core.outcome,
      timing: { approvedAt: t.approvedAt, relayedAt: t.relayedAt, delaySeconds: t.delaySeconds, windowSeconds: t.window.seconds, defaultSeconds: DEC2_DEFAULT_WINDOW_SECONDS },
      verified: ['elements', 'instruction_is_mandate', 'grant_document', 'request', 'log_chain', 'log_head', 'decision', 'decision_record', 'approvals', 'outcome', 'mandate_bound_to_grant', exception ? 'exception' : 'no_exception_needed', 'timing'],
      notVerified: [...AGENT_PACK_NOT_VERIFIED],
    };
  } catch (err) {
    return bad('agent_evidence_check_failed', 'input', err instanceof Error ? err.message.slice(0, 120) : 'non-error throw');
  }
}

/**
 * The decision-log check this verifier applies to a pack's log slice (DECISION.md section 9: the hash chain from its genesis, the fifteen kinds and the
 * payload members the evidence check reads), as a verdict: `{ ok: true }` or the first refusal with its `seq`. Exposed so the check can be judged by the
 * specification's decision-log vectors (transaction-controls docs/core/vectors/decision-log.json). It takes no expected head: a pinned head is the
 * Console's commitment, judged by the pack's own log checks.
 */
export function decisionLogVerdict(input: { logId: unknown; entries: unknown }): { ok: true } | { ok: false; reason: string; seq?: number; entry?: number } {
  if (!Array.isArray(input?.entries)) return { ok: false, reason: 'log_entries_malformed' };
  const p = chainProblem(input.logId, input.entries);
  if (p === null) return { ok: true };
  const m = /^([a-z_]+)(?: \((seq|entry) ([0-9]+)\))?$/.exec(p);
  if (!m) return { ok: false, reason: p };
  return { ok: false, reason: m[1]!, ...(m[2] === 'seq' ? { seq: Number(m[3]) } : m[2] === 'entry' ? { entry: Number(m[3]) } : {}) };
}
