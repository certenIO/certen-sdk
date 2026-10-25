/**
 * Every answer the finality framework gives that is not a level: a named state with the values it was judged at (the twin of
 * pkg/finality/state.go). Nothing is returned as a bare string, a boolean or a weaker level.
 *
 * The machine registry of the codes and their field names is test/fixtures/finality/finality/states.json, byte-identical to the
 * validator's testdata/finality/states.json. The canonical form (`canonical()`) is what the Go and TypeScript verifiers compare on
 * every vector: JSON with sorted keys and no whitespace, EVERY integer field of ANY width (number or bigint here) as a decimal
 * string, EVERY byte string (Uint8Array) as 0x-prefixed lower-case hex ("0x" for the empty string), a level by name.
 */
import { levelName } from './level.js';

/** A Level placed in a state's fields: it renders by name, where a bare number renders as a decimal string. */
export class LevelField {
  constructor(readonly level: number) {}
}
export const lvl = (l: number): LevelField => new LevelField(l);

export type FieldValue =
  | null
  | undefined
  | boolean
  | string
  | number
  | bigint
  | Uint8Array
  | LevelField
  | Date
  | FieldValue[]
  | { [k: string]: FieldValue };

export type Fields = Record<string, FieldValue>;

/** Codes the framework itself raises (chain packages add their own, section 7, with their own constants). */
export const Code = {
  ChainUnsupported: 'finality_chain_unsupported',
  ChainBroken: 'finality_chain_broken',
  EvidenceMalformed: 'finality_evidence_malformed',
  EvidenceUnrecognised: 'finality_evidence_unrecognised',
  EvidenceTooLarge: 'finality_evidence_too_large',
  BlockMismatch: 'finality_block_mismatch',
  PinsCorrupt: 'finality_pins_corrupt',
  PinUnknown: 'finality_pin_unknown',
  LedgerExtensionBad: 'finality_ledger_extension_invalid',
  NotApplicable: 'level_not_applicable',
  Pending: 'finality_pending',
  LevelAlreadyPresent: 'level_already_present',
  // Operational states of the Go implementation that V2_SPEC_S7 section 7 does not list (registry scope "go_operational").
  AddendumMalformed: 'finality_addendum_malformed',
  VerifierFailed: 'finality_verifier_failed',
  IncludedUnavailable: 'finality_included_unavailable',
  IncludedInvalid: 'finality_included_invalid',
  FinalizedBlockUnavailable: 'finality_finalized_block_unavailable',
} as const;

/** The check names of finality_chain_broken (section 2.3), exactly. */
export const Check = {
  SeqGap: 'seq_gap',
  PrevHash: 'prev_hash',
  OwnHash: 'own_hash',
  LevelDuplicate: 'level_duplicate',
  Kind: 'kind',
  LegBinding: 'leg_binding',
} as const;

