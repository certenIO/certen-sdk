// ---- Client Options ----

export interface CertenClientOptions {
  apiKey: string;
  baseUrl?: string;
  /**
   * Per-request timeout in ms. Default 30_000.
   *
   * This was hardcoded, and the ceiling was reachable in normal use: `execute.proof()` falls back to
   * fetching the Accumulate merkle receipt, which can take longer than 30s on a busy network — so the
   * call failed as `NETWORK_ERROR` with no way for the caller to allow more time. Raise it when you
   * are on a slow link or fetching proofs.
   *
   * This bounds a SINGLE HTTP request, not `execute.wait()`, which polls to its own `timeoutMs`
   * budget (default 360s).
   */
  timeoutMs?: number;
}

// ---- Identity ----

export interface CreateIdentityParams {
  name: string;
  /**
   * SEND THIS. An identity registered with only a `publicKeyHash` cannot sign — create accepts it and every
   * later signing call rejects it, leaving an identity that consumes quota and can never be used.
   * `identity.update()` repairs one if the hash matches.
   */
  publicKey?: string;
  publicKeyHash?: string;
  chains?: string[];
  credits?: number;
  signingMode?: 'external' | 'provider';
  /**
   * Provider configuration — an OBJECT.
   *
   * This was declared `string` while the endpoint's schema is `{ type: 'object' }`, so passing a
   * provider name rejected with a 400 pointing at a field the caller believed they had set
   * correctly. Open-ended because the schema is `additionalProperties: true`.
   */
  signingProvider?: Record<string, unknown>;
  idempotencyKey?: string;
  // No `webhookUrl`: POST /v1/identity does not accept one. Fastify strips unknown properties, so passing
  // it was a silent no-op. Set it with `identity.update()`, which does accept it.
}

/**
 * RESPONSE TYPES ARE snake_case, BECAUSE THE API IS.
 *
 * These interfaces used to be camelCase while the resources did `return data` with no
 * transformation, so every declared response field was `undefined` at runtime. The mismatch was
 * invisible: TypeScript reported `intentId: string`, the value was `undefined`, and the failure
 * surfaced somewhere else entirely as a missing id. `execute.ts` was written against the real
 * shape and reads snake_case directly, which is why the one flow that had been exercised
 * end-to-end worked while the typed resources did not.
 *
 * Verified against the live OpenAPI spec and real responses on 2026-07-31. Request parameter
 * types stay camelCase — those are this SDK's own surface, and the resources map them to
 * snake_case on the way out.
 */
export interface ChainAccount {
  chain_id: string;
  address: string;
  status: string;
}

export interface Identity {
  id: string;
  adi_url: string;
  book_url: string | null;
  key_page_url: string | null;
  status: string;
  /**
   * Is this identity's key actually on its on-chain key page?
   *
   * `null` means the key page could not be read — **unknown, not usable**. Never treat null as a
   * soft yes; an Accumulate outage is exactly when a caller most needs to be told "I don't know".
   *
   * Before 0.5.0 the gateway derived this from a database column (whether a `public_key` had been
   * supplied), so it read `true` from the moment the identity row existed — including for an
   * identity whose provisioning had failed halfway and whose on-chain key page was held by the
   * CERTEN sponsor key rather than the customer's. It reported the reassuring answer on the one
   * failure where the distinction matters. It now reflects the chain.
   */
  can_sign?: boolean | null;
  error_message?: string | null;
  credit_balance: number;
  chain_accounts: ChainAccount[];
  created_at: string;
}

export interface IdentityResponse {
  identity: Identity;
  signing_mode?: string;
  signing_provider?: unknown;
  /** Only on create, and only once — the URL stops working after it is read. */
  mnemonic_retrieval?: { url: string; expires_in: number };
  warning?: string;
  /**
   * Free-form: the gateway serializes this subtree with mixed casing (`key_books` holds
   * `keyBookUrl`, `keyPages`, `signers[].keyAddress`) and `publicKeyHash` arrives as a
   * JSON-serialized Node Buffer. Typing it precisely would encode a shape that is itself a bug.
   */
  governance?: {
    authorities: number;
    total_signers: number;
    key_books: unknown[];
  };
  balances?: {
    chain_id: string;
    address: string;
    token: string;
    balance: string;
  }[];
  pending?: {
    total: number;
    urgent: number;
    governance: number;
    transactions: number;
  };
}

