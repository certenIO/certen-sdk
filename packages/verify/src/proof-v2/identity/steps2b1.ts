// Steps 15, 16, 17 and 20 of the contract-identity verifier (package 2b-1; twin of steps_2b1.go): the attest part, the header link of the
// attestation block B_v to the settlement block (same block, hop chain through the EIP-2935 history, or header spine), the attestation
// transaction and receipt with the strict ABI decode, and the message binding.
import type { HeaderFields } from '../finality/rlpheader.js';
import { ABIError } from './abidec.js';
import { decodeComprehensiveProofCall, decodeProofExecutedData, decodeZKBlob } from './abiattest.js';
import { classifyTx, decodeReceiptLeaf, TxError, TxTypeAccessList, TxTypeDynamicFee, TxTypeLegacy, TxTypeSetCode } from './attest.js';
import { addrOf, concat, eq, hashOf, hex as hexOf, isZero, keccak, utf8, wordOf, zeros } from './bytes.js';
import type { AttestProof } from './codec.js';
import { parseTx, succeeded } from './context.js';
import { attestStated, header, verified, type Env, type StepOutput } from './framework.js';
import * as N from './names.js';
import { readAccount, readIndexedLeaf, readSlot, ReadError, rlpUint } from './reads.js';
import type { PartResult } from './report.js';
import { R, U, one } from './steps2a.js';
import { keyBytes32, mappingSlotAt, memberSlot, slotIndex } from './slots.js';
import { defaultVocabulary, malformed, must, type StateError } from './states.js';

const mismatch = (field: string): StateError => must(N.CodeAttestMismatch, '', { field });
const linkName = (link: number): string => (link === 1 ? N.HopLinkHops : link === 0 ? N.HopLinkSameBlock : N.HopLinkSpine);
const unlinked = (link: number, index: number, reason: string): StateError => must(N.CodeHeaderUnlinked, '', { link: linkName(link), index: BigInt(Math.max(index, 0)), reason });
const proofInvalid = (root: string, a: Uint8Array, slot: Uint8Array): StateError => must(N.CodeProofInvalid, '', { root, address: a, slot });
const proofInvalidLeaf = (root: string, a: Uint8Array, txIndex: number): StateError => must(N.CodeProofInvalid, '', { root, address: a, slot: '0x' + hexOf(rlpUint(BigInt(txIndex))) });
const absent = (part: string): StateError => must(N.CodeUnproven, N.RowUnprovenAttestAbsent, { reason: N.RowUnprovenAttestAbsent, part });

const detailTooLarge = /^(?:bytes|txs)=([0-9]{1,19});limit=([0-9]{1,19})$/;
const detailReach = /^gap=([0-9]{1,19});window=([0-9]{1,19});hops_carried=([0-9]{1,19});last_hop=([0-9]{1,19})$/;
const nums = (re: RegExp, detail: string): bigint[] | undefined => {
  const m = re.exec(detail);
  if (!m) return undefined;
  const out = m.slice(1).map((s) => BigInt(s));
  return out.every((v) => v < 1n << 64n) ? out : undefined;
};

/** The unproven states a Stated attest part becomes on authorization_attest and intra_block_window (undefined when the reason has none). */
function statedStates(st: NonNullable<ReturnType<typeof attestStated>>): { auth: StateError; window: StateError } | undefined {
  const window = absent(N.JudgedIntraBlockWindow);
  switch (st.reason) {
    case N.RowUnprovenCaptureNotAttemptedInWindow:
    case N.RowUnprovenStateUnavailable:
    case N.RowUnprovenAttestBlockStateUnavailable:
      return { window, auth: must(N.CodeUnproven, st.reason, { reason: st.reason, part: N.JudgedAuthorizationAttest, judgedBlock: st.judgedBlock, judgedHash: st.judgedHash, failures: st.failures.map((f) => ({ host: f.host, error: f.error })) }) };
    case N.RowUnprovenAttestEventNotFound:
      return { window, auth: must(N.CodeUnproven, st.reason, { reason: st.reason, part: N.JudgedAuthorizationAttest }) };
    case N.RowUnprovenAttestBlockOutOfReach: {
      const n = nums(detailReach, st.detail);
      return n ? { window, auth: must(N.CodeUnproven, st.reason, { reason: st.reason, gap: n[0]!, window: n[1]!, hops_carried: n[2]!, last_hop: n[3]! }) } : undefined;
    }
    case N.RowUnprovenBlockTooLarge: {
      const n = nums(detailTooLarge, st.detail);
      if (!n) return undefined;
      return {
        auth: must(N.CodeUnproven, st.reason, { reason: st.reason, part: N.JudgedAuthorizationAttest, bytes: n[0]!, limit: n[1]! }),
        window: must(N.CodeUnproven, st.reason, { reason: st.reason, part: N.JudgedIntraBlockWindow, bytes: n[0]!, limit: n[1]! }),
      };
    }
    default:
      throw new Error(`contractidentity: step 15: stated attest reason "${st.reason}" has no unproven row`);
  }
}

