// Steps 18, 18b, 19 and 22 of the contract-identity verifier (package 2b-2; twin of steps_2b2.go): the authorization state of the anchor at the
// state before and after the attestation block, the byte rule and flips, attestation uniqueness, the authorization rules at B_v and the
// intra-block window (rule IB). Verdict precedence is D4 of S8_FREEZE section 6.11: a rule counts only when its words are equal at both stations.
import { TxError, verifyBlockTxs } from './attest.js';
import { abiPackRoot } from './abipack.js';
import { addrOf, addrWord, bigOf, concat, eq, hashOf, isZero, keccak, lowerHex, low20, utf8, wordOf, zeros } from './bytes.js';
import type { CanonValue } from './canon.js';
import { open, verified, type AuthDiff, type AuthStation, type Env, type OwnerCheck, type StepOutput, type ValidatorRow, type Words } from './framework.js';
import type { Build } from './manifest.js';
import * as N from './names.js';
import { hasCode, zeroAccount, type AccountState } from './reads.js';
import type { PartResult } from './report.js';
import { arrayElementSlot, keyAddress, keyBytes32, mappingSlotAt, memberSlot, slotIndex } from './slots.js';
import { must, type StateError } from './states.js';
import { Rd, R, U, buildRefs, checkImmutables, carried, mask } from './steps2a.js';

const K = keccak;
const unproven = (row: string, fields: Record<string, CanonValue>): StateError => must(N.CodeUnproven, row, { ...fields, reason: row });
const absent = (part: string): StateError => unproven(N.RowUnprovenAttestAbsent, { part });
const flip = (): StateError => must(N.CodeAttestMismatch, '', { field: 'flip' });
const authMismatch = (field: string, onchain: CanonValue, want: CanonValue, at: string): StateError => must(N.CodeAuthorizationMismatch, '', { field, onchain, want, at });
function withPart(st: StateError, part: string): StateError {
  const f: Record<string, CanonValue> = { ...(st.fields as Record<string, CanonValue>) };
  if ('part' in f) f['part'] = part;
  return must(st.code, st.reason, f);
}
const num = bigOf;
const ratio = (n: Uint8Array, d: Uint8Array): string => `${num(n)}/${num(d)}`;
const W = (w: Words, k: string): Uint8Array => w[k] ?? zeros(32);

/** The sort order of AUTH row ids: by id, then by numeric suffix (A02:2 before A02:10), bare ids first. */
function keyLess(a: string, b: string): boolean {
  const [ia, ...ra] = a.split(':');
  const [ib, ...rb] = b.split(':');
  if (ia !== ib) return ia! < ib!;
  const sa = ra.length ? a.slice(ia!.length + 1) : '';
  const sb = rb.length ? b.slice(ib!.length + 1) : '';
  if (sa === '' || sb === '') return sa === '' && sb !== '';
  const na = /^[0-9]+$/.test(sa) ? BigInt(sa) : undefined;
  const nb = /^[0-9]+$/.test(sb) ? BigInt(sb) : undefined;
  if (na !== undefined && nb !== undefined) return na < nb;
  if ((na !== undefined) !== (nb !== undefined)) return na !== undefined;
  return sa < sb;
}
const cmpKeys = (a: string, b: string): number => (keyLess(a, b) ? -1 : keyLess(b, a) ? 1 : 0);

interface St { name: string; rd: Rd; w: Words; acc: Record<string, AccountState>; val: ValidatorRow[]; v: Uint8Array; g: Uint8Array; vPub: boolean }

function shapedPKCList(raw: string[], count: bigint): Uint8Array[] | undefined {
  if (BigInt(raw.length) !== count || raw.length > 256) return undefined;
  const out: Uint8Array[] = [];
  for (const [i, x] of raw.entries()) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(x)) return undefined;
    const b = hashOf(x);
    if (i > 0 && out[i - 1]!.every((v, j) => v === b[j]) ) return undefined;
    if (i > 0 && cmpBytes(out[i - 1]!, b) >= 0) return undefined;
    out.push(b);
  }
  return out;
}
const cmpBytes = (a: Uint8Array, b: Uint8Array): number => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return a.length - b.length; };

