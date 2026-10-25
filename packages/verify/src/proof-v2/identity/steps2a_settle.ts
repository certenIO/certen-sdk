// Steps 10-14 of the contract-identity verifier (package 2a, part 2; twin of step_2a_settle.go): the anchor identity and record, the verifier
// chain, the state at the settlement block (Open entries only) and the authority level of the settled call.
import { ABIError, decodeGovernanceBatchData, decodeGovernanceOperationData, decodeSettlementCall } from './abidec.js';
import { abiPackRoot } from './abipack.js';
import { addrOf, addrWord, bigOf, concat, eq, hashOf, isZero, keccak, lowerHex, low20, padWord, utf8, wordOf, zeros } from './bytes.js';
import { TagCaptured } from './codec.js';
import { open, settleStated, verified, type AnchorRecord, type Env, type StepOutput, type Words } from './framework.js';
import * as N from './names.js';
import { readBytes } from './reads.js';
import { arrayElementSlot, keyBytes32, keyBytes4, keyAddress, mappingSlotAt, memberSlot, pageSlot, slotIndex } from './slots.js';
import { must, type StateError } from './states.js';
import type { CanonValue } from './canon.js';
import { K, R, Rd, U, carried, checkImmutables, judgeCode, one, statedU } from './steps2a.js';
void carried;

const statedOrNone = (env: Env, part: string): StepOutput | undefined => {
  const st = settleStated(env);
  return st ? one(U(part, statedU(st, part))) : undefined;
};

export function step10(env: Env): StepOutput {
  const f = env.facts.A;
  const { manifest: m, ctx } = env;
  const sd = statedOrNone(env, N.JudgedCodeIdentity);
  if (sd) return sd;
  const row = m.deployment(ctx.chain, N.RoleAnchor);
  if (!row) { f.anchorRefusal = must(N.CodeAddressNotPublished, '', { role: N.RoleAnchor, address: zeros(20) }); return one(R(N.JudgedCodeIdentity, f.anchorRefusal)); }
  const bld = m.build(row.build);
  if (!bld) throw new Error(`contractidentity: the manifest has no build "${row.build}"`);
  const j = judgeCode(new Rd(env), N.RoleAnchor, 'anchor', f.anchor, bld, false);
  if (j.refusal) { f.anchorRefusal = j.refusal; return one(R(N.JudgedCodeIdentity, j.refusal)); }
  const chainWord = wordOf(ctx.chain);
  const st = checkImmutables(N.RoleAnchor, j.code!, bld, (im) => {
    if (im.rule.kind !== 'chainId') throw new Error(`contractidentity: anchor immutable ${im.name} has the rule kind "${im.rule.kind}"`);
    return chainWord;
  });
  if (st) { f.anchorRefusal = st; return one(R(N.JudgedCodeIdentity, st)); }
  f.anchorState = j.acct; f.anchorCode = j.code!;
  return one(verified(N.JudgedCodeIdentity));
}

const record = (words: Uint8Array[], isBatch: Uint8Array, leafCount: Uint8Array): AnchorRecord => {
  const p = words[10]!;
  return {
    words, bundleId: words[0]!, merkleRoot: words[1]!, executionCommitment: words[6]!, operationId: words[7]!, accumulateBlockHeight: words[8]!, accSetRoot: words[11]!,
    accIncarnation: words[12]!, batchLeafCount: leafCount, valid: p[11] === 1, proofExecuted: p[10] === 1, governanceExecuted: p[9] === 1, governanceLevel: p[8]!, isBatchAnchor: eq(isBatch, slotIndex(1)),
  };
};

