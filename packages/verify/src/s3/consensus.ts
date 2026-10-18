/**
 * The consensus-side judgement of a certificate's proof v2 (validator pkg/proof/v2 evidence_decode.go, pkg/consensus evidence20_view.go,
 * intent_certificate.go judgeProofV2, pkg/intentcert proofv2_root.go).
 *
 *   - unmarshalCertifiedEvidence: the decode of a certificate's proof v2 exactly as the rules v14 binary performed it for a document that
 *     claims 2.0 (into v14's member set only, so a key evidence 2.1 added is ignored whatever its JSON type) and as this verifier does for a
 *     document that claims 2.1 (completely).
 *   - evidence20View: a document that claims 2.0 is judged on the members v14's decode kept.
 *   - judgeProofV2: the order in which consensus judges a v3 certificate's proof v2, with the verifier and the binding injected.
 *
 * The documents here are Go's Evidence form (every binary value as hex), not the portable form: this is the form a certificate carries.
 */
import { VerifyError } from '../proof-v2/bytes.js';
import { decodeVal, marshalVal, parseGoJson, JObj, zero, type FieldDef, type GoVal, type Sch, type StructDef } from './jsonx.js';
import { JsonError } from './gojson.js';

const S = 'string' as const;
const U = 'u64' as const;
const f = (name: string, json: string, sch: Sch, omitempty = false): FieldDef => ({ name, json, sch, omitempty });

export const CHAIN_ROOT: StructDef = [f('Name', 'name', S), f('Pending', 'pending', { list: 'strptr' }), f('Count', 'count', U), f('Anchor', 'anchor', S)];
const PARTITION_ANCHOR: StructDef = [f('Message', 'message', S), f('Receipt', 'receipt', S)];
const INDEX_PROOF: StructDef = [f('Position', 'position', U), f('Entry', 'entry', S), f('Receipt', 'receipt', S)];
const ARRIVAL: StructDef = [f('Before', 'before', { ptr: INDEX_PROOF }, true), f('At', 'at', { struct: INDEX_PROOF })];
const VOTE_HOP: StructDef = [f('Page', 'page', S), f('Message', 'message', S), f('Signature', 'signature', S), f('Block', 'block', U), f('Receipt', 'receipt', S), f('Arrival', 'arrival', { ptr: ARRIVAL }, true)];
const PRODUCTION: StructDef = [f('Account', 'account', S), f('Chain', 'chain', S), f('Message', 'message', S), f('Receipt', 'receipt', S), f('Arrival', 'arrival', { struct: ARRIVAL }), f('Sequenced', 'sequenced', S, true)];
const TRANSPORT: StructDef = [f('Kind', 'kind', S), f('Source', 'source', S, true), f('Destination', 'destination', S, true), f('Number', 'number', U, true)];
const VOTE: StructDef = [
  f('Authority', 'authority', S),
  f('Origin', 'origin', S),
  f('Vote', 'vote', S),
  f('Cause', 'cause', S, true),
  f('Transport', 'transport', { struct: TRANSPORT }),
  f('Message', 'message', S),
  f('Receipt', 'receipt', S),
  f('Hops', 'hops', { list: { struct: VOTE_HOP } }, true),
  f('Counted', 'counted', { list: { struct: VOTE_HOP } }, true),
  f('Produced', 'produced', { ptr: PRODUCTION }, true),
];
const HISTORY_ENTRY: StructDef = [f('Transaction', 'transaction', S), f('Initiator', 'initiator', S, true)];
export const PAGE_HISTORY: StructDef = [f('Entries', 'entries', { list: { struct: HISTORY_ENTRY } }), f('Index', 'index', { list: S })];
const PAGE_STATE: StructDef = [
  f('URL', 'url', S),
  f('State', 'state', S),
  f('Receipt', 'receipt', S),
  f('Chains', 'chains', { list: { struct: CHAIN_ROOT } }, true),
  f('PendingHash', 'pendingHash', S, true),
  f('ChainError', 'chainError', S, true),
  f('Partition', 'partition', S, true),
  f('Roles', 'roles', { list: S }, true),
  f('History', 'history', { ptr: PAGE_HISTORY }, true),
];
/** PageStateV14: PageState as the rules v14 head declared it. */
const PAGE_STATE_V14: StructDef = PAGE_STATE.slice(0, 6);
const RECEIPT_STEP: StructDef = [f('Hash', 'hash', S), f('Right', 'right', 'bool')];
const STATE_RECEIPT: StructDef = [f('Start', 'start', S), f('Anchor', 'anchor', S), f('LocalBlock', 'localBlock', U), f('Entries', 'entries', { list: { struct: RECEIPT_STEP } })];
const ACCOUNT_STATE_PROOF: StructDef = [
  f('AccountURL', 'accountUrl', S),
  f('AccountState', 'accountState', S),
  f('StateReceipt', 'stateReceipt', { struct: STATE_RECEIPT }),
  f('Chains', 'chains', { list: { struct: CHAIN_ROOT } }),
  f('SecondaryHash', 'secondaryHash', S),
  f('PendingHash', 'pendingHash', S),
];
const VALIDATOR_SET_PROOF: StructDef = [f('Incarnation', 'incarnation', S), f('Network', 'network', { struct: ACCOUNT_STATE_PROOF }), f('Globals', 'globals', { struct: ACCOUNT_STATE_PROOF })];
const SET_CHECK: StructDef = [f('Majors', 'majors', U), f('Hops', 'hops', { list: S }), f('Set', 'set', { struct: VALIDATOR_SET_PROOF }), f('Routing', 'routing', { ptr: ACCOUNT_STATE_PROOF }, true)];
/** SetCheckV14: SetCheck as v14 declared it. */
const SET_CHECK_V14: StructDef = SET_CHECK.slice(0, 3).map((x) => ({ ...x, omitempty: false }));

