/**
 * The Base Sepolia l1_posted verifier (V2_SPEC_S7 section 5.4; the TypeScript twin of the validator's pkg/finality/baseposted): body codec,
 * OP blob and frame decoding, channel assembly, singular and span batches, KZG blob authentication, batcher authentication through
 * SystemConfig state proofs, and the kind. Go and TypeScript return the same canonical verdict on every vector of finality_base_posted1.
 */
export * from './wire.js';
export * from './blob.js';
export * from './channel.js';
export * from './pins.js';
export * from './trie.js';
export * from './verify.js';
