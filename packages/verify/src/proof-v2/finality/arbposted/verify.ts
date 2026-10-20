/**
 * The verifier of arb-sepolia/l1_posted/v1 (V2_SPEC_S7 section 5.6; the twin of pkg/finality/arbposted/verify.go). It is pure: no I/O, no
 * clock, no randomness. It trusts only its pins, the Sepolia light-client chain inside the evidence (judged by ethl1), and standard
 * cryptography: the Bridge account is proven under the state root of a covered L1 block, its implementation code hash is pinned, the
 * sequencer accumulator of batch N is recomputed from the evidence and equals the proven storage word, the blobs are hash-bound and
 * KZG-verified under the pinned ceremony setup, and the batch payload is decoded down to the L2 messages.
 *
 * What the level proves, verbatim (spec 1.1) is STATEMENT; nothing here claims more. The order of the checks is the order of annex A6.3
 * (the first failing check names the state).
 */
import { sha256 } from '@noble/hashes/sha2';
import { MptError, verifyAccount, verifySlot } from '../../../s6/mpt.js';
import { RlpError } from '../../../s6/rlp.js';
import { decodeContainer, defaultLimits } from '../codec.js';
import { sameBytes, type BlockRef } from '../evidence.js';
import { blockAt, covers, ethl1PinsFrom, verifyFinalizedHead } from '../ethl1/index.js';
import { Level } from '../level.js';
import type { Pins } from '../pins.js';
import { sepoliaPins } from '../pins.js';
import type { Kind, Registry, Verdict } from '../registry.js';
import { readHeader } from '../rlpheader.js';
import { FinalityStateError, evidenceTooLarge, evidenceUnrecognised, newState } from '../state.js';
import { loadKzgSetup, type KzgBlob } from '../baseposted/kzg.js';
import { trieRoot } from '../baseposted/trie.js';
import {
  TX_INTERNAL,
  TX_RETRY,
  accumulator,
  arrayElementSlot,
  dataHash,
  headerNonce,
  isDelayedOriginType,
  txType,
  verifyDelayed,
} from './delayed.js';
import {
  PayloadOffL1,
  PayloadTooLarge,
  PayloadUndecodable,
  PayloadUnknownHeader,
  BlobPayloadError,
  HEADER_BROTLI,
  HEADER_DAS,
  HEADER_DAS_TREE,
  HEADER_ZEROHEAVY,
  decodeBlobs,
  decodePayload,
  type L2Message,
} from './nitro.js';
import { CHAIN, KIND_NAME, PIN_KZG, USED_KZG_SETUP_SHA256, kzgPinOf, loadArbPins, pinnedBridgeImpl, type ArbPins } from './pins.js';
import {
  CodeBatchDataOffL1,
  CodeBatchHeaderUnknown,
  CodePreBold,
  ContentReason,
  L1FinalityReason,
  blobMismatch,
  contentNotFound,
  contractIdentity,
  l1FinalityUnproven,
  pinMismatch,
  stateProofInvalid,
} from './states.js';
import { DataBlobs, DataCalldata, DataNone, decodeEvidence, type Bounds, type Evidence } from './wire.js';

/** The section 1.1 wording of what the level proves; the report shows it verbatim and nothing may strengthen it. */
export const STATEMENT =
  "the sequencer committed in finalized L1 state to batch N whose payload contains a message whose signed transactions are exactly this block's signed transactions. It does not prove the block hash or state root, nor the message's absolute position.";

/** The logic_pins role of the Bridge implementation. */
const BRIDGE_IMPL_ROLE = 'bridge_impl';

/** EIP-1967 implementation slot. */
const EIP1967_IMPL_SLOT = Uint8Array.from('360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'.match(/../g)!, (h) => parseInt(h, 16));

/** The decoder bounds under these pins: the section 8.2 generic limits, the Sepolia link and spine bounds and the Arbitrum pins. */
function boundsFor(maxLinks: number, maxSpineHeaders: number, a: ArbPins): Bounds {
  const lim = defaultLimits();
  lim.maxBlobsArbitrum = a.maxBlobs;
  lim.maxSegments = a.maxSegments;
  lim.maxUncompressedBatch = a.maxUncompressedBatch;
  return { lim, maxLinks, maxSpineHeaders, maxBlobs: a.maxBlobs };
}

const innerCode = (e: unknown): string => (e instanceof FinalityStateError ? e.code : 'unknown');

const sameTxs = (a: readonly Uint8Array[], b: readonly Uint8Array[]): boolean => a.length === b.length && a.every((x, i) => sameBytes(x, b[i]!));

/** Wraps an MPT/RLP failure of a proof read as the named state it is. */
function proven<T>(which: 'account' | 'slot', f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof MptError || e instanceof RlpError) throw stateProofInvalid(which);
    throw e;
  }
}

