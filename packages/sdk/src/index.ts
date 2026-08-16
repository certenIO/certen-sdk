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
export { CertenUnfundedAccountError, movesValue, normalizeChainId } from './funding.js';
export type { DoctorReport, DoctorCheck, CheckStatus } from './doctor.js';