export function step11(env: Env): StepOutput {
  const f = env.facts.A;
  const { ctx } = env;
  const sd = statedOrNone(env, N.JudgedRecord);
  if (sd) return sd;
  if (isZero(f.anchorId)) return { parts: [U(N.JudgedRecord, f.pathFailure!)], readPlanIncomplete: 'anchor_id_unavailable' };
  if (f.anchorRefusal) return { parts: [R(N.JudgedRecord, f.anchorRefusal)], readPlanIncomplete: 'anchor_not_established' };
  const r = new Rd(env);
  const rec = mappingSlotAt(keyBytes32(f.anchorId), 1);
  const words = Array.from({ length: 13 }, (_, k) => r.slot(f.anchor, f.anchorState, memberSlot(rec, k)));
  const isBatch = r.slot(f.anchor, f.anchorState, mappingSlotAt(keyBytes32(f.anchorId), 2));
  const leafCount = r.slot(f.anchor, f.anchorState, mappingSlotAt(keyBytes32(f.anchorId), 3));
  if (!r.ok()) return { parts: [R(N.JudgedRecord, r.bad!)], readPlanIncomplete: 'anchor_record' };
  const a = record(words, isBatch, leafCount);
  const inconsistent = (field: string): StepOutput => one(R(N.JudgedRecord, must(N.CodeRecordInconsistent, '', { field })));
  if (!eq(a.bundleId, f.anchorId)) return inconsistent('bundle_id');
  if (!a.valid || !a.proofExecuted) return one(R(N.JudgedRecord, must(N.CodeRecordNotExecuted, '', { anchorId: f.anchorId, valid: a.valid, proofExecuted: a.proofExecuted })));
  f.record = a;
  if (!a.isBatchAnchor) return one(U(N.JudgedRecord, must(N.CodeUnproven, N.RowUnprovenAnchorNotBatch, { anchorId: f.anchorId })));
  const packed = concat(utf8('certen:batchbundle:v2'), wordOf(ctx.chain), a.merkleRoot, a.batchLeafCount, a.operationId, a.accumulateBlockHeight, a.accSetRoot, a.accIncarnation);
  if (!eq(K(packed), f.anchorId)) return inconsistent('bundle_id');
  const b = ctx.batch;
  for (const [field, got, want] of [['merkle_root', a.merkleRoot, b.batchRoot], ['operation_id', a.operationId, b.operationId], ['acc_set_root', a.accSetRoot, b.accSetRoot], ['incarnation', a.accIncarnation, b.incarnation]] as const) {
    if (!eq(got, want)) return inconsistent(field);
  }
  return one(verified(N.JudgedRecord));
}

export function step12(env: Env): StepOutput {
  const f = env.facts.A;
  const { manifest: m, ctx } = env;
  const sd = statedOrNone(env, N.JudgedCodeIdentity);
  if (sd) return sd;
  if (f.anchorRefusal) return { parts: [R(N.JudgedCodeIdentity, f.anchorRefusal)], readPlanIncomplete: 'anchor_not_established' };
  const judged = [N.RuleVERIFIERID];
  const r = new Rd(env);
  const w30 = r.slot(f.anchor, f.anchorState, slotIndex(30));
  if (!r.ok()) return { parts: [R(N.JudgedCodeIdentity, r.bad!)], readPlanIncomplete: 'anchor_slot_30' };
  const v = low20(w30);
  f.verifierFlags = Uint8Array.of(w30[10]!, w30[9]!);
  const notPublished = (role: string, a: Uint8Array): StepOutput => ({ parts: [R(N.JudgedCodeIdentity, must(N.CodeAddressNotPublished, '', { role, address: a }))], rulesJudged: judged, readPlanIncomplete: 'verifier_chain_not_established' });
  const vrow = m.deployment(ctx.chain, N.RoleBlsZkVerifier);
  if (!vrow || isZero(v) || !eq(addrOf(vrow.address), v)) return notPublished(N.RoleBlsZkVerifier, v);
  f.verifier = v;
  const vb = m.build(vrow.build);
  if (!vb) throw new Error(`contractidentity: the manifest has no build "${vrow.build}"`);
  const jv = judgeCode(r, N.RoleBlsZkVerifier, 'blsZkVerifier', v, vb, false);
  f.verifierState = jv.acct;
  const refuse = (st: StateError): StepOutput => ({ parts: [R(N.JudgedCodeIdentity, st)], rulesJudged: judged, readPlanIncomplete: 'verifier_chain_not_established' });
  if (jv.refusal) return refuse(jv.refusal);
  f.verifierCode = jv.code!;
  let first = zeros(32);
  const st = checkImmutables(N.RoleBlsZkVerifier, jv.code!, vb, (im, idx) => {
    if (im.rule.kind !== 'deployment') throw new Error(`contractidentity: verifier immutable ${im.name} has the rule kind "${im.rule.kind}"`);
    if (idx === 0) {
      const ref = im.references[0]!;
      first = addrWord(low20(jv.code!.slice(ref.start, ref.start + 32)));
    }
    return first;
  });
  if (st) return refuse(st);
  const g = low20(first);
  const grow = m.deployment(ctx.chain, N.RoleGroth16Verifier);
  if (!grow || !eq(addrOf(grow.address), g)) return notPublished(N.RoleGroth16Verifier, g);
  f.groth16 = g; f.groth16Build = grow.build;
  const gb = m.build(grow.build);
  if (!gb) throw new Error(`contractidentity: the manifest has no build "${grow.build}"`);
  const jg = judgeCode(r, N.RoleGroth16Verifier, '', g, gb, false);
  f.groth16State = jg.acct;
  if (jg.refusal) return refuse(jg.refusal);
  f.groth16Code = jg.code!;
  return { parts: [verified(N.JudgedCodeIdentity)], rulesJudged: judged };
}