/** Evidence (evidence.go). */
export const EVIDENCE: StructDef = [
  f('Version', 'version', S),
  f('Account', 'account', S),
  f('TxHash', 'txHash', S),
  f('Receipt', 'receipt', S),
  f('Majors', 'majors', U),
  f('Certify', 'certify', { list: S }),
  f('Anchor', 'anchor', { struct: PARTITION_ANCHOR }),
  f('Pages', 'pages', { list: { struct: PAGE_STATE } }, true),
  f('Anchors', 'anchors', { map: { struct: PARTITION_ANCHOR } }, true),
  f('Votes', 'votes', { list: { struct: VOTE } }, true),
  f('Transaction', 'transaction', S, true),
  f('Check', 'check', { struct: SET_CHECK }),
];
/** EvidenceV14: Evidence as the rules v14 head (d20f693) declared it: the members a v14 decode kept, with v14's tags. */
export const EVIDENCE_V14: StructDef = [
  EVIDENCE[0]!, EVIDENCE[1]!, EVIDENCE[2]!, EVIDENCE[3]!, EVIDENCE[4]!, EVIDENCE[5]!, EVIDENCE[6]!,
  f('Pages', 'pages', { list: { struct: PAGE_STATE_V14 } }, true),
  f('Check', 'check', { struct: SET_CHECK_V14 }),
];

const EVIDENCE_SCH: Sch = { struct: EVIDENCE };

/** A certificate's decoded evidence: Go's Evidence with every member by Go field name. */
export type EvidenceVal = { [field: string]: GoVal };

/** UnmarshalCertifiedEvidence: JSON null is (nil, nil); a document that claims 2.1 is decoded completely, every other into v14's member set. */
export function unmarshalCertifiedEvidence(raw: Uint8Array | string): EvidenceVal | null {
  const tree = parseGoJson(raw);
  // The probe: json.Unmarshal(raw, &struct{ Version string }).
  let version = '';
  if (tree !== null) {
    if (!(tree instanceof JObj)) throw new JsonError(`json: cannot unmarshal ${typeof tree === 'string' ? 'string' : Array.isArray(tree) ? 'array' : typeof tree === 'boolean' ? 'bool' : 'number'} into Go value of type struct`);
    version = (decodeVal({ struct: [f('Version', 'version', S)] }, tree, 'probe') as { Version: string }).Version;
  }
  if (version === '2.1') return decodeVal(EVIDENCE_SCH, tree, 'Evidence') as EvidenceVal;
  const w = decodeVal({ struct: EVIDENCE_V14 }, tree, 'EvidenceV14') as EvidenceVal;
  if (tree === null) return null;
  return fromV14(w);
}