/** The verifier of arb-sepolia/l1_posted/v1. */
export class ArbPostedKind implements Kind {
  name(): string {
    return KIND_NAME;
  }
  chain(): bigint {
    return CHAIN;
  }
  level(): Level {
    return Level.L1Posted;
  }

  /** Judges the whole CFE1 container of one leg block (spec 5.6). The L2 header is b.headerRlp (the leg's Settlement.Header). */
  verify(p: Pins | null, b: BlockRef, evidence: Uint8Array): Verdict {
    const c = decodeContainer(evidence, defaultLimits());
    if (c.header.kind !== KIND_NAME || c.header.chain !== CHAIN || c.header.level !== Level.L1Posted) {
      throw evidenceUnrecognised(c.header.kind, '');
    }
    const arb = loadArbPins(p);
    const eth = sepoliaPins(p);
    const ep = ethl1PinsFrom(eth);
    const kzgPin = kzgPinOf(p);
    if (kzgPin !== USED_KZG_SETUP_SHA256) throw pinMismatch(PIN_KZG);
    const e = decodeEvidence(c.body, boundsFor(ep.maxLinks, ep.maxSpineHeaders, arb));
    const hdr = readHeader(b.headerRlp ?? new Uint8Array(0));
    if (hdr.number <= arb.boldGenesisL2Block) {
      throw newState(CodePreBold, { n: hdr.number, bold_genesis_l2_block: arb.boldGenesisL2Block });
    }
    return this.verifyBody(arb, ep, b, hdr.transactionRoot, e);
  }

  private verifyBody(arb: ArbPins, ep: ReturnType<typeof ethl1PinsFrom>, b: BlockRef, headerTxRoot: Uint8Array, e: Evidence): Verdict {
    // annex step 1: the carried transaction list is the block's.
    if (!sameBytes(trieRoot(e.blockTxs), headerTxRoot)) throw contentNotFound(ContentReason.BlockTxsRootMismatch, { batch: e.batchSeq });
    if (e.dataKind === DataNone) throw contentNotFound(ContentReason.NoDataBatch, { batch: e.batchSeq });
    // annex step 2 / 5.2: the L1 finalized head, and the state block on its covered spine.
    let head;
    try {
      head = verifyFinalizedHead(ep, e.lc);
    } catch (err) {
      if (err instanceof FinalityStateError) throw l1FinalityUnproven(L1FinalityReason.LCRefused, innerCode(err));
      throw err;
    }
    let covered;
    try {
      covered = covers(head, e.l1Spine, ep.maxSpineHeaders);
    } catch (err) {
      if (err instanceof FinalityStateError) throw l1FinalityUnproven(L1FinalityReason.SpineRefused, innerCode(err));
      throw err;
    }
    const s = blockAt(covered, e.stateBlock);
    return this.verifyState(arb, s, b, e);
  }