export interface DeleteIdentityResponse {
  deleted: boolean;
  id: string;
  adi_url: string;
  note?: string;
}

export interface UpdateIdentityParams {
  linkChains?: string[];
  unlinkChains?: string[];
  webhookUrl?: string;
  /** Repairs an identity created with only a `publicKeyHash`. The hash must match. */
  publicKey?: string;
}

/** @deprecated There is no identity list endpoint — `GET /v1/identities` does not exist. */
export interface ListIdentitiesParams {
  limit?: number;
  offset?: number;
}

// ---- Transaction ----

/**
 * A transaction intent. Two accepted shapes:
 *
 *  - a single native transfer: `{ fromChain, toChain, amount, fromAddress, toAddress, tokenSymbol }`
 *  - multi-leg / contract call: `{ adiUrl, legs: [...] }`, with `contractCall` on a leg for an arbitrary
 *    authorized function call
 *
 * Left open (`[k: string]: unknown`) deliberately: the gateway's own schema is `additionalProperties: true`
 * here, and a narrower type in the SDK than on the server would reject payloads the API accepts.
 */
/**
 * How the proof cycle is scheduled. It changes WHEN the proof is produced, never what it proves.
 *
 * - `on_demand` (default) — starts immediately, completes in roughly 60–110 seconds. Use it for
 *   anything a user or counterparty is waiting on.
 * - `on_cadence` — batched with other proofs by the validators. Cheaper per proof, higher latency.
 *   Use it for bulk settlement where nobody is watching the clock.
 *
 * A union rather than `string` because the two values are the whole vocabulary, and a typo previously
 * passed the gateway's validation and failed downstream in the proof service, far from its cause.
 */
export type ProofClass = 'on_demand' | 'on_cadence';

export interface TransactionIntent {
  [k: string]: unknown;
}

/**
 * Per-deployment CERTEN contract addresses, keyed by role.
 *
 * Open-ended because the gateway's schema is `additionalProperties: true` — a narrower type here
 * than on the server would reject payloads the API accepts.
 */
export interface ContractAddresses {
  anchor?: string;
  anchorV2?: string;
  abstractAccount?: string;
  entryPoint?: string;
  factory?: string;
  [k: string]: unknown;
}

export interface ContractCall {
  target: string;
  functionSignature: string;
  /** Native wei forwarded with the call. Default "0". A string, because wei past 2^53 loses precision. */
  value?: string;
  args?: unknown[];
  /** Events the call MUST emit for validators to attest success — proof of effect, not just non-revert. */
  expectedEvents?: Array<{ contract: string; topic0: string; dataHash?: string }>;
}

export interface TransactionLeg {
  legId?: string;
  chain?: string;
  chainId?: number;
  fromAddress?: string;
  toAddress?: string;
  amount?: string;
  contractCall?: ContractCall;
  [k: string]: unknown;
}

export interface CreateTransactionParams {
  identityId: string;
  /** REQUIRED by the API. */
  intent: TransactionIntent;
  /**
   * Per-deployment contract addresses. An OBJECT keyed by role, not a list.
   *
   * This was declared as `string[]`, and `execute.contractCall` sent `[target]`. The endpoint
   * requires an object and rejects an array outright — `/contract_addresses must be object` — so
   * every call carrying it failed with a 400 that named a field the caller never set by hand.
   * The gateway applies sensible defaults when it is omitted, which is why omitting it works and
   * is the right default.
   *
   * Only set this to point at a non-standard deployment of the CERTEN contracts.
   */
  contractAddresses?: ContractAddresses;
  proofClass?: ProofClass;
  /** Which key PAGE signs, e.g. `acc://org.acme/book/2`. Must be in the same book. */
  signerKeyPage?: string;
  /** Which SEAT on the page signs, 64 hex. Defaults to the identity's bound key. */
  signerPublicKey?: string;
  idempotencyKey?: string;
}

