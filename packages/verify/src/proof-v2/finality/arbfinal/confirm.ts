/**
 * The confirmation-path classifier of arb-sepolia/finalized/v1 (V2_SPEC_S7 5.7 O4 with amendment r3; the twin of pkg/finality/arbfinal
 * confirm.go): the transaction at confTxIndex and its receipt are MPT-proven under K's transactionsRoot and receiptsRoot, the receipt status
 * is 1, it holds an AssertionConfirmed log of the Rollup for the assertion hash, and the path is honest only if the Rollup was called with
 * confirmAssertion (route direct) or a callee PROVEN to be a ValidatorWallet (proveWallet, at K) was called through an entry point that
 * carries a call to the Rollup with confirmAssertion, with no AssertionForceConfirmed log and anyTrustFastConfirmer zero at K (route wallet).
 * Everything else is a named state, never a weaker level.
 *
 * Documented residuals (the Go review V-RB12-E1RAISE W17, W18, W19 and N5 and pkg/finality/arbfinal/testdata/finality_arb_final3/README.md; no check
 * exists in either verifier, so this is the same residual in both): [W17] the inner confirmAssertion arguments are not bound to the assertion
 * hash; [W18] the other calls of the batch and the gas-refunder callback are not constrained; [W19] the wallet identity is judged at the end of
 * block K, so a same-block swap and restore at K is invisible (as it is for the Rollup logic code). [N5] For the wallet route "not fast/force"
 * therefore rests on anyTrustFastConfirmer == 0 at the end of K and on the Rollup owner not being able to set and unset it inside block K. Only a
 * Rollup-privileged party can exploit it (it also could force-confirm, which is logged). The wallet route does NOT prove: which
 * validator/owner/executor sent the tx (the wallet's onlyExecutorOrOwner guard and the Rollup's own validator check ran, success is the
 * evidence), that the wallet is staked/whitelisted beyond Rollup acceptance, that the batch had no other calls, or that the log came from the
 * decoded call (W17/W18). Tightening options, a design item and not this port: require every call of the batch to target the Rollup, and bind
 * the first confirmAssertion argument to the assertion hash. Tests: units_residuals.test.ts pins this paragraph and shows each residual in an
 * accepted world.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { MptError, ProofNodes, verifyAccountIn, verifyProofIn, verifySlotIn, type AccountState } from '../../../s6/mpt.js';
import { RlpError, split, splitList } from '../../../s6/rlp.js';
import { EthTxError, decodeTx } from '../baseposted/ethtx.js';
import { rlpIndexKey } from '../baseposted/trie.js';
import type { L1Block } from '../ethl1/index.js';
import { sameBytes } from '../evidence.js';
import type { HeaderFields } from '../rlpheader.js';
import type { FinalityStateError } from '../state.js';
import { AbiError, packArgs, unpackArgs, type AbiType, type AbiValue } from './abi.js';
import { roleOf, type ArbFinalPins } from './pins.js';
import { ReceiptError, decodeReceipt } from './receipt.js';
import {
  ConfirmReason,
  PathFast,
  PathForce,
  RoleWalletLogic,
  RoleWalletProxy,
  confirmationUnproven,
  confirmedByOwnerForce,
  stateProofInvalid,
  txProofInvalid,
} from './states.js';
import type { Evidence } from './wire.js';

/** The routes of an honest confirmation. */
export const RouteDirect = 'direct';
export const RouteWallet = 'wallet';

/** The proven confirmation of the assertion: the route the transaction took and its hash. Only an honest confirmation is returned; every other outcome is a named state. */
export interface Confirmed {
  route: string;
  txHash: Uint8Array;
}

/** The part of the evidence the classifier reads. */
export type ConfirmEvidence = Pick<Evidence, 'confTxIndex' | 'confTxRaw' | 'confReceiptRaw' | 'nodes'>;

/**
 * The node set of a proof read: a plain list (a proof database is then built for this read alone, as before) or the ProofNodes of the
 * verification, whose proof database is built once and shared by every read (RB12-TS-FIX-ARBSEP, audit N-5).
 */
export type ProofSource = readonly Uint8Array[] | ProofNodes;

/** The ProofNodes of a proof source: the shared set itself, or a new one over the list. */
export const proofNodesOf = (src: ProofSource): ProofNodes => (src instanceof ProofNodes ? src : new ProofNodes(src));

