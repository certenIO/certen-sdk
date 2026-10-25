/**
 * The verifier of base-sepolia/l1_posted/v1 (V2_SPEC_S7 section 5.4, O1-O6; the twin of the validator's pkg/finality/baseposted
 * verify.go). It is pure: no I/O, no clock, no randomness. It trusts only its pins, the Sepolia light-client chain inside the
 * evidence (judged by ethl1), and standard cryptography: every frame transaction is proven in an L1 block of the covered spine,
 * signed by the batcher that SystemConfig named AT THAT BLOCK, and (blobs) hash-bound and KZG-verified under the pinned ceremony
 * setup; the channel is assembled and decoded; the leg's L2 block is bound to its batch, the L1-info deposit and the sequencing window.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';
import { RlpError, split, splitList, structItems, uintOf, fixedOf, bytesOf } from '../../../s6/rlp.js';
import { MptError, verifyProof } from '../../../s6/mpt.js';
import { decodeContainer, defaultLimits } from '../codec.js';
import { sameBytes, type BlockRef } from '../evidence.js';
import { blockAt, covers, ethl1PinsFrom, verifyFinalizedHead } from '../ethl1/index.js';
import { Level } from '../level.js';
import type { Pins } from '../pins.js';
import { sepoliaPins } from '../pins.js';
import type { Kind, Registry, Verdict } from '../registry.js';
import { readHeader, type HeaderFields } from '../rlpheader.js';
import {
  EvidenceReason,
  FinalityStateError,
  blockMismatch,
  evidenceUnrecognised,
  malformed,
  newState,
  pinsCorrupt,
  PinsReason,
  type Fields,
} from '../state.js';
import { blobToData, BlobDecodeError } from './blob.js';
import { ChannelError, decompress, parseFrames, type Frame } from './channel.js';
import { EthTxError, decodeTx, senderOf, TX_BLOB } from './ethtx.js';
import { KzgContext, loadKzgSetup, type KzgBlob } from './kzg.js';
import { CHAIN, KIND_NAME, ROLE_SYSTEM_CONFIG_IMPL, channelTimeoutAt, parseBasePins, type BasePins } from './pins.js';
import { BatchFormatError, BatchStreamError, decodeBatches, type Batch } from './span.js';
import { rlpIndexKey, trieRoot } from './trie.js';
import { decodeBody, encodeBody, type Body } from './wire.js';

/** The Base R and unavailability codes this kind raises (V2_SPEC_S7 section 7); registered in the shared registry. */
export const CodeL1FinalityUnproven = 'l1_finality_unproven';
export const CodeBatcherSender = 'batcher_sender_mismatch';
export const CodeBatcherNotToInbox = 'batcher_tx_not_to_inbox';
export const CodeBlobMismatch = 'blob_commitment_mismatch';
export const CodeChannelIncomplete = 'channel_incomplete';
export const CodeChannelTimedOut = 'channel_timed_out';
export const CodeChannelMalformed = 'channel_malformed';
export const CodeBatchNotFound = 'batch_not_found';
export const CodeBatchBindingMismatch = 'batch_binding_mismatch';
export const CodeBatchOutsideWindow = 'batch_outside_sequencing_window';
export const CodeBatchFormat = 'batch_format_unsupported';
export const CodeL1TxProofInvalid = 'l1_tx_proof_invalid';
export const CodeL1StateProofInvalid = 'l1_state_proof_invalid';
export const CodeContractIdentity = 'contract_identity_unproven';

/** The reason of l1_finality_unproven when the LC part of the container is refused; the inner fault code rides in `inner`. */
export const LC_REFUSED = 'lc_refused';

/** keccak256("eip1967.proxy.implementation") - 1 */
const EIP1967_IMPL_SLOT = Uint8Array.from('360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'.match(/../g)!, (h) => parseInt(h, 16));
/** SystemConfig.batcherHash (storage slot 103, [BASE Q2]) */
const BATCHER_HASH_SLOT = (() => {
  const s = new Uint8Array(32);
  s[31] = 103;
  return s;
})();

const st = (code: string, fields: Fields = {}): FinalityStateError => newState(code, fields);

const hex32 = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

