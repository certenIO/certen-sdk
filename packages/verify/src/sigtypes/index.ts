/**
 * Verification of every key-signature type Accumulate's executor accepts on a key page (RB8, gap G-42): ed25519, legacyED25519,
 * rcd1, btc, btclegacy, eth, rsaSha256, ecdsaSha256 and typedData, directly or as the innermost signature of a delegation chain.
 * See verify.ts for the rule and the shared conformance vectors that pin it against the validator's Go implementation.
 */
export {
  ACCEPTED_KEY_TYPES,
  DELEGATION_DEPTH_LIMIT,
  DelegationDepthExceeded,
  EvidenceInconsistent,
  ExecutorGateNotMet,
  ExecutorVersionUnproven,
  Form,
  NetworkNameUnproven,
  NotKeySignature,
  SigtypeError,
  SignatureInvalid,
  TransactionUnavailableForTypedData,
  TypedDataChainIdMismatch,
  decodeSignature,
  decodeTransaction,
  ethHash,
  initiatorHash,
  metadataHash,
  publicKeyHash,
  typeRule,
  unwrap,
  verdictOf,
  verifyKeySignature,
  verifySignatureBytes,
} from './verify.js';
export type { FormName, Unwrapped, Verified, VerifyEnv } from './verify.js';
export { EthRule, ExecutorVersion, KERMIT_ACTIVATIONS, checkExecutorGate, ethChainId, executorFloor, normalizePartition, requiredVersion } from './gate.js';
export type { Activation, EthRuleName, Where } from './gate.js';
export { eip712Hash } from './eip712.js';
export { transactionHash } from './txhash.js';
export { WireError, decodeObject, decodeUnion, encodeNode } from './wire.js';
export type { WireNode } from './wire.js';
