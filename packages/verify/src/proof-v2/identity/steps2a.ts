// Steps 1c-9 of the contract-identity verifier (package 2a, part 1; twin of steps_2a.go): the settlement facts, the account identity at the
// settlement block, the account strings, immutables and CREATE2 provenance, and the anchor pointer. Steps 10-14 are in steps2a_settle.ts.
import { abiPack, str } from './abipack.js';
import { addrOf, addrWord, concat, eq, hashOf, isZero, keccak, lowerHex, low20, utf8, zeros } from './bytes.js';
import { succeeded } from './context.js';
import { header, notApplicableS6, open, settleStated, verified, type Env, type StepOutput } from './framework.js';
import type { Build, Generation, Immutable, Ref } from './manifest.js';
import * as N from './names.js';
import { hasCode, zeroAccount, readAccount, readBytes, readSlot, ReadError, type AccountState } from './reads.js';
import type { Log } from './context.js';
import { JudgedParts, type PartResult } from './report.js';
import { slotIndex, keyAddress, keyBytes32, mappingSlotAt } from './slots.js';
import { malformed, must, type StateError } from './states.js';
import type { Stated } from './codec.js';

export const buildAccount = 'CertenAccountV7_3/r5';
export const buildFactory = 'CertenAccountFactoryV11/r5';
export const entryPointLiteral = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const S = N.JudgedSettlementPath;

export const R = (part: string, st: StateError): PartResult => ({ part, status: 'refused', state: st });
export const U = (part: string, st: StateError): PartResult => ({ part, status: 'unproven', state: st });
export const one = (p: PartResult): StepOutput => ({ parts: [p] });
export const K = keccak;
export const carried = (e: Env, a: Uint8Array): Uint8Array | undefined => e.container?.codes.find((c) => eq(c.address, a))?.runtime;

export function mask(code: Uint8Array, refs: Ref[]): Uint8Array {
  const out = Uint8Array.from(code);
  for (const r of refs) for (let i = Math.max(r.start, 0); i < Math.min(r.start + r.length, out.length); i++) out[i] = 0;
  return out;
}
export const buildRefs = (b: Build): Ref[] => b.immutables.flatMap((im) => im.references);

/** The U a carried Stated settle part becomes on a part that needs a settlement-block read (D2). */
export function statedU(st: Stated, part: string): StateError {
  if (st.reason !== N.RowUnprovenCaptureNotAttemptedInWindow && st.reason !== N.RowUnprovenStateUnavailable) throw new Error(`contractidentity: stated settle part with reason "${st.reason}" reached a settle-dependent step`);
  return must(N.CodeUnproven, st.reason, {
    reason: st.reason, part, judgedBlock: st.judgedBlock, judgedHash: st.judgedHash, failures: st.failures.map((f) => ({ host: f.host, error: f.error })),
  });
}

/** A reader of the settlement state: the first failed read is the proof_invalid state, a defect is thrown. */
export class Rd {
  bad: StateError | undefined;
  readonly root: Uint8Array;
  constructor(readonly env: Env, readonly name: string = N.AtSettle) { this.root = env.facts.A.stateRootN; }
  ok(): boolean { return this.bad === undefined; }
  private fail(e: unknown, a: Uint8Array): void {
    if (!(e instanceof ReadError)) throw e;
    this.bad ??= must(N.CodeProofInvalid, '', { root: this.name, address: a, slot: e.slot ?? zeros(32) });
  }
  account(a: Uint8Array): AccountState {
    if (!this.ok()) return zeroAccount();
    try { return readAccount(this.root, this.env.nodes!, a); } catch (e) { this.fail(e, a); return zeroAccount(); }
  }
  slot(a: Uint8Array, acct: AccountState, s: Uint8Array): Uint8Array {
    if (!this.ok()) return zeros(32);
    try { return readSlot(acct.storageRoot, this.env.nodes!, s); } catch (e) { this.fail(e, a); return zeros(32); }
  }
  bytes(a: Uint8Array, acct: AccountState, s: Uint8Array, max: bigint): Uint8Array | undefined {
    if (!this.ok()) return undefined;
    try { return readBytes(acct.storageRoot, this.env.nodes!, s, max); } catch (e) { this.fail(e, a); return undefined; }
  }
}

