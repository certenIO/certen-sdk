// The attestation call and the ZK blob (twin of abi.go DecodeComprehensiveProofCall, DecodeProofExecutedData, DecodeZKBlob): the strict decoder
// of abidec.ts applied to executeComprehensiveProof. Only the members the verifier reads are returned.
import { ABIError, decodeArgs, defaultABILimits, selector4, tAddr, tArr, tB32, tBytes, tString, tTup, tU, type ABILimits, type T } from './abidec.js';
import { bigOf } from './bytes.js';

export const SigExecuteComprehensiveProof = 'executeComprehensiveProof(bytes32,(bytes32,bytes32,bytes32[],bytes32,(string,bytes32,bytes32[],address,uint8,uint256,uint256,uint256,bool),(bytes,address[],uint256[],uint256,uint256,bool,bytes32),(bytes32,bytes32,bytes32,bytes32,string,uint256,bytes32,string,address),uint256,bytes))';
const tBool: T = { k: 'b' };
const certenProofType = (lim: ABILimits): T => tTup(
  ['transactionHash', tB32], ['merkleRoot', tB32], ['proofHashes', tArr(tB32)], ['leafHash', tB32],
  ['governanceProof', tTup(['keyBookURL', tString], ['keyBookRoot', tB32], ['keyPageProofs', tArr(tB32)], ['authorityAddress', tAddr], ['authorityLevel', tU(8)], ['nonce', tU(256)], ['requiredSignatures', tU(256)], ['providedSignatures', tU(256)], ['thresholdMet', tBool])],
  ['blsProof', tTup(['aggregateSignature', tBytes], ['validatorAddresses', tArr(tAddr, lim.maxValidators)], ['votingPowers', tArr(tU(256), lim.maxValidators)], ['totalVotingPower', tU(256)], ['signedVotingPower', tU(256)], ['thresholdMet', tBool], ['messageHash', tB32])],
  ['commitments', tTup(['operationCommitment', tB32], ['crossChainCommitment', tB32], ['governanceRoot', tB32], ['executionCommitment', tB32], ['sourceChain', tString], ['sourceBlockHeight', tU(256)], ['sourceTxHash', tB32], ['targetChain', tString], ['targetAddress', tAddr])],
  ['expirationTime', tU(256)], ['metadata', tBytes],
);
export interface ComprehensiveProofCall {
  anchorId: Uint8Array; operationCommitment: Uint8Array; validatorAddresses: Uint8Array[]; votingPowers: bigint[]; totalVotingPower: bigint; signedVotingPower: bigint;
  messageHash: Uint8Array; aggregateSignature: Uint8Array; authorityLevel: number;
}
/** DecodeComprehensiveProofCall: THROWS an ABIError for any slack in the encoding. */
export function decodeComprehensiveProofCall(calldata: Uint8Array, lim: ABILimits = defaultABILimits()): ComprehensiveProofCall {
  const want = selector4(SigExecuteComprehensiveProof);
  if (calldata.length < 4) throw new ABIError('truncated', 'selector', 0, 0n, 0n, `${calldata.length} bytes`);
  if (!want.every((b, i) => b === calldata[i])) throw new ABIError('selector', 'selector', 0, 0n, 0n, 'selector is not executeComprehensiveProof');
  const items = decodeArgs(calldata.slice(4), [['anchorId', tB32], ['proof', certenProofType(lim)]]);
  const p = items[1]!.items;
  const gov = p[4]!.items;
  const bls = p[5]!.items;
  const com = p[6]!.items;
  if (bls[1]!.items.length !== bls[2]!.items.length) throw new ABIError('shape', 'proof.blsProof.votingPowers', 0, BigInt(bls[2]!.items.length), BigInt(bls[1]!.items.length), 'validatorAddresses and votingPowers differ in length');
  return {
    anchorId: items[0]!.w, operationCommitment: com[0]!.w, validatorAddresses: bls[1]!.items.map((x) => x.w.slice(12)), votingPowers: bls[2]!.items.map((x) => bigOf(x.w)),
    totalVotingPower: bigOf(bls[3]!.w), signedVotingPower: bigOf(bls[4]!.w), messageHash: bls[6]!.w, aggregateSignature: bls[0]!.b, authorityLevel: gov[4]!.w[31]!,
  };
}
export const decodeProofExecutedData = (data: Uint8Array): void => {
  decodeArgs(data, [['transactionHash', tB32], ['merkleVerified', tBool], ['blsVerified', tBool], ['governanceVerified', tBool], ['timestamp', tU(256)]]);
};
export interface ZKBlob { messageHash: Uint8Array; pubkeyCommitment: Uint8Array; signedVotingPower: bigint; totalVotingPower: bigint }
export function decodeZKBlob(blob: Uint8Array): ZKBlob {
  if (blob.length < 18 * 32) throw new ABIError('truncated', 'aggregateSignature', 0, BigInt(blob.length), 576n, 'blob shorter than 18 words');
  const w = (i: number): Uint8Array => blob.slice(i * 32, (i + 1) * 32);
  return { messageHash: w(12), pubkeyCommitment: w(13), signedVotingPower: bigOf(w(14)), totalVotingPower: bigOf(w(15)) };
}