/**
 * proveLeaf: root commits to a leaf at key rlp(index), proven from the shared node set, and the leaf equals the carried raw bytes. A missing
 * or inconsistent node, an absent key, or a leaf that differs from the carried bytes is a failure (false), never a throw.
 */
export function proveLeaf(root: Uint8Array, index: number, nodes: ProofSource, carried: Uint8Array): boolean {
  let v: Uint8Array | undefined;
  try {
    // an empty node can never be a trie node: the leaf proofs read a database without it (the reader of a ProofNodes skips it)
    v = verifyProofIn(proofNodesOf(nodes).reader(), root, rlpIndexKey(index));
  } catch (e) {
    if (e instanceof MptError || e instanceof RlpError) return false;
    throw e;
  }
  return v !== undefined && sameBytes(v, carried);
}

const concat2 = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/**
 * tx.Hash() of a raw transaction decodeTx accepted: keccak256 of the raw bytes (a legacy transaction, and the canonical envelope of the
 * typed ones), except a blob transaction in its network form [tx, blobs, commitments, proofs] / [tx, version, ...], whose hash is that of the
 * canonical transaction inside it, 0x03 || rlp(tx fields) (go-ethereum keeps the sidecar out of the hash).
 */
export function txHashOf(raw: Uint8Array): Uint8Array {
  if (raw.length > 1 && raw[0] === 3) {
    const first = split(splitList(raw.subarray(1)).content);
    if (first.kind === 'list') return keccak_256(concat2(Uint8Array.of(3), first.raw));
  }
  return keccak_256(raw);
}

/** The first four bytes of calldata; ok is false when there are fewer (the selector then reads as zero, which no pinned selector is). */
export function selectorOf(b: Uint8Array): { sel: Uint8Array; ok: boolean } {
  if (b.length < 4) return { sel: new Uint8Array(4), ok: false };
  return { sel: Uint8Array.from(b.subarray(0, 4)), ok: true };
}

/** Whether sel is one of the four pinned ValidatorWallet entry points. */
export function isWalletSelector(arb: ArbFinalPins, sel: Uint8Array): boolean {
  return (
    sameBytes(sel, arb.sel.walletTx) || sameBytes(sel, arb.sel.walletTxs) || sameBytes(sel, arb.sel.walletTxRefund) || sameBytes(sel, arb.sel.walletTxsRef)
  );
}

/** One call of a ValidatorWallet entry point. */
export interface WalletCall {
  dest: Uint8Array;
  data: Uint8Array;
  amount: bigint;
}

/**
 * decodeWalletCalls: the calls of a ValidatorWallet entry point (nitro-contracts v3.1.0 src/rollup/ValidatorWallet.sol):
 * executeTransaction(bytes,address,uint256), executeTransactions(bytes[],address[],uint256[]) and the two gas-refunder variants that
 * prepend an address. undefined when sel is not an entry point or the arguments do not decode; the encoding must be canonical:
 * re-encoding the decoded arguments reproduces the input (N2(2): dirty address bits, offset gaps, trailing words, padding garbage are all
 * refused), and the arrays of a batch must have equal lengths.
 */
export function decodeWalletCalls(arb: ArbFinalPins, sel: Uint8Array, input: Uint8Array): WalletCall[] | undefined {
  let types: AbiType[];
  let kind: 'tx' | 'txRefund' | 'txs' | 'txsRef';
  if (sameBytes(sel, arb.sel.walletTx)) {
    types = ['bytes', 'address', 'uint256'];
    kind = 'tx';
  } else if (sameBytes(sel, arb.sel.walletTxRefund)) {
    types = ['address', 'bytes', 'address', 'uint256'];
    kind = 'txRefund';
  } else if (sameBytes(sel, arb.sel.walletTxs)) {
    types = ['bytes[]', 'address[]', 'uint256[]'];
    kind = 'txs';
  } else if (sameBytes(sel, arb.sel.walletTxsRef)) {
    types = ['address', 'bytes[]', 'address[]', 'uint256[]'];
    kind = 'txsRef';
  } else {
    return undefined;
  }
  if (input.length < 4) return undefined;
  const args = input.subarray(4);
  let vals: AbiValue[];
  try {
    vals = unpackArgs(types, args);
  } catch (e) {
    if (e instanceof AbiError) return undefined;
    throw e;
  }
  if (!sameBytes(packArgs(types, vals), args)) return undefined;
  if (kind === 'tx') return [{ data: vals[0] as Uint8Array, dest: vals[1] as Uint8Array, amount: vals[2] as bigint }];
  if (kind === 'txRefund') return [{ data: vals[1] as Uint8Array, dest: vals[2] as Uint8Array, amount: vals[3] as bigint }];
  const off = kind === 'txsRef' ? 1 : 0;
  const data = vals[off] as Uint8Array[];
  const dest = vals[off + 1] as Uint8Array[];
  const amt = vals[off + 2] as bigint[];
  if (data.length !== dest.length || data.length !== amt.length) return undefined;
  return data.map((d, i) => ({ data: d, dest: dest[i]!, amount: amt[i]! }));
}

