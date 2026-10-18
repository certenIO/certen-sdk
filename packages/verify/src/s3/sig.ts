/**
 * Decoding a carried transaction or signature, and the verification of a key signature as the evidence 2.1 verifier maps it onto named
 * states (validator xsigverify.go; xtimeline.go decodeTxn, decodeSig).
 */
import { VerifyError } from '../proof-v2/bytes.js';
import { decodeSignature, DelegationDepthExceeded, verifyKeySignature as govsigVerify, type Verified } from '../sigtypes/verify.js';
import { ExecutorVersionUnproven } from '../sigtypes/gate.js';
import { WireError, type WireNode } from '../sigtypes/wire.js';
import { goHex } from './gojson.js';
import { bodyOf, decodeTxn as decodeTxnBytes, principalOf, txnHash } from './model.js';
import { refusal21, State } from './states.js';
import type { ProvenAcct } from './xtypes.js';

/** decodeTxn: a transaction from hex, which must have a body and a principal. */
export function decodeTxnHex(h: string): WireNode {
  const raw = goHex(h);
  if (!raw || raw.length === 0) throw new VerifyError('a transaction is not hex');
  let txn: WireNode;
  try {
    txn = decodeTxnBytes(raw);
  } catch (e) {
    if (e instanceof WireError) throw new VerifyError(`a transaction does not decode: ${e.message}`);
    throw e;
  }
  if (!bodyOf(txn) || !principalOf(txn)) throw new VerifyError('a transaction has no body or principal');
  return txn;
}

/**
 * decodeSig: a signature from hex. The empty object decodes to no signature (null), as Accumulate's UnmarshalSignature returns a nil
 * Signature with no error; the Go callers go on to call methods on it and panic, so a document carrying one has no Go verdict.
 */
export function decodeSigHex(h: string): WireNode | null {
  const raw = goHex(h);
  if (!raw || raw.length === 0) throw new VerifyError('a signature is not hex');
  try {
    return decodeSignature(raw);
  } catch (e) {
    if (e instanceof WireError) throw new VerifyError(`a signature does not decode: ${e.message}`);
    throw e;
  }
}

/** A signature that decoded to nothing is not a signature the verifier can judge; Go panics on it, here it is a plain refusal. */
export function requireSig(sig: WireNode | null): WireNode {
  if (!sig) throw new VerifyError('a signature decodes to the empty object');
  return sig;
}

/**
 * verifyKeySignature (xsigverify.go): govsig.Verify over the carried transaction at (partition, block), an executor version that cannot
 * be proven is g1_executor_version_unproven, a delegation deeper than the limit is g1_delegation_depth_exceeded, anything else is a
 * signature that does not sign the transaction.
 */
export function verifyKeySignature(sig: WireNode, txn: WireNode, network: string, pa: ProvenAcct, page: string, block: number): Verified {
  try {
    return govsigVerify(sig, { txHash: txnHash(txn), transaction: txn, networkName: network, where: { partition: pa.anchor.id.toLowerCase(), block } });
  } catch (e) {
    if (e instanceof ExecutorVersionUnproven) throw refusal21(State.ExecutorVersionUnproven, pa.anchor.id, pa.anchor.block, `the signature on ${page}: ${e.message}`);
    if (e instanceof DelegationDepthExceeded) throw refusal21(State.DelegationDepthExceeded, pa.anchor.id, pa.anchor.block, `the signature on ${page}: ${e.message}`);
    throw refusal21(State.SignatureInvalid, pa.anchor.id, pa.anchor.block, `the signature on ${page}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