const DriftRows = ['A05', 'A07', 'A10', 'A11', 'A14', 'A18'];
const validatorKey = (a: Uint8Array): string => 'A09:' + lowerHex(a);
const DriftSuffixes = [':0', ':1', ':key'];
export function driftIds(post: Words): string[] {
  const rec = Object.keys(post).filter((k) => k.startsWith('A09:') && DriftSuffixes.some((s) => k.endsWith(s))).sort();
  return [...DriftRows, ...rec];
}
/** The AUTH words of a captured attestation must be complete (an error, never a skipped comparison). */
function attestWordsComplete(env: Env): void {
  const f = env.facts;
  if (!f.B1.attestCaptured) return;
  for (const [name, st] of [['Pre', f.B2.pre], ['Post', f.B2.post]] as const) {
    if (Object.keys(st.words).length === 0 && isZero(st.stateRoot)) continue;
    const missing = DriftRows.filter((id) => !(id in st.words));
    for (const k of Object.keys(st.words).filter((x) => x.startsWith('A10:')).sort()) {
      const rk = validatorKey(low20(st.words[k]!));
      for (const sfx of DriftSuffixes) if (!((rk + sfx) in st.words)) missing.push(rk + sfx);
    }
    if (missing.length > 0) throw new Error(`contractidentity: step 13: Facts.B2.${name}.Words lacks the AUTH rows ${missing.join(',')} although the attestation part is captured`);
  }
}