function readStation(env: Env, name: string, root: Uint8Array, A: Uint8Array, anchorId: Uint8Array, opId: Uint8Array, pkc: Uint8Array): St {
  const rd = new Rd(env, name, root);
  const s: St = { name, rd, w: {}, acc: {}, val: [], v: zeros(20), g: zeros(20), vPub: false };
  const acctA = rd.account(A);
  s.acc['A'] = acctA;
  const at = (id: string, sl: Uint8Array): Uint8Array => { const x = rd.slot(A, acctA, sl); s.w[id] = x; return x; };
  at('A01', slotIndex(0));
  const rec = mappingSlotAt(keyBytes32(anchorId), 1);
  for (let k = 0; k < 13; k++) at(`A02:${k}`, memberSlot(rec, k));
  at('A03', mappingSlotAt(keyBytes32(anchorId), 2));
  at('A04', mappingSlotAt(keyBytes32(anchorId), 3));
  at('A05', mappingSlotAt(keyBytes32(pkc), 4));
  at('A07', slotIndex(5));
  at('A08', slotIndex(6));
  const nW = at('A10', slotIndex(13));
  const n = bigOf(nW);
  if (rd.ok() && n > BigInt(env.limits.maxValidators)) rd.bad = must(N.CodeProofInvalid, '', { root: name, address: A, slot: slotIndex(13) });
  for (let i = 0n; rd.ok() && i < n; i++) {
    const addr = low20(at(`A10:${i}`, arrayElementSlot(13, i, 20).slot));
    const base = mappingSlotAt(keyAddress(addr), 12);
    const k = lowerHex(addr);
    const w0 = rd.slot(A, acctA, base);
    const w1 = rd.slot(A, acctA, memberSlot(base, 1));
    const kb = rd.bytes(A, acctA, memberSlot(base, 2), 256n) ?? new Uint8Array(0);
    const w3 = rd.slot(A, acctA, memberSlot(base, 3));
    s.w[`A09:${k}:0`] = w0; s.w[`A09:${k}:1`] = w1; s.w[`A09:${k}:3`] = w3; s.w[`A09:${k}:key`] = K(kb);
    s.val.push({ address: addr, registered: eq(w0, slotIndex(1)), power: w1, blsKey: kb });
  }
  at('A11', slotIndex(14)); at('A12', slotIndex(15)); at('A13', slotIndex(16));
  const a14 = at('A14', slotIndex(17));
  const row = env.manifest.setRootRowFor(env.ctx.chain, env.facts.B1.headerV!.number, lowerHex(a14));
  if (row && row.pkcList !== null && row.pkcCount !== null) for (const c of shapedPKCList(row.pkcList, row.pkcCount) ?? []) at('A06:' + lowerHex(c), mappingSlotAt(keyBytes32(c), 4));
  at('A15', mappingSlotAt(keyBytes32(opId), 18));
  at('A16', slotIndex(27));
  at('A17', slotIndex(29));
  const s30 = at('A18', slotIndex(30));
  s.w['A18'] = addrWord(low20(s30));
  s.w['A19'] = wordOf(s30[11]!); s.w['A20'] = wordOf(s30[10]!); s.w['A21'] = wordOf(s30[9]!);
  s.v = low20(s30);
  const acctV = rd.account(s.v);
  s.acc['V'] = acctV;
  ['V01', 'V02', 'V03'].forEach((id, i) => { s.w[id] = rd.slot(s.v, acctV, slotIndex(i)); });
  const vrow = env.manifest.deploymentAt(env.ctx.chain, lowerHex(s.v));
  if (vrow && vrow.role === N.RoleBlsZkVerifier) {
    s.vPub = true;
    const code = carried(env, s.v);
    if (code && eq(K(code), acctV.codeHash)) {
      const bld = env.manifest.build(vrow.build);
      const im = bld?.immutables.find((x) => x.rule.kind === 'deployment' && x.references.length > 0);
      const ref = im?.references[0];
      if (ref && ref.length === 32 && ref.start >= 0 && ref.start + 32 <= code.length) s.g = low20(code.slice(ref.start, ref.start + 32));
    }
  }
  if (!isZero(s.g)) s.acc['G'] = rd.account(s.g);
  return s;
}
const publish = (s: St, root: Uint8Array): AuthStation => ({ stateRoot: root, words: s.w, accounts: s.acc, verifier: s.v, verifierPublished: s.vPub, groth16: s.g });

