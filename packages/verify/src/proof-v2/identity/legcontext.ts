// The leg context of an outcome evidence file and the judgement of a portable document with it (twin of legContextFromOutcome, deriveS6 and reportContractIdentityFile in
// cmd/proofverify/contract_identity.go): the LegContext is built from the Settlement the outcome evidence proves, the S6 replay-guard evidence of its member, the batch facts and
// the S9 registry its quorum states, and the S7 report of the same run. The S7 phase runs first (judgeFinalityText over the same document), then the S8 phase, and combineExit joins
// the two. Nothing in the file is trusted: the verifier judges it.
import { RlpError, listItems, split } from '../../s6/rlp.js';
import {
  S6ReplayError, S6_REASONS, S6_REPLAY_LAYOUTS, S6_REPLAY_UNPROVEN, decodeReplayGuardEvidence, decodeS6Settlement, verifyReplayGuardEvidence,
} from '../../s6/replay.js';
import { judgeFinalityText, type DocumentFinality } from '../finality/docreport.js';
import { deriveIncluded, type Settlement as FinSettlement } from '../finality/evidence.js';
import { levelName } from '../finality/level.js';
import type { Pins } from '../finality/pins.js';
import type { Report as FinalityReport } from '../finality/report.js';
import { asNamed } from '../finality/state.js';
import { wireFinalityOptions } from '../finality/surface.js';
import { toHex } from './canon.js';
import type { LegContext, ReceiptLeaf, S6Link, S6Status, S7Report } from './context.js';
import { parseTx } from './context.js';
import { CiMemberError, combineExit, judgeContractIdentity, memberText, type CiOutcome } from './cliflag.js';
import * as N from './names.js';
import {
  OutcomeFileError, batchFactsFromOutcome, readOutcomeEvidence, registry9FromOutcome, settlementFromOutcome, type OutcomeEvidence,
} from './outcomefile.js';
import { verifyContractIdentity, type ManifestInput } from './surface.js';

const hex0x = (b: Uint8Array): string => '0x' + toHex(b);
const fail = (m: string): never => {
  throw new OutcomeFileError(m);
};

/** The receipt consensus encoding (EIP-2718 typed or legacy) as the leaf the verifier reads. */
export function receiptFromBytes(b: Uint8Array): ReceiptLeaf {
  let type = 0;
  let body = b;
  if (b.length > 0 && b[0]! < 0x80) {
    type = b[0]!;
    body = b.slice(1);
  }
  try {
    const it = split(body);
    if (it.kind !== 'list' || it.rest.length !== 0) return fail('the receipt is not one list');
    const f = listItems(it.content);
    if (f.length !== 4) return fail(`the receipt has ${f.length} fields, want 4`);
    const bloom = Uint8Array.from(f[2]!.content);
    if (bloom.length !== 256) return fail('the receipt bloom is not 256 bytes');
    let gas = 0n;
    for (const x of f[1]!.content) gas = (gas << 8n) | BigInt(x);
    const logs = listItems(f[3]!.content).map((l) => {
      const lf = listItems(l.content);
      if (lf.length !== 3) return fail('a log has three fields');
      const address = Uint8Array.from(lf[0]!.content);
      if (address.length !== 20) return fail('a log address is not 20 bytes');
      return { address, topics: listItems(lf[1]!.content).map((t) => Uint8Array.from(t.content)), data: Uint8Array.from(lf[2]!.content) };
    });
    return { type, postStateOrStatus: Uint8Array.from(f[0]!.content), cumulativeGasUsed: gas, bloom, logs };
  } catch (e) {
    if (e instanceof RlpError) return fail(`the receipt does not decode: ${e.message}`);
    throw e;
  }
}

interface S6Result { status: S6Status; reason: string; state: string; link?: S6Link }

/**
 * deriveS6 states what S6 (the replay-slot proof) established about a settlement that is already proven in its block: s6_proven iff the call is a settlement of a pinned account
 * generation and the evidence proves the slot consumed; s6_silent iff S6 made no claim (the call is of no pinned generation, or no evidence is carried); s6_not_proven, with the
 * named state, iff the evidence judged the leg and did not prove it.
 */