export interface Judged { acct: AccountState; code?: Uint8Array; gen?: Generation; refusal?: StateError }
/** Judges the code at `addr` against a build: account present, carried bytes hash to the proven codeHash, masked hash is the build's (or an unpinned generation). */
export function judgeCode(r: Rd, role: string, genRole: string, addr: Uint8Array, build: Build, scanGen: boolean): Judged {
  const acct = r.account(addr);
  if (!r.ok()) return { acct, refusal: r.bad! };
  if (!hasCode(acct)) return { acct, refusal: must(N.CodeAccountAbsent, '', { role, address: addr, root: r.name }) };
  const code = carried(r.env, addr);
  if (!code || !eq(K(code), acct.codeHash)) return { acct, refusal: must(N.CodeCodeUnprovenBytes, '', { address: addr }) };
  const want = hashOf(build.runtime.maskedKeccak);
  const masked = K(mask(code, buildRefs(build)));
  if (code.length === build.runtime.bytes && eq(masked, want)) return { acct, code };
  if (scanGen) {
    for (const g of r.env.manifest.generations()) {
      if (g.role === genRole && !g.pinned && g.runtimeBytes === code.length && eq(K(mask(code, g.references)), hashOf(g.maskedKeccak))) return { acct, code, gen: g };
    }
  }
  return { acct, code, refusal: must(N.CodeCodeNotPublished, '', { role, address: addr, code_hash: acct.codeHash, masked_keccak: masked, want }) };
}
export const genUnpinned = (row: string, g: Generation, code: Uint8Array): StateError => must(N.CodeUnproven, row, { generation: g.generation, code_hash: K(code), kind: g.kind });

/** Checks every immutable reference of the carried code against the word the rule dictates; returns the first mismatch as a state. */
export function checkImmutables(role: string, code: Uint8Array, build: Build, want: (im: Immutable, idx: number) => Uint8Array): StateError | undefined {
  for (const im of build.immutables) {
    for (const [i, ref] of im.references.entries()) {
      if (ref.length !== 32 || ref.start < 0 || ref.start + ref.length > code.length) throw new Error(`contractidentity: build ${build.contract}/${build.variant} immutable ${im.name} reference ${i} [${ref.start},+${ref.length}) does not fit the ${code.length} byte code`);
      const w = want(im, i);
      const got = code.slice(ref.start, ref.start + 32);
      if (!eq(got, w)) return must(N.CodeImmutableMismatch, '', { role, name: im.name, offset: BigInt(ref.start), got, want: w });
    }
  }
  return undefined;
}

/** The outcome shared by the account-dependent parts when the account is not established (D1). */
function blocked(env: Env, part: string): StepOutput | undefined {
  const f = env.facts.A;
  const st = settleStated(env);
  if (st) return one(U(part, statedU(st, part)));
  const inc = (p: PartResult): StepOutput => ({ parts: [p], readPlanIncomplete: 'account_not_established' });
  if (isZero(f.account)) {
    if (!f.pathFailure) throw new Error('contractidentity: no account was selected and step 3 recorded no failure');
    return inc(U(part, f.pathFailure));
  }
  if (f.generationState) return inc(U(part, f.generationState));
  if (f.accountRefusal) return inc(R(part, f.accountRefusal));
  if (!f.accountState.exists) throw new Error('contractidentity: the account state is not established and no step refused it');
  return undefined;
}
export { blocked };

export function step1c(env: Env): StepOutput {
  const st = settleStated(env);
  if (st && st.reason !== N.RowUnprovenCaptureNotAttemptedInWindow && st.reason !== N.RowUnprovenStateUnavailable) return { framework: malformed(N.PartSettle, N.MalformedUnknownStatedReason, 0, 0, 0) };
  return {};
}

