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

/**
 * What the identity endpoints return: the identity's own fields, plus the joined sub-resources.
 *
 * `extends Identity` rather than `{ identity: Identity }`. The gateway used to nest the identity
 * under an `identity` key on create, read and update, which made those the odd ones out —
 * `GET /v1/transaction/{id}` returns its fields bare and nests only the joined `proof`, and most of
 * the surface does the same. Two shapes for one idea meant a caller had to memorise which reads
 * were wrapped and which were bare, with no rule available to learn.
 *
 * Flattened in the gateway's 2026-08 break, taken while there were no external integrators — the
 * only moment it is cheap. `governance`, `balances` and `pending` stay nested, because that IS the
 * convention: a response carries its own fields bare and names anything joined onto it.
 *
 * **Migrating:** `result.identity.id` becomes `result.id`. If you need the identity alone, it is
 * structurally the same object — `const identity: Identity = result`.
 */
export interface IdentityResponse extends Identity {
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
  submit_url?: string | null;
  /**
   * Null on an idempotent replay of an intent that has not been submitted yet — the echo carries
   * the stored row, and these columns are null until the transaction reaches Accumulate.
   */
  tx_hash?: string | null;
  proof_id?: string | null;
  /** True when this is an idempotent replay echoing the original intent. */
  idempotent?: boolean;
}

/**
 * Response to `GET /v1/transaction/{id}`.
 *
 * The `| null` on several fields is not defensive typing. The gateway declared them
 * `type: 'string'` in its response schema, and fast-json-stringify coerces a null to `""` rather
 * than rejecting it — so a transaction with no proof reported `proof_id: ""`, on all 205 intents in
 * the production table. The gateway now declares those fields nullable and returns a real null, and
 * these types say so. A caller writing `tx.proof_id != null` gets the right answer on both, which
 * was not true of `""`.
 */
