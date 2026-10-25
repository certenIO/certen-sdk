/**
 * The Base Sepolia finalized verifier (V2_SPEC_S7 section 5.5; the TypeScript twin of the validator's pkg/finality/basefinal): body codec,
 * the AggregateVerifier game (type 621) replayed through isGameClaimValid from L1 state proofs, the output root recomputed from an L2
 * header, the L2 spine down to the leg's block, and the kind. Go and TypeScript return the same canonical verdict on every vector of
 * finality_base_final1 (23 live cases and 73 judge-level cases).
 */
export * from './states.js';
export * from './pins.js';
export * from './wire.js';
export * from './verify.js';