export function deriveS6(s: { headerRlp: Uint8Array; txRlp: Uint8Array; txData: Uint8Array }, receipt: ReceiptLeaf, replayGuardText: string | undefined): S6Result {
  const sel = toHex(s.txData.slice(0, 4));
  const pinned = s.txData.length >= 4 && Object.values(S6_REPLAY_LAYOUTS).some((l) => l.selectors.includes(sel));
  if (!pinned) return { status: N.S6S6Silent, reason: 'unsupported_generation', state: '' };
  if (replayGuardText === undefined) return { status: N.S6S6Silent, reason: 'absent', state: '' };
  const notProven = (state: string, reason: string): S6Result => ({ status: N.S6S6NotProven, reason: '', state: `${state}{reason=${reason}}` });
  let ev;
  try {
    ev = decodeReplayGuardEvidence(new TextEncoder().encode(replayGuardText));
  } catch (e) {
    // evidence the strict S6 reader refuses was judged and is not a proof: the leg carries it as the named state, never as a file error
    if (e instanceof S6ReplayError) return notProven(e.state, e.reason);
    throw e;
  }
  try {
    const decoded = decodeS6Settlement({
      headerRlp: hex0x(s.headerRlp),
      txRlp: hex0x(s.txRlp),
      receiptStatus: receipt.postStateOrStatus.length === 1 && receipt.postStateOrStatus[0] === 1 ? 1 : 0,
      logs: receipt.logs.map((l) => ({ address: hex0x(l.address), topics: l.topics.map(hex0x), data: hex0x(l.data) })),
    });
    const chk = verifyReplayGuardEvidence(ev, decoded);
    if (chk.state !== 'proven') return notProven(chk.state, chk.reason);
    if (!chk.contract || !chk.slot || !chk.settlementBlock || !chk.provenAt || !chk.codeHash) return fail('the S6 check is proven and carries no link');
    return {
      status: N.S6S6Proven, reason: '', state: '',
      link: {
        contract: chk.contract, leafKey: chk.slot.key,
        settlementBlock: { number: BigInt(chk.settlementBlock.number), hash: chk.settlementBlock.hash },
        provenAt: { number: BigInt(chk.provenAt.number), hash: chk.provenAt.hash }, codeHash: chk.codeHash,
      },
    };
  } catch (e) {
    if (e instanceof S6ReplayError) return notProven(e.state, e.reason);
    if (e instanceof OutcomeFileError) throw e;
    return notProven(S6_REPLAY_UNPROVEN, S6_REASONS.proofDoesNotVerify);
  }
}

/** The S7 report of the run, in the form the verifier reads: the levels by name, the status and the state code of each. */
export function s7ReportOf(rep: FinalityReport): S7Report {
  const levels: Record<string, { status: string; code: string }> = {};
  for (const [l, st] of rep.levels) levels[levelName(l)] = { status: st.status, code: st.state?.code ?? '' };
  const fb = rep.finalizedBlock;
  return {
    block: { chain: BigInt(rep.block.chain), number: BigInt(rep.block.number), hash: rep.block.hash },
    headline: levelName(rep.headline),
    levels,
    unsupported: rep.unsupported?.code ?? '',
    ...(fb ? { finalizedBlock: { number: BigInt(fb.number), hash: fb.hash, stateRoot: fb.stateRoot } } : {}),
  };
}