/** The reason of finality_evidence_malformed (a closed set; registry enums.reason). */
export const EvidenceReason = {
  Truncated: 'truncated',
  LengthExceedsRemaining: 'length_exceeds_remaining',
  StrNotASCIIOrNUL: 'str_not_ascii_or_nul',
  CountExceedsRemaining: 'count_exceeds_remaining',
  NodesNotAscendingUnique: 'nodes_not_ascending_unique',
  TrailingBytes: 'trailing_bytes',
  LevelNotStored: 'level_not_stored',
  DiffersFromAddendum: 'differs_from_addendum',
  HeaderNotRLPList: 'header_not_rlp_list',
  HeaderTrailingBytes: 'header_trailing_bytes',
  HeaderBadItem: 'header_bad_item',
  HeaderTooFewItems: 'header_too_few_items',
  HeaderItemNot32Bytes: 'header_item_not_32_bytes',
  HeaderItemNotCanonUint: 'header_item_not_canonical_uint',
  HeaderItemIsList: 'header_item_is_list',
  // The compact Adiri committee chain (pkg/finality/adiri, RB11-F1): the container body of adiri/finalized/v1.
  CFA1BadMagic: 'cfa1_bad_magic',
  CFA1KeyLength: 'cfa1_key_length',
  CFA1NoRecords: 'cfa1_no_records',
  CFA1NoTables: 'cfa1_no_tables',
  CFA1SignersTooMany: 'cfa1_signers_too_many',
  CFA1TableEmpty: 'cfa1_table_empty',
  CFA1TableIndexOutOfRange: 'cfa1_table_index_out_of_range',
  CFA1TableSize: 'cfa1_table_size',
  CFA1TooLargeToEncode: 'cfa1_too_large_to_encode',
  LevelNotFinalized: 'level_not_finalized',
  LinkKind2AtSeal: 'link_kind_2_at_seal',
  LinkKindUnknown: 'link_kind_unknown',
  SpineEmpty: 'spine_empty',
  BadEnumValue: 'bad_enum_value',
  // The Sepolia L1-finality kind (pkg/finality/ethsepolia, RB11-C2): the framing reasons of the light-client part, as pkg/finality/ethl1
  // names them, and the spine that does not end at the leg block.
  AttestedOffset: 'attested_offset',
  Empty: 'empty',
  ExecutionOffset: 'execution_offset',
  ExtraDataLength: 'extra_data_length',
  ExtraDataOffset: 'extra_data_offset',
  FinalizedOffset: 'finalized_offset',
  HeaderLength: 'header_length',
  HeaderOffset: 'header_offset',
  LayoutByteNotZero: 'layout_byte_not_zero',
  LayoutByteUnknown: 'layout_byte_unknown',
  LayoutByteZero: 'layout_byte_zero',
  Length: 'length',
  SpineNotEndingAtBlock: 'spine_not_ending_at_block',
  UnknownKind: 'unknown_kind',
  UnsupportedProfile: 'unsupported_profile',
} as const;

/** The reason of finality_addendum_malformed (the JSON form of an addendum, a section and a proof id). */
export const AddendumReason = {
  NotJSON: 'not_json',
  UnknownKey: 'unknown_key',
  DuplicateKey: 'duplicate_key',
  MissingKey: 'missing_key',
  BadValue: 'bad_value',
  LevelNotStored: 'level_not_stored',
  UnknownLevel: 'unknown_level',
  NotLowerHex: 'not_lowercase_hex',
  Not32Bytes: 'not_32_bytes',
  NotUUID: 'not_canonical_uuid',
  WrongFormat: 'wrong_format',
} as const;

/** The reason of finality_pins_corrupt. */
export const PinsReason = {
  SHA256Mismatch: 'sha256_mismatch',
  SHA256ConstantMalformed: 'sha256_constant_malformed',
  NotUTF8: 'not_utf8',
  ContainsCR: 'contains_cr',
  ByteOrderMark: 'byte_order_mark',
  KeysUnsorted: 'keys_unsorted',
  DuplicateKey: 'duplicate_key',
  UnknownKey: 'unknown_key',
  NotJSON: 'not_json',
  BadValue: 'bad_value',
  WrongFormat: 'wrong_format',
  PublishedUTCEmpty: 'published_utc_empty',
  ChainIDMismatch: 'chain_id_mismatch',
  GenesisRootMalformed: 'genesis_validators_root_malformed',
  ParticipationFloor: 'participation_floor_invalid',
  BoundMissing: 'bound_missing',
  ForksEmpty: 'forks_empty',
  ForkMalformed: 'fork_malformed',
  ForkEpochNotAscending: 'fork_epoch_not_ascending',
  ForkLayoutUnknown: 'fork_layout_unknown',
  FirstForkNotEpochZero: 'first_fork_not_epoch_zero',
  AnchorMalformed: 'anchor_malformed',
  AnchorPeriodDuplicate: 'anchor_period_duplicate',
  AnchorPeriodNotAscending: 'anchor_period_not_ascending',
  AnchorWspBelow256: 'anchor_wsp_epochs_below_256',
  AnchorDerivedByEmpty: 'anchor_derived_by_empty',
} as const;

