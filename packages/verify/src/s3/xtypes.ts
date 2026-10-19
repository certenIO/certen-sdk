/**
 * The types the evidence 2.1 verifier passes between its parts (validator xverify.go: xIn, provenAcct, Report).
 */
import type { SetVerdict } from '../proof-v2/verify.js';
import type { PageChainX as PageChain } from './chains.js';
import type { AccUrl } from './acc.js';
import type { Evidence, PageState } from './evidence.js';
import type { XAnchor } from './executor.js';
import type { PageRole, StateEntry } from './states.js';
import type { WireNode } from './model.js';

/** What verifyFrom hands the 2.1 verifier: the certified root every anchor must be proven into and the transaction's partition anchor. */
export interface XIn {
  certRoot: Uint8Array;
  x: XAnchor;
  /** The state tree root the set check is bound to (the routing proof binds there too). */
  setRoot: Uint8Array;
  /** The name of the network the proven Network account holds: the chain id of a typedData signature. */
  network: string;
}

/** One verified page with where it was proven. */
export interface ProvenAcct {
  i: number;
  acct: WireNode;
  url: AccUrl;
  anchor: XAnchor;
  chain: PageChain;
  page: PageState;
}

/** ProvenPage: one proven page in the report - where it was proven and why it is there. */
export interface ProvenPage {
  url: string;
  partition: string;
  block: number;
  /** Re-derived from the proven states and equal to the recorded ones. */
  roles: PageRole[];
  /** The recorded roles whose justification is a fact outside the evidence (header-authority, initiator-signer, certified-key-page). */
  declared: PageRole[];
}

/** ArrivalReport: one counted signature or vote and the block the verifier derived for it. */
export interface ArrivalReport {
  kind: 'signature' | 'produced';
  account: string;
  partition: string;
  message: string;
  block: number;
}

/** Authorization modes of a report (design D3). */
export const MODE_AUTHORITIES_REQUIRED = 'authorities_required';
export const MODE_ALL_AUTHORITIES_DISABLED = 'all_authorities_disabled';

/** The report of a verified evidence 2.1 document (proofv2.Report). */
export interface Report21 {
  incarnation: string;
  majors: number;
  certifiedBlock: number;
  certifiedRoot: string;
  checkBlock: number;
  partition: string;
  anchorBlock: number;
  /** The proven pages' states (binary), and what was established about their chains, in the same order. */
  pages: { account: WireNode; state: Uint8Array }[];
  pageChains: PageChain[];
  proven: ProvenPage[];
  setVerdict: SetVerdict;
  validators: number;
  threshold: number;
  version: string;
  tag: string;
  unproven: StateEntry[];
  routingHeight: number;
  authorizationMode: string;
  disclosures: StateEntry[];
  arrivals: ArrivalReport[];
  txHash: string;
  anchorTxHash: string;
  anchorStateRoot: string;
  anchorRootChainAnchor: string;
  accumulateSetRoot: string;
}

export type { Evidence, PageState };