export function step15(env: Env): StepOutput {
  const f = env.facts.B1;
  const st = attestStated(env);
  if (!st) { f.attestCaptured = true; return {}; }
  f.attestCaptured = false;
  if (!defaultVocabulary().check('stated_reason_builders', st.reason)) return { framework: malformed(N.PartAttest, N.MalformedUnknownStatedReason, 0, 0, 0) };
  const s = statedStates(st);
  if (!s) return { framework: malformed(N.PartAttest, N.MalformedBadStatedReason, 0, 0, 0) };
  const link = must(N.CodeUnproven, N.RowUnprovenAttestAbsent, { reason: N.RowUnprovenAttestAbsent, part: N.JudgedRegistryLink });
  return { parts: [U(N.JudgedAuthorizationAttest, s.auth), U(N.JudgedIntraBlockWindow, s.window), U(N.JudgedRegistryLink, link)] };
}

export function step16(env: Env): StepOutput {
  const f = env.facts;
  if (!f.B1.attestCaptured) return {};
  const a = env.container!.attest.attest;
  if (!a) throw new Error('contractidentity: step 16: captured attest part without a body');
  const s = f.A.settleHeader;
  if (!s) throw new Error('contractidentity: step 16: the settlement header was not read (step 2 did not run)');
  if (!env.ctx.settlement?.hasTx) throw new Error('contractidentity: step 16: the leg context carries no settlement transaction index');
  const part = N.JudgedAuthorizationAttest;
  let incomplete = '';
  let verdict: PartResult | undefined;
  const decide = (r: PartResult): void => { verdict ??= r; };
  let hv: HeaderFields | undefined;
  let hp: HeaderFields | undefined;
  try { hv = header(env, a.headerV); } catch { /* unreadable: decided below */ }
  try { hp = header(env, a.headerVParent); } catch { /* unreadable: decided below */ }
  if (!hv) return { parts: [R(part, unlinked(a.link, 0, N.HopReasonHashChainBroken))], readPlanIncomplete: 'attest_header_unreadable' };
  if (a.link === 0) { if (BigInt(a.txIndex) >= env.ctx.settlement.txLeafIndex) decide(R(part, mismatch('order'))); } else if (hv.number >= s.number) decide(R(part, mismatch('order')));
  let walked = 0;
  if (a.link === 0) {
    if (!eq(hv.hash, s.hash)) decide(R(part, unlinked(a.link, 0, N.HopReasonHashChainBroken)));
  } else if (a.link === 1) {
    walked = hopChain(env, hv, a, decide, (x) => { incomplete = x; });
  } else {
    let prevHash = s.parentHash;
    let prevNum = s.number;
    if (a.spine.length === 0) decide(R(part, unlinked(a.link, 0, N.HopReasonHashChainBroken)));
    for (const [j, raw] of a.spine.entries()) {
      let h: HeaderFields;
      try { h = header(env, raw); } catch { decide(R(part, unlinked(a.link, j, N.HopReasonHashChainBroken))); break; }
      if (!eq(h.hash, prevHash)) { decide(R(part, unlinked(a.link, j, N.HopReasonHashChainBroken))); break; }
      if (prevNum === 0n || h.number !== prevNum - 1n) { decide(R(part, unlinked(a.link, j, N.HopReasonNumbersNotConsecutive))); break; }
      prevHash = h.parentHash; prevNum = h.number; walked = j + 1;
      if (j === a.spine.length - 1 && !eq(h.hash, hv.hash)) decide(R(part, unlinked(a.link, j, N.HopReasonHashChainBroken)));
    }
  }
  if (!hp || !eq(hp.hash, hv.parentHash) || hp.number + 1n !== hv.number) decide(R(part, unlinked(a.link, 0, N.HopReasonParentMismatch)));
  const b = f.B1;
  b.headerV = hv; b.stateRootPost = hv.stateRoot;
  if (hp) { b.headerVParent = hp; b.stateRootPre = hp.stateRoot; }
  b.hopChain = { link: a.link, walked };
  b.headerLinked = verdict === undefined;
  return { readPlanIncomplete: hp ? incomplete : 'attest_parent_header_unreadable', parts: [verdict ?? verified(part)] };
}