/** The LegContext of the leg an outcome evidence file settles, judged against the S7 report of the same run (undefined: S7 judged no leg, and the verifier says so). */
export function legContextFromOutcome(ev: OutcomeEvidence, leg: { chain: bigint; settlement: FinSettlement }, s7: FinalityReport | undefined): LegContext {
  const s = leg.settlement;
  try {
    deriveIncluded(leg.chain, s);
  } catch (e) {
    return fail(`the outcome evidence settlement does not verify: ${asNamed(e)?.toString() ?? (e as Error).message}`);
  }
  let tx;
  try {
    tx = parseTx(s.tx!.leafValue);
  } catch (e) {
    return fail(`the outcome evidence settlement transaction does not decode: ${(e as Error).message}`);
  }
  const receipt = receiptFromBytes(s.receipt!.leafValue);
  const s6 = deriveS6({ headerRlp: s.headerRlp, txRlp: s.tx!.leafValue, txData: tx.data }, receipt, ev.member.replayGuardText);
  const registry9 = registry9FromOutcome(ev);
  return {
    chain: leg.chain,
    settlement: { header: s.headerRlp, blockHash: s.blockHash, hasTx: true, hasReceipt: true, txLeafIndex: s.tx!.leafIndex },
    tx, receipt, adiUrl: ev.member.adiUrl,
    s6Status: s6.status, s6Reason: s6.reason, s6State: s6.state, ...(s6.link ? { s6: s6.link } : {}),
    batch: batchFactsFromOutcome(ev),
    ...(registry9 ? { registry9 } : {}),
    ...(s7 ? { s7: s7ReportOf(s7) } : {}),
  };
}

export interface DocumentJudgement {
  /** What the tool prints: the S7 report, then the one line of the S8 row. */
  text: string;
  /** combineExit of the two phases. */
  exit: number;
  s7?: DocumentFinality;
  s8?: CiOutcome;
}
export interface DocumentOptions {
  /** What the S7 report calls the document (the path). */
  subject?: string;
  pins?: Pins | null;
  manifest?: ManifestInput;
  extension?: Uint8Array;
}

const messageOf = (e: unknown): string => asNamed(e)?.toString() ?? (e instanceof Error ? e.message : String(e));

/**
 * The portable document judged for its contract identity (reportFinalityFileCI): the outcome evidence is the Settlement source, the S7 phase judges the document's finality section
 * against it, the document's `contractIdentity` member is judged against the leg by the S8 verifier, and the exit code is combineExit of the two. An outcome evidence that cannot be read
 * or does not settle the leg is exit 2 with `proofverify: <error>` and no S8 row. A document that is not one JSON object ends with the S7 phase alone (its report already says so).
 */
export async function judgeContractIdentityDocument(document: string | Uint8Array, outcome: string | Uint8Array, opts: DocumentOptions = {}): Promise<DocumentJudgement> {
  const docText = typeof document === 'string' ? document : new TextDecoder().decode(document);
  let ev: OutcomeEvidence;
  let leg: { chain: bigint; settlement: FinSettlement };
  try {
    ev = readOutcomeEvidence(outcome);
    leg = settlementFromOutcome(ev);
  } catch (e) {
    return { text: `proofverify: ${messageOf(e)}\n`, exit: 2 };
  }
  const w = await wireFinalityOptions({
    settlement: { chain: leg.chain, settlement: leg.settlement, source: 'outcome evidence' },
    ...(opts.pins !== undefined ? { pins: opts.pins } : {}),
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
  });
  const s7 = 'failure' in w ? w.failure : judgeFinalityText(docText, w.options);
  let member: string | undefined;
  try {
    member = memberText(docText, 'contractIdentity');
  } catch (e) {
    if (e instanceof CiMemberError) return { text: s7.text, exit: s7.exit, s7 };
    throw e;
  }
  let ctx: LegContext;
  try {
    ctx = legContextFromOutcome(ev, leg, s7.report);
  } catch (e) {
    if (e instanceof OutcomeFileError) return { text: `${s7.text}proofverify: ${e.message}\n`, exit: combineExit(s7.exit, 2), s7 };
    throw e;
  }
  const s8 = judgeContractIdentity(member, ctx, (c) => verifyContractIdentity(c, opts.manifest, opts.extension, ctx));
  return { text: s7.text + s8.text, exit: combineExit(s7.exit, s8.exit), s7, s8 };
}
