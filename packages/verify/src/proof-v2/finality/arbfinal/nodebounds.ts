/**
 * The spec 8.2 split of the NODES bound (the twin of pkg/finality/arbfinal/nodebounds.go): the decoder bounds every element by
 * max_tx_leaf_bytes because the transaction and receipt proof paths are only known once K is on the covered spine; here, with K's roots,
 * every element that is not read by the walk of key rlp(confTxIndex) from K's transactionsRoot or receiptsRoot is a state, storage or
 * unreferenced node and must be at most max_node_bytes (finality_evidence_too_large{part:"nodes", count: its length, limit, index: its
 * position in the ascending NODES order}).
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { MptError, ProofNodes, verifyProofIn, type ProofReader } from '../../../s6/mpt.js';
import { RlpError } from '../../../s6/rlp.js';
import { rlpIndexKey } from '../baseposted/trie.js';
import type { HeaderFields } from '../rlpheader.js';
import { evidenceTooLarge, hexLower } from '../state.js';
import type { Evidence } from './wire.js';

/**
 * A reader of the shared proof database that remembers which nodes a proof walk read (Go pathRecorder). The database is the one of the
 * verification (ProofNodes.reader(): it keeps no empty node, which can never be a trie node and is never looked up; Go's memorydb accepts one
 * and the walk then refuses it), not a new one per walk.
 */
class PathRecorder implements ProofReader {
  readonly seen = new Set<string>();
  constructor(private readonly db: ProofReader) {}
  get(hash: Uint8Array): Uint8Array | undefined {
    const v = this.db.get(hash);
    if (v !== undefined) this.seen.add(hexLower(hash));
    return v;
  }
}

/**
 * The set of node hashes (keccak256, lower-case hex) that the walk of key rlp(index) from root reads out of nodes. A walk that fails
 * part-way still reports what it read; the proof itself is judged by proveLeaf.
 */
function proofPathNodes(root: Uint8Array, index: number, set: ProofNodes, seen: Set<string>): void {
  const db = new PathRecorder(set.reader());
  try {
    verifyProofIn(db, root, rlpIndexKey(index));
  } catch (e) {
    if (!(e instanceof MptError || e instanceof RlpError)) throw e;
  }
  for (const h of db.seen) seen.add(h);
}

/**
 * checkNodeBounds: finality_evidence_too_large{part:"nodes", index} for the first element above maxNodeBytes that no transaction or receipt
 * walk reads. set is the ProofNodes of e.nodes shared with the rest of the verification (a new one when omitted).
 */
export function checkNodeBounds(kHeader: HeaderFields, e: Evidence, maxNodeBytes: number, set: ProofNodes = new ProofNodes(e.nodes)): void {
  if (!e.nodes.some((n) => n.length > maxNodeBytes)) return;
  const onPath = new Set<string>();
  proofPathNodes(kHeader.transactionRoot, e.confTxIndex, set, onPath);
  proofPathNodes(kHeader.receiptsRoot, e.confTxIndex, set, onPath);
  for (let i = 0; i < e.nodes.length; i++) {
    const n = e.nodes[i]!;
    if (n.length <= maxNodeBytes) continue;
    if (onPath.has(hexLower(keccak_256(n)))) continue;
    const s = evidenceTooLarge('nodes', n.length, maxNodeBytes);
    s.fields.index = BigInt(i);
    throw s;
  }
}