export function step13(env: Env): StepOutput {
  const f = env.facts.A;
  const { manifest: m, ctx } = env;
  const part = N.JudgedStateAtSettlement;
  const sd = statedOrNone(env, part);
  if (sd) return sd;
  attestWordsComplete(env);
  if (f.anchorRefusal || isZero(f.verifier) || isZero(f.anchorState.storageRoot)) return { parts: [verified(part)], readPlanIncomplete: 'anchor_chain_not_established' };
  const pol = m.policy();
  const r = new Rd(env);
  const A = f.anchor; const V = f.verifier; const acctA = f.anchorState; const acctV = f.verifierState;
  r.account(f.groth16);
  const words: Words = {};
  const a = (id: string, s: Uint8Array): Uint8Array => { const w = r.slot(A, acctA, s); words[id] = w; return w; };
  const paused = a('A01', slotIndex(0));
  let incomplete = '';
  if (env.container!.attest.tag === TagCaptured) {
    if (!isZero(env.facts.B1.pkc)) a('A05', mappingSlotAt(keyBytes32(env.facts.B1.pkc), 4)); else incomplete = 'pkc_unavailable';
  }
  a('A07', slotIndex(5));
  const bind = a('A08', slotIndex(6));
  const nWord = a('A10', slotIndex(13));
  let n = bigOf(nWord);
  if (r.ok() && n > BigInt(env.limits.maxValidators)) { incomplete = 'validator_list_too_large'; n = 0n; }
  const vals: { addr: Uint8Array; power: Uint8Array }[] = [];
  for (let i = 0n; i < n && r.ok(); i++) {
    const { slot: el } = arrayElementSlot(13, i, 20);
    const val = a(`A10:${i}`, el);
    const base = mappingSlotAt(keyAddress(low20(val)), 12);
    const k = validatorKey(low20(val));
    words[k + ':0'] = r.slot(A, acctA, base);
    const power = r.slot(A, acctA, memberSlot(base, 1));
    words[k + ':1'] = power;
    vals.push({ addr: low20(val), power });
    const kb = r.bytes(A, acctA, memberSlot(base, 2), 256n);
    if (kb) words[k + ':key'] = keccak(kb);
    words[k + ':3'] = r.slot(A, acctA, memberSlot(base, 3));
  }
  a('A11', slotIndex(14));
  const num = a('A12', slotIndex(15)); const den = a('A13', slotIndex(16)); const root = a('A14', slotIndex(17));
  const owner = a('A16', slotIndex(27));
  const gov = a('A17', slotIndex(29));
  const s30 = a('A18', slotIndex(30));
  words['A18'] = addrWord(low20(s30));
  words['A19'] = wordOf(s30[11]!); words['A20'] = wordOf(s30[10]!); words['A21'] = wordOf(s30[9]!);
  const v0 = r.slot(V, acctV, slotIndex(0)); const v1 = r.slot(V, acctV, slotIndex(1)); const v2 = r.slot(V, acctV, slotIndex(2));
  words['V01'] = v0; words['V02'] = v1; words['V03'] = v2;
  const ownersA = m.ownerCovering(ctx.chain, 'anchor', f.settleHeader!.number);
  let ownersV = m.ownerCovering(ctx.chain, 'blsZkVerifier', f.settleHeader!.number);
  if (ownersV.length === 0) ownersV = ownersA;
  const seen = new Set<string>();
  for (const o of [...ownersA, ...ownersV]) { const oa = addrOf(o.address); if (!seen.has(lowerHex(oa))) { seen.add(lowerHex(oa)); r.account(oa); } }
  if (!r.ok()) return { parts: [R(part, r.bad!)], readPlanIncomplete: 'state_at_settlement' };
  f.settleAuth = words;
  const out: StepOutput = {
    parts: [verified(part)], readPlanIncomplete: incomplete, open: [],
    rulesJudged: [N.RulePAUSED, N.RuleBINDING, N.RuleENABLED, N.RuleTHRESHOLDA, N.RuleTHRESHOLDV, N.RuleOWNER, N.RuleGOVVERIFIER, N.RuleMINGOV, N.RuleSETROOT],
  };
  if (incomplete === '') out.rulesJudged!.push(N.RuleREGISTERED, N.RulePOWER, N.RuleTOTALPOWER);
  const alert = (field: string, onchain: CanonValue, want: CanonValue): void => { out.open!.push(open(part, N.OpenAlert, N.CodeAlert, '', { field, at: N.AtSettle, onchain, want })); };
  const ratio = (x: Uint8Array, y: Uint8Array): string => `${bigOf(x)}/${bigOf(y)}`;
  const flag = (b: boolean): bigint => (b ? 1n : 0n);
  if (paused[31] !== 0) alert('paused', BigInt(paused[31]!), 0n);
  if (bind[31] !== Number(flag(pol.pubkeyBindingEnforced))) alert('binding', BigInt(bind[31]!), flag(pol.pubkeyBindingEnforced));
  if (s30[11] !== Number(flag(pol.blsZkVerificationEnabled))) alert('enabled', BigInt(s30[11]!), flag(pol.blsZkVerificationEnabled));
  const wantA = `${pol.blsThreshold.numerator}/${pol.blsThreshold.denominator}`;
  if (ratio(num, den) !== wantA) alert('threshold', ratio(num, den), wantA);
  const wantV = `${pol.verifierThreshold.numerator}/${pol.verifierThreshold.denominator}`;
  if (ratio(v0, v1) !== wantV) alert('verifier_threshold', ratio(v0, v1), wantV);
  for (const [got, rows] of [[low20(owner), ownersA], [low20(v2), ownersV]] as const) {
    const inRows = rows.some((o) => eq(addrOf(o.address), got));
    if (!inRows) alert('owner', got, rows.length > 0 ? addrOf(rows[0]!.address) : zeros(20));
  }
  const g = low20(gov);
  if (!isZero(g)) alert('governance_verifier', g, zeros(20));
  if (s30[10]! < pol.minimumGovernanceLevel) alert('minimum_governance_level', BigInt(s30[10]!), BigInt(pol.minimumGovernanceLevel));
  if (incomplete === '') {
    let registered = 0n;
    let sum = 0n;
    let zero = -1;
    vals.forEach((v, i) => {
      if (eq(words[validatorKey(v.addr) + ':0']!, wordOf(1))) registered++;
      const p = bigOf(v.power);
      sum += p;
      if (p === 0n && zero < 0) zero = i;
    });
    if (registered !== BigInt(vals.length)) alert('registered', registered, BigInt(vals.length));
    if (zero >= 0) alert('power', vals[zero]!.power, 1n);
    const tot = words['A11']!;
    if (bigOf(tot) !== sum) alert('total_power', tot, wordOf(sum));
    const sorted = [...vals].sort((x, y) => { for (let i = 0; i < 20; i++) if (x.addr[i] !== y.addr[i]) return x.addr[i]! - y.addr[i]!; return 0; });
    const want = keccak(abiPackRoot(sorted.map((v) => v.addr), sorted.map((v) => bigOf(v.power)), bigOf(num), bigOf(den)));
    if (!eq(want, root)) alert('set_root', root, want);
  }
  for (const id of driftIds(env.facts.B2.post.words)) {
    const att = env.facts.B2.post.words[id];
    if (!att) continue;
    const cur = words[id] ?? zeros(32);
    if (!eq(cur, att)) out.open!.push(open(part, N.OpenDrift, N.CodeDrift, '', { field: id, attest: att, settle: cur }));
  }
  return out;
}

