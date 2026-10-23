/**
 * The Ethereum Sepolia eth-sepolia/finalized/v1 verifier (V2_SPEC_S7 sections 3.3 and 5.3; the TypeScript twin of the validator's
 * pkg/finality/ethsepolia and pkg/finality/lcssz): the body codec, the kind over ethl1 (the light-client library) and the light-client
 * object locators. The rolling ledger (Pins.Extend, VerifyLedger) lives beside the pins (../ledger.ts). Go and TypeScript return the same
 * canonical verdict on every vector of finality_eth_sepolia1, 2 and 3.
 */
export * from './states.js';
export * from './kind.js';
export * as lcssz from './lcssz.js';