/** @deprecated The flat shape this described was never accepted by POST /v1/transaction. Use `intent`. */
export interface LegacyFlatTransactionParams {
  identityId: string;
  type: string;
  to: string;
  amount: string;
  token?: string;
  chain?: string;
  memo?: string;
  idempotencyKey?: string;
}

/**
 * Signing data from `POST /v1/transaction` — a NEW intent.
 *
 * Distinct from `SignRequestSigningData` below, which is what `POST /v1/sign` returns for an
 * EXISTING transaction. They carry the bytes to sign under different names, and a single
 * `SigningData` type covering both is what let the wrong field name go unnoticed. Read
 * `hash_to_sign` here and `data_for_signature` there, or use `execute.*`, which handles it.
 */
export interface IntentSigningData {
  request_id?: string;
  transaction_hash?: string;
  /** Sign the RAW BYTES of this hex. Do not hash it again; do not sign its ASCII. */
  hash_to_sign: string;
}

/** Signing data from `POST /v1/sign` — co-signing something that already exists. */
export interface SignRequestSigningData {
  /** Same contract as `hash_to_sign`, different name. See `IntentSigningData`. */
  data_for_signature: string;
  transaction_hash?: string;
  signer_url?: string;
  signer_version?: number;
  timestamp?: number;
}

/** Response to `POST /v1/transaction` — the intent was opened, not executed. */
export interface CreateTransactionResponse {
  intent_id: string;
  status: string;
  /** `external` (you hold the key) or `provider` (the gateway signs). */
  signing_mode?: 'external' | 'provider';
  /** Absent in provider mode — there is nothing for you to sign. */
  signing_data?: IntentSigningData;
  submit_url?: string;
  tx_hash?: string;
  proof_id?: string;
  /** True when this is an idempotent replay echoing the original intent. */
  idempotent?: boolean;
}

/** Response to `GET /v1/transaction/{id}`. */
export interface TransactionResponse {
  intent_id: string;
  identity_id: string;
  status: string;
  intent_type?: string;
  accum_tx_hash?: string;
  proof_id?: string;
  proof_bundle_url?: string;
  error_message?: string | null;
  created_at: string;
  updated_at?: string;
  completed_at?: string;
  proof?: {
    id: string;
    bundle_url?: string;
    layers?: unknown;
    governance?: unknown;
    attestations?: unknown;
  };
}

export interface ListTransactionsResponse {
  transactions: TransactionResponse[];
  limit: number;
  offset: number;
}

/** Response to `POST /v1/transaction/{id}/signature`. */
export interface SubmitSignatureResponse {
  intent_id: string;
  status: string;
  tx_hash?: string;
}

export interface SubmitSignatureParams {
  signature: string;
  publicKey: string;
}

export interface ListTransactionsParams {
  limit?: number;
  offset?: number;
}

// ---- Governance ----

/**
 * Governance against an identity's key page, its account authorities, or its key book.
 *
 * `operations` is an array so several changes are authorized together — removing a compromised seat and
 * adding its replacement is one quorum, not two. Three KINDS exist and cannot be mixed in one request:
 * key-page (`add_key`, `remove_key`, `set_threshold`, `add_delegate`, `remove_delegate`), authority
 * (`add_authority`, `remove_authority`), and `create_key_page`.
 */
export interface GovernanceParams {
  /** The ADI, e.g. `acc://panel.acme` — NOT a uuid. */
  identity: string;
  operations: Array<Record<string, unknown>>;
  keyPageUrl?: string;
  signerKeyPage?: string;
  signerPublicKey?: string;
}

/** Response to `POST /v1/governance` — the operation was opened, not executed. */
export interface CreateGovernanceResponse {
  governance_op_id: string;
  status: string;
  tx_hash?: string;
  signing_mode?: 'external' | 'provider';
  signing_data?: IntentSigningData;
  submit_url?: string;
}

