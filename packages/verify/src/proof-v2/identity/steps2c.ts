// Steps 21, 23 and 24 of the contract-identity verifier (package 2c; twin of steps_2c.go): the registry object, the owner pin and the registry
// link of the attestation (S9 or the manifest history), rules_not_judged, and the binding of the state root to the S7 finality level.
// Verdict precedence of registry_mismatch and pkc_mismatch is F17 (S8_FREEZE D8): a compared word that differs between the stations is U.
import { abiPackRoot } from './abipack.js';
import { addrOf, addrWord, bigOf, cmpAddr, eq, hashOf, isZero, keccak, lowerHex, low20, utf8, wordOf, concat } from './bytes.js';
import type { CanonValue } from './canon.js';
import { open, verified, type Env, type StepOutput, type Words } from './framework.js';
import * as N from './names.js';
import { JudgedParts, type OpenEntry, type PartResult } from './report.js';
import { fixedRulesNotJudged } from './runner.js';
import { must, type StateError } from './states.js';
import { R, U } from './steps2a.js';
import type { S7Report } from './context.js';

const baseKeys = ['A01', 'A05', 'A07', 'A08', 'A10', 'A11', 'A12', 'A13', 'A14', 'A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'V03'];
interface Val { addr: Uint8Array; registered: Uint8Array; power: Uint8Array; keyHash: Uint8Array }
interface Station { name: string; at: string; w: Words; n: bigint; vals: Val[]; tooLarge: boolean }
const W = (w: Words, k: string): Uint8Array => w[k] ?? new Uint8Array(32);
const one = wordOf(1);
const valKey = (a: Uint8Array, suffix: string): string => 'A09:' + lowerHex(a) + ':' + suffix;
const missingErr = (station: string, missing: string[]): Error => new Error('contractidentity: step 21: Facts.B2.' + station + ' lacks ' + missing.join(',') + ' although the attestation part is captured');

function load(name: string, at: string, words: Words): Station {
  const s: Station = { name, at, w: words, n: 0n, vals: [], tooLarge: false };
  const missing = baseKeys.filter((k) => !(k in words));
  if (missing.length > 0) throw missingErr(name, missing);
  const n = bigOf(words['A10']!);
  if (n > 64n) { s.tooLarge = true; return s; }
  s.n = n;
  for (let i = 0n; i < n; i++) {
    const el = words['A10:' + i];
    if (!el) { missing.push('A10:' + i); continue; }
    const addr = low20(el);
    const v: Val = { addr, registered: zeros32(), power: zeros32(), keyHash: zeros32() };
    for (const [sfx, f] of [['0', 'registered'], ['1', 'power'], ['key', 'keyHash']] as const) {
      const w = words[valKey(addr, sfx)];
      if (!w) missing.push(valKey(addr, sfx)); else v[f] = w;
    }
    s.vals.push(v);
  }
  if (missing.length > 0) throw missingErr(name, missing);
  return s;
}
const zeros32 = (): Uint8Array => new Uint8Array(32);
const sortedVals = (s: Station): Val[] => [...s.vals].sort((a, b) => cmpAddr(a.addr, b.addr));
function same(pre: Station, post: Station): string {
  for (const k of baseKeys) if (!eq(W(pre.w, k), W(post.w, k))) return k;
  if (pre.n !== post.n) return 'A10';
  for (const [i, b] of post.vals.entries()) {
    const a = pre.vals[i]!;
    if (!eq(a.addr, b.addr) || !eq(a.registered, b.registered) || !eq(a.power, b.power) || !eq(a.keyHash, b.keyHash)) return 'A10:' + i;
  }
  return '';
}
function keyed(env: Env, post: Station): Uint8Array[] {
  const vs = env.facts.B2.validators;
  if (BigInt(vs.length) !== post.n) throw missingErr('Validators', [vs.length + ' entries for a validatorList of ' + post.n]);
  return vs.map((v, i) => {
    if (!eq(v.address, post.vals[i]!.addr) || !v.blsKey || !eq(keccak(v.blsKey), post.vals[i]!.keyHash)) throw missingErr('Validators', ['entry ' + i + ' is not the validator proven at post']);
    return v.blsKey;
  });
}
const lp = (b: Uint8Array): Uint8Array => concat(new Uint8Array([(b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255]), b);
function keysDigest(addrs: Uint8Array[], keys: Uint8Array[]): Uint8Array {
  const idx = addrs.map((_, i) => i).sort((a, b) => cmpAddr(addrs[a]!, addrs[b]!));
  const count = addrs.length;
  const parts = [lp(utf8('certen:validator-keys:v1')), new Uint8Array([(count >>> 24) & 255, (count >>> 16) & 255, (count >>> 8) & 255, count & 255])];
  for (const i of idx) parts.push(addrs[i]!, lp(keys[i]!));
  return keccak(concat(...parts));
}
const frac = (n: bigint, d: bigint): string => n + '/' + d;
const fits64 = (w: Uint8Array): boolean => bigOf(w) < 1n << 64n;
function expectedSubsets(powers: bigint[], total: bigint, num: bigint, den: bigint): bigint | undefined {
  const n = powers.length;
  if (n > 20) return undefined;
  const rhs = total * num;
  const sums: bigint[] = new Array(1 << n).fill(0n);
  let count = 0n;
  for (let mask = 1; mask < 1 << n; mask++) {
    const low = mask & -mask;
    const bit = 31 - Math.clz32(low);
    sums[mask] = sums[mask & (mask - 1)]! + powers[bit]!;
    if (sums[mask]! * den >= rhs) count++;
  }
  return count;
}
const attestAbsentRegistry = (): StateError => must(N.CodeUnproven, N.RowUnprovenAttestAbsent, { reason: N.RowUnprovenAttestAbsent, part: N.JudgedRegistryLink });

function carryIB(ib: Env['facts']['B2']['ib'], part: string): StateError {
  const f: Record<string, CanonValue> = { ...(ib.state!.fields as Record<string, CanonValue>) };
  if ('part' in f) f['part'] = part;
  return must(ib.state!.code, typeof f['reason'] === 'string' ? f['reason'] : '', f);
}
function fieldKeys(field: string, pre: Station, post: Station): string[] {
  if (field === 'threshold') return ['A12', 'A13'];
  if (field === 'set_root' || field === 'certen_set_root' || field === 'message_root') return ['A14'];
  if (field === 'pkc') return ['A05'];
  const set = new Set(['A10']);
  for (const st of [pre, post]) for (const k of Object.keys(st.w)) if ((k.startsWith('A10:') || k.startsWith('A09:')) && !k.endsWith(':3')) set.add(k);
  return [...set].sort();
}
function precedence(env: Env, pre: Station, post: Station, block: bigint, keys: string[], refuse: () => StateError): PartResult {
  for (const k of keys) {
    if (!eq(W(pre.w, k), W(post.w, k))) return U(N.JudgedRegistryLink, must(N.CodeUnproven, N.RowUnprovenStateChangedInBlock, { reason: N.RowUnprovenStateChangedInBlock, field: k, pre: W(pre.w, k), post: W(post.w, k), block }));
  }
  const ib = env.facts.B2.ib;
  if (ib.evaluated && ib.verified) return R(N.JudgedRegistryLink, refuse());
  if (ib.state) return U(N.JudgedRegistryLink, carryIB(ib, N.JudgedRegistryLink));
  return U(N.JudgedRegistryLink, attestAbsentRegistry());
}
/** The owner pin (21b): undefined = verified, an empty-part result = no verdict (rule IB has none), else the part. */
function ownerPin(env: Env, pre: Station, post: Station, block: bigint): PartResult | undefined | 'silent' {
  for (const o of [{ field: 'anchor_owner', key: 'A16', role: 'anchor' }, { field: 'verifier_owner', key: 'V03', role: 'verifier' }]) {
    const pw = W(pre.w, o.key);
    const qw = W(post.w, o.key);
    const rows = env.manifest.ownerCovering(env.ctx.chain, o.role, block);
    const inRows = (w: Uint8Array): boolean => rows.some((r) => eq(w, addrWord(addrOf(r.address))));
    if (!eq(pw, qw)) return U(N.JudgedAuthorizationAttest, must(N.CodeUnproven, N.RowUnprovenStateChangedInBlock, { reason: N.RowUnprovenStateChangedInBlock, field: o.key, pre: pw, post: qw, block }));
    if (inRows(pw)) continue;
    const ib = env.facts.B2.ib;
    if (ib.evaluated && ib.verified) {
      return R(N.JudgedAuthorizationAttest, must(N.CodeAuthorizationMismatch, '', { field: o.field, onchain: low20(pw), want: rows.length > 0 ? addrOf(rows[0]!.address) : new Uint8Array(20), at: N.AtAttestPre }));
    }
    if (ib.state) return U(N.JudgedAuthorizationAttest, carryIB(ib, N.JudgedAuthorizationAttest));
    return 'silent';
  }
  return undefined;
}
function registry9Field(r9: NonNullable<Env['ctx']['registry9']>, pre: Station, post: Station): string {
  const rm = r9.members.map((x) => ({ addr: x.address, power: x.power, key: keccak(Uint8Array.from(x.blsKey.match(/../g) ?? [], (h) => parseInt(h, 16))) })).sort((a, b) => cmpAddr(a.addr, b.addr));
  for (const [i, m] of rm.entries()) {
    for (const st of [post, pre]) {
      const oc = sortedVals(st);
      if (i >= oc.length) continue;
      if (!eq(oc[i]!.addr, m.addr) || !eq(oc[i]!.registered, one)) return 'member_address';
      if (!eq(oc[i]!.power, wordOf(m.power))) return 'member_power';
      if (!eq(oc[i]!.keyHash, m.key)) return 'member_key';
    }
  }
  for (const st of [post, pre]) if (BigInt(rm.length) !== st.n) return 'count';
  for (const st of [post, pre]) if (!eq(W(st.w, 'A12'), wordOf(r9.num)) || !eq(W(st.w, 'A13'), wordOf(r9.den))) return 'threshold';
  const root = keccak(abiPackRoot(rm.map((x) => x.addr), rm.map((x) => x.power), r9.num, r9.den));
  if (!eq(root, W(post.w, 'A14'))) return 'set_root';
  if (!eq(r9.certenSetRoot, W(post.w, 'A14'))) return 'certen_set_root';
  if (!eq(r9.certenSetRoot, W(pre.w, 'A14'))) return 'message_root';
  return '';
}

function history(env: Env, pre: Station, post: Station, block: bigint, keys: Uint8Array[]): { ok: boolean; open: OpenEntry[] } {
  const nc = (part: string, reason: string, f: Record<string, CanonValue>): OpenEntry[] => [open(N.JudgedRegistryLink, N.OpenNotChecked, N.CodeNotChecked, part + ' / ' + reason, { ...f, part, reason })];
  const rootPost = lowerHex(W(post.w, 'A14'));
  const rootPre = lowerHex(W(pre.w, 'A14'));
  let row = env.manifest.setRootRowFor(env.ctx.chain, block, rootPost);
  if (row && rootPre !== rootPost) row = undefined;
  if (!row) return { ok: false, open: nc(N.JudgedRegistryLink, 'no_registry_in_file', {}) };
  const fail = (reason: string, f: Record<string, CanonValue>): { ok: boolean; open: OpenEntry[] } => ({ ok: false, open: nc('registry_keys', reason, f) });
  if (row.keysDigest === null) return fail('row_without_keys_digest', {});
  const want = hashOf(row.keysDigest);
  const gotPost = keysDigest(post.vals.map((v) => v.addr), keys);
  if (!eq(gotPost, want)) return fail('keys_digest_mismatch', { want, got: gotPost });
  let same2 = pre.vals.length === post.vals.length;
  for (let i = 0; same2 && i < post.vals.length; i++) same2 = eq(pre.vals[i]!.addr, post.vals[i]!.addr) && eq(pre.vals[i]!.keyHash, post.vals[i]!.keyHash);
  if (!same2) return fail('keys_digest_mismatch', { want, got: keysDigest(pre.vals.map((v) => v.addr), pre.vals.map((v) => v.keyHash)) });
  for (const st of [post, pre]) {
    if (!eq(W(st.w, 'A12'), wordOf(row.thresholdNumerator)) || !eq(W(st.w, 'A13'), wordOf(row.thresholdDenominator))) {
      const ok = fits64(W(st.w, 'A12')) && fits64(W(st.w, 'A13'));
      return fail('threshold_mismatch', { want: frac(row.thresholdNumerator, row.thresholdDenominator), got: ok ? frac(bigOf(W(st.w, 'A12')), bigOf(W(st.w, 'A13'))) : 'out_of_range' });
    }
  }
  if (row.pkcCount === null) return fail('row_without_pkc_count', {});
  for (const st of [post, pre]) {
    if (!eq(W(st.w, 'A07'), wordOf(row.pkcCount))) return fail('pkc_count_mismatch', { want: row.pkcCount, got: fits64(W(st.w, 'A07')) ? bigOf(W(st.w, 'A07')) : (1n << 64n) - 1n });
  }
  if (row.pkcList === null) return fail('pkc_list_absent', {});
  const list = row.pkcList;
  if (BigInt(list.length) !== row.pkcCount) return fail('pkc_count_mismatch', { want: row.pkcCount, got: BigInt(list.length) });
  const cs: Uint8Array[] = [];
  for (const [i, s] of list.entries()) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(s)) return fail('pkc_list_malformed', { index: BigInt(i) });
    const b = hashOf(s);
    if (i > 0 && cmpAddr(cs[i - 1]!, b) >= 0) return fail('pkc_list_malformed', { index: BigInt(i) });
    cs.push(b);
  }
  if (list.length > env.limits.maxPKCList) return fail('pkc_list_too_large', { count: BigInt(list.length), limit: BigInt(env.limits.maxPKCList) });
  for (const st of [post, pre]) {
    const missing = cs.map((c) => 'A06:' + lowerHex(c)).filter((k) => !(k in st.w));
    if (missing.length > 0) throw missingErr(st.name, missing);
  }
  for (const c of cs) for (const st of [post, pre]) if (!eq(W(st.w, 'A06:' + lowerHex(c)), one)) return fail('pkc_set_mismatch', { entry: c });
  return { ok: true, open: [] };
}

