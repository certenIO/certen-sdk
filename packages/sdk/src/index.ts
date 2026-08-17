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
export { fetchSharedProof, parseShareTarget } from './shared-proof.js';
// Standalone for the same reason: these carry their credential in the body and need no API key,
// so a caller using OAuth is not made to hold one. See oauth.ts.
export { fetchOAuthToken, refreshOAuthToken, revokeOAuthToken } from './oauth.js';
// Exported so a caller can split `mnemonic_retrieval.url` the same way the SDK does, rather than
// writing their own regex against a string whose parts they cannot afford to get wrong.
export { parseMnemonicTarget } from './resources/identity.js';
// Standalone for the same reason as the OAuth helpers: the caller has no credential yet, and
// obtaining its first one is the entire purpose. See registration.ts.
export { redeemRegistrationToken } from './registration.js';
export { CertenUnfundedAccountError, movesValue, normalizeChainId } from './funding.js';
export type { DoctorReport, DoctorCheck, CheckStatus } from './doctor.js';
