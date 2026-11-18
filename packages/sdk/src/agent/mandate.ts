/**
 * certen.mandate/v1 (docs/agentic/AGENT-GRANT.md section 3): the principal-signed instruction an agent payment must lie inside.
 * Written independently of docs/agentic/vectors/lib-agt.mjs; the vectors are the judge (agent.vectors.test.ts).
 */
import { canonicalize, digestHex, taggedPreimage } from './core.js';

export const MANDATE_TAG = 'certen:mandate:v1';
export const MANDATE_SCHEMA = 'certen.mandate/v1';

type Obj = Record<string, unknown>;
const isObj = (o: unknown): o is Obj => o !== null && typeof o === 'object' && !Array.isArray(o);
const ACC = /^acc:\/\/[a-z0-9][a-z0-9.-]*\.acme(\/[a-z0-9._-]+)*$/;
export const isAcc = (s: unknown): s is string => typeof s === 'string' && ACC.test(s);
const isAddr = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-f]{40}$/.test(s);
const isHash = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-f]{64}$/.test(s);
export const isAmount = (s: unknown): s is string => typeof s === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(s);
const isInt = (n: unknown, min = 0): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
const exactKeys = (o: unknown, keys: readonly string[]): o is Obj => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => k in o);
const hostOf = (u: string): string => u.replace(/^acc:\/\//, '').split('/')[0]!;

/** The URL is the ADI, a path under it, or a sub-ADI of it (GRANT.md GR-36 reading); a name sharing only a prefix is not. */
export function underAdi(url: unknown, adi: unknown): boolean {
  if (!isAcc(url) || !isAcc(adi)) return false;
  const h = hostOf(url);
  const a = hostOf(adi);
  return h === a || h.endsWith(`.${a}`);
}

export interface Mandate {
  schema: string; mandateId: string; version: number; priorHash: string | null;
  principal: { adi: string; keyBook: string }; agent: { adi: string };
  grant: { grantId: string; version: number; hash: string }; purpose: string;
  limits: { asset: { chainId: number; token: string }; perPayment: string; cumulative: { amount: string; periodSeconds: number } };
  beneficiaries: Array<{ chainId: number; address: string }>;
  validity: { notBefore: number; notAfter: number }; issuedAt: number;
}

const KEYS = ['schema', 'mandateId', 'version', 'priorHash', 'principal', 'agent', 'grant', 'purpose', 'limits', 'beneficiaries', 'validity', 'issuedAt'] as const;

/** null when the mandate is well formed, else the member that is not (the refusal detail). */
export function mandateShape(m: unknown): string | null {
  if (!exactKeys(m, KEYS)) return 'members';
  if (m.schema !== MANDATE_SCHEMA) return 'schema';
  if (typeof m.mandateId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(m.mandateId)) return 'mandateId';
  if (!isInt(m.version, 1)) return 'version';
  if (m.version === 1 ? m.priorHash !== null : !isHash(m.priorHash)) return 'priorHash';
  const p = m.principal;
  if (!exactKeys(p, ['adi', 'keyBook']) || !isAcc(p.adi) || !isAcc(p.keyBook)) return 'principal';
  if (!(p.keyBook as string).startsWith(`${p.adi as string}/`)) return 'principal.keyBook';
  if (!exactKeys(m.agent, ['adi']) || !isAcc(m.agent.adi)) return 'agent';
  const g = m.grant;
  if (!exactKeys(g, ['grantId', 'version', 'hash']) || typeof g.grantId !== 'string' || !isInt(g.version, 1) || !isHash(g.hash)) return 'grant';
  if (m.purpose !== 'vendor-payment') return 'purpose';
  const l = m.limits;
  if (!exactKeys(l, ['asset', 'perPayment', 'cumulative']) || !exactKeys(l.asset, ['chainId', 'token']) || !isInt(l.asset.chainId, 1)
    || !(isAddr(l.asset.token) || l.asset.token === 'native') || !isAmount(l.perPayment)
    || !exactKeys(l.cumulative, ['amount', 'periodSeconds']) || !isAmount(l.cumulative.amount) || !isInt(l.cumulative.periodSeconds, 60)
    || BigInt(l.cumulative.amount) < BigInt(l.perPayment)) return 'limits';
  const b = m.beneficiaries;
  if (!Array.isArray(b) || b.length < 1 || b.length > 64 || !b.every((x) => exactKeys(x, ['chainId', 'address']) && isInt(x.chainId, 1) && isAddr(x.address))) return 'beneficiaries';
  const v = m.validity;
  if (!exactKeys(v, ['notBefore', 'notAfter']) || !isInt(v.notBefore) || !isInt(v.notAfter)) return 'validity';
  if (v.notAfter < v.notBefore || (m.version === 1 && v.notAfter === v.notBefore)) return 'validity';
  if (!isInt(m.issuedAt)) return 'issuedAt';
  return null;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
/** SHA-256( lp("certen:mandate:v1") || lp(canonical mandate) ), canonical form RFC 8785. */
export const mandateHash = (m: unknown): string => digestHex(taggedPreimage(MANDATE_TAG, [utf8(canonicalize(m))]));

export interface MandateLineage { headHash: string; headWithdrawn?: boolean; ambiguous?: boolean }
export interface GrantHeadFacts {
  grantId: string; version: number; hash: string; subject: string; grantor: string;
  validity: { notBefore: number; notAfter: number }; perTransaction: string;
  cumulative: { amount: string; periodSeconds: number }; beneficiaries: Array<{ chainId: number; address: string }>;
}
export interface MandatePayment { beneficiary: { chainId: number; address: string }; asset: { chainId: number; token: string }; amount: string; at: number }
export interface CheckMandateInput {
  mandate: unknown; signerBook: unknown; lineage: unknown; grantHead: unknown; payment: unknown;
  usage?: unknown; lift?: unknown;
}
export type MandateResult = { ok: true; mandateHash: string; liftedPerPayment: boolean } | { ok: false; reason: string; detail?: string };

const no = (reason: string, detail?: string): MandateResult => (detail === undefined ? { ok: false, reason } : { ok: false, reason, detail });

/** AGENT-GRANT.md section 3.3: the refusal order is fixed. Fail closed on anything not established. */
export function checkMandate(input: CheckMandateInput): MandateResult {
  const d = mandateShape(input.mandate);
  if (d) return no('mandate_malformed', d);
  const m = input.mandate as Mandate;
  if (!isAcc(input.signerBook)) return no('mandate_unsigned');
  if (underAdi(input.signerBook, m.agent.adi)) return no('mandate_signed_by_agent');
  if (input.signerBook !== m.principal.keyBook) return no('mandate_signer_not_principal');
  if (underAdi(m.principal.adi, m.agent.adi)) return no('mandate_principal_is_agent');
  const lin = input.lineage;
  if (!isObj(lin) || typeof lin.headHash !== 'string') return no('mandate_lineage_unreadable');
  if (lin.ambiguous === true) return no('mandate_lineage_ambiguous');
  if (mandateHash(m) !== lin.headHash) return no(lin.headWithdrawn === true ? 'mandate_withdrawn' : 'mandate_superseded');
  if (m.validity.notAfter === m.validity.notBefore) return no('mandate_withdrawn');
  const gh = input.grantHead as GrantHeadFacts | undefined;
  if (!isObj(gh) || m.agent.adi !== gh.subject || m.principal.adi !== gh.grantor) return no('mandate_grant_party_mismatch');
  if (m.grant.grantId !== gh.grantId || m.grant.version !== gh.version || m.grant.hash !== gh.hash) return no('mandate_grant_not_head');
  if (!isObj(gh.validity) || !isAmount(gh.perTransaction) || !isObj(gh.cumulative) || !isAmount(gh.cumulative.amount) || !Array.isArray(gh.beneficiaries))
    return no('mandate_grant_unreadable');
  if (m.validity.notBefore < gh.validity.notBefore || m.validity.notAfter > gh.validity.notAfter
    || BigInt(m.limits.perPayment) > BigInt(gh.perTransaction)
    || m.limits.cumulative.periodSeconds !== gh.cumulative.periodSeconds || BigInt(m.limits.cumulative.amount) > BigInt(gh.cumulative.amount)
    || !m.beneficiaries.every((b) => gh.beneficiaries.some((g) => g.chainId === b.chainId && g.address === b.address))) return no('mandate_exceeds_grant');
  const p = input.payment as MandatePayment;
  if (!isObj(p) || !isInt(p.at) || !isObj(p.asset) || !isObj(p.beneficiary) || !isAmount(p.amount)) return no('mandate_payment_malformed');
  if (p.at < m.validity.notBefore) return no('mandate_not_yet_valid');
  if (p.at >= m.validity.notAfter) return no('mandate_expired');
  if (p.asset.chainId !== m.limits.asset.chainId || p.asset.token !== m.limits.asset.token) return no('mandate_asset_mismatch');
  if (!m.beneficiaries.some((b) => b.chainId === p.beneficiary.chainId && b.address === p.beneficiary.address)) return no('mandate_beneficiary_not_listed');
  const usage = input.usage === undefined ? { cumulative: '0' } : input.usage;
  if (!isObj(usage) || !isAmount(usage.cumulative)) return no('mandate_usage_malformed');
  const lifted = input.lift === 'exact';
  if (!lifted && BigInt(p.amount) > BigInt(m.limits.perPayment)) return no('mandate_per_payment_exceeded');
  if (BigInt(usage.cumulative as string) + BigInt(p.amount) > BigInt(m.limits.cumulative.amount)) return no('mandate_cumulative_exceeded');
  return { ok: true, mandateHash: mandateHash(m), liftedPerPayment: lifted };
}

export type MandateRecheck =
  | { ok: true; outcome: 'unchanged' } | { ok: true; outcome: 'denied'; reason: string }
  | { ok: true; outcome: 'exposure_window_open'; until: number } | { ok: true; outcome: 'window_closed' } | { ok: false; reason: 'recheck_malformed' };

/** INTERVENTION.md section 4a: a pending item is re-judged; a certified one is never re-decided (DE-21). */
export function recheckMandate(input: { item: unknown; world: unknown }): MandateRecheck {
  const { item, world } = input;
  if (!isObj(item) || !isObj(world)) return { ok: false, reason: 'recheck_malformed' };
  if (item.certified === true) {
    if (!isInt(item.windowUntil) || !isInt(world.now)) return { ok: false, reason: 'recheck_malformed' };
    return world.now < item.windowUntil ? { ok: true, outcome: 'exposure_window_open', until: item.windowUntil } : { ok: true, outcome: 'window_closed' };
  }
  if (!isObj(item.check) || !isObj(item.check.payment)) return { ok: false, reason: 'recheck_malformed' };
  const c = item.check as unknown as CheckMandateInput & { payment: Obj };
  const r = checkMandate({ ...c, lineage: world.lineage, payment: { ...c.payment, at: world.now }, usage: world.usage });
  return r.ok ? { ok: true, outcome: 'unchanged' } : { ok: true, outcome: 'denied', reason: r.reason };
}

/** EVIDENCE-AGT.md section 2: the agent C5 record binds the signed mandate hash, never the agent's own stated intent. */
export function checkInstructionBinding(input: { record: unknown; mandate: unknown; agentIntentHash?: unknown }): { ok: true } | { ok: false; reason: string } {
  const rec = input.record;
  const h = isObj(rec) && isObj(rec.instruction) ? rec.instruction.hash : undefined;
  if (!isHash(h)) return { ok: false, reason: 'evidence_instruction_missing' };
  if (mandateShape(input.mandate)) return { ok: false, reason: 'evidence_mandate_malformed' };
  if (input.agentIntentHash !== undefined && input.agentIntentHash !== null && h === input.agentIntentHash) return { ok: false, reason: 'evidence_instruction_not_mandate' };
  if (h !== mandateHash(input.mandate)) return { ok: false, reason: 'evidence_instruction_mismatch' };
  return { ok: true };
}