/** The proof database: every node keyed by its own keccak256 (an empty node can never be a trie node and is never looked up). */
class NodeDb {
  private readonly nodes: Uint8Array[];
  constructor(nodes: readonly Uint8Array[]) {
    this.nodes = nodes.filter((n) => n.length > 0);
  }

  /** trie.VerifyProof: ok is false for any proof failure; v is undefined for a proven absence. */
  value(root: Uint8Array, key: Uint8Array): { ok: boolean; v: Uint8Array | undefined } {
    try {
      return { ok: true, v: verifyProof(root, key, this.nodes) };
    } catch (e) {
      if (e instanceof MptError || e instanceof RlpError) return { ok: false, v: undefined };
      throw e;
    }
  }

  /** An account under a state root: its storage root and code hash. A missing proof, a bad node or an absent account is l1_state_proof_invalid{account}. */
  account(stateRoot: Uint8Array, addr: Uint8Array): { root: Uint8Array; codeHash: Uint8Array } {
    const bad = (): FinalityStateError => st(CodeL1StateProofInvalid, { which: 'account' });
    const r = this.value(stateRoot, keccak_256(addr));
    if (!r.ok || r.v === undefined || r.v.length === 0) throw bad();
    try {
      const it = structItems(r.v, 4);
      uintOf(it[0]!, 8);
      uintOf(it[1]!, 32);
      return { root: Uint8Array.from(fixedOf(it[2]!, 32)), codeHash: Uint8Array.from(bytesOf(it[3]!)) };
    } catch (e) {
      if (e instanceof RlpError) throw bad();
      throw e;
    }
  }

  /** A storage slot under a storage root; an absent slot reads zero. */
  slot(storageRoot: Uint8Array, slot: Uint8Array): Uint8Array {
    const bad = (): FinalityStateError => st(CodeL1StateProofInvalid, { which: 'slot' });
    const out = new Uint8Array(32);
    const r = this.value(storageRoot, keccak_256(slot));
    if (!r.ok) throw bad();
    if (r.v === undefined || r.v.length === 0) return out;
    let raw: Uint8Array;
    try {
      const it = split(r.v);
      if (it.rest.length !== 0) throw new RlpError('input contains more than one value');
      raw = bytesOf(it);
    } catch (e) {
      if (e instanceof RlpError) throw bad();
      throw e;
    }
    if (raw.length > 32) throw bad();
    out.set(raw, 32 - raw.length);
    return out;
  }
}

/**
 * Proves, under stateRoot of L1 block number l1, SystemConfig.batcherHash and the implementation behind the pinned proxy (EIP-1967
 * slot), whose code hash must be a pinned syscfg_impl. It returns the batcher address.
 */
function systemConfigAt(db: NodeDb, bp: BasePins, stateRoot: Uint8Array, l1: bigint): Uint8Array {
  const acct = db.account(stateRoot, bp.systemConfig);
  const bh = db.slot(acct.root, BATCHER_HASH_SLOT);
  const implWord = db.slot(acct.root, EIP1967_IMPL_SLOT);
  const impl = implWord.slice(12);
  const ia = db.account(stateRoot, impl);
  const ch = new Uint8Array(32);
  ch.set(ia.codeHash.subarray(0, 32));
  if (!bp.systemConfigImplHashes.has(hex32(ch))) {
    throw st(CodeContractIdentity, { role: ROLE_SYSTEM_CONFIG_IMPL, address: impl, code_hash: ch, judged_at: l1 });
  }
  for (let i = 0; i < 12; i++) if (bh[i] !== 0) throw st(CodeBatcherSender);
  return bh.slice(12);
}

/** The prefix compare of a (possibly truncated) committed hash: n leading bytes are committed, 0 means none. */
function prefixEq(have: Uint8Array, n: number, want: Uint8Array): boolean {
  if (n <= 0 || n > 32) return false;
  for (let i = 0; i < n; i++) if (have[i] !== want[i]) return false;
  return true;
}

/**
 * The L1-info deposit: with the 4-byte selector included, the epoch number sits at calldata [28:36] and the epoch hash at [100:132]; the
 * deposit is a type-0x7e transaction whose data is the last of its eight RLP items.
 */