function code2(env: Env, root: string, role: string, a: Uint8Array, acct: AccountState, build: Build, part: string): { code?: Uint8Array; st?: StateError } {
  if (!hasCode(acct)) return { st: must(N.CodeAccountAbsent, '', { role, address: a, root }) };
  const c = carried(env, a);
  if (!c) return { st: unproven(N.RowUnprovenCodeNotCarried, { part, address: a }) };
  if (!eq(K(c), acct.codeHash)) return { st: must(N.CodeCodeUnprovenBytes, '', { address: a }) };
  const want = hashOf(build.runtime.maskedKeccak);
  const masked = K(mask(c, buildRefs(build)));
  if (c.length !== build.runtime.bytes || !eq(masked, want)) return { st: must(N.CodeCodeNotPublished, '', { role, address: a, code_hash: acct.codeHash, masked_keccak: masked, want }) };
  return { code: c };
}

/** The identity of A, V and G at one attestation station (b2Chain): the first failure is the state. */
function chain2(env: Env, s: St, A: Uint8Array, part: string): StateError | undefined {
  const m = env.manifest;
  const chain = env.ctx.chain;
  const arow = m.deployment(chain, N.RoleAnchor);
  if (!arow) return must(N.CodeAddressNotPublished, '', { role: N.RoleAnchor, address: A });
  const abld = m.build(arow.build);
  if (!abld) throw new Error(`contractidentity: the manifest has no build "${arow.build}"`);
  const ca = code2(env, s.name, N.RoleAnchor, A, s.acc['A']!, abld, part);
  if (ca.st) return ca.st;
  const chainWord = wordOf(chain);
  const st = checkImmutables(N.RoleAnchor, ca.code!, abld, (im) => {
    if (im.rule.kind !== 'chainId') throw new Error(`contractidentity: anchor immutable ${im.name} has the rule kind "${im.rule.kind}"`);
    return chainWord;
  });
  if (st) return st;
  if (!s.vPub) return undefined;
  const vrow = m.deploymentAt(chain, lowerHex(s.v))!;
  const vbld = m.build(vrow.build);
  if (!vbld) throw new Error(`contractidentity: the manifest has no build "${vrow.build}"`);
  const cv = code2(env, s.name, N.RoleBlsZkVerifier, s.v, s.acc['V']!, vbld, part);
  if (cv.st) return cv.st;
  let first = zeros(32);
  const st2 = checkImmutables(N.RoleBlsZkVerifier, cv.code!, vbld, (im, idx) => {
    if (im.rule.kind !== 'deployment') throw new Error(`contractidentity: verifier immutable ${im.name} has the rule kind "${im.rule.kind}"`);
    if (idx === 0) { const ref = im.references[0]!; first = addrWord(low20(cv.code!.slice(ref.start, ref.start + 32))); }
    return first;
  });
  if (st2) return st2;
  const g = low20(first);
  const grow = m.deployment(chain, N.RoleGroth16Verifier);
  if (!grow || !eq(addrOf(grow.address), g)) return must(N.CodeAddressNotPublished, '', { role: N.RoleGroth16Verifier, address: g });
  const gbld = m.build(grow.build);
  if (!gbld) throw new Error(`contractidentity: the manifest has no build "${grow.build}"`);
  return code2(env, s.name, N.RoleGroth16Verifier, g, s.acc['G'] ?? zeroAccount(), gbld, part).st;
}

function prereq(env: Env): string {
  const f = env.facts;
  if (!f.B1.attestCaptured) return 'attest_not_captured';
  if (isZero(f.B1.stateRootPre) || isZero(f.B1.stateRootPost)) return 'attest_headers_unreadable';
  if (isZero(f.A.anchor)) throw new Error('contractidentity: step 18: no anchor address (step 9 did not run)');
  if (isZero(f.A.anchorId)) return 'anchor_id_unavailable';
  if (isZero(f.B1.pkc)) return 'attest_pkc_unavailable';
  return '';
}