const padAddr = (a: Uint8Array): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(a, 12);
  return out;
};

/**
 * proveWallet is the identity rule of the wallet route (V2_SPEC_S7 5.7 O4, amendment r3): wallet is a ValidatorWallet at the state whose
 * root is stateRoot, proven from nodes, iff
 *  1. the account proof of wallet resolves from stateRoot to an existing account whose code hash has the logic_pins role validator_wallet_proxy;
 *  2. the storage proof of the EIP-1967 implementation slot (proxy_slots.wallet_impl) resolves from that account's storage root to exactly the
 *     32-byte word of the pinned implementation address (confirm_path.validator_wallet_impl, high 12 bytes zero);
 *  3. the account proof of that implementation resolves from stateRoot to an existing account whose code hash has the role validator_wallet_logic.
 * Any error or missing or foreign node is false, never a throw: an unproven account, an externally owned account, any other contract, a
 * proxy of the same code over another implementation, an implementation of other code. Only stateRoot (K's) is read: a proof under S does
 * not count.
 */
export function proveWallet(arb: ArbFinalPins, stateRoot: Uint8Array, wallet: Uint8Array, nodes: ProofSource): boolean {
  const set = proofNodesOf(nodes);
  try {
    const acct = verifyAccountIn(set, stateRoot, wallet);
    if (!acct.exists || roleOf(arb, acct.codeHash) !== RoleWalletProxy) return false;
    const word = verifySlotIn(set, acct.storageRoot, arb.walletImplSlot);
    if (!sameBytes(word, padAddr(arb.walletImpl))) return false;
    const impl = verifyAccountIn(set, stateRoot, arb.walletImpl);
    return impl.exists && roleOf(arb, impl.codeHash) === RoleWalletLogic;
  } catch (e) {
    if (e instanceof MptError || e instanceof RlpError) return false;
    throw e;
  }
}

/**
 * walletCallee is the callee of a confirmation transaction that takes the wallet route's decoding: a transaction with a callee other than
 * the Rollup whose calldata decodes, canonically, as one of the four ValidatorWallet entry points. The builder captures the proofs
 * proveWallet reads for exactly this address; it is not an identity claim.
 */
export function walletCallee(arb: ArbFinalPins, tx: { to: Uint8Array | null; data: Uint8Array } | null): Uint8Array | undefined {
  if (tx === null || tx.to === null || sameBytes(tx.to, arb.rollup)) return undefined;
  const { sel } = selectorOf(tx.data);
  if (decodeWalletCalls(arb, sel, tx.data) === undefined) return undefined;
  return tx.to;
}

/**
 * 5.7 O4: the confirmation path under K (see the module comment). Throws a named state for every outcome that is not an honest confirmation.
 * set is the ProofNodes of e.nodes shared with the rest of the verification (a new one when omitted).
 */