function registryObject(env: Env, pre: Station, post: Station, keys: Uint8Array[]): { [k: string]: CanonValue } | undefined {
  if (same(pre, post) !== '') return undefined;
  const f = env.facts;
  const [a12, a13, a20, a21, a7] = ['A12', 'A13', 'A20', 'A21', 'A07'].map((k) => W(post.w, k));
  if (![a12!, a13!, a20!, a21!, a7!].every(fits64) || bigOf(a20!) > 255n || bigOf(a21!) > 255n) return undefined;
  const thN = bigOf(a12!);
  const thD = bigOf(a13!);
  const members = post.vals.map((v, i) => ({ address: v.addr, power: bigOf(v.power), registered: eq(v.registered, one), blsKey: Array.from(keys[i]!, (b) => b.toString(16).padStart(2, '0')).join('') }));
  const powers: bigint[] = [];
  let powersFit = true;
  for (const v of post.vals) {
    powersFit = powersFit && fits64(v.power);
    if (eq(v.registered, one) && bigOf(v.power) > 0n) powers.push(bigOf(v.power));
  }
  const ac: { [k: string]: CanonValue } = { count: bigOf(a7!), pkc: f.B1.pkc, pkcAuthorized: eq(W(post.w, 'A05'), one) };
  if (fits64(W(post.w, 'A11')) && powersFit && post.n <= 20n) {
    const e = expectedSubsets(powers, bigOf(W(post.w, 'A11')), thN, thD);
    if (e !== undefined) ac['expected_subset_count'] = e;
  }
  return {
    owner: low20(W(post.w, 'A16')), root: W(post.w, 'A14'), threshold: { num: thN, den: thD }, totalVotingPower: bigOf(W(post.w, 'A11')), count: post.n, members,
    authorizedCommitments: ac, binding: eq(W(post.w, 'A08'), one), verifier: low20(W(post.w, 'A18')),
    governance: { paused: !isZero(W(post.w, 'A01')), governanceVerifier: low20(W(post.w, 'A17')), minimumGovernanceLevel: bigOf(a20!), minimumGovernanceLevelForValueOps: bigOf(a21!) },
  };
}