export function step18(env: Env): StepOutput {
  const f = env.facts;
  const why = prereq(env);
  if (why !== '') return { parts: [U(N.JudgedCodeIdentity, absent(N.JudgedCodeIdentity))], readPlanIncomplete: why === 'attest_not_captured' ? '' : why };
  const A = f.A.anchor;
  const anchorId = f.A.anchorId;
  const pkc = f.B1.pkc;
  const opId = env.ctx.batch.operationId;
  const stations: { name: string; root: Uint8Array }[] = [{ name: N.AtAttestPre, root: f.B1.stateRootPre }, { name: N.AtAttestPost, root: f.B1.stateRootPost }];
  const st: St[] = [];
  let bad: StateError | undefined;
  for (const s of stations) {
    const r = readStation(env, s.name, s.root, A, anchorId, opId, pkc);
    st.push(r);
    if (!bad && !r.rd.ok()) bad = r.rd.bad;
  }
  if (bad) {
    return {
      readPlanIncomplete: 'attest_stations',
      parts: f.B1.headerLinked ? [R(N.JudgedAuthorizationAttest, bad), R(N.JudgedCodeIdentity, bad)] : [U(N.JudgedCodeIdentity, absent(N.JudgedCodeIdentity))],
    };
  }
  const b = f.B2;
  b.pre = publish(st[0]!, stations[0]!.root);
  b.post = publish(st[1]!, stations[1]!.root);
  b.validators = st[1]!.val;
  const [pre, post] = [st[0]!, st[1]!];
  const validPre = W(pre.w, 'A02:10')[11] === 1;
  b.recordCreatedInBlock = !validPre;
  let changed: AuthDiff[] = [];
  const ordered = [...new Set([...Object.keys(pre.w), ...Object.keys(post.w)])].sort(cmpKeys);
  for (const k of ordered) {
    if (k === 'A15' || k === 'A02:10' || (!validPre && (k.startsWith('A02:') || k === 'A03' || k === 'A04'))) continue;
    if (!eq(W(pre.w, k), W(post.w, k))) changed.push({ row: k, pre: W(pre.w, k), post: W(post.w, k) });
  }
  let flipBad = false;
  if (!eq(W(pre.w, 'A15'), slotIndex(0)) || !eq(W(post.w, 'A15'), slotIndex(1))) flipBad = true;
  if (validPre) {
    const p = W(pre.w, 'A02:10');
    const q = W(post.w, 'A02:10');
    const outside = !eq(p.slice(12), q.slice(12)) || p[11] !== q[11] || q[11] !== 1 || !eq(p.slice(0, 8), q.slice(0, 8)) || q[9]! > 1;
    if (outside) { changed.push({ row: 'A02:10', pre: p, post: q }); changed.sort((x, y) => cmpKeys(x.row, y.row)); }
    if (p[10] !== 0 || q[10] !== 1 || p[9] !== 0 || p[8] !== 0) flipBad = true;
    if (!isZero(f.B1.call.anchorId) && q[8] !== f.B1.call.authorityLevel) flipBad = true;
    b.governanceExecutedFlip = p[9] === 0 && q[9] === 1;
  }
  let codeChanged = false;
  for (const id of ['A', 'V', 'G']) {
    const p = pre.acc[id]?.codeHash ?? zeros(32);
    const q = post.acc[id]?.codeHash ?? zeros(32);
    if (!eq(p, q)) { changed.push({ row: `C01:${id}`, pre: p, post: q }); codeChanged = true; }
  }
  changed = changed.sort((x, y) => cmpKeys(x.row, y.row));
  b.changed = changed;
  let codeFail: StateError | undefined;
  if (f.B1.headerLinked) for (const s of st) { const x = chain2(env, s, A, N.JudgedCodeIdentity); codeFail ??= x; }
  b.codeFailure = codeFail;
  if (!f.B1.headerLinked) return { parts: [U(N.JudgedCodeIdentity, absent(N.JudgedCodeIdentity))] };
  const parts: PartResult[] = [];
  if (!codeFail) parts.push(verified(N.JudgedCodeIdentity));
  else if (codeFail.code === N.CodeUnproven) parts.push(U(N.JudgedCodeIdentity, codeFail));
  else parts.push(R(N.JudgedCodeIdentity, codeFail));
  const block = f.B1.headerV!.number;
  const part = N.JudgedAuthorizationAttest;
  if (codeFail && !codeChanged && codeFail.code === N.CodeUnproven) parts.push(U(part, withPart(codeFail, part)));
  else if (codeFail && !codeChanged) parts.push(R(part, codeFail));
  else if (flipBad) parts.push(R(part, flip()));
  else if (b.recordCreatedInBlock) parts.push(U(part, must(N.CodeUnproven, N.RowUnprovenRecordCreatedInBlock, { reason: N.RowUnprovenRecordCreatedInBlock, block })));
  else if (changed.length > 0) {
    const d = changed[0]!;
    parts.push(U(part, must(N.CodeUnproven, N.RowUnprovenStateChangedInBlock, { reason: N.RowUnprovenStateChangedInBlock, field: d.row, pre: d.pre, post: d.post, block })));
  } else parts.push(verified(part));
  return { parts };
}