/** The reason of finality_included_unavailable. */
export const IncludedReason = {
  /**
   * The bundle holds an execution proof (component 5) without its block_header_rlp, as bundles written before the header was captured do.
   * Without the header the leg binding D0 cannot be recomputed, so nothing is judged; it is not corrupt evidence and not a failure
   * (Go IncludedNoBlockHeader, raised by the validator's bundle reader, which has no TypeScript twin).
   */
  NoBlockHeader: 'no_block_header',
  /**
   * The header of a legacy leg (see NoBlockHeader) was asked of every provider the validator is configured with for the leg's chain and none
   * served the block (Go IncludedLegacyHeaderUnserved, pkg/finality/legacyhdr; raised by the validator's reconstruction, which has no TypeScript twin).
   */
  LegacyHeaderUnserved: 'legacy_header_unserved',
  NoSettlement: 'no_settlement',
  NoExecutionProof: 'no_execution_proof_component',
  SettlementNotJudged: 'no_settlement_to_recompute_d0',
} as const;

/** The reason of finality_ledger_extension_invalid (a closed set; registry enums.reason; raised by the Sepolia ledger extension, pkg/finality/ethsepolia). */
export const LedgerReason = {
  BaseNotPrefix: 'base_not_prefix',
  BlockRootOnAppendedEntry: 'block_root_on_appended_entry',
  CommitteeRootMismatch: 'committee_root_mismatch',
  LinkMissing: 'link_missing',
  LinkRefused: 'link_refused',
  LinkSha256Mismatch: 'link_sha256_mismatch',
  NonLedgerContentDiffers: 'non_ledger_content_differs',
  PeriodNotNext: 'period_not_next',
  PredecessorCommitteeUnavailable: 'predecessor_committee_unavailable',
  RootPinUnverifiable: 'root_pin_unverifiable',
  WspWidened: 'wsp_widened',
} as const;

/** The field of pin_mismatch (a closed set; registry enums.field): the pin of the Arbitrum kinds that disagrees with what the evidence is judged under. */
export const PinMismatchField = {
  BoldGenesisL2Block: 'bold_genesis_l2_block',
  Bridge: 'bridge',
  ChainId: 'chain_id',
  ConfirmPathSelectorsConfirmAssertion: 'confirm_path.selectors.confirm_assertion',
  ConfirmPathSelectorsFastConfirmAssertion: 'confirm_path.selectors.fast_confirm_assertion',
  ConfirmPathSelectorsFastConfirmNewAssertion: 'confirm_path.selectors.fast_confirm_new_assertion',
  ConfirmPathSelectorsForceConfirmAssertion: 'confirm_path.selectors.force_confirm_assertion',
  ConfirmPathSelectorsWalletExecuteTransaction: 'confirm_path.selectors.wallet_execute_transaction',
  ConfirmPathSelectorsWalletExecuteTransactionWithGasRefunder: 'confirm_path.selectors.wallet_execute_transaction_with_gas_refunder',
  ConfirmPathSelectorsWalletExecuteTransactions: 'confirm_path.selectors.wallet_execute_transactions',
  ConfirmPathSelectorsWalletExecuteTransactionsWithGasRefunder: 'confirm_path.selectors.wallet_execute_transactions_with_gas_refunder',
  ConfirmPathTopicsAssertionConfirmed: 'confirm_path.topics.assertion_confirmed',
  ConfirmPathTopicsAssertionForceConfirmed: 'confirm_path.topics.assertion_force_confirmed',
  ConfirmPathValidatorWalletImpl: 'confirm_path.validator_wallet_impl',
  KZGSetupSHA256: 'kzg_setup_sha256',
  Layout: 'layout',
  LayoutAccArraySlot: 'layout.acc_array_slot',
  LayoutDelayedAccArraySlot: 'layout.delayed_acc_array_slot',
  LogicPins: 'logic_pins',
  LogicPinsValidatorWalletLogic: 'logic_pins.validator_wallet_logic',
  LogicPinsValidatorWalletProxy: 'logic_pins.validator_wallet_proxy',
  MaxBlobs: 'max_blobs',
  MaxHeaderChain: 'max_header_chain',
  MaxSegments: 'max_segments',
  MaxUncompressedBatch: 'max_uncompressed_batch',
  ParentChainId: 'parent_chain_id',
  ProxySlotsAdminLogic: 'proxy_slots.admin_logic',
  ProxySlotsUserLogic: 'proxy_slots.user_logic',
  ProxySlotsWalletImpl: 'proxy_slots.wallet_impl',
  Rollup: 'rollup',
  Section: 'section',
} as const;