/** Response to `GET /v1/governance/{id}`. */
export interface GovernanceResponse {
  governance_op_id: string;
  identity_id: string;
  operation_type: string;
  status: string;
  request_payload?: unknown;
  signing_data?: IntentSigningData;
  accum_tx_hash?: string;
  created_at: string;
  completed_at?: string;
}

/** Response to `POST /v1/governance/{id}/signature`. */
export interface SubmitGovernanceSignatureResponse {
  governance_op_id: string;
  status: string;
  tx_hash?: string;
}

export interface SubmitGovernanceSignatureParams {
  signature: string;
  publicKey: string;
}

// ---- Pending Actions ----

export interface PendingAction {
  id: string;
  identity_id: string | null;
  identity_url?: string | null;
  category: string;
  type: string;
  status: string;
  tx_hash: string;
  tx_id: string | null;
  principal: string | null;
  transaction_type: string | null;
  collected_signatures: number;
  total_authorities: number;
  required_signatures?: number;
  approved_authorities: number;
  /** Whether the caller's own key has already signed — the field most inboxes filter on. */
  user_has_signed?: boolean;
  awaiting_authorities?: unknown;
  is_ready?: boolean;
  chain_status?: unknown;
  expires_at: string | null;
  discovered_at: string;
  created_at?: string;
}