export function step2(env: Env): StepOutput {
  const c = env.container!;
  const s = env.ctx.settlement!;
  if (c.chain !== env.ctx.chain) return { framework: must(N.CodeBlockMismatch, '', { field: 'chain', want: env.ctx.chain, got: c.chain }) };
  let h;
  try { h = header(env, s.header); } catch { return { framework: must(N.CodeBlockMismatch, '', { field: 'number', want: c.leg.number, got: 0n }) }; }
  if (h.number !== c.leg.number) return { framework: must(N.CodeBlockMismatch, '', { field: 'number', want: h.number, got: c.leg.number }) };
  if (!eq(h.hash, c.leg.hash)) return { framework: must(N.CodeBlockMismatch, '', { field: 'hash', want: h.hash, got: c.leg.hash }) };
  env.facts.A.settleHeader = h;
  return {};
}

function infrastructure(env: Env, to: Uint8Array | undefined): { infra: boolean; role: string } {
  if (!to) return { infra: false, role: '' };
  const row = env.manifest.deploymentAt(env.ctx.chain, lowerHex(to));
  if (!row) return { infra: false, role: '' };
  const events = Object.values(env.manifest.accountEventTopics());
  for (const l of env.ctx.receipt!.logs) if (l.topics.length > 0 && events.some((t) => eq(l.topics[0]!, hashOf(t.topic0)))) return { infra: false, role: '' };
  return { infra: true, role: row.role };
}