/** The hop chain: B_v -> hop headers -> settlement header, every step proven by the EIP-2935 history slot. Returns the links walked. */
function hopChain(env: Env, hv: HeaderFields, a: AttestProof, decide: (r: PartResult) => void, setIncomplete: (s: string) => void): number {
  const part = N.JudgedAuthorizationAttest;
  const row = env.manifest.eip2935(env.ctx.chain);
  if (!row || row.window === 0n) throw new Error(`contractidentity: step 16: the manifest has no eip2935 window for chain ${env.ctx.chain}`);
  const hist = addrOf(row.address);
  const pin = hashOf(row.codeHash);
  const hdrs: HeaderFields[] = [hv];
  for (const [j, raw] of a.hopHeaders.entries()) {
    try { hdrs.push(header(env, raw)); } catch { decide(R(part, unlinked(1, j, N.HopReasonHashChainBroken))); setIncomplete('attest_hop_header_unreadable'); return 0; }
  }
  const k = a.hopHeaders.length;
  hdrs.push(env.facts.A.settleHeader!);
  let walked = 0;
  for (let i = 0; i <= k; i++) {
    const lo = hdrs[i]!;
    const hi = hdrs[i + 1]!;
    const root = i < k ? `hop:${i + 1}` : N.AtSettle;
    let failed = false;
    const fail = (st: StateError, cls: (p: string, s: StateError) => PartResult): void => { if (!failed) decide(cls(part, st)); failed = true; };
    if (hi.number <= lo.number) fail(unlinked(1, i, N.HopReasonNumbersNotConsecutive), R);
    else if (hi.number - lo.number > row.window && i === k) {
      fail(must(N.CodeUnproven, N.RowUnprovenAttestBlockOutOfReach, { reason: N.RowUnprovenAttestBlockOutOfReach, gap: hi.number - lo.number, window: row.window, hops_carried: BigInt(k), last_hop: lo.number }), U);
    } else if (hi.number - lo.number > row.window) fail(unlinked(1, i, N.HopReasonGapOutOfRange), R);
    let acct;
    try { acct = readAccount(hi.stateRoot, env.nodes!, hist); } catch (e) {
      if (!(e instanceof ReadError)) throw e;
      decide(R(part, proofInvalid(root, hist, e.slot ?? zeros(32)))); setIncomplete('attest_hop_read'); return walked;
    }
    if (!acct.exists || !eq(acct.codeHash, pin)) fail(unlinked(1, i, N.HopReasonHistoryCodeMismatch), R);
    if (acct.exists) {
      const slot = wordOf(lo.number % row.window);
      let w;
      try { w = readSlot(acct.storageRoot, env.nodes!, slot); } catch (e) {
        if (!(e instanceof ReadError)) throw e;
        decide(R(part, proofInvalid(root, hist, e.slot ?? slot))); setIncomplete('attest_hop_read'); return walked;
      }
      if (isZero(w) || !eq(w, lo.hash)) fail(unlinked(1, i, N.HopReasonSlotMismatch), R);
    }
    if (!failed && walked === i) walked = i + 1;
  }
  return walked;
}