export function step21(env: Env): StepOutput {
  const f = env.facts;
  if (!f.B1.attestCaptured) return {};
  f.C.registry = undefined;
  f.C.registryLink = '';
  const absent = (): StepOutput => ({ parts: [U(N.JudgedRegistryLink, attestAbsentRegistry())] });
  if (!f.B1.headerLinked) return absent();
  const stations: Station[] = [];
  for (const [name, at, st] of [['Pre', N.AtAttestPre, f.B2.pre], ['Post', N.AtAttestPost, f.B2.post]] as const) {
    if (Object.keys(st.words).length === 0) {
      if (!isZero(st.stateRoot)) throw missingErr(name, baseKeys);
      return absent();
    }
    const cs = load(name, at, st.words);
    if (cs.tooLarge) return absent();
    stations.push(cs);
  }
  const [pre, post] = [stations[0]!, stations[1]!];
  const block = f.B1.headerV!.number;
  const keys = keyed(env, post);
  const out: StepOutput = { rulesJudged: ['OWNER'], parts: [], open: [] };
  const pin = ownerPin(env, pre, post, block);
  if (pin === undefined) out.parts!.push(verified(N.JudgedAuthorizationAttest));
  else if (pin !== 'silent') out.parts!.push(pin);
  f.C.registry = registryObject(env, pre, post, keys);
  let link = verified(N.JudgedRegistryLink);
  const r9 = env.ctx.registry9;
  if (r9) {
    const field = registry9Field(r9, pre, post);
    if (field !== '') link = precedence(env, pre, post, block, fieldKeys(field, pre, post), () => must(N.CodeRegistryMismatch, '', { field }));
    if (isZero(r9.signerCommitment)) {
      out.open!.push(open(N.JudgedRegistryLink, N.OpenNotChecked, N.CodeNotChecked, 'pkc_signer_check / no_s9_commitment', { part: 'pkc_signer_check', reason: 'no_s9_commitment' }));
    } else if (link.status === 'verified' && !eq(r9.signerCommitment, f.B1.pkc)) {
      link = precedence(env, pre, post, block, fieldKeys('pkc', pre, post), () => must(N.CodePkcMismatch, '', { s9: r9.signerCommitment, onchain: f.B1.pkc }));
    }
    if (link.status === 'verified') f.C.registryLink = 'via S9';
  } else {
    const h = history(env, pre, post, block, keys);
    out.open!.push(...h.open);
    if (h.ok) f.C.registryLink = 'via manifest_history{keys:digest,pkc:exact_set}';
  }
  out.parts!.push(link);
  return out;
}