/** The reason of finality_finalized_block_unavailable. */
export const FinalizedBlockReason = {
  NoHeader: 'no_header',
  HeaderUnreadable: 'header_unreadable',
} as const;

/** The two not-applicable cells of the section 1 table, verbatim. */
export const NotApplicableReason = {
  ChainIsL1: 'this chain is the L1',
  NoL1Settlement: 'no L1 settlement exists',
} as const;

// ---- canonical form ----

const utf8 = new TextEncoder();

/** The byte-wise order of Go's sort.Strings (UTF-8 bytes), which differs from a UTF-16 code-unit order outside the BMP. */
export function cmpUtf8(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export function hexLower(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** The text Go 1.25 encoding/json writes for a string with SetEscapeHTML(false). */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else if (c === 0x2028 || c === 0x2029) out += `\\u${c.toString(16)}`;
    else if (c >= 0xd800 && c <= 0xdfff) out += '�'; // a lone surrogate: Go holds invalid UTF-8 as U+FFFD
    else out += ch;
  }
  return `${out}"`;
}

function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * canonValue renders v canonically (state.go canonValue): maps with sorted keys, integers as decimal strings, byte strings as
 * 0x-prefixed lower-case hex, a level by name, booleans and null as JSON literals, a time as RFC 3339 UTC.
 */
export function canonValue(v: FieldValue): string {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'string':
      return goQuote(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      return goQuote(v.toString());
    case 'number':
      if (!Number.isSafeInteger(v)) throw new Error(`state field ${v} is not a safe integer: carry wide integers as bigint`);
      return goQuote(String(v));
  }
  if (v instanceof LevelField) return goQuote(levelName(v.level));
  if (v instanceof Uint8Array) return goQuote(`0x${hexLower(v)}`);
  if (v instanceof Date) return goQuote(rfc3339(v));
  if (Array.isArray(v)) return `[${v.map(canonValue).join(',')}]`;
  const keys = Object.keys(v).sort(cmpUtf8);
  return `{${keys.map((k) => `${goQuote(k)}:${canonValue((v as { [k: string]: FieldValue })[k])}`).join(',')}}`;
}

/** A named state that is also a thrown error: `code` and `fields` as in pkg/finality StateError. */
export class FinalityStateError extends Error {
  readonly code: string;
  readonly fields: Fields;
  constructor(code: string, fields: Fields = {}) {
    super(code);
    this.name = 'FinalityStateError';
    this.code = code;
    this.fields = { ...fields };
  }
  /** `{"code":...,"fields":{...}}` with sorted keys and no whitespace. */
  canonical(): string {
    return `{"code":${goQuote(this.code)},"fields":${canonValue(this.fields)}}`;
  }
  /** `code{k=v,...}` in sorted key order, as Go's Error(). */
  override toString(): string {
    const keys = Object.keys(this.fields).sort(cmpUtf8);
    return `${this.code}{${keys.map((k) => `${k}=${canonValue(this.fields[k])}`).join(',')}}`;
  }
}

/** The named state in err, if err is one. */
export function asNamed(err: unknown): FinalityStateError | undefined {
  return err instanceof FinalityStateError ? err : undefined;
}

/** The canonical text of a verdict the conformance vectors compare: "ok" for no error. */
export function canonOf(err: unknown): string {
  if (err === undefined || err === null) return 'ok';
  const st = asNamed(err);
  if (st) return st.canonical();
  return `NOT A NAMED STATE: ${err instanceof Error ? err.message : String(err)}`;
}

export function newState(code: string, fields: Fields = {}): FinalityStateError {
  return new FinalityStateError(code, fields);
}

// ---- constructors of the framework states (section 7, Framework R and N) ----

const nonNeg = (n: number): number => (n > 0 ? n : 0);