export function step3(env: Env): StepOutput {
  const { ctx, manifest: m } = env;
  const f = env.facts.A;
  const lc = m.topic('LeafConsumed');
  if (!lc) throw new Error('contractidentity: the manifest has no topics.LeafConsumed');
  const topic0 = hashOf(lc.topic0);
  const to = ctx.tx!.to;
  const sel = new Uint8Array(4);
  sel.set(ctx.tx!.data.slice(0, 4));
  const unsupported = (reason: string): StateError => must(N.CodeUnproven, N.RowUnprovenSettlementPathUnsupported, { to: to ?? zeros(20), selector: sel, reason });
  const proven = ctx.s6Status === N.S6S6Proven;
  const s6Parts = (fail: StateError | undefined): { link: PartResult; opens: ReturnType<typeof open>[] } => {
    if (proven) return { link: U(N.JudgedS6Link, fail!), opens: [] };
    if (ctx.s6Status === N.S6S6NotProven) return { link: notApplicableS6(N.S6S6NotProven), opens: [open(N.JudgedS6Link, N.OpenNotChecked, N.CodeNotChecked, N.RowNotCheckedS6LinkS6NotProven, { state: ctx.s6State })] };
    return { link: notApplicableS6(N.S6S6Silent), opens: [] };
  };
  const fail = (st: StateError): StepOutput => {
    f.pathFailure = st;
    const { link, opens } = s6Parts(st);
    return { parts: [U(S, st), link], open: opens };
  };
  if (!succeeded(ctx.receipt!)) return fail(must(N.CodeUnproven, N.RowUnprovenSettlementNotExecuted, { status: ctx.receipt!.postStateOrStatus }));
  const cands: Log[] = [];
  let foreign = 0;
  for (const l of ctx.receipt!.logs) {
    if (l.topics.length !== 3 || !eq(l.topics[0]!, topic0)) continue;
    if (to && eq(l.address, to)) {
      if (!proven || eq(l.topics[2]!, ctx.s6!.leafKey)) cands.push(l);
      continue;
    }
    foreign++;
  }
  if (cands.length >= 2) return fail(unsupported('multiple_leaf_consumed'));
  if (cands.length === 0 && foreign >= 1) return fail(unsupported('not_direct_call'));
  if (cands.length === 0) {
    if (proven) return fail(must(N.CodeUnproven, N.RowUnprovenSettlementEventMissing, { count: 0n }));
    const { infra, role } = infrastructure(env, to);
    if (infra) {
      const na = must(N.CodeNotApplicable, N.RowNotApplicableCertenInfrastructureCall, { to: to!, role });
      const out: StepOutput = { parts: [], halt: true, haltReason: 'certen_infrastructure_call' };
      for (const p of JudgedParts) {
        if (p === S) out.parts!.push({ part: p, status: 'not_applicable', state: na });
        else if (p === N.JudgedS6Link) { const { link, opens } = s6Parts(na); out.parts!.push(link); out.open = opens; } else out.parts!.push({ part: p, status: 'not_applicable' });
      }
      return out;
    }
    return fail(must(N.CodeUnproven, N.RowUnprovenSettlementEventMissing, { count: 0n }));
  }
  const cand = cands[0]!;
  f.account = cand.address; f.anchorId = cand.topics[1]!; f.leafKey = cand.topics[2]!; f.selector = sel;
  let path = verified(S);
  let link = verified(N.JudgedS6Link);
  let opens: ReturnType<typeof open>[] = [];
  if (!proven) ({ link, opens } = s6Parts(undefined));
  else if (!eq(cand.address, ctx.s6!.contract)) link = R(N.JudgedS6Link, must(N.CodeS6LinkMismatch, '', { field: 'account' }));
  const st = settleStated(env);
  if (st) path = U(S, statedU(st, S));
  else {
    const bld = m.build(buildAccount);
    if (!bld) throw new Error(`contractidentity: the manifest has no build ${buildAccount}`);
    f.stateRootN = f.settleHeader!.stateRoot;
    const j = judgeCode(new Rd(env), N.RoleAccount, 'account', cand.address, bld, true);
    if (j.gen) { f.generationState = genUnpinned(N.RowUnprovenAccountGenerationUnpinned, j.gen, j.code!); path = U(S, f.generationState); }
    else if (!j.refusal) {
      f.generation = buildAccount;
      const want = '0x' + Array.from(sel, (b) => b.toString(16).padStart(2, '0')).join('');
      if (!m.accountSelectors('V7_3').some((s) => s.selector.toLowerCase() === want)) { f.pathFailure = unsupported('selector_not_pinned'); path = U(S, f.pathFailure); }
    }
  }
  return { parts: [path, link], open: opens };
}

export function step4(env: Env): StepOutput {
  const { ctx } = env;
  const f = env.facts.A;
  f.stateRootN = f.settleHeader!.stateRoot;
  if (ctx.s6Status !== N.S6S6Proven || isZero(f.account)) return {};
  const leg = env.container!.leg;
  const s6 = ctx.s6!;
  const mismatch = (field: string): StepOutput => one(R(N.JudgedS6Link, must(N.CodeS6LinkMismatch, '', { field })));
  if (s6.settlementBlock.number !== leg.number || !eq(s6.settlementBlock.hash, leg.hash)) return mismatch('block');
  if (eq(s6.provenAt.hash, leg.hash)) return s6.provenAt.number !== leg.number ? mismatch('proven_at') : one(verified(N.JudgedS6Link));
  const st = settleStated(env);
  if (st) return one(U(N.JudgedS6Link, statedU(st, N.JudgedS6Link)));
  const r = new Rd(env);
  const acct = r.account(f.account);
  if (!r.ok()) return one(R(N.JudgedS6Link, r.bad!));
  if (!eq(acct.codeHash, s6.codeHash)) return mismatch('code_hash');
  return one(verified(N.JudgedS6Link));
}

