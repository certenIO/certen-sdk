/**
 * The named states and refusals of evidence 2.1 (validator pkg/proof/v2: crosspartition.go, xverify.go, xtimeline.go, xroles.go,
 * xexecutor.go; design docs/proof/G1_CROSS_PARTITION.md D6). A verifier that cannot establish a fact answers with a NAMED STATE that
 * carries the partition and the block it judged at - never a weaker answer shaped like the strong one. A refusal that is not a named
 * state is a plain error (a malformed document, a hash that does not recompute), exactly as in Go.
 */
import { VerifyError } from '../proof-v2/bytes.js';

/** A fact the verifier could not establish, with where it was judged (proofv2.NamedState). It is both a refusal (thrown) and a report entry. */
export class NamedState extends VerifyError {
  constructor(
    readonly code: string,
    readonly partition: string,
    readonly block: number,
    readonly detail: string,
  ) {
    super(NamedState.format(code, partition, block, detail));
    this.name = 'NamedState';
  }

  /** NamedState.Error(). */
  static format(code: string, partition: string, block: number, detail: string): string {
    let where = '';
    if (partition !== '' && block !== 0) where = `{${partition},${block}}`;
    else if (partition !== '') where = `{${partition}}`;
    else if (block !== 0) where = `{${block}}`;
    return detail === '' ? code + where : `${code}${where}: ${detail}`;
  }

  /** The state as a report entry (the shape the shared vectors record). */
  entry(): { code: string; partition: string; block: number; detail: string } {
    return { code: this.code, partition: this.partition, block: this.block, detail: this.detail };
  }
}

/** refusal21: a refusal that names the state, the partition and the block it was judged at. */
export function refusal21(code: string, partition: string, block: number, detail: string): NamedState {
  return new NamedState(code, partition, block, detail);
}

/** A report entry: a state that is not a refusal (Report.Unproven, Report.Disclosures). */
export interface StateEntry {
  code: string;
  partition: string;
  block: number;
  detail: string;
}

export function stateEntry(code: string, partition: string, block: number, detail: string): StateEntry {
  return { code, partition, block, detail };
}

/** The versions and domain tags of evidence 2.1. */
export const VERSION_21 = '2.1';
export const DOMAIN_G1_V4 = 'certen:g1:v4';
export const DOMAIN_GOVROOT_V4 = 'certen:govroot:v4';

/** The named states (crosspartition.go, xverify.go, xtimeline.go, xroles.go, xexecutor.go). */
export const State = {
  HistoricalUnavailable: 'g1_historical_unavailable',
  NotReady: 'g1_state_not_ready',
  PartitionAnchorUnavailable: 'g1_partition_anchor_unavailable',
  ForeignPartitionMismatch: 'g1_foreign_partition_mismatch',
  RoutingUnproven: 'g1_routing_unproven',
  AuthorityVoterOutsideList: 'g1_authority_voter_outside_list',
  HeaderAuthorityMissing: 'g1_header_authority_missing',
  AuthorityMissing: 'g1_authority_missing',
  DelegationDepthExceeded: 'g1_delegation_depth_exceeded',
  DelegateEntryAbsent: 'g1_delegate_entry_absent',
  InitiatorPageUnproven: 'g1_initiator_page_unproven',
  CertifiedPageUnproven: 'g1_certified_page_unproven',
  ExecutorOverrideUnsupported: 'g1_executor_override_unsupported',
  ClosureExceedsBudget: 'g1_closure_exceeds_budget',
  RoutingHistoryUnproven: 'g1_routing_history_unproven',
  DirectoryPartitionUnsupported: 'g1_directory_partition_unsupported',
  VoteHeld: 'g1_vote_held',
  VoteProductionUnbound: 'g1_vote_production_unbound',
  ExecutorVersionUnsupported: 'g1_executor_version_unsupported',
  CompletenessUnproven: 'g1_completeness_unproven',
  BlockBeforeArrival: 'g1_block_before_signature',
  PageBlockMismatch: 'g1_page_block_mismatch',
  BookPageCountUnproven: 'g1_book_pagecount_unproven',
  ChainUnboundPending: 'g1_chain_unbound_pending',
  ChainMoved: 'g1_chain_moved',
  CrossIdentityPending: 'g1_cross_identity_pending',
  RoutingMismatch: 'g1_routing_mismatch',
  RoleMismatch: 'g1_role_mismatch',
  HistoryFoldMismatch: 'g1_history_fold_mismatch',
  HistoryHeadMismatch: 'g1_history_head_mismatch',
  HistoryUnreplayable: 'g1_history_unreplayable',
  ArrivalUnproven: 'g1_arrival_unproven',
  VoteNotReproduced: 'g1_vote_not_reproduced',
  AuthorityNotReady: 'g1_authority_not_ready',
  TransactionMismatch: 'g1_transaction_mismatch',
  SignatureInvalid: 'g1_signature_invalid',
  ExecutorVersionUnproven: 'g1_executor_version_unproven',
  InitiatorSignatureNotCarried: 'g1_initiator_signature_not_carried',
  Evidence21Required: 'g1_evidence_21_required',
} as const;

/** PageRole (crosspartition.go) and KnownRoles, in canonical order. */
export type PageRole =
  | 'principal-chain'
  | 'authority-book'
  | 'authority-page'
  | 'header-authority'
  | 'delegate-book'
  | 'delegate-page'
  | 'voter'
  | 'initiator-signer'
  | 'certified-key-page'
  | 'synthetic-chain'
  | 'system-ledger';

export const Role = {
  PrincipalChain: 'principal-chain',
  AuthorityBook: 'authority-book',
  AuthorityPage: 'authority-page',
  HeaderAuthority: 'header-authority',
  DelegateBook: 'delegate-book',
  DelegatePage: 'delegate-page',
  Voter: 'voter',
  InitiatorSigner: 'initiator-signer',
  CertifiedKeyPage: 'certified-key-page',
  SyntheticChain: 'synthetic-chain',
  SystemLedger: 'system-ledger',
} as const satisfies Record<string, PageRole>;

export const KNOWN_ROLES: readonly PageRole[] = [
  Role.PrincipalChain, Role.AuthorityBook, Role.AuthorityPage, Role.HeaderAuthority, Role.DelegateBook, Role.DelegatePage, Role.Voter,
  Role.InitiatorSigner, Role.CertifiedKeyPage, Role.SyntheticChain, Role.SystemLedger,
];

/**
 * CanonicalRoles: the roles sorted by KnownRoles' order with duplicates removed; an unknown role is an error naming it. The Go sort is not
 * stable but its keys are distinct, so the result is the same.
 */
export function canonicalRoles(roles: readonly string[]): PageRole[] {
  const rank = new Map<string, number>(KNOWN_ROLES.map((r, i) => [r, i]));
  const seen = new Set<string>();
  const out: PageRole[] = [];
  for (const r of roles) {
    if (!rank.has(r)) throw new VerifyError(`unknown page role ${JSON.stringify(r)}`);
    if (!seen.has(r)) {
      seen.add(r);
      out.push(r as PageRole);
    }
  }
  return out.sort((a, b) => rank.get(a)! - rank.get(b)!);
}