/** json.Unmarshal(raw, &Evidence): the whole of the type, whatever version the document claims (JSON null leaves the zero Evidence). */
export function decodeEvidenceFull(raw: Uint8Array | string): EvidenceVal {
  return decodeVal(EVIDENCE_SCH, parseGoJson(raw), 'Evidence') as EvidenceVal;
}

/** EvidenceV14.Evidence(): the document with v14's members set and every evidence 2.1 member zero. */
function fromV14(w: EvidenceVal): EvidenceVal {
  const ev = zero(EVIDENCE_SCH) as EvidenceVal;
  for (const k of ['Version', 'Account', 'TxHash', 'Receipt', 'Majors', 'Certify', 'Anchor']) ev[k] = w[k]!;
  const chk = w.Check as EvidenceVal;
  const out = ev.Check as EvidenceVal;
  for (const k of ['Majors', 'Hops', 'Set']) out[k] = chk[k]!;
  if (w.Pages !== null) {
    ev.Pages = (w.Pages as EvidenceVal[]).map((p) => {
      const q = zero({ struct: PAGE_STATE }) as EvidenceVal;
      for (const k of ['URL', 'State', 'Receipt', 'Chains', 'PendingHash', 'ChainError']) q[k] = p[k]!;
      return q;
    });
  }
  return ev;
}

/**
 * Evidence20View is a certificate's proof v2 as the rules v14 binary decoded it: every member that evidence 2.1 defines and v14's structs
 * did not have is cleared. A document that claims 2.0 is verified, bound and committed (govRoot v3) on this view before the cross-partition
 * activation; a document that claims 2.1 is never viewed.
 */
export function evidence20View(ev: EvidenceVal | null): EvidenceVal | null {
  if (ev === null) return null;
  const out = zero(EVIDENCE_SCH) as EvidenceVal;
  for (const k of ['Version', 'Account', 'TxHash', 'Receipt', 'Majors', 'Anchor']) out[k] = ev[k]!;
  // append([]string(nil), s...) is nil for an empty s: an empty member of the document is a null one in its view
  out.Certify = ev.Certify === null || (ev.Certify as GoVal[]).length === 0 ? null : [...(ev.Certify as GoVal[])];
  const chk = ev.Check as EvidenceVal;
  const oc = out.Check as EvidenceVal;
  oc.Majors = chk.Majors!;
  oc.Hops = chk.Hops === null || (chk.Hops as GoVal[]).length === 0 ? null : [...(chk.Hops as GoVal[])];
  oc.Set = chk.Set!;
  if (ev.Pages !== null) {
    out.Pages = (ev.Pages as EvidenceVal[]).map((p) => {
      const q = zero({ struct: PAGE_STATE }) as EvidenceVal;
      for (const k of ['URL', 'State', 'Receipt', 'Chains', 'PendingHash', 'ChainError']) q[k] = p[k]!;
      return q;
    });
  }
  return out;
}

/** json.Marshal(ev). */
export function marshalEvidence(ev: EvidenceVal | null): string {
  return ev === null ? 'null' : marshalVal(EVIDENCE_SCH, ev);
}

/** The kept and cleared member lists, for the test that pins them to the fields of Evidence. */
export const VIEW_KEPT = {
  evidence: ['Version', 'Account', 'TxHash', 'Receipt', 'Majors', 'Certify', 'Anchor', 'Pages', 'Check'],
  setCheck: ['Majors', 'Hops', 'Set'],
  pageState: ['URL', 'State', 'Receipt', 'Chains', 'PendingHash', 'ChainError'],
} as const;
export const EVIDENCE_FIELDS = EVIDENCE.map((x) => x.name);
export const SET_CHECK_FIELDS = SET_CHECK.map((x) => x.name);
export const PAGE_STATE_FIELDS = PAGE_STATE.map((x) => x.name);

// --------------------------------------------------------------------------------------------------------------------------------
// judgeProofV2

/** The refusals of an intent certificate's proof v2 (intent_certificate.go), each by name. */
export class IntentProofError extends VerifyError {
  constructor(
    readonly kind:
      | 'ErrIntentProofV2Missing'
      | 'ErrIntentProofV21NotInForce'
      | 'ErrIntentProofV21Missing'
      | 'ErrIntentProofV2Invalid'
      | 'ErrIntentAccumulateSetMismatch'
      | 'ErrIntentGovRootMismatch',
    message: string,
  ) {
    super(message);
    this.name = kind;
  }
}