export function step23(env: Env): StepOutput {
  env.facts.C.rulesNotJudged = fixedRulesNotJudged();
  return {};
}

const levelRank: Record<string, number> = { none: 0, included: 1, l1_posted: 2, finalized: 3 };
function finalizedStatus(s7: S7Report, leg: { hash: Uint8Array }): { status: string; auth: boolean } {
  if (s7.unsupported !== '') return { status: 'refused:' + s7.unsupported, auth: false };
  const l = s7.levels['finalized'];
  if (!l) return { status: 'absent', auth: false };
  switch (l.status) {
    case 'verified':
      if (!s7.finalizedBlock) return { status: 'verified_block_unavailable', auth: false };
      if (!eq(s7.finalizedBlock.hash, leg.hash)) return { status: 'verified_other_block', auth: false };
      return { status: 'verified', auth: true };
    case 'pending': return { status: 'pending', auth: false };
    case 'level_not_applicable': return { status: 'level_not_applicable', auth: false };
    case 'refused': return { status: 'refused:' + (l.code !== '' ? l.code : 'unnamed'), auth: false };
    default: return { status: 'absent', auth: false };
  }
}
export function step24(env: Env): StepOutput {
  const s7 = env.ctx.s7;
  if (!s7) throw new Error('contractidentity: step 24: no S7 report (context validation should have refused)');
  const lb = env.facts.C.level;
  const { status, auth } = finalizedStatus(s7, env.container!.leg);
  lb.authenticated = auth;
  lb.s7FinalizedStatus = status;
  let best = 'none';
  for (const [name, st] of Object.entries(s7.levels)) if (st.status === 'verified' && (levelRank[name] ?? 0) > levelRank[best]! && (name !== 'finalized' || auth)) best = name;
  lb.judgedAtLevel = best;
  if (s7.unsupported !== '') {
    const st = must(N.CodeUnproven, N.RowUnprovenS7ChainUnsupported, { part: N.UnprovenPartAll, chain: env.ctx.chain });
    lb.judgedAtLevel = 'none';
    lb.authenticated = false;
    return { supersede: true, parts: JudgedParts.map((p) => U(p, st)) };
  }
  return {};
}