  /**
   * The part of the judgement that runs under the state root of the covered L1 block S: the Bridge identity, the accumulator, the blobs,
   * the payload decode and the match. It is separate so that tests can give it a state built in memory.
   */
  verifyState(arb: ArbPins, s: { hash: Uint8Array; number: bigint; stateRoot: Uint8Array }, b: BlockRef, e: Evidence): Verdict {
    const root = s.stateRoot;

    // 5.6 O2: the Bridge account under stateRoot_S, its EIP-1967 implementation, the pinned implementation code hash.
    const bridge = proven('account', () => verifyAccount(root, arb.bridge, e.nodes));
    if (!bridge.exists) throw contractIdentity(BRIDGE_IMPL_ROLE, arb.bridge, new Uint8Array(32), s.number);
    const implWord = proven('slot', () => verifySlot(bridge.storageRoot, EIP1967_IMPL_SLOT, e.nodes));
    const impl = implWord.slice(12);
    const implAcct = proven('account', () => verifyAccount(root, impl, e.nodes));
    if (!implWord.subarray(0, 12).every((x) => x === 0) || !implAcct.exists || !pinnedBridgeImpl(arb, implAcct.codeHash)) {
      throw contractIdentity(BRIDGE_IMPL_ROLE, impl, implAcct.codeHash, s.number);
    }

    // 5.6 O3: acc_N and the recomputed accumulator.
    const accWord = proven('slot', () => verifySlot(bridge.storageRoot, arrayElementSlot(arb.layout.accArraySlot, e.batchSeq), e.nodes));
    if (e.dataKind === DataCalldata) {
      if (e.calldata.length === 0) throw newState(CodeBatchHeaderUnknown, { batch: e.batchSeq });
      const h = e.calldata[0]!;
      if (h !== HEADER_BROTLI && h !== HEADER_ZEROHEAVY && h !== HEADER_DAS && h !== HEADER_DAS_TREE) {
        throw newState(CodeBatchHeaderUnknown, { batch: e.batchSeq, byte: h });
      }
    }
    if (!sameBytes(accumulator(e.beforeAcc, dataHash(e), e.delayedAcc), accWord)) {
      throw contentNotFound(ContentReason.AccumulatorMismatch, { batch: e.batchSeq });
    }

    // 5.6 O4: blobs.
    let payload: Uint8Array;
    if (e.dataKind === DataBlobs) {
      if (e.blobs.length !== e.versionedHashes.length) throw blobMismatch();
      verifyBlobs(e);
      try {
        payload = decodeBlobs(e.blobs.map((x) => x.raw));
      } catch (err) {
        if (err instanceof BlobPayloadError) throw contentNotFound(ContentReason.PayloadUndecodable, { batch: e.batchSeq });
        throw err;
      }
    } else {
      payload = e.calldata;
    }
    const res = decodePayload(payload, arb.maxUncompressedBatch, arb.maxSegments);
    switch (res.status) {
      case PayloadOffL1:
        throw newState(CodeBatchDataOffL1, { batch: e.batchSeq, header_byte: res.headerByte });
      case PayloadUnknownHeader:
        throw newState(CodeBatchHeaderUnknown, { batch: e.batchSeq, byte: res.headerByte });
      case PayloadUndecodable:
        throw contentNotFound(ContentReason.PayloadUndecodable, { batch: e.batchSeq });
      case PayloadTooLarge:
        if (res.exceededUncompressed) throw evidenceTooLarge('uncompressed_batch', BigInt(arb.maxUncompressedBatch) + 1n, BigInt(arb.maxUncompressedBatch));
        throw evidenceTooLarge('segments', BigInt(arb.maxSegments) + 1n, BigInt(arb.maxSegments));
    }

    // annex steps 7-8: classify the block's transactions and match one message.
    const std: Uint8Array[] = [];
    const types: bigint[] = [];
    let delayedOrigin = false;
    for (const tx of e.blockTxs) {
      const t = txType(tx);
      types.push(BigInt(t));
      if (t <= 4) std.push(tx);
      else if (t === TX_INTERNAL || t === TX_RETRY) continue;
      else if (isDelayedOriginType(t)) delayedOrigin = true;
      else throw contentNotFound(ContentReason.UnsupportedTxType, { batch: e.batchSeq, tx_type: BigInt(t) });
    }
    let delayedK: bigint | undefined;
    if (delayedOrigin) {
      const nonce = b.headerRlp === undefined ? undefined : headerNonce(b.headerRlp);
      delayedK = verifyDelayed(arb, bridge.storageRoot, e, res, types, nonce ?? 0n);
    }
    if (std.length === 0 && !delayedOrigin) throw contentNotFound(ContentReason.NoStandardTransactions, { batch: e.batchSeq });
    let ordinal = -1;
    if (std.length > 0) {
      const m: L2Message | undefined = res.messages.find((x) => sameTxs(std, x.txs));
      if (m === undefined) {
        throw contentNotFound(ContentReason.NoMatchingMessage, {
          batch: e.batchSeq,
          messages_scanned: BigInt(res.messages.length),
          segments: BigInt(res.segments),
        });
      }
      ordinal = m.ordinal;
    }
    const fields: Verdict['fields'] = {
      batch_sequence_number: e.batchSeq,
      blobs: BigInt(e.blobs.length),
      l1_state_block: s.number,
      l1_state_block_hash: s.hash,
      messages: BigInt(res.messages.length),
      statement: STATEMENT,
    };
    if (ordinal >= 0) fields.message_ordinal = BigInt(ordinal);
    if (delayedK !== undefined) fields.delayed_message_index = delayedK;
    return { level: Level.L1Posted, kind: KIND_NAME, fields };
  }
}

/**
 * Checks every blob against its versioned hash (the commitment hashes to it: sha256(commitment) with the first byte 0x01) and then the blob
 * proofs under the pinned ceremony setup, as one batched KZG check that falls back to the one-by-one judgement. Any failure is the one
 * state blob_commitment_mismatch (the reference checks blob by blob and names the same state for either check).
 */
export function verifyBlobs(e: Pick<Evidence, 'blobs' | 'versionedHashes'>): void {
  for (let j = 0; j < e.blobs.length; j++) {
    const h = sha256(e.blobs[j]!.commitment);
    h[0] = 0x01;
    if (!sameBytes(h, e.versionedHashes[j]!)) throw blobMismatch();
  }
  if (e.blobs.length === 0) return;
  const kz = loadKzgSetup(USED_KZG_SETUP_SHA256);
  const items: KzgBlob[] = e.blobs.map((x) => ({ raw: x.raw, commitment: x.commitment, proof: x.proof }));
  if (kz.verifyBlobs(items) >= 0) throw blobMismatch();
}

/** Adds the kind to a registry; there is no import-time registration. */
export function registerArbPosted(reg: Registry): void {
  reg.registerKind(new ArbPostedKind());
}