export const MESSAGES = {
  ErrIntentProofV2Missing: 'the chain requires the v3 intent certificate, and the block carries no proof v2',
  ErrIntentProofV21NotInForce: 'the block carries evidence 2.1, which the chain does not require yet',
  ErrIntentProofV21Missing: "the chain requires evidence 2.1, and the block's proof v2 is not",
  ErrIntentProofV2Invalid: "the block's proof v2 does not verify against the chain's Accumulate spine",
  ErrIntentAccumulateSetMismatch: 'the Accumulate set root recomputed from the block\'s L4 differs from the one it claims',
  ErrIntentGovRootMismatch: 'govRoot v2 recomputed from the block differs from the one it claims',
} as const;

/** ErrBind marks an error of the root computation that is the binding of the report to the intent (BindProofV2, BindProofV21). */
export class BindError extends VerifyError {
  /** The refusal the binding gave (a NamedState, or a plain error): what Go's errors.As finds through the wrapped ErrBind. */
  constructor(
    message: string,
    readonly inner?: Error,
  ) {
    super(message);
    this.name = 'BindError';
  }
}

export interface JudgeInputs<R extends { accumulateSetRoot: string }> {
  /** The certificate's proof v2, as decoded (null: the block carries none). */
  proofV2: EvidenceVal | null;
  /** Whether the cross-partition activation is in force for the block (G1CrossPartitionRequired). */
  activationRequired: boolean;
  /** The real verifier of the document's version against the chain's spine; it receives the document it must judge. */
  verify: (doc: EvidenceVal) => R;
  /** The set root the L4 leg was verified against. */
  accRoot: string;
  /** The binding and the root together (ProofV2Root): a BindError is the binding's refusal, any other error the root's. */
  root: (rep: R, doc: EvidenceVal) => string;
}

/**
 * judgeProofV2 is the part of intentInputs that judges a v3 certificate's proof v2, in the order consensus judges it, and returns the
 * govRoot (v3 over evidence 2.0, v4 over evidence 2.1) the message commits:
 *
 *   1. the evidence's version against the activation in force: 2.1 before it, or 2.0 after it, is refused by name;
 *   2. the document, by the real verifier of its version against the chain's spine (a document that claims 2.0 is judged on its
 *      evidence-2.0 view, exactly what v14 decoded);
 *   3. one validator set: the set root the spine derived must be the one the L4 leg was verified against;
 *   4. the binding and the root together.
 */
export function judgeProofV2<R extends { accumulateSetRoot: string }>(inn: JudgeInputs<R>): { govRoot: string; report: R } {
  const fail = (k: keyof typeof MESSAGES, extra = ''): never => {
    throw new IntentProofError(k, extra === '' ? MESSAGES[k] : `${MESSAGES[k]}${extra}`);
  };
  if (inn.proofV2 === null) return fail('ErrIntentProofV2Missing');
  const version = inn.proofV2.Version as string;
  const is21 = version === '2.1';
  if (is21 && !inn.activationRequired) return fail('ErrIntentProofV21NotInForce');
  if (!is21 && inn.activationRequired) return fail('ErrIntentProofV21Missing', ` (proof version ${JSON.stringify(version)})`);
  // A document that claims 2.0 and reaches here is judged with no activation in force: as v14 judged it, on the members v14's decode kept.
  const doc = is21 ? inn.proofV2 : (evidence20View(inn.proofV2) as EvidenceVal);
  let rep: R;
  try {
    rep = inn.verify(doc);
  } catch (e) {
    return fail('ErrIntentProofV2Invalid', `: ${e instanceof Error ? e.message : String(e)}`);
  }
  // One anchor commits one Accumulate set root: the set the spine derived must be the set the L4 leg was verified against.
  if (rep.accumulateSetRoot !== inn.accRoot) {
    return fail('ErrIntentAccumulateSetMismatch', `: the spine derives set root ${rep.accumulateSetRoot}, the L4 leg ${inn.accRoot}`);
  }
  try {
    return { govRoot: inn.root(rep, doc), report: rep };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (e instanceof BindError) return fail('ErrIntentProofV2Invalid', `: ${m}`);
    return fail('ErrIntentGovRootMismatch', `: ${m}`);
  }
}