export function classifyConfirmation(
  arb: ArbFinalPins,
  kb: Pick<L1Block, 'number' | 'stateRoot'>,
  kHeader: Pick<HeaderFields, 'transactionRoot' | 'receiptsRoot'>,
  acctK: Pick<AccountState, 'storageRoot'> | null,
  assertion: Uint8Array,
  e: ConfirmEvidence,
  set: ProofNodes = new ProofNodes(e.nodes),
): Confirmed {
  if (!proveLeaf(kHeader.transactionRoot, e.confTxIndex, set, e.confTxRaw)) throw txProofInvalid('tx');
  if (!proveLeaf(kHeader.receiptsRoot, e.confTxIndex, set, e.confReceiptRaw)) throw txProofInvalid('receipt');
  let tx: ReturnType<typeof decodeTx>;
  try {
    tx = decodeTx(e.confTxRaw);
  } catch (err) {
    if (err instanceof EthTxError || err instanceof RlpError) throw txProofInvalid('tx');
    throw err;
  }
  let rc: ReturnType<typeof decodeReceipt>;
  try {
    rc = decodeReceipt(e.confReceiptRaw);
  } catch (err) {
    if (err instanceof ReceiptError || err instanceof RlpError) throw txProofInvalid('receipt');
    throw err;
  }
  const txHash = txHashOf(e.confTxRaw);
  const unproven = (reason: string): FinalityStateError => confirmationUnproven(reason, txHash, kb.number);
  const force = (path: string): FinalityStateError => confirmedByOwnerForce(path, txHash, kb.number);
  if (rc.status !== 1) throw unproven(ConfirmReason.ReceiptStatus);
  let confirmed = false;
  let forced = false;
  for (const l of rc.logs) {
    if (!sameBytes(l.address, arb.rollup) || l.topics.length === 0) continue;
    if (sameBytes(l.topics[0]!, arb.topic.confirmed) && l.topics.length > 1 && sameBytes(l.topics[1]!, assertion)) confirmed = true;
    else if (sameBytes(l.topics[0]!, arb.topic.forceConfirmed)) forced = true;
  }
  if (!confirmed) throw unproven(ConfirmReason.LogMissing);
  if (forced) throw force(PathForce);
  // [r2:E1FIX L1] a contract creation has no callee: its data is init code, not calldata, so no selector of it names an entry point of the
  // Rollup or of a ValidatorWallet.
  if (tx.to === null) throw unproven(ConfirmReason.Indirect);
  const input = tx.data;
  const { sel } = selectorOf(input);
  if (sameBytes(tx.to, arb.rollup)) {
    if (sameBytes(sel, arb.sel.confirm)) return { route: RouteDirect, txHash };
    if (sameBytes(sel, arb.sel.force)) throw force(PathForce);
    if (sameBytes(sel, arb.sel.fast) || sameBytes(sel, arb.sel.fastNew)) throw force(PathFast);
    throw unproven(ConfirmReason.Indirect);
  }
  // The wallet route. The calldata of a transaction that has a callee is a ValidatorWallet entry point only if the callee IS one: [r3:E1RAISE]
  // that is proven, not read from the calldata. Anything not established is confirmation_path_unproven{indirect}: a statement about code the
  // verifier has not identified, never a weaker level and never the label "wallet".
  const calls = decodeWalletCalls(arb, sel, input);
  if (calls === undefined) {
    if (isWalletSelector(arb, sel)) throw unproven(ConfirmReason.WalletUndecodable);
    throw unproven(ConfirmReason.Indirect);
  }
  if (!proveWallet(arb, kb.stateRoot, tx.to, set)) throw unproven(ConfirmReason.Indirect);
  let found = false;
  for (const c of calls) {
    const cs = selectorOf(c.data);
    if (!sameBytes(c.dest, arb.rollup) || !cs.ok) continue;
    if (sameBytes(cs.sel, arb.sel.confirm)) found = true;
    else if (sameBytes(cs.sel, arb.sel.force)) throw force(PathForce);
    else if (sameBytes(cs.sel, arb.sel.fast) || sameBytes(cs.sel, arb.sel.fastNew)) throw force(PathFast);
  }
  if (!found) throw unproven(ConfirmReason.WalletNoConfirm);
  // A wallet confirmation is honest only while no fast confirmer exists at K (annex A3, spec r2:L6).
  if (acctK === null) throw new Error('classifyConfirmation: the Rollup account at K is required for a wallet confirmation');
  let fw: Uint8Array;
  try {
    fw = verifySlotIn(set, acctK.storageRoot, wordOf(arb.layout.fastConfirmerSlot));
  } catch (err) {
    if (err instanceof MptError || err instanceof RlpError) throw stateProofInvalid('slot');
    throw err;
  }
  let v = 0n;
  for (const x of fw) v = (v << 8n) | BigInt(x);
  v = (v >> arb.layout.fastConfirmerShiftBits) & ((1n << 160n) - 1n);
  if (v !== 0n) throw unproven(ConfirmReason.FastConfirmerSet);
  return { route: RouteWallet, txHash };
}

/** w32 of a uint64: 32 bytes with the value in the last eight. */
function wordOf(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setBigUint64(24, BigInt.asUintN(64, v), false);
  return out;
}