function l1Info(dep: Uint8Array): { num: bigint; hash: Uint8Array } | undefined {
  try {
    const list = splitList(dep.subarray(1));
    if (list.rest.length !== 0) return undefined;
    let content = list.content;
    let n = 0;
    let last: Uint8Array | undefined;
    while (content.length > 0) {
      const it = split(content);
      n++;
      if (n === 8) {
        if (it.kind !== 'string') return undefined;
        last = it.content;
      }
      content = it.rest;
    }
    if (n !== 8 || last === undefined || last.length < 132) return undefined;
    return { num: new DataView(last.buffer, last.byteOffset, last.byteLength).getBigUint64(28, false), hash: Uint8Array.from(last.subarray(100, 132)) };
  } catch (e) {
    if (e instanceof RlpError) return undefined;
    throw e;
  }
}

function distinctSorted(input: readonly bigint[]): bigint[] {
  return [...new Set(input)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The verifier of base-sepolia/l1_posted/v1. */
export class BasePostedKind implements Kind {
  name(): string {
    return KIND_NAME;
  }
  chain(): bigint {
    return CHAIN;
  }
  level(): Level {
    return Level.L1Posted;
  }

  /** Judges the container (spec 5.4 O1-O6). The L2 header is b.headerRlp (the leg's Settlement.Header). */
  verify(p: Pins | null, b: BlockRef, evidence: Uint8Array): Verdict {
    const bp = parseBasePins(p);
    const eth = sepoliaPins(p);
    const ep = ethl1PinsFrom(eth);
    const lim = defaultLimits();
    const c = decodeContainer(evidence, lim);
    if (c.header.kind !== KIND_NAME) throw evidenceUnrecognised(c.header.kind, '');
    if (c.header.chain !== CHAIN || c.header.level !== Level.L1Posted) throw malformed('header.chain', EvidenceReason.DiffersFromAddendum, 0, 0);
    if (c.header.blockNumber !== b.number) throw blockMismatch('blockNumber', b.number, c.header.blockNumber);
    if (!sameBytes(c.header.blockHash, b.hash)) throw blockMismatch('blockHash', b.hash, c.header.blockHash);
    const maxBlobs = Math.min(bp.maxBlobs, lim.maxBlobsBase);
    const body = decodeBody(c.body, lim, ep, maxBlobs);
    if (!sameBytes(encodeBody(body), c.body)) throw malformed('body', EvidenceReason.NodesNotAscendingUnique, 0, 0);
    // The leg header: raw RLP hashed as given and read positionally.
    if (b.headerRlp === undefined || b.headerRlp.length === 0) throw malformed('leg.header', EvidenceReason.HeaderNotRLPList, 0, 0);
    const l2 = readHeader(b.headerRlp);
    if (!sameBytes(l2.hash, b.hash)) throw blockMismatch('blockHash', b.hash, l2.hash);
    if (l2.number !== b.number) throw blockMismatch('blockNumber', b.number, l2.number);
    // O6: post-Denim blocks (200 ms blocks, shared timestamps, new batch format) are not yet pinned.
    if (l2.timestamp >= bp.denimTime) throw st(CodeBatchFormat, { type: 'post_denim' });
    // O1: L1 finality, then the spine.
    let head;
    try {
      head = verifyFinalizedHead(ep, body.lc);
    } catch (e) {
      if (e instanceof FinalityStateError) throw st(CodeL1FinalityUnproven, { reason: LC_REFUSED, inner: e.code });
      throw e;
    }
    const covered = covers(head, body.l1Spine, ep.maxSpineHeaders);
    return verifyChannel(bp, body, covered, l2, head);
  }
}

/** Adds the kind to a registry; there is no import-time registration. */
export function registerBasePosted(reg: Registry): void {
  reg.registerKind(new BasePostedKind());
}

type Covered = ReturnType<typeof covers>;

/** O3-O5 over a covered L1 spine. */
export function verifyChannel(bp: BasePins, body: Body, covered: Covered, l2: HeaderFields, head: { slot: bigint; epoch: bigint }): Verdict {
  const db = new NodeDb(body.nodes);
  const frames: Frame[] = [];
  const frameL1: bigint[] = [];
  /** the timestamp of the L1 block of each entry of frameL1 (selects the channel timeout, see below) */
  const frameTime: bigint[] = [];
  let batcher: Uint8Array = new Uint8Array(20);
  let prevL1 = 0n;
  let prevIdx = 0;
  // The KZG checks of one evidence run as one batch; whatever fails first in the order a one-by-one check would meet it is the verdict.
  const pending: KzgBlob[] = [];
  let kz: KzgContext | undefined;
  const flush = (): void => {
    if (pending.length === 0) return;
    const bad = kz!.verifyBlobs(pending);
    pending.length = 0;
    if (bad >= 0) throw st(CodeBlobMismatch);
  };
  try {
    body.frames.forEach((f, i) => {
      // O1: the frame L1 block is a header of the covered spine, by number.
      const blk = blockAt(covered, f.l1Block);
      const raw = body.l1Spine[Number(covered[0]!.number - f.l1Block)]!;
      const hdr = readHeader(raw);
      if (i > 0 && (f.l1Block < prevL1 || (f.l1Block === prevL1 && f.txIndex <= prevIdx))) throw st(CodeChannelIncomplete);
      prevL1 = f.l1Block;
      prevIdx = f.txIndex;
      // Inclusion: the transaction is the value at rlp(index) of the block transaction trie.
      const inc = db.value(hdr.transactionRoot, rlpIndexKey(f.txIndex));
      if (!inc.ok || !sameBytes(inc.v ?? new Uint8Array(0), f.txRaw)) throw st(CodeL1TxProofInvalid);
      let tx;
      try {
        tx = decodeTx(f.txRaw);
      } catch (e) {
        if (e instanceof EthTxError) throw st(CodeL1TxProofInvalid);
        throw e;
      }
      if (tx.to === null || !sameBytes(tx.to, bp.batchInbox)) throw st(CodeBatcherNotToInbox);
      // Authentication: the sender is SystemConfig.batcherHash proven at THIS frame L1 block.
      const want = systemConfigAt(db, bp, blk.stateRoot, f.l1Block);
      let from: Uint8Array;
      try {
        from = senderOf(tx, bp.l1ChainId);
      } catch (e) {
        if (e instanceof EthTxError) throw st(CodeBatcherSender);
        throw e;
      }
      if (!sameBytes(from, want)) throw st(CodeBatcherSender);
      batcher = want;
      const datas: Uint8Array[] = [];
      if (tx.type === TX_BLOB) {
        if (f.blobs.length !== tx.blobHashes.length) throw st(CodeBlobMismatch);
        f.blobs.forEach((bl, j) => {
          const s = sha256(bl.commitment);
          s[0] = 0x01;
          if (!sameBytes(s, tx.blobHashes[j]!)) throw st(CodeBlobMismatch);
          if (kz === undefined) {
            try {
              kz = loadKzgSetup(bp.kzgSetupSha256);
            } catch {
              throw pinsCorrupt(PinsReason.BadValue, { key: bp.kzgSetupKey });
            }
          }
          pending.push(bl);
          try {
            datas.push(blobToData(bl.raw));
          } catch (e) {
            if (e instanceof BlobDecodeError) {
              flush();
              throw st(CodeChannelMalformed);
            }
            throw e;
          }
        });
      } else {
        if (f.blobs.length !== 0) throw st(CodeBlobMismatch);
        datas.push(tx.data);
      }
      for (const d of datas) {
        let fr: Frame[];
        try {
          fr = parseFrames(d);
        } catch (e) {
          if (e instanceof ChannelError) {
            flush();
            throw st(CodeChannelMalformed);
          }
          throw e;
        }
        for (const x of fr) {
          if (sameBytes(x.id, body.channelId)) {
            frames.push(x);
            frameL1.push(f.l1Block);
            frameTime.push(hdr.timestamp);
          }
        }
      }
    });
  } catch (e) {
    flush();
    throw e;
  }
  flush();
  // O4: contiguous from 0, exactly one closing frame (the last), all within channel_timeout of the first.
  if (frames.length === 0) throw st(CodeChannelIncomplete);
  const parts: Uint8Array[] = [];
  frames.forEach((fr, i) => {
    if (fr.number !== i || fr.isLast !== (i === frames.length - 1)) throw st(CodeChannelIncomplete);
    parts.push(fr.data);
  });
  const stream = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let off = 0;
  for (const x of parts) {
    stream.set(x, off);
    off += x.length;
  }
  // op-node IngestFrame ignores a frame when `currentCh.OpenBlockNumber()+cb.spec.ChannelTimeout(origin.Time) < origin.Number`: origin is the
  // L1 block that holds the frame, so the timeout in force (50 from Granite, 300 before) is selected by that block's own timestamp, frame by
  // frame [r2:D2FIX]. frameL1 is non-decreasing (the frames are in order), so the difference cannot go below zero.
  frameL1.forEach((l, i) => {
    if (l - frameL1[0]! > channelTimeoutAt(bp, frameTime[i]!)) throw st(CodeChannelTimedOut);
  });
  let raw: Uint8Array;
  try {
    raw = decompress(stream, bp.maxRlpBytesPerChannel);
  } catch (e) {
    if (e instanceof ChannelError) throw st(CodeChannelMalformed);
    throw e;
  }
  let batches: Batch[];
  try {
    batches = decodeBatches(raw, { genesisTime: bp.l2GenesisTime, blockTime: bp.l2BlockTime, chainId: bp.chainId });
  } catch (e) {
    if (e instanceof BatchFormatError) throw st(CodeBatchFormat, { type: e.typ });
    if (e instanceof RlpError || e instanceof BatchStreamError) throw st(CodeChannelMalformed);
    throw e;
  }
  const bt = batches.find((x) => x.timestamp === l2.timestamp);
  if (bt === undefined) throw st(CodeBatchNotFound, { timestamp: l2.timestamp, n_batches: batches.length });
  // O5: binding.
  if (!prefixEq(bt.parentHash, bt.parentLen, l2.parentHash)) throw st(CodeBatchBindingMismatch, { field: 'parent_hash' });
  const dep0 = body.deposits[0];
  if (dep0 === undefined || dep0.length === 0 || dep0[0] !== 0x7e) throw st(CodeBatchBindingMismatch, { field: 'l1_info_deposit' });
  // O2/O5: the block's transaction list is depositTxs followed by the batch's transactions and the two lists are told apart by type alone, as
  // OP derivation does (a batch may not embed a deposit or an empty transaction: checkSingularBatch / span batch validation drop it). Without
  // this a prover moves any block transaction the batcher never posted into depositTxs and the recomputed root still matches [r2:D2FIX].
  for (const d of body.deposits) if (d.length === 0 || d[0] !== 0x7e) throw st(CodeBatchBindingMismatch, { field: 'deposit_txs' });
  for (const x of bt.txs) if (x.length === 0 || x[0] === 0x7e) throw st(CodeBatchBindingMismatch, { field: 'batch_txs' });
  const info = l1Info(dep0);
  if (info === undefined) throw st(CodeBatchBindingMismatch, { field: 'l1_info_deposit' });
  if (bt.epochNum !== info.num) throw st(CodeBatchBindingMismatch, { field: 'epoch_num' });
  if (!prefixEq(bt.epochHash, bt.epochLen, info.hash)) throw st(CodeBatchBindingMismatch, { field: 'epoch_hash' });
  for (const l of frameL1) if (l < bt.epochNum || l - bt.epochNum > bp.seqWindowSize) throw st(CodeBatchOutsideWindow);
  const all = [...body.deposits, ...bt.txs];
  if (!sameBytes(trieRoot(all), l2.transactionRoot)) throw st(CodeBatchBindingMismatch, { field: 'transactions_root' });
  return {
    level: Level.L1Posted,
    kind: KIND_NAME,
    fields: {
      channel_id: body.channelId,
      l1_blocks: distinctSorted(frameL1),
      batcher,
      batch_type: BigInt(bt.type),
      span_index: BigInt(bt.spanIndex),
      span_blocks: BigInt(bt.spanBlocks),
      parent_hash_bits: BigInt(bt.parentLen * 8),
      epoch_hash_bits: BigInt(bt.epochLen * 8),
      finalized_slot: head.slot,
      finalized_epoch: head.epoch,
    },
  };
}