export function step18b(env: Env): StepOutput {
  const f = env.facts;
  const post = f.B2.post;
  if (!f.B1.attestCaptured || !f.B1.headerLinked || Object.keys(post.words).length === 0 || f.B2.codeFailure || f.B2.changed.length > 0) return {};
  const part = N.JudgedAuthorizationAttest;
  const anchorId = f.A.anchorId;
  const pre = f.B2.pre;
  if (!eq(W(post.words, 'A03'), slotIndex(1)) || (!f.B2.recordCreatedInBlock && !eq(W(pre.words, 'A03'), slotIndex(1)))) return { parts: [U(part, unproven(N.RowUnprovenAnchorNotBatch, { anchorId }))] };
  if (!eq(W(post.words, 'A02:7'), env.ctx.batch.operationId)) return { parts: [R(part, flip())] };
  const packed = concat(utf8('certen:batchbundle:v2'), wordOf(env.ctx.chain), ...['A02:1', 'A04', 'A02:7', 'A02:8', 'A02:11', 'A02:12'].map((k) => W(post.words, k)));
  if (!eq(K(packed), anchorId)) return { parts: [R(part, must(N.CodeRecordInconsistent, '', { field: 'bundle_id' }))] };
  return { parts: [verified(part)] };
}

const unchanged = (ch: AuthDiff[], rows: string[]): boolean => !ch.some((d) => rows.some((r) => d.row === r || d.row.startsWith(r + ':')));
function stationValidators(s: AuthStation): ValidatorRow[] {
  const n = bigOf(W(s.words, 'A10'));
  const out: ValidatorRow[] = [];
  for (let i = 0n; i < n; i++) {
    const a = low20(W(s.words, `A10:${i}`));
    const k = lowerHex(a);
    out.push({ address: a, registered: eq(W(s.words, `A09:${k}:0`), slotIndex(1)), power: W(s.words, `A09:${k}:1`) });
  }
  return out;
}
const setRootOf = (s: AuthStation): Uint8Array => {
  const vals = stationValidators(s).sort((x, y) => cmpBytes(x.address, y.address));
  return K(abiPackRoot(vals.map((v) => v.address), vals.map((v) => num(v.power)), num(W(s.words, 'A12')), num(W(s.words, 'A13'))));
};

function innerOK(signed: bigint, total: bigint, den: bigint, nm: bigint): boolean {
  const mod = 1n << 256n;
  const lhs = (signed * den) % mod;
  const rhs = (total * nm) % mod;
  if (den !== 0n && lhs / den !== signed) return false;
  if (nm !== 0n && rhs / nm !== total) return false;
  return lhs >= rhs;
}

type Call = Env['facts']['B1']['call'];
function outerRule(s: AuthStation, call: Call, at: string): StateError | undefined {
  const vals = stationValidators(s);
  const reg = new Map(vals.map((v) => [lowerHex(v.address), v] as const));
  if (call.validatorAddresses.length !== call.votingPowers.length) return authMismatch(N.AuthFieldCount, BigInt(call.votingPowers.length), BigInt(call.validatorAddresses.length), at);
  const seen = new Set<string>();
  let sum = 0n;
  for (const [i, a] of call.validatorAddresses.entries()) {
    const k = lowerHex(a);
    if (seen.has(k)) return authMismatch(N.AuthFieldCount, BigInt(seen.size), BigInt(call.validatorAddresses.length), at);
    seen.add(k);
    const r = reg.get(k);
    if (!r || !r.registered) return authMismatch(N.AuthFieldKey, a, zeros(20), at);
    if (num(r.power) !== call.votingPowers[i]!) return authMismatch(N.AuthFieldPower, r.power, wordOf(call.votingPowers[i]!), at);
    sum += call.votingPowers[i]!;
  }
  if (sum !== call.outerSigned!) return authMismatch(N.AuthFieldPower, wordOf(sum), wordOf(call.outerSigned!), at);
  const total = num(W(s.words, 'A11'));
  if (call.outerTotal! !== total) return authMismatch(N.AuthFieldTotalPower, W(s.words, 'A11'), wordOf(call.outerTotal!), at);
  const nm = num(W(s.words, 'A12'));
  const den = num(W(s.words, 'A13'));
  if (den === 0n) return authMismatch(N.AuthFieldThreshold, wordOf(call.outerSigned!), zeros(32), at);
  const required = (total * nm) / den;
  if (call.outerSigned! < required) return authMismatch(N.AuthFieldThreshold, wordOf(call.outerSigned!), wordOf(required), at);
  return undefined;
}

