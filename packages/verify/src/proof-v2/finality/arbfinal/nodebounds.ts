/**
 * The spec 8.2 split of the NODES bound (the twin of pkg/finality/arbfinal/nodebounds.go): the decoder bounds every element by
 * max_tx_leaf_bytes because the transaction and receipt proof paths are only known once K is on the covered spine; here, with K's roots,
 * every element that is not read by the walk of key rlp(confTxIndex) from K's transactionsRoot or receiptsRoot is a state, storage or
 * unreferenced node and must be at most max_node_bytes (finality_evidence_too_large{part:"nodes", count: its length, limit, index: its
 * position in the ascending NODES order}).
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { MptError, ProofDb, verifyProofIn } from '../../../s6/mpt.js';
import { RlpError } from '../../../s6/rlp.js';
import { rlpIndexKey } from '../baseposted/trie.js';
import type { HeaderFields } from '../rlpheader.js';
import { evidenceTooLarge, hexLower } from '../state.js';
import type { Evidence } from './wire.js';

/** A proof database that remembers which nodes a proof walk read (Go pathRecorder). */
class PathRecorder extends ProofDb {
  readonly seen = new Set<string>();
  override get(hash: Uint8Array): Uint8Array | undefined {
    const v = super.get(hash);
    if (v !== undefined) this.seen.add(hexLower(hash));
    return v;
  }
}

/** The proof database keeps no empty node: an empty node can never be a trie node and is never looked up (Go's memorydb accepts one and the walk then refuses it). */
const nonEmpty = (nodes: readonly Uint8Array[]): Uint8Array[] => nodes.filter((n) => n.length > 0);

/**
 * The set of node hashes (keccak256, lower-case hex) that the walk of key rlp(index) from root reads out of nodes. A walk that fails
 * part-way still reports what it read; the proof itself is judged by proveLeaf.
 */
function proofPathNodes(root: Uint8Array, index: number, nodes: readonly Uint8Array[], seen: Set<string>): void {
  const db = new PathRecorder(nonEmpty(nodes));
  try {
    verifyProofIn(db, root, rlpIndexKey(index));
  } catch (e) {
    if (!(e instanceof MptError || e instanceof RlpError)) throw e;
  }
  for (const h of db.seen) seen.add(h);
}

/** checkNodeBounds: finality_evidence_too_large{part:"nodes", index} for the first element above maxNodeBytes that no transaction or receipt walk reads. */
export function checkNodeBounds(kHeader: HeaderFields, e: Evidence, maxNodeBytes: number): void {
  if (!e.nodes.some((n) => n.length > maxNodeBytes)) return;
  const onPath = new Set<string>();
  proofPathNodes(kHeader.transactionRoot, e.confTxIndex, e.nodes, onPath);
  proofPathNodes(kHeader.receiptsRoot, e.confTxIndex, e.nodes, onPath);
  for (let i = 0; i < e.nodes.length; i++) {
    const n = e.nodes[i]!;
    if (n.length <= maxNodeBytes) continue;
    if (onPath.has(hexLower(keccak_256(n)))) continue;
    const s = evidenceTooLarge('nodes', n.length, maxNodeBytes);
    s.fields.index = BigInt(i);
    throw s;
  }
}