export function step17(env: Env): StepOutput {
  const f = env.facts;
  if (!f.B1.attestCaptured) return {};
  const a = env.container!.attest.attest;
  const hv = f.B1.headerV;
  if (!a || !hv) return {};
  const part = N.JudgedAuthorizationAttest;
  const A = f.A.anchor;
  if (isZero(A)) throw new Error('contractidentity: step 17: no anchor address (step 9 did not run)');
  for (const rd of [{ name: N.RootAttestTx, root: hv.transactionRoot, want: a.txLeaf }, { name: N.RootAttestReceipt, root: hv.receiptsRoot, want: a.receiptLeaf }]) {
    let leaf;
    try { leaf = readIndexedLeaf(rd.root, env.nodes!, BigInt(a.txIndex), env.limits.maxNodeBytes); } catch (e) {
      if (!(e instanceof ReadError)) throw e;
      return { parts: [R(part, proofInvalidLeaf(rd.name, A, a.txIndex))], readPlanIncomplete: 'attest_inclusion_read' };
    }
    if (!eq(leaf, rd.want)) return { parts: [R(part, proofInvalidLeaf(rd.name, A, a.txIndex))], readPlanIncomplete: 'attest_inclusion_leaf' };
  }
  let info;
  try { info = classifyTx(a.txLeaf); } catch (e) { if (e instanceof TxError) return one(R(part, mismatch('tx_to'))); throw e; }
  if (![TxTypeLegacy, TxTypeAccessList, TxTypeDynamicFee, TxTypeSetCode].includes(info.type)) {
    return one(U(part, must(N.CodeUnproven, N.RowUnprovenAttestTxTypeUnsupported, { reason: N.RowUnprovenAttestTxTypeUnsupported, type: '0x' + info.type.toString(16).padStart(2, '0') })));
  }
  let tx;
  try { tx = parseTx(a.txLeaf); } catch { return one(R(part, mismatch('tx_to'))); }
  let rc;
  try { rc = decodeReceiptLeaf(a.receiptLeaf); } catch { return one(R(part, mismatch('status'))); }
  f.B1.attestTx = tx; f.B1.attestReceipt = rc; f.B1.txIndex = a.txIndex;
  if (!succeeded(rc)) return one(R(part, mismatch('status')));
  const anchorId = f.A.anchorId;
  if (isZero(anchorId)) {
    if (!f.A.pathFailure) throw new Error('contractidentity: step 17: no anchorId and step 3 recorded no failure');
    return one(U(part, f.A.pathFailure));
  }
  const pe = env.manifest.topic('ProofExecuted');
  if (!pe) throw new Error('contractidentity: the manifest has no topics.ProofExecuted');
  const topic0 = hashOf(pe.topic0);
  const logs = rc.logs.filter((l) => eq(l.address, A) && l.topics.length === 2 && eq(l.topics[0]!, topic0) && eq(l.topics[1]!, anchorId));
  const es = env.manifest.selector('CertenAnchorV8_2/executeComprehensiveProof');
  if (!es) throw new Error('contractidentity: the manifest has no selectors row CertenAnchorV8_2/executeComprehensiveProof');
  if (!/^0x[0-9a-fA-F]{8}$/.test(es.selector)) throw new Error(`contractidentity: the manifest selector "${es.selector}" is not 4 bytes`);
  const execSel = Uint8Array.from(es.selector.slice(2).match(/../g)!, (h) => parseInt(h, 16));
  const sel = new Uint8Array(4);
  sel.set(tx.data.slice(0, 4));
  const toIsA = tx.to !== undefined && eq(tx.to, A);
  if (toIsA && eq(sel, execSel)) {
    if (logs.length !== 1) return one(R(part, mismatch('log')));
  } else if (logs.length >= 1) {
    return one(U(part, must(N.CodeUnproven, N.RowUnprovenAttestIndirectCall, { reason: N.RowUnprovenAttestIndirectCall, to: tx.to ?? zeros(20), selector: sel })));
  } else if (!toIsA) return one(R(part, mismatch('tx_to')));
  else return one(R(part, mismatch('selector')));
  try { decodeProofExecutedData(logs[0]!.data); } catch (e) { if (e instanceof ABIError) return one(R(part, mismatch('log'))); throw e; }
  let call;
  try { call = decodeComprehensiveProofCall(tx.data); } catch (e) {
    if (!(e instanceof ABIError)) throw e;
    const field = (e.field === '' ? 'input' : e.field).slice(0, 64);
    return one(U(part, must(N.CodeUnproven, N.RowUnprovenAttestCalldataUndecodable, { reason: e.kind, field })));
  }
  f.B1.call = {
    anchorId: call.anchorId, operationCommitment: call.operationCommitment, outerSigned: call.signedVotingPower, outerTotal: call.totalVotingPower,
    validatorAddresses: call.validatorAddresses, votingPowers: call.votingPowers, authorityLevel: call.authorityLevel,
  };
  if (!eq(call.anchorId, anchorId)) return one(R(part, mismatch('anchor_id')));
  const rec = f.A.record;
  const opId = rec && eq(rec.bundleId, anchorId) ? rec.operationId : env.ctx.batch.operationId;
  if (!eq(call.operationCommitment, opId)) return one(R(part, mismatch(N.AttestFieldOperationCommitment)));
  let blob;
  try { blob = decodeZKBlob(call.aggregateSignature); } catch { return one(R(part, mismatch('blob_layout'))); }
  if (!eq(blob.messageHash, call.messageHash) || isZero(blob.pubkeyCommitment)) return one(R(part, mismatch('blob_layout')));
  f.B1.call.blobInnerSigned = blob.signedVotingPower; f.B1.call.blobInnerTotal = blob.totalVotingPower;
  f.B1.messageHash = blob.messageHash; f.B1.pkc = blob.pubkeyCommitment;
  return one(verified(part));
}

