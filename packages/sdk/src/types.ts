// ---- Client Options ----

export interface CertenClientOptions {
  apiKey: string;
  baseUrl?: string;
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
  signingProvider?: string;
  idempotencyKey?: string;
  // No `webhookUrl`: POST /v1/identity does not accept one. Fastify strips unknown properties, so passing
  // it was a silent no-op. Set it with `identity.update()`, which does accept it.
}

export interface ChainAccount {
  chainId: string;
  address: string;
  status: string;
}

export interface IdentityResponse {
  identity: {
    id: string;
    adiUrl: string;
    bookUrl: string | null;
    keyPageUrl: string | null;
    status: string;
    creditBalance: number;
    chainAccounts: ChainAccount[];
    createdAt: string;
  };
  governance?: {
    authorities: number;
    totalSigners: number;
    keyBooks: unknown[];
  };
  balances?: {
    chainId: string;
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
export interface TransactionIntent {
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
  contractAddresses?: string[];
  proofClass?: string;
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

export interface SigningData {
  dataToSign: string;
  signerUrl: string;
  signerVersion: number;
  timestamp: number;
}

export interface TransactionResponse {
  intentId: string;
  identityId: string;
  status: string;
  signingData?: SigningData;
  accumTxHash?: string;
  proofId?: string;
  proofBundleUrl?: string;
  createdAt: string;
  completedAt?: string;
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

export interface GovernanceResponse {
  governanceOpId: string;
  identityId: string;
  operationType: string;
  status: string;
  signingData?: SigningData;
  accumTxHash?: string;
  createdAt: string;
  completedAt?: string;
}

export interface SubmitGovernanceSignatureParams {
  signature: string;
  publicKey: string;
}

// ---- Pending Actions ----

export interface PendingAction {
  id: string;
  identityId: string | null;
  category: string;
  type: string;
  status: string;
  txHash: string;
  txId: string | null;
  principal: string | null;
  transactionType: string | null;
  collectedSignatures: number;
  totalAuthorities: number;
  approvedAuthorities: number;
  expiresAt: string | null;
  discoveredAt: string;
}

export interface PendingActionsResponse {
  actions: PendingAction[];
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

export interface SignResponse {
  signRequestId: string;
  status: string;
  signingData?: SigningData;
}

export interface SubmitSignSignatureParams {
  signature: string;
  publicKey: string;
}

// ---- Portfolio ----

export interface ChainBalance {
  chainId: string;
  address: string;
  deployed: boolean;
  balances: { token: string; balance: string }[];
}

export interface PortfolioIdentity {
  adiUrl: string;
  status: string;
  creditBalance: number;
  chains: ChainBalance[];
  pendingActions: number;
}

export interface PortfolioResponse {
  identities: PortfolioIdentity[];
  totalChains: number;
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
    createdAt: string;
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
  apiKey: {
    id: string;
    key: string;
    name: string;
    prefix: string;
    rateLimitRpm: number;
    createdAt: string;
  };
  warning: string;
}

export interface ApiKeyListItem {
  id: string;
  name: string;
  prefix: string;
  orgId: string;
  permissions: string[];
  rateLimitRpm: number;
  isActive: boolean;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface AuditLogEntry {
  id: number;
  orgId: string;
  apiKeyId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  requestSummary: Record<string, unknown> | null;
  responseStatus: number | null;
  createdAt: string;
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
  totalRequests: number;
  successfulRequests: number;
  byEndpoint: { endpoint: string; count: number }[];
  daily: { date: string; count: number }[];
}