const Levels = [N.LevelNONE, N.LevelOPERATOR, N.LevelMANAGER, N.LevelADMIN, N.LevelROOT];
function levelOf(page: bigint, book: Uint8Array, setWord: Uint8Array, stored: Uint8Array, governing: Uint8Array): { level: number; source: string; invalid?: bigint } {
  if (page === 0n || isZero(book)) return { level: 0, source: 'none' };
  if (!isZero(setWord)) { const v = bigOf(stored); return v > 4n ? { level: 0, source: 'stored', invalid: v } : { level: Number(v), source: 'stored' }; }
  if (!eq(book, governing)) return { level: 0, source: 'none' };
  if (page === 1n) return { level: 4, source: 'governing_default' };
  if (page === 2n) return { level: 3, source: 'governing_default' };
  return { level: 1, source: 'governing_default' };
}
function requiredFor(stored: number, value: bigint): number {
  if (stored !== 0) return stored;
  const ether = 10n ** 18n;
  if (value >= ether * 10n) return 4;
  if (value >= ether) return 3;
  if (value >= ether / 10n) return 2;
  return 1;
}

export function step14(env: Env): StepOutput {
  const f = env.facts.A;
  const part = N.JudgedAuthorityLevel;
  const bl = (() => { const b = blockedAuthority(env, part); return b; })();
  if (bl) return bl;
  if (f.pathFailure) return { parts: [U(part, f.pathFailure)], readPlanIncomplete: 'settlement_call_not_pinned' };
  if (isZero(f.governingBookHash)) return { parts: [U(part, must(N.CodeUnproven, N.RowUnprovenAuthorityLevelUnproven, { reason: N.LevelReasonCalldataUndecodable, field: 'governing_book_hash' }))], readPlanIncomplete: 'governing_book_hash_unavailable' };
  const unproven = (fields: Record<string, CanonValue>): StepOutput => one(U(part, must(N.CodeUnproven, N.RowUnprovenAuthorityLevelUnproven, fields)));
  const undecoded = (fields: Record<string, CanonValue>): StepOutput => ({ ...unproven(fields), readPlanIncomplete: 'settlement_calldata' });
  let call;
  try { call = decodeSettlementCall(env.ctx.tx!.data); } catch (e) {
    if (!(e instanceof ABIError)) throw e;
    if (e.kind === 'cap') return undecoded({ reason: N.LevelReasonTooManyLegs, count: e.got, limit: e.limit });
    return undecoded({ reason: N.LevelReasonCalldataUndecodable, field: e.field });
  }
  const book = call.proof.authorityBook;
  const page = call.proof.authorityPage;
  const r = new Rd(env);
  const setWord = r.slot(f.account, f.accountState, pageSlot(10, book, page));
  const stored = r.slot(f.account, f.accountState, pageSlot(9, book, page));
  const reqs = call.legs.map((l) => r.slot(f.account, f.accountState, mappingSlotAt(keyBytes4(l.selector), 8)));
  if (!r.ok()) return { parts: [R(part, r.bad!)], readPlanIncomplete: 'authority_level' };
  const invalidWord = (slot: Uint8Array): StepOutput => one(R(part, must(N.CodeProofInvalid, '', { root: N.AtSettle, address: f.account, slot })));
  if (!isZero(setWord) && !eq(setWord, slotIndex(1))) return invalidWord(pageSlot(10, book, page));
  const lv = levelOf(page, book, setWord, stored, f.governingBookHash);
  if (lv.invalid !== undefined) return one(R(part, must(N.CodeAuthorityLevelInvalid, '', { field: N.LevelInvalidFieldPageLevel, got: lv.invalid })));
  const required: number[] = [];
  for (const [i, l] of call.legs.entries()) {
    const v = bigOf(reqs[i]!);
    if (v > 4n) return invalidWord(mappingSlotAt(keyBytes4(l.selector), 8));
    required.push(requiredFor(Number(v), l.value));
  }
  for (const [i, l] of call.legs.entries()) if (eq(l.target, f.account)) return unproven({ reason: N.LevelReasonSelfCallLeg, leg: BigInt(i) });
  const logged = loggedLevel(env, call);
  if (logged === undefined) return unproven({ reason: N.LevelReasonLevelLogMissing });
  if (logged !== lv.level) return unproven({ reason: N.LevelReasonLevelDiffersFromLogged, logged: Levels[logged]!, computed: Levels[lv.level]! });
  const obj = { level: Levels[lv.level]!, loggedLevel: Levels[logged]!, book, page, source: lv.source, legs: [] as { target: Uint8Array; selector: Uint8Array; value: bigint; required: string }[] };
  for (const [i, l] of call.legs.entries()) {
    if (lv.level < required[i]!) return unproven({ reason: N.LevelReasonLevelBelowRequiredAtN, leg: BigInt(i), level: Levels[lv.level]!, required: Levels[required[i]!]! });
    obj.legs.push({ target: l.target, selector: l.selector, value: l.value, required: Levels[required[i]!]! });
  }
  f.authority = obj;
  return one(verified(part));
}