/** finality_evidence_malformed for a part; got and want are byte or element counts (0 when not meaningful). */
export function malformed(part: string, reason: string, got: number, want: number): FinalityStateError {
  return newState(Code.EvidenceMalformed, { part, reason, got_len: BigInt(nonNeg(got)), want_len: BigInt(nonNeg(want)) });
}

/** malformed for element `index` of a list or item of a header. */
export function malformedAt(part: string, index: number, reason: string, got: number, want: number): FinalityStateError {
  const s = malformed(part, reason, got, want);
  s.fields.index = BigInt(index);
  return s;
}

/** finality_evidence_too_large{part,count,limit}. */
export function evidenceTooLarge(part: string, count: number | bigint, limit: number | bigint): FinalityStateError {
  return newState(Code.EvidenceTooLarge, { part, count: BigInt(count), limit: BigInt(limit) });
}

/** finality_evidence_unrecognised{kind,version}. */
export function evidenceUnrecognised(kind: string, version: string): FinalityStateError {
  return newState(Code.EvidenceUnrecognised, { kind, version });
}

/** finality_chain_unsupported{chain}. */
export function chainUnsupported(chain: bigint): FinalityStateError {
  return newState(Code.ChainUnsupported, { chain });
}

/** finality_chain_broken{seq,check}. */
export function chainBroken(seq: bigint | number, check: string, extra: Fields = {}): FinalityStateError {
  return newState(Code.ChainBroken, { seq: BigInt(seq), check, ...extra });
}

/** finality_block_mismatch{field,want,got}. */
export function blockMismatch(field: string, want: FieldValue, got: FieldValue): FinalityStateError {
  return newState(Code.BlockMismatch, { field, want, got });
}

/** finality_pins_corrupt{reason, ...}. */
export function pinsCorrupt(reason: string, extra: Fields = {}): FinalityStateError {
  return newState(Code.PinsCorrupt, { reason, ...extra });
}

/** level_not_applicable{chain,level,reason}: complete as an answer. */
export function notApplicableState(chain: bigint, level: number, reason: string): FinalityStateError {
  return newState(Code.NotApplicable, { chain, level: lvl(level), reason });
}

/** finality_addendum_malformed{field, reason}: the JSON form of an addendum, a section or a proof id was refused. */
export function addendumMalformed(field: string, reason: string, extra: Fields = {}): FinalityStateError {
  return newState(Code.AddendumMalformed, { field, reason, ...extra });
}

/** finality_included_unavailable{reason}: level 1 cannot be derived because a leg has no Settlement. */
export function includedUnavailable(reason: string, extra: Fields = {}): FinalityStateError {
  return newState(Code.IncludedUnavailable, { reason, ...extra });
}

/** finality_finalized_block_unavailable{chain, number, reason[, index]}. */
export function finalizedBlockUnavailable(chain: bigint, number: bigint, reason: string, extra: Fields = {}): FinalityStateError {
  return newState(Code.FinalizedBlockUnavailable, { chain, number, reason, ...extra });
}

/**
 * The builder-side (and offline) "not yet" of a level: the level reached (proven), the next level, the reason from the closed set of
 * states.json, an optional ETA and the reason's own fields. It is not a failure and never carries weaker evidence.
 */
export interface PendingState {
  chain: bigint;
  levelReached: number;
  nextLevel: number;
  reason: string;
  eta?: Date;
  judged?: Fields;
}

/** Renders the single code finality_pending{chain, level_reached, next_level, reason, eta?, ...}. */
export function pendingState(p: PendingState): FinalityStateError {
  const s = newState(Code.Pending, { chain: p.chain, level_reached: lvl(p.levelReached), next_level: lvl(p.nextLevel), reason: p.reason });
  if (p.eta !== undefined) s.fields.eta = p.eta;
  for (const [k, v] of Object.entries(p.judged ?? {})) s.fields[k] = v;
  return s;
}

/** The offline verifier's pending for a level without an addendum (R4). */
export function noEvidenceInFile(chain: bigint, reached: number, next: number): FinalityStateError {
  return pendingState({ chain, levelReached: reached, nextLevel: next, reason: 'no_evidence_in_file' });
}