interface Rule { rows: string[]; u: boolean; test: (s: AuthStation, at: string) => StateError | undefined }

export function step19(env: Env): StepOutput {
  const f = env.facts;
  const b = f.B2;
  if (!f.B1.attestCaptured || !f.B1.headerLinked || Object.keys(b.post.words).length === 0 || Object.keys(b.pre.words).length === 0 || b.codeFailure) return {};
  if (!b.ib.evaluated) throw new Error('contractidentity: step 19: rule IB (step 22) was not evaluated');
  const part = N.JudgedAuthorizationAttest;
  const pol = env.manifest.policy();
  const call = f.B1.call;
  const callOK = !isZero(call.anchorId) && call.outerSigned !== undefined && call.outerTotal !== undefined && call.blobInnerSigned !== undefined && call.blobInnerTotal !== undefined;
  const pkc = f.B1.pkc;
  const out: StepOutput = { rulesJudged: [N.RuleENABLED, N.RuleVERIFIERID, N.RuleBINDING, N.RuleTHRESHOLDA, N.RuleTHRESHOLDV, N.RuleSETROOT, N.RuleMINGOV, N.RulePAUSED, N.RuleGOVVERIFIER] };
  const flag = (x: boolean): bigint => (x ? 1n : 0n);
  const thr = (t: { numerator: bigint; denominator: bigint }): string => `${t.numerator}/${t.denominator}`;
  const rules: Rule[] = [
    { rows: ['A19'], u: false, test: (s, at) => (eq(W(s.words, 'A19'), wordOf(flag(pol.blsZkVerificationEnabled))) ? undefined : authMismatch(N.AuthFieldEnabled, num(W(s.words, 'A19')), flag(pol.blsZkVerificationEnabled), at)) },
    { rows: ['A18'], u: false, test: (s) => (s.verifierPublished ? undefined : must(N.CodeAddressNotPublished, '', { role: N.RoleBlsZkVerifier, address: s.verifier })) },
    { rows: ['A08'], u: false, test: (s, at) => (eq(W(s.words, 'A08'), wordOf(flag(pol.pubkeyBindingEnforced))) ? undefined : authMismatch(N.AuthFieldBinding, num(W(s.words, 'A08')), flag(pol.pubkeyBindingEnforced), at)) },
    { rows: ['A05'], u: false, test: (s, at) => (eq(W(s.words, 'A05'), slotIndex(1)) ? undefined : must(N.CodeCommitmentNotAuthorized, '', { pkc, at })) },
    { rows: ['A12', 'A13'], u: false, test: (s, at) => (ratio(W(s.words, 'A12'), W(s.words, 'A13')) === thr(pol.blsThreshold) ? undefined : authMismatch(N.AuthFieldThreshold, ratio(W(s.words, 'A12'), W(s.words, 'A13')), thr(pol.blsThreshold), at)) },
    { rows: ['V01', 'V02'], u: false, test: (s, at) => (ratio(W(s.words, 'V01'), W(s.words, 'V02')) === thr(pol.verifierThreshold) ? undefined : authMismatch(N.AuthFieldVerifierThreshold, ratio(W(s.words, 'V01'), W(s.words, 'V02')), thr(pol.verifierThreshold), at)) },
    {
      rows: ['A09', 'A10', 'A11'], u: false, test: (s, at) => {
        const vals = stationValidators(s);
        const registered = BigInt(vals.filter((v) => v.registered).length);
        const sum = vals.reduce((n, v) => n + num(v.power), 0n);
        if (registered !== BigInt(vals.length)) return authMismatch(N.AuthFieldCount, registered, BigInt(vals.length), at);
        for (const v of vals) if (num(v.power) === 0n) return authMismatch(N.AuthFieldPower, v.power, 1n, at);
        if (sum !== num(W(s.words, 'A11'))) return authMismatch(N.AuthFieldTotalPower, W(s.words, 'A11'), wordOf(sum), at);
        return undefined;
      },
    },
    { rows: ['A09', 'A10', 'A12', 'A13', 'A14'], u: false, test: (s, at) => { const root = setRootOf(s); return eq(root, W(s.words, 'A14')) ? undefined : authMismatch(N.AuthFieldSetRoot, W(s.words, 'A14'), root, at); } },
    { rows: ['A09', 'A10', 'A11', 'A12', 'A13'], u: false, test: (s, at) => (callOK ? outerRule(s, call, at) : undefined) },
    {
      rows: ['V01', 'V02'], u: false, test: (s, at) =>
        (!callOK || innerOK(call.blobInnerSigned!, call.blobInnerTotal!, num(W(s.words, 'V02')), num(W(s.words, 'V01'))) ? undefined : authMismatch(N.AuthFieldVerifierThreshold, wordOf(call.blobInnerSigned!), wordOf(call.blobInnerTotal!), at)),
    },
    { rows: ['A01'], u: false, test: (s, at) => (W(s.words, 'A01')[31] === 0 ? undefined : authMismatch(N.AuthFieldPaused, BigInt(W(s.words, 'A01')[31]!), 0n, at)) },
    {
      rows: ['A17'], u: true, test: (s, at) => { const g = low20(W(s.words, 'A17')); return isZero(g) ? undefined : unproven(N.RowUnprovenGovernanceVerifierUnpinned, { address: g, at }); },
    },
    { rows: ['A20'], u: false, test: (s, at) => { const got = num(W(s.words, 'A20')); return got >= BigInt(pol.minimumGovernanceLevel) ? undefined : authMismatch(N.AuthFieldMinimumGovernanceLevel, got, BigInt(pol.minimumGovernanceLevel), at); } },
    { rows: ['A20'], u: false, test: (s) => (callOK && BigInt(call.authorityLevel) < num(W(s.words, 'A20')) ? must(N.CodeAttestMismatch, '', { field: 'authority_level' }) : undefined) },
  ];
  let verdict: PartResult | undefined;
  for (const r of rules) {
    const failPre = r.test(b.pre, N.AtAttestPre);
    const failPost = r.test(b.post, N.AtAttestPost);
    if (!failPre || !failPost || !unchanged(b.changed, r.rows)) continue;
    if (verdict) continue;
    if (r.u) verdict = U(part, failPre);
    else if (b.ib.verified) verdict = R(part, failPre);
    else if (b.ib.state && b.ib.state.code === N.CodeUnproven) verdict = U(part, withPart(b.ib.state, part));
    else if (b.ib.state) verdict = R(part, b.ib.state);
    else throw new Error('contractidentity: step 19: rule IB is neither verified nor carries a state');
  }
  out.parts = [verdict ?? verified(part)];
  if (callOK && (call.blobInnerSigned !== call.outerSigned || call.blobInnerTotal !== call.outerTotal)) {
    out.open = [open(part, N.OpenAlert, N.CodeAlert, '', { field: 'inner_outer_differ', at: N.AtAttestPost, onchain: `${call.blobInnerSigned}/${call.blobInnerTotal}`, want: `${call.outerSigned}/${call.outerTotal}` })];
  }
  return out;
}

