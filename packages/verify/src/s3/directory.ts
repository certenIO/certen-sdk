/**
 * The Directory as a partition of evidence 2.1, and the partition anchors of either kind (validator xdirectory.go; design D2, D2b, D2c).
 *
 * A block validator partition proves a block to the Directory with a BlockValidatorAnchor it sends and the Directory executes. The
 * Directory has no such anchor: it anchors itself with a DirectoryAnchor addressed to its own anchor pool. The anchor kind is therefore
 * checked per partition kind, and the partition an anchor proves is DERIVED from the committed anchor body's Source - never from the
 * wrapper that delivered it, which no hash covers.
 */
import { hexBytes } from '../proof-v2/bytes.js';
import { AccUrl, ANCHOR_POOL, DIRECTORY, DN_URL, goEqualFold, parsePartitionUrl } from './acc.js';
import { bigOf, bytesOf, nodeOf, principalOf, urlOf, type WireNode } from './model.js';
import { refusal21, State } from './states.js';
import { VerifyError } from '../proof-v2/bytes.js';
import type { SeqMsg } from './evidence.js';

/** A decoded partition anchor of either kind. */
export interface PartitionAnchor21 {
  body: { source?: AccUrl; minorBlockIndex: number; rootChainAnchor: Uint8Array; stateTreeAnchor: Uint8Array };
  seq: SeqMsg;
  /** The anchor transaction's hash. */
  tx: Uint8Array;
  /** The body is a DirectoryAnchor. */
  directory: boolean;
}

const hash32 = (n: WireNode, name: string): Uint8Array => {
  const b = bytesOf(n, name);
  return b.length === 32 ? b : new Uint8Array(32);
};

/** decodeAnchor21: the shape of a delivered anchor of either kind (xdirectory.go). */
export function decodeAnchor21(m: SeqMsg): PartitionAnchor21 {
  // the anchor is read back from the binary form the import wrote (messaging.UnmarshalMessage): a trailing field it cannot place, or a nested value that
  // does not decode, is no anchor
  if (!m.decodes) throw new VerifyError('partition anchor: field Message: failed to unmarshal value: the message does not decode');
  if (m.kind !== 'transaction' || !m.txn || !nodeOf(m.txn, 'body')) {
    throw new VerifyError(`partition anchor is ${m.kind === 'transaction' ? '*messaging.TransactionMessage' : m.kind}, not a transaction`);
  }
  const principal = principalOf(m.txn);
  if (!m.source || !m.destination || !principal) throw new VerifyError('partition anchor names no source, destination or principal');
  // Both kinds are executed by the Directory: delivered to its anchor pool.
  if (!DN_URL.equal(m.destination) || !DN_URL.joinPath(ANCHOR_POOL).equal(principal)) {
    throw new VerifyError("partition anchor is not delivered to the Directory's anchor pool");
  }
  const body = nodeOf(m.txn, 'body')!;
  if (body.cls !== 'BlockValidatorAnchor' && body.cls !== 'DirectoryAnchor') {
    throw new VerifyError(`partition anchor is ${bodyTypeName(body)}, not a block validator or directory anchor`);
  }
  return {
    seq: m,
    tx: m.txnHash!,
    directory: body.cls === 'DirectoryAnchor',
    body: {
      source: urlOf(body, 'source'),
      minorBlockIndex: Number(bigOf(body, 'minorBlockIndex')),
      rootChainAnchor: hash32(body, 'rootChainAnchor'),
      stateTreeAnchor: hash32(body, 'stateTreeAnchor'),
    },
  };
}

function bodyTypeName(body: WireNode): string {
  return body.cls;
}

/**
 * partition(): the id of the partition the anchor proves ("Directory" or "BVN2"), derived from the committed body's Source, with the
 * wrapper's Source required to agree and the anchor's kind required to be the one that partition's kind is proven by.
 */
export function partitionOfAnchor(a: PartitionAnchor21): string {
  const block = a.body.minorBlockIndex;
  if (!a.body.source) throw refusal21(State.ForeignPartitionMismatch, '', block, 'the anchor body names no source');
  const id = parsePartitionUrl(a.body.source);
  if (id === undefined) throw refusal21(State.ForeignPartitionMismatch, '', block, `the anchor's source ${a.body.source.toString()} is not a partition`);
  if (!goEqualFold(a.seq.source!.toString(), a.body.source.toString())) {
    throw refusal21(State.ForeignPartitionMismatch, id, block, `url ${a.body.source}: the anchor's body (the committed value) names ${a.body.source}, the message that delivered it ${a.seq.source}`);
  }
  const isDir = goEqualFold(id, DIRECTORY);
  if (isDir && !a.directory) {
    throw refusal21(State.ForeignPartitionMismatch, id, block, `url ${a.body.source}: the Directory is proven by a DirectoryAnchor, this anchor is a BlockValidatorAnchor`);
  }
  if (!isDir && a.directory) {
    throw refusal21(State.ForeignPartitionMismatch, id, block, `url ${a.body.source}: a block validator partition is proven by a BlockValidatorAnchor, this anchor is a DirectoryAnchor`);
  }
  return id;
}

export { hexBytes };