export interface TransactionResponse {
  intent_id: string;
  identity_id: string;
  status: string;
  intent_type?: string;
  /** Null until the intent has been submitted to Accumulate. */
  accum_tx_hash?: string | null;
  /** Null until the proof cycle completes. Absent is the same as null here. */
  proof_id?: string | null;
  proof_bundle_url?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at?: string;
  /** Null while the transaction is still in flight — the gateway has always sent a real null here. */
  completed_at?: string | null;
  proof?: {
    id: string;
    bundle_url?: string | null;
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
  /**
   * The UUID the other identity routes take.
   *
   * Added in the gateway's 2026-08 release. There is no identity collection endpoint, so
   * `portfolio.get()` is the only way to enumerate an org's identities — and without the id it
   * could not answer the question people actually reach for it with, since the UUID is shown once
   * at create time and every other route is keyed by it. Absent when talking to an older gateway.
   */
  id?: string;
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

/**
 * The organization's own fields, at the top level.
 *
 * Nested under `organization` until the gateway's 2026-08 break — one of four operations that
 * wrapped their resource while the rest of the surface returned it bare. See the note on
 * `IdentityResponse`.
 */
export interface OrgResponse {
  id: string;
  name: string;
  plan: string;
  created_at: string;
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

/** One priced operation, on one chain. */
export interface PricingItem {
  /** e.g. `identity.provision`, `account.deploy`, `proof.execute`. */
  sku: string;
  /** The chain it applies to. `"*"` is the fallback for any chain without its own entry. */
  chain: string;
  /**
   * `flat` — `platform_fee_usd` is the whole price.
   * `quoted` — gas is measured at execution and added, so the total depends on chain conditions.
   */
  mode: 'flat' | 'quoted';
  platform_fee_usd: string;
  gas_buffer_bps: number;
  min_charge_usd: string;
  /** null when uncapped. */
  max_charge_usd: string | null;
}

/**
 * Everything CERTEN charges for, and what it costs.
 *
 * Added in the gateway's 2026-08 release. Before it, prices could only be discovered one at a time
 * through `quote()`, against sku names that are not guessable — it is `identity.provision`, not
 * `identity.create` — so finding one meant guessing and reading the refusal.
 *
 * `price_book_version` and `price_book_hash` are the same values quotes and receipts carry, so a
 * price seen here can be traced through to the charge.
 */
export interface PricingCatalog {
  price_book_version: string;
  price_book_hash: string;
  currency: string;
  items: PricingItem[];
}

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
  /**
   * The id to pass back as `quote_id` to lock this price.
   *
   * The wire field is `quote_id`, not `id`. This type declared `id`, so every read of it was
   * `undefined` — `certen quote` printed an empty id and then advised passing it, which is the one
   * thing a quote exists to enable. `id` is kept as an optional alias so any caller that already
   * reads it keeps compiling, but `quote_id` is the field the gateway actually sends.
   */
  quote_id: string;
  /** @deprecated The gateway sends `quote_id`. Always undefined in practice. */
  id?: string;
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

/**
 * A payment the gateway has seen and, usually, credited.
 *
 * `attribution` says HOW it was credited: `registered_address` means the sending wallet is a
 * known payer for the organization, and the payment never needed a deposit intent at all.
 */
export interface PaymentRecord {
  id?: string;
  rail?: string;
  status?: string;
  amount_usd?: string;
  chain?: string;
  token_symbol?: string;
  from_address?: string;
  tx_hash?: string;
  confirmations?: number;
  attribution?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface DepositIntentStatus {
  reference: string;
  status: 'open' | 'matched' | 'expired' | 'cancelled';
  amount_usd: string;
  expires_at: string;
  matched_at: string | null;
  payment_id: string | null;
}

// ---- Chains (public contract registry) ----

/**
 * One deployed contract.
 *
 * `verified` means the address was confirmed to carry bytecode via `eth_getCode`. Non-EVM entries
 * are transcribed from validator configuration and are never independently verified — so `false`
 * there means "not checkable this way", not "suspect".
 */
export interface ContractEntry {
  address: string;
  verified?: boolean;
  /** Only present for EVM families; other explorers differ enough that a guessed path would 404. */
  explorer_url?: string;
  [key: string]: unknown;
}

/**
 * A network in the registry.
 *
 * The casing is mixed on the wire and that is not a mistake here: the gateway serialises its
 * static registry (`chainId`, `displayName`) and adds its own fields (`explorer_url`) around it.
 * Renaming either side in this type would describe a response the gateway does not send.
 */
export interface ChainEntry {
  id: string;
  chainId: number | null;
  family: string;
  displayName: string;
  environment: string;
  explorer: string;
  status: string;
  contracts: Record<string, ContractEntry>;
  [key: string]: unknown;
}

export interface ChainsListResponse {
  version: string;
  last_updated: string;
  accumulate: { network: string; environment: string; api: string; explorer: string };
  count: number;
  chains: ChainEntry[];
}

export interface ChainDetailResponse {
  chain: ChainEntry;
}

// ---- Proofs ----

/**
 * A proof artifact.
 *
 * Deliberately open: the shape is defined by the proof-service and the gateway documents it as
 * `additionalProperties: true`. Pinning fields here would encode one version of a downstream
 * contract this SDK does not own, and would start lying the first time it changed.
 */
export interface ProofArtifact {
  [key: string]: unknown;
}

export interface ProofCustody {
  [key: string]: unknown;
}

/**
 * An Accumulate merkle inclusion receipt, read live from the network.
 *
 * `anchored` is the field that matters: a transaction can be `delivered` and not yet anchored, and
 * only an anchored transaction has an inclusion proof a counterparty can check against a block
 * root they obtained themselves.
 */
export interface ChainReceipt {
  tx_hash: string;
  status: string;
  principal?: string | null;
  tx_type?: string | null;
  anchored: boolean;
  chain_index?: number | null;
  block_time?: string | null;
  found?: boolean;
  receipt?: {
    start?: string;
    end?: string;
    anchor?: string;
    entries?: unknown[];
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface ProofShare {
  id?: string;
  proof_id?: string;
  /** Returned once, at creation. Later reads expose only `token_prefix`. */
  token?: string;
  token_prefix?: string;
  url?: string;
  label?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
  view_count?: number;
  last_viewed_at?: string | null;
  [key: string]: unknown;
}

export interface ProofSharesResponse {
  shares: ProofShare[];
  [key: string]: unknown;
}

// ---- Device authorization (RFC 8628) ----

export interface DeviceAuthorization {
  /** Returned ONCE. The gateway stores only its HMAC. Possession of it is the authorization. */
  device_code: string;
  /** The short code a human reads off the terminal and types into the portal. */
  user_code: string;
  verification_uri: string;
  /** Prefills the portal field. Following it does NOT approve — approval is always a click. */
  verification_uri_complete?: string;
  expires_in: number;
  /** Seconds. Poll no faster than this. */
  interval: number;
}

export interface DeviceAuthorizationStatus {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'claimed';
  /** Present ONLY in the first response after approval, and never again. */
  api_key?: string;
  key_prefix?: string;
  key_id?: string;
  org_id?: string;
  permissions?: string[];
  interval?: number;
  note?: string;
  warning?: string;
}