export interface PendingActionsResponse {
  actions: PendingAction[];
  stats?: {
    total: number;
    urgent: number;
    governance: number;
    transactions: number;
    awaiting_others: number;
  };
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface ListPendingParams {
  identity?: string;
  status?: string;
  category?: string;
  limit?: number;
  offset?: number;
}

// ---- Sign ----

export interface SignRequestParams {
  type: 'pending_action' | 'transaction';
  targetId: string;
  identity?: string;
  signerUrl?: string;
  vote?: string;
  signature?: string;
  publicKey?: string;
}

/** Response to `POST /v1/sign`. */
export interface SignResponse {
  sign_request_id: string;
  status: string;
  tx_hash?: string;
  signature_count?: number;
  signing_mode?: 'external' | 'provider';
  signing_data?: SignRequestSigningData;
  submit_url?: string;
  expires_at?: string;
}

/**
 * Response to `POST /v1/sign/{id}/signature`.
 *
 * A spent `sign_request_id` 404s rather than replaying, so a failed submit must be retried by
 * requesting fresh signing data — never by resubmitting the same id.
 */
export interface SubmitSignSignatureResponse {
  status: string;
  tx_hash?: string;
  signature_count?: number;
}

export interface SubmitSignSignatureParams {
  signature: string;
  publicKey: string;
}

// ---- Portfolio ----

export interface ChainBalance {
  chain_id: string;
  address: string;
  deployed: boolean;
  balances: { token: string; balance: string }[];
}

export interface PortfolioIdentity {
  adi_url: string;
  status: string;
  credit_balance: number;
  chains: ChainBalance[];
  pending_actions: number;
}

export interface PortfolioResponse {
  identities: PortfolioIdentity[];
  total_chains: number;
}

// ---- Admin ----

export interface CreateOrgParams {
  name: string;
  plan?: string;
  webhookUrl?: string;
}

export interface OrgResponse {
  organization: {
    id: string;
    name: string;
    plan: string;
    created_at: string;
  };
}

export interface CreateApiKeyParams {
  name: string;
  orgId: string;
  permissions?: string[];
  rateLimitRpm?: number;
  expiresAt?: string;
}

export interface ApiKeyResponse {
  api_key: {
    id: string;
    /** The only time the secret is ever returned. It cannot be retrieved again. */
    key: string;
    name: string;
    prefix: string;
    rate_limit_rpm: number;
    permissions?: string[];
    created_at: string;
  };
  warning: string;
}

export interface ApiKeyListItem {
  id: string;
  name: string;
  prefix: string;
  org_id: string;
  permissions: string[];
  rate_limit_rpm: number;
  is_active: boolean;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

export interface AuditLogEntry {
  id: number;
  org_id: string;
  api_key_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  request_summary: Record<string, unknown> | null;
  response_status: number | null;
  created_at: string;
}

export interface AuditLogResponse {
  entries: AuditLogEntry[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface UsageSummaryResponse {
  period: {
    from: string;
    to: string;
  };
  total_requests: number;
  successful_requests: number;
  by_endpoint: { endpoint: string; count: number }[];
  daily: { date: string; count: number }[];
}

// ── Billing ────────────────────────────────────────────────────────────────
//
// Every amount is a fixed-6dp decimal STRING ("12.340000"), never a number.
// Parsing money into a float loses cents at scale; compare and display the
// string, or convert to an integer number of micro-dollars.

export interface BalanceResponse {
  currency: string;
  available_usd: string;
  held_usd: string;
  /** The credit line IN FORCE. Zero once an expiring grant has lapsed. */
  credit_limit_usd: string;
  /** available + credit line. NOT what may be committed — see ObligationsResponse. */
  spendable_usd: string;
  status: 'active' | 'suspended' | 'closed';
  /** Why service stopped. Without it `status: suspended` is unactionable. */
  suspended_reason?: string | null;
  /**
   * The credit line, and the points at which it changes what you can do.
   *
   * `suspends_at_usd` is the one an autonomous caller needs: it is the drawdown
   * at which work stops being accepted. Publishing it is what makes it possible
   * to top up BEFORE being cut off rather than after.
   */
  credit?: {
    kind: 'none' | 'trial' | 'comp' | 'terms';
    label: string | null;
    /** The limit as granted, before expiry. Differs from credit_limit_usd only for a lapsed grant. */
    granted_limit_usd: string;
    expires_at: string | null;
    expired: boolean;
    warns_at_usd: string;
    suspends_at_usd: string;
  };
}

/** A price, fixed at a moment, from published inputs. Free to ask for. */
export interface QuoteResponse {
  id: string;
  sku: string;
  chain: string;
  chains?: string[] | null;
  leg_count: number;
  proof_class: 'on_demand' | 'on_cadence' | null;
  platform_fee_usd: string;
  gas_usd: string;
  total_usd: string;
  /** Ceiling CERTEN promises. Gas over this is absorbed, not passed on. */
  max_total_usd: string;
  expires_at: string;
  computation?: {
    /**
     * Which cost history priced the gas.
     *
     * `class_thin` means the proof class has its own history but too little of
     * it for the median to be stable — the price is indicative rather than firm.
     */
    gas_estimate_basis?: 'class_specific' | 'class_thin' | 'unclassified_fallback';
    [k: string]: unknown;
  };
}

export interface Obligation {
  intent_id: string;
  status: string;
  chain: string;
  estimated_usd: string;
  covered_by_hold: boolean;
  created_at: string;
}

export interface ObligationsResponse {
  pending_intents: number;
  estimated_total_usd: string;
  /** The part of the pending cost with no hold behind it yet. */
  uncovered_usd: string;
  spendable_usd: string;
  /** Spendable minus uncovered commitments. The number to gate new work on. */
  remaining_usd: string;
  shortfall_usd: string;
  enforcing: boolean;
  obligations: Obligation[];
}

export interface DepositIntent {
  reference: string;
  amount_usd: string;
  expires_at: string;
}

export interface DepositTarget {
  chain: string;
  chain_id: number;
  token_symbol: string;
  token_address: string;
  token_decimals: number;
  deposit_address: string;
  min_confirmations: number;
  /** Null when no amount was supplied — nothing was opened. */
  deposit_intent: DepositIntent | null;
  note: string;
}

export interface DepositIntentStatus {
  reference: string;
  status: 'open' | 'matched' | 'expired' | 'cancelled';
  amount_usd: string;
  expires_at: string;
  matched_at: string | null;
  payment_id: string | null;
}