function blockedAuthority(env: Env, part: string): StepOutput | undefined {
  const f = env.facts.A;
  const st = settleStated(env);
  if (st) return one(U(part, statedU(st, part)));
  const inc = (p: ReturnType<typeof U>): StepOutput => ({ parts: [p], readPlanIncomplete: 'account_not_established' });
  if (isZero(f.account)) { if (!f.pathFailure) throw new Error('contractidentity: no account was selected and step 3 recorded no failure'); return inc(U(part, f.pathFailure)); }
  if (f.generationState) return inc(U(part, f.generationState));
  if (f.accountRefusal) return inc(R(part, f.accountRefusal));
  if (!f.accountState.exists) throw new Error('contractidentity: the account state is not established and no step refused it');
  return undefined;
}

function loggedLevel(env: Env, call: ReturnType<typeof decodeSettlementCall>): number | undefined {
  const f = env.facts.A;
  const events = env.manifest.accountEventTopics();
  const opT = events['GovernanceOperationExecuted'];
  const batchT = events['GovernanceBatchExecuted'];
  if (!opT || !batchT) return undefined;
  const ops: { topics: Uint8Array[]; data: Uint8Array }[] = [];
  const batches: { topics: Uint8Array[]; data: Uint8Array }[] = [];
  for (const l of env.ctx.receipt!.logs) {
    if (!eq(l.address, f.account) || l.topics.length !== 3) continue;
    if (eq(l.topics[0]!, hashOf(opT.topic0))) ops.push(l); else if (eq(l.topics[0]!, hashOf(batchT.topic0))) batches.push(l);
  }
  if (ops.length !== call.legs.length) return undefined;
  let level = -1;
  const same = (lv: number): boolean => { if (level >= 0 && level !== lv) return false; level = lv; return true; };
  for (const [i, l] of call.legs.entries()) {
    if (!eq(ops[i]!.topics[2]!, addrWord(l.target))) return undefined;
    let d;
    try { d = decodeGovernanceOperationData(ops[i]!.data); } catch { return undefined; }
    if (!same(d.level)) return undefined;
  }
  if (call.batch) {
    if (batches.length !== 1 || !eq(batches[0]!.topics[2]!, f.anchorId)) return undefined;
    let d;
    try { d = decodeGovernanceBatchData(batches[0]!.data); } catch { return undefined; }
    if (d.callCount !== BigInt(call.legs.length) || !same(d.level)) return undefined;
  }
  return level >= 0 ? level : undefined;
}
void padWord; void readBytes;
