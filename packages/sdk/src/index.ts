export { CertenClient, paginate, paginateWithTotal, DEFAULT_BASE_URL } from './client.js';
export * from './types.js';
export type { SignFn, ProofGatedCallParams, TransferParams, OpenedIntent } from './resources/execute.js';
export {
  CertenError,
  CertenAuthError,
  CertenRateLimitError,
  CertenBadRequestError,
  CertenServerError,
  CertenPaymentRequiredError,
} from './errors.js';
export type { PaymentResolution } from './errors.js';
export { runDoctor, CREDENTIALLED_CHECKS } from './doctor.js';
// Standalone on purpose: redeeming a share link needs no API key and therefore no client. See
// shared-proof.ts.
export { fetchSharedProof, parseShareTarget, decodeSharedBundle } from './shared-proof.js';
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
export { CertenUnfundedAccountError, movesValue, normalizeChainId } from './funding.js';
// One resolver, shared by the CLI and MCP. Two copies of this would drift — see sign-target.ts.
export { resolveSignTarget } from './sign-target.js';

// An autonomous agent's identity and every proof-gated verb it needs, composed once. See agent.ts.
export { CertenAgent, ed25519Signer } from './agent.js';
export type { AgentSigner, CertenAgentState, ProvisionParams } from './agent.js';
export type { SignTarget } from './sign-target.js';
export type { DoctorReport, DoctorCheck, CheckStatus } from './doctor.js';
