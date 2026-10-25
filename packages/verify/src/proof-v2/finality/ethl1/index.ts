/**
 * The Ethereum L1 finalized-head verifier (V2_SPEC_S7 section 5.2; the TypeScript twin of the validator's pkg/finality/ethl1): strict SSZ
 * for both light-client layouts (Gloas fixed-size, Electra/Fulu offset-based), the LC container codec, the sync-committee BLS check on
 * @noble/curves, verifyFinalizedHead and covers. It is pure: no I/O, no clock, no randomness; it trusts only its Pins argument and
 * standard cryptography. Go and TypeScript return the same canonical state on every shared conformance vector
 * (test/fixtures/finality/ethl1_v2); a difference is stop-the-line.
 */
export * from './types.js';
export * from './fault.js';
export * from './ssz.js';
export * from './electra.js';
export * from './lccodec.js';
export * from './bls.js';
export * from './verify.js';
export * from './covers.js';
export * from './api.js';