export function step20(env: Env): StepOutput {
  const f = env.facts;
  if (!f.B1.attestCaptured || isZero(f.B1.messageHash)) return {};
  const part = N.JudgedAuthorizationAttest;
  const A = f.A.anchor;
  const anchorId = f.A.anchorId;
  const rec = f.A.record;
  const read = (root: string, sr: Uint8Array, slots: Uint8Array[]): { ws?: Uint8Array[]; st?: StateError } => {
    let acct;
    try { acct = readAccount(sr, env.nodes!, A); } catch (e) { if (!(e instanceof ReadError)) throw e; return { st: proofInvalid(root, A, e.slot ?? zeros(32)) }; }
    const out: Uint8Array[] = [];
    for (const s of slots) {
      try { out.push(readSlot(acct.storageRoot, env.nodes!, s)); } catch (e) { if (!(e instanceof ReadError)) throw e; return { st: proofInvalid(root, A, e.slot ?? s) }; }
    }
    return { ws: out };
  };
  const refuse = (st: StateError): StepOutput => ({ parts: [R(part, st)], readPlanIncomplete: 'attest_message_read' });
  let exec: Uint8Array; let opId: Uint8Array; let accSet: Uint8Array; let inc: Uint8Array;
  if (rec && eq(rec.bundleId, anchorId)) ({ executionCommitment: exec, operationId: opId, accSetRoot: accSet, accIncarnation: inc } = rec);
  else {
    const base = mappingSlotAt(keyBytes32(anchorId), 1);
    const r = read(N.AtAttestPost, f.B1.stateRootPost, [memberSlot(base, 6), memberSlot(base, 7), memberSlot(base, 11), memberSlot(base, 12)]);
    if (r.st) return refuse(r.st);
    [exec, opId, accSet, inc] = r.ws as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  }
  const r2 = read(N.AtAttestPre, f.B1.stateRootPre, [slotIndex(17)]);
  if (r2.st) return refuse(r2.st);
  const tag = new Uint8Array(32);
  tag.set(utf8('certen:bls:v2:pre'));
  f.B1.messageRecomputed = keccak(concat(tag, wordOf(env.ctx.chain), anchorId, exec, opId, r2.ws![0]!, accSet, inc));
  if (!eq(f.B1.messageRecomputed, f.B1.messageHash)) return { parts: [R(part, mismatch('message_hash'))] };
  return { parts: [verified(part)] };
}