// The allow-list of writers the specification freezes, keyed by contract name; a contract not listed here is not frozen.
const frozen: Record<string, Record<string, { any?: boolean; paths?: string[] }>> = {
  CertenAnchorV8_2: {
    constructor: { any: true }, createAnchor: { paths: ['anchors[]'] }, createBatchAnchor: { paths: ['anchors[]', 'isBatchAnchor[]', 'batchLeafCount[]'] },
    executeComprehensiveProof: { paths: ['anchors[].proofExecuted', 'anchors[].governanceLevel', 'usedCommitments[]'] }, executeWithGovernance: { paths: ['anchors[].governanceExecuted'] },
  },
  BLSZKVerifierV2_1: { constructor: { any: true } },
};
function gateCondition(env: Env, key: string): string {
  const rec = env.manifest.authWriters(key);
  if (!rec) return N.BuildCondStatusMissing;
  if (rec.status !== 'pass') {
    for (const c of [N.BuildCondA, N.BuildCondB, N.BuildCondC, N.BuildCondD, N.BuildCondE, N.BuildCondF]) if (rec.conditions[c] !== 'pass') return c;
    return N.BuildCondStatusMissing;
  }
  const al = env.manifest.authAllowList(key);
  const bld = env.manifest.build(key);
  if (!al || !bld) return N.BuildCondAllowlistNotFrozen;
  const fz = frozen[bld.contract];
  if (!fz) return N.BuildCondAllowlistNotFrozen;
  for (const row of al.rows) {
    const fr = fz[row.function];
    const any = row.allowedWrites === '*';
    if (!fr || any !== (fr.any === true) || (any && !row.deploymentOnly)) return N.BuildCondAllowlistNotFrozen;
    if (!any) for (const p of row.allowedWrites as string[]) if (!(fr.paths ?? []).includes(p)) return N.BuildCondAllowlistNotFrozen;
  }
  return '';
}