export function step5(env: Env): StepOutput {
  const f = env.facts.A;
  const st = settleStated(env);
  if (st) return one(U(N.JudgedCodeIdentity, statedU(st, N.JudgedCodeIdentity)));
  if (isZero(f.account)) return { parts: [U(N.JudgedCodeIdentity, f.pathFailure!)], readPlanIncomplete: 'account_not_established' };
  const bld = env.manifest.build(buildAccount);
  if (!bld) throw new Error(`contractidentity: the manifest has no build ${buildAccount}`);
  const j = judgeCode(new Rd(env), N.RoleAccount, 'account', f.account, bld, true);
  if (j.gen) return { parts: [U(N.JudgedCodeIdentity, genUnpinned(N.RowUnprovenAccountGenerationUnpinned, j.gen, j.code!))], readPlanIncomplete: 'account_generation_unpinned' };
  if (j.refusal) { f.accountRefusal = j.refusal; return { parts: [R(N.JudgedCodeIdentity, j.refusal)], readPlanIncomplete: 'account_not_established' }; }
  f.accountState = j.acct; f.accountCode = j.code!;
  return one(verified(N.JudgedCodeIdentity));
}

/** The governing book of an ADI: adiURL + "/" + a lower-case name (no further "/"), as the factory's isGoverningBookOf. */
export function isGoverningBookOf(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length === 0 || a[a.length - 1] === 0x2f || b.length < a.length + 2) return false;
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if (c >= 0x41 && c <= 0x5a) return false;
    if (i < a.length) { if (c !== a[i]) return false; } else if ((i === a.length) !== (c === 0x2f)) return false;
  }
  return true;
}

export function step6(env: Env): StepOutput {
  const f = env.facts.A;
  const bl = blocked(env, N.JudgedAccountProvenance);
  if (bl) return bl;
  const r = new Rd(env);
  const max = BigInt(env.limits.maxString);
  const adi = r.bytes(f.account, f.accountState, slotIndex(0), max);
  const book = r.bytes(f.account, f.accountState, slotIndex(11), max);
  if (!r.ok()) return { parts: [R(N.JudgedAccountProvenance, r.bad!)], readPlanIncomplete: 'account_strings' };
  const canon = (reason: string): StepOutput => one(R(N.JudgedAccountProvenance, must(N.CodeAccountNotCanonical, '', { reason })));
  if (!eq(adi!, utf8(env.ctx.adiUrl))) return canon('adi_url');
  if (!isGoverningBookOf(adi!, book!)) return canon('governing_book');
  f.adiUrl = env.ctx.adiUrl; f.governingBook = book!;
  return one(verified(N.JudgedAccountProvenance));
}

export function constantWord(rule: { value?: string }): Uint8Array { return addrWord(addrOf(rule.value ?? entryPointLiteral)); }
const dflt = (v: string | undefined): string => (v === undefined || v === '' ? entryPointLiteral : v);

export function step7(env: Env): StepOutput {
  const f = env.facts.A;
  const bl = blocked(env, N.JudgedAccountProvenance);
  if (bl) return bl;
  if (f.adiUrl === '') return {};
  const bld = env.manifest.build(f.generation);
  if (!bld) throw new Error(`contractidentity: the manifest has no build "${f.generation}"`);
  const ownerWord = addrWord(low20(K(utf8(f.adiUrl))));
  const bookHash = K(f.governingBook);
  const st = checkImmutables(N.RoleAccount, f.accountCode, bld, (im) => {
    if (im.rule.kind === 'constant') return addrWord(addrOf(dflt(im.rule.value)));
    if (im.rule.kind === 'adiDerivedOwner') return ownerWord;
    if (im.rule.kind === 'keccakOfGoverningBook') return bookHash;
    throw new Error(`contractidentity: account immutable ${im.name} has the rule kind "${im.rule.kind}", which step 7 does not know`);
  });
  if (st) return one(R(N.JudgedAccountProvenance, st));
  f.governingBookHash = bookHash;
  return one(verified(N.JudgedAccountProvenance));
}

