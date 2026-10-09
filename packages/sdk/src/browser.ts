/**
 * The browser-safe surface of the SDK: the client, its resources, the typed errors, the status table, the chain catalogue and every
 * pure helper. Nothing reachable from here uses a Node built-in or a bare Node global (packages/sdk/test/browser-entry.test.ts
 * bundles it for a browser and runs it with `process`, `Buffer` and `require` removed).
 *
 * `package.json` points the `browser` export condition here, and `@certen.io/sdk/browser` names it explicitly. The default entry
 * (index.ts) is this plus the two modules that need Node: `CertenAgent` / `ed25519Signer` (local key handling with node:crypto) and
 * `fetchSharedProof` / `decodeSharedBundle` (gunzip with node:zlib).
 */
export { CertenClient, paginate, paginateWithTotal, DEFAULT_BASE_URL } from './client.js';
export * from './types.js';
export type { SignFn, ProofGatedCallParams, TransferParams, OpenedIntent, WaitUntil, IntentStateEvent } from './resources/execute.js';
export {
  CertenError,
  CertenAuthError,
  CertenRateLimitError,
  CertenBadRequestError,
  CertenServerError,
  CertenPaymentRequiredError,
  CertenHeaderAuthorityNotExecutableError,
  CertenIntentFailedError,
  CertenWaitTimeoutError,
  CertenProofNotAvailableError,
  CertenForeignOriginError,
  HEADER_AUTHORITY_NOT_EXECUTABLE,
} from './errors.js';
// Transaction-header fields (additional authorities, deadline): the validators the SDK runs before
// sending, exported so the CLI and MCP apply the identical rules. See header-fields.ts.
export {
  normalizeAdditionalAuthorities, normalizeExpiresAt, parseDuration, expiresIn, MAX_ADDITIONAL_AUTHORITIES,
  MAX_AUTHORITY_URL_LENGTH, GATEWAY_EXPIRY_MIN_S, GATEWAY_EXPIRY_MAX_S, LOCAL_EXPIRY_MIN_S, HEADER_FIELD_ERROR_CODES,
} from './header-fields.js';
// Where an intent can be and what each status means: the one table wait(), the CLI and the MCP server share. See intent-states.ts.
export {
  INTENT_STATUS_CLASS, classifyIntentStatus, isTerminalIntentStatus, intentOutcome, EXECUTION_PROOF_UNAVAILABLE,
} from './intent-states.js';
export type { IntentStatusClass, KnownIntentStatus, IntentOutcome, IntentOutcomeName } from './intent-states.js';
export { describeReasonCode, isTransactionReasonCode, REASON_CODE_DESCRIPTIONS } from './reason-codes.js';
export type { PaymentResolution } from './errors.js';
export { runDoctor, CREDENTIALLED_CHECKS } from './doctor.js';
// Splitting a share link into token and gateway is pure string work; fetching and decoding one (which gunzips) is Node-only. See
// share-target.ts and shared-proof.ts.
export { parseShareTarget } from './share-target.js';
// execution-proof.ts: verify a bundle's component 5 (the receipt and its trie proof) with no
// dependencies and no gateway — what a counterparty runs.
export {
  verifyExecutionProof, checkAgainstHeader, executionComponentOf, decodeReceipt, verifyTrieProof,
  keccak256, rlpDecode, rlpEncodeUint, bytesFrom,
} from './execution-proof.js';
export type { ExecutionProofComponent, ExecutionVerification, DecodedReceipt, DecodedLog } from './execution-proof.js';
// Standalone for the same reason: these carry their credential in the body and need no API key,
// so a caller using OAuth is not made to hold one. See oauth.ts.
export { fetchOAuthToken, refreshOAuthToken, revokeOAuthToken } from './oauth.js';
// Exported so a caller can split `mnemonic_retrieval.url` the same way the SDK does, rather than
// writing their own regex against a string whose parts they cannot afford to get wrong.
export { parseMnemonicTarget } from './resources/identity.js';
// Standalone for the same reason as the OAuth helpers: the caller has no credential yet, and
// obtaining its first one is the entire purpose. See registration.ts.
export { redeemRegistrationToken } from './registration.js';
// Keypair-proof self-service signup — no browser, no email, nobody at CERTEN. Standalone for the
// same reason: the caller holds nothing yet. See self-signup.ts.
export { selfSignup, requestSignupChallenge, completeSignup } from './self-signup.js';
export { CertenUnfundedAccountError, CertenFundingUnverifiableError, movesValue, normalizeChainId } from './funding.js';
export type { FundingUnverifiableReason } from './funding.js';
// The chain catalogue: the single source the CLI and MCP derive every chain table from. See chains.ts.
export {
  CHAIN_CATALOGUE, chainInfo, chainSlug, nativeSymbolFor, faucetForChain, defaultEnabledChains, enablableChains,
  parseEnabledChains, ChainConfigurationError, gatewayServes, chainAvailability, resolveEnabledChains,
  readNativeBalance, describeUnverifiable,
} from './chains.js';
export type {
  ChainCatalogueEntry, ChainSupport, ServedChain, ChainAvailability, BalanceRow, NativeBalanceReading,
} from './chains.js';
// One resolver, shared by the CLI and MCP. Two copies of this would drift — see sign-target.ts.
export { resolveSignTarget } from './sign-target.js';

export type { SignTarget } from './sign-target.js';
export type { DoctorReport, DoctorCheck, CheckStatus } from './doctor.js';
