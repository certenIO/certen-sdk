/**
 * The intent's vote evidence (validator liteclient/proof/govvote evidence.go: Evidence) as the binding reads it. The document is decoded
 * with the rules of json.Unmarshal into the whole of govvote.Evidence, so a document Go refuses to decode ("missing or malformed" in
 * ProofV2Root) is refused here, and only then are the members the facts need read.
 */
import { JsonError } from './gojson.js';
import { decodeVal, parseGoJson, type FieldDef, type GoVal, type Sch, type StructDef } from './jsonx.js';
import type { VoteEvidenceView } from './bind-v21.js';

const S = 'string' as const;
const f = (name: string, json: string, sch: Sch, omitempty = false): FieldDef => ({ name, json, sch, omitempty });

const STEP: StructDef = [f('Hash', 'hash', S), f('Right', 'right', 'bool')];
const RECEIPT: StructDef = [f('Start', 'start', S), f('Anchor', 'anchor', S), f('LocalBlock', 'localBlock', 'i64'), f('Entries', 'entries', { list: { struct: STEP } })];
const ACCOUNT_AUTHORITY: StructDef = [f('URL', 'url', S), f('Disabled', 'disabled', 'bool', true)];
/** SigFact and the other facts have no JSON tags: the keys are the Go field names. */
const SIG_FACT: StructDef = [
  f('ID', 'ID', S),
  f('Signer', 'Signer', S),
  f('Path', 'Path', { list: S }),
  f('Version', 'Version', 'u64'),
  f('KeyHash', 'KeyHash', S),
  f('Vote', 'Vote', 'vote'),
  f('Block', 'Block', 'i64'),
  f('Partition', 'Partition', S, true),
];
const ARRIVAL_FACT: StructDef = [
  f('ID', 'ID', S),
  f('Page', 'Page', S),
  f('Authority', 'Authority', S),
  f('Path', 'Path', { list: S }),
  f('Block', 'Block', 'i64'),
  f('Origin', 'Origin', S),
  f('Vote', 'Vote', 'vote'),
];
const RECORDED_VOTE: StructDef = [f('ID', 'ID', S), f('Authority', 'Authority', S), f('Origin', 'Origin', S), f('Vote', 'Vote', 'vote'), f('Block', 'Block', 'i64'), f('ReleasedAt', 'ReleasedAt', 'i64')];
const SIGNATURE_EVIDENCE: StructDef = [f('Fact', 'fact', { struct: SIG_FACT }), f('Signature', 'signature', S), f('Receipt', 'receipt', { struct: RECEIPT })];
const ARRIVAL_EVIDENCE: StructDef = [f('Fact', 'fact', { struct: ARRIVAL_FACT }), f('Signature', 'signature', S), f('Receipt', 'receipt', { struct: RECEIPT })];
const VOTE_EVIDENCE: StructDef = [f('Fact', 'fact', { struct: RECORDED_VOTE }), f('Signature', 'signature', S), f('Receipt', 'receipt', { struct: RECEIPT })];
const HISTORY_ENTRY: StructDef = [
  f('Index', 'index', 'i64'),
  f('EntryHash', 'entryHash', S),
  f('LocalBlock', 'localBlock', 'i64'),
  f('Receipt', 'receipt', { struct: RECEIPT }),
  f('Transaction', 'transaction', S),
  f('Initiator', 'initiator', S, true),
];
const PAGE_HISTORY: StructDef = [f('Page', 'page', S), f('Entries', 'entries', 'i64'), f('Genesis', 'genesis', { struct: HISTORY_ENTRY }), f('Events', 'events', { list: { struct: HISTORY_ENTRY } })];
const ACCOUNT_ENTRY: StructDef = [
  f('Index', 'index', 'i64'),
  f('EntryHash', 'entryHash', S),
  f('Header', 'header', S),
  f('Body', 'body', S),
  f('DataEntryHash', 'dataEntryHash', S, true),
  f('LocalBlock', 'localBlock', 'i64', true),
  f('Receipt', 'receipt', { ptr: RECEIPT }, true),
];
const ACCOUNT_HISTORY: StructDef = [f('Account', 'account', S), f('Entries', 'entries', 'i64'), f('Events', 'events', { list: { struct: ACCOUNT_ENTRY } }), f('Live', 'live', { list: { struct: ACCOUNT_AUTHORITY } })];
const AUTHORITY_EVIDENCE: StructDef = [f('Block', 'block', 'i64'), f('Accounts', 'accounts', { list: { struct: ACCOUNT_HISTORY } }), f('DecidedByLiveState', 'decidedByLiveState', { list: S }, true)];

/** govvote.Evidence. */
export const VOTE_EVIDENCE_DOC: StructDef = [
  f('Version', 'version', S),
  f('Account', 'account', S),
  f('Transaction', 'transaction', S),
  f('Authorities', 'authorities', { list: { struct: ACCOUNT_AUTHORITY } }),
  f('Extra', 'extra', { list: S }, true),
  f('IgnoreDisabled', 'ignoreDisabled', 'bool', true),
  f('Signatures', 'signatures', { list: { struct: SIGNATURE_EVIDENCE } }, true),
  f('Arrivals', 'arrivals', { list: { struct: ARRIVAL_EVIDENCE } }, true),
  f('Votes', 'votes', { list: { struct: VOTE_EVIDENCE } }, true),
  f('Pages', 'pages', { list: { struct: PAGE_HISTORY } }),
  f('AuthoritySet', 'authoritySet', { ptr: AUTHORITY_EVIDENCE }),
  f('NetworkName', 'networkName', S, true),
];

type Rec = { [k: string]: GoVal };
const arr = (v: GoVal): Rec[] => (v === null ? [] : (v as Rec[]));
const num = (v: GoVal): number => Number(v as bigint);

/**
 * json.Unmarshal(voteEvidence, &gev): refused (a plain error) when the document does not decode as a govvote.Evidence. Returns the members
 * the governing facts read.
 */
export function decodeVoteEvidence(raw: Uint8Array | string): VoteEvidenceView {
  if (raw.length === 0) throw new JsonError('unexpected end of JSON input');
  const d = decodeVal({ struct: VOTE_EVIDENCE_DOC }, parseGoJson(raw), 'Evidence') as Rec;
  return {
    account: d.Account as string,
    transaction: d.Transaction as string,
    authorities: arr(d.Authorities!).map((a) => ({ url: a.URL as string, disabled: a.Disabled as boolean })),
    extra: d.Extra === null ? [] : (d.Extra as string[]),
    signatures: arr(d.Signatures!).map((s) => ({ signer: (s.Fact as Rec).Signer as string, block: num((s.Fact as Rec).Block!), signature: s.Signature as string })),
    votes: arr(d.Votes!).map((v) => ({ authority: (v.Fact as Rec).Authority as string, origin: (v.Fact as Rec).Origin as string, block: num((v.Fact as Rec).Block!) })),
    arrivals: arr(d.Arrivals!).map((a) => ({
      page: (a.Fact as Rec).Page as string,
      origin: (a.Fact as Rec).Origin as string,
      path: (a.Fact as Rec).Path === null ? [] : ((a.Fact as Rec).Path as string[]),
      block: num((a.Fact as Rec).Block!),
    })),
  };
}