export function step8(env: Env): StepOutput {
  const f = env.facts.A;
  const { manifest: m, ctx } = env;
  const bl = blocked(env, N.JudgedAccountProvenance);
  if (bl) return bl;
  if (f.adiUrl === '' || isZero(f.governingBookHash)) return { readPlanIncomplete: 'account_strings_unavailable' };
  const row = m.deployment(ctx.chain, N.RoleAccountFactory);
  if (!row) return one(R(N.JudgedAccountProvenance, must(N.CodeAddressNotPublished, '', { role: N.RoleAccountFactory, address: zeros(20) })));
  const factory = addrOf(row.address);
  f.factoryAddress = factory;
  const fb = m.build(buildFactory);
  if (!fb) throw new Error(`contractidentity: the manifest has no build ${buildFactory}`);
  const r = new Rd(env);
  const j = judgeCode(r, N.RoleAccountFactory, 'factory', factory, fb, false);
  let refusal = j.refusal;
  let deployed = zeros(32);
  let registered = zeros(32);
  if (!refusal) {
    deployed = r.slot(factory, j.acct, mappingSlotAt(keyAddress(f.account), 2));
    const regKey = K(abiPack(str(f.adiUrl), str(f.governingBook)));
    registered = r.slot(factory, j.acct, mappingSlotAt(keyBytes32(regKey), 3));
    if (!r.ok()) refusal = r.bad;
  }
  const canon = (reason: string): StepOutput => one(R(N.JudgedAccountProvenance, must(N.CodeAccountNotCanonical, '', { reason })));
  const creation = m.creationArtifactBytes(buildAccount);
  const owner = low20(K(utf8(f.adiUrl)));
  let entry = addrOf(entryPointLiteral);
  const ab = m.build(buildAccount);
  if (ab) for (const im of ab.immutables) if (im.rule.kind === 'constant') entry = low20(constantWord(im.rule));
  const initcode = concat(creation, abiPack(entry, owner, str(f.adiUrl), str(f.governingBook)));
  const salt = K(utf8(f.adiUrl));
  const addr = low20(K(Uint8Array.of(0xff), factory, salt, K(initcode)));
  if (!eq(addr, f.account)) return canon('create2');
  if (refusal) return one(R(N.JudgedAccountProvenance, refusal));
  const st = checkImmutables(N.RoleAccountFactory, j.code!, fb, (im) => {
    if (im.rule.kind !== 'constant') throw new Error(`contractidentity: factory immutable ${im.name} has the rule kind "${im.rule.kind}"`);
    return constantWord(im.rule);
  });
  if (st) return one(R(N.JudgedAccountProvenance, st));
  if (!eq(deployed, slotIndex(1))) return canon('deployed_flag');
  if (!eq(registered, addrWord(f.account))) return canon('registry');
  return one(verified(N.JudgedAccountProvenance));
}

export function step9(env: Env): StepOutput {
  const f = env.facts.A;
  const row = env.manifest.deployment(env.ctx.chain, N.RoleAnchor);
  if (row) f.anchor = addrOf(row.address);
  const bl = blocked(env, N.JudgedPointer);
  if (bl) return bl;
  if (!row) return one(R(N.JudgedPointer, must(N.CodeAddressNotPublished, '', { role: N.RoleAnchor, address: zeros(20) })));
  const r = new Rd(env);
  const got = low20(r.slot(f.account, f.accountState, slotIndex(2)));
  if (!r.ok()) return one(R(N.JudgedPointer, r.bad!));
  if (eq(got, f.anchor)) return one(verified(N.JudgedPointer));
  if (!isZero(got) && carried(env, got)) {
    const ab = env.manifest.build(row.build);
    if (ab) {
      const j = judgeCode(new Rd(env), N.RoleAnchor, 'anchor', got, ab, true);
      if (j.gen) return one(U(N.JudgedPointer, genUnpinned(N.RowUnprovenAnchorGenerationUnpinned, j.gen, j.code!)));
    }
  }
  return one(R(N.JudgedPointer, must(N.CodePointerMismatch, '', { account: f.account, got, want: f.anchor })));
}