export function step22(env: Env): StepOutput {
  const f = env.facts;
  const part = N.JudgedIntraBlockWindow;
  if (!f.B1.attestCaptured) return {};
  const b = f.B2;
  if (Object.keys(b.pre.words).length === 0 || Object.keys(b.post.words).length === 0) return { parts: [U(part, absent(part))], readPlanIncomplete: 'attest_stations_unavailable' };
  const rdPre = new Rd(env, N.AtAttestPre, f.B1.stateRootPre);
  const rdPost = new Rd(env, N.AtAttestPost, f.B1.stateRootPost);
  const owners: OwnerCheck[] = [];
  const seen = new Set<string>();
  for (const s of [b.pre, b.post]) {
    for (const id of ['A16', 'V03']) {
      const o = low20(W(s.words, id));
      if (seen.has(lowerHex(o))) continue;
      seen.add(lowerHex(o));
      owners.push({ address: o, pre: rdPre.account(o), post: rdPost.account(o) });
    }
  }
  if (!rdPre.ok() || !rdPost.ok()) {
    const bad = rdPre.bad ?? rdPost.bad!;
    if (!f.B1.headerLinked) return { parts: [U(part, absent(part))], readPlanIncomplete: 'attest_owner' };
    b.ib = { evaluated: true, verified: false, state: bad, owners: [], types: [] };
    return { parts: [R(part, bad)], readPlanIncomplete: 'attest_owner' };
  }
  if (!f.B1.headerLinked) return { parts: [U(part, absent(part))] };
  const a = env.container!.attest.attest;
  if (!a) throw new Error('contractidentity: step 22: captured attest part without a body');
  const res = { evaluated: true, verified: false, state: undefined as StateError | undefined, owners, types: [] as number[] };
  const decide = (st: StateError): StepOutput => {
    res.state = st;
    b.ib = res;
    return { parts: [st.code === N.CodeUnproven ? U(part, st) : R(part, st)] };
  };
  let census;
  try { census = verifyBlockTxs(f.B1.headerV!.transactionRoot, a.blockTxs, a.txIndex, a.txLeaf, env.limits); } catch (e) {
    if (!(e instanceof TxError)) throw e;
    if (e.kind === 'too_many_transactions' || e.kind === 'transactions_too_large') return decide(unproven(N.RowUnprovenBlockTooLarge, { part, bytes: e.got, limit: e.limit }));
    return decide(must(N.CodeAttestMismatch, '', { field: 'block_txs' }));
  }
  res.types = census.distinct;
  for (const role of [N.RoleAnchor, N.RoleBlsZkVerifier]) {
    const row = env.manifest.deployment(env.ctx.chain, role);
    if (!row) throw new Error(`contractidentity: step 22: the manifest has no ${role} deployment row for chain ${env.ctx.chain}`);
    const cond = gateCondition(env, row.build);
    if (cond !== '') return decide(unproven(N.RowUnprovenBuildWithoutWriterProof, { part, build: row.build, condition: cond }));
  }
  for (const o of owners) if (hasCode(o.pre) || hasCode(o.post)) return decide(unproven(N.RowUnprovenOwnerNotEoa, { part, address: o.address }));
  for (const o of owners) if (o.pre.nonce !== o.post.nonce) return decide(unproven(N.RowUnprovenOwnerActiveInBlock, { part, address: o.address, pre: o.pre.nonce, post: o.post.nonce }));
  const scan = env.manifest.txScan(env.ctx.chain);
  if (!scan) throw new Error(`contractidentity: step 22: the manifest has no policy.txScan for chain ${env.ctx.chain}`);
  const covered = new Set(scan.coveredTypes);
  const system = new Set(scan.systemTypes);
  for (const [i, ty] of census.types.entries()) {
    if (!covered.has(ty) && !system.has(ty)) return decide(unproven(N.RowUnprovenTxTypeUnsupported, { part, type: '0x' + ty.toString(16).padStart(2, '0'), index: BigInt(i) }));
  }
  res.verified = true;
  b.ib = res;
  return { parts: [verified(part)] };
}
