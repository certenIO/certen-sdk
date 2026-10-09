import { bytesToHex, concatBytes, hexToBytes, utf8 } from './bytes.js';
import { sha256 } from './sha256.js';
import { maybeWebCrypto } from './random.js';
import type { CertenClient } from './client.js';
import type { Receipt, ReceiptProof, ReceiptVerification, ReceiptCheck } from './types.js';

/**
 * Check a receipt yourself, without trusting the answer CERTEN gives about its own work.
 *
 * The gateway returns a `verification` block on every receipt. It is honest and it is useless on
 * its own: it is CERTEN checking CERTEN. Its actual worth is that every check in it is reproducible
 * from published data — and until now nothing reproduced them, so in practice the claim was taken
 * on faith by everyone who read it.
 *
 * This runs the four checks the receipt's own instructions describe:
 *
 *   1. `digest` is sha256 of the canonical JSON of `body` — the amount is a consequence of the
 *      receipt's contents, not a number printed beside them.
 *   2. The ed25519 signature over those digest bytes verifies against a key from the PUBLISHED key
 *      set, not against whatever the receipt asserted about itself.
 *   3. The salted leaf hash matches — this receipt is that leaf.
 *   4. The audit path folds to a root, and that root equals the one on a signed head fetched
 *      SEPARATELY from `/v1/transparency/heads/{treeSize}`. Comparing against the `root_hash` that
 *      travelled inside the proof would prove nothing at all; the independent fetch is the check.
 *
 * Every check reports `ok: false` with a reason rather than throwing, and an unavailable
 * transparency log downgrades the inclusion checks to `skipped` — never to `ok`. A verifier that
 * cannot reach the log must say so, because "I could not check" and "it checks out" are the two
 * answers a dispute must never confuse.
 */

/** Canonical JSON: keys sorted at every level, no whitespace. The form that was hashed. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** This runtime's Web Crypto cannot verify ed25519. Not a bad signature: the check could not be made. */
class Ed25519Unavailable extends Error {}

/**
 * Verify an ed25519 signature with Web Crypto (Node >= 22 and current browsers), so the same code runs in both.
 * Resolves false for a signature or key that is malformed or does not verify; throws `Ed25519Unavailable` when the runtime cannot
 * verify ed25519 at all, so that case is reported as "could not check" and never as ok.
 */
async function verifyEd25519(publicKeyHex: string, message: Uint8Array, signatureHex: string): Promise<boolean> {
  const subtle = maybeWebCrypto()?.subtle;
  if (!subtle) throw new Ed25519Unavailable('no Web Crypto (crypto.subtle) in this runtime');
  let pub: Uint8Array;
  let sig: Uint8Array;
  try {
    pub = hexToBytes(publicKeyHex);
    sig = hexToBytes(signatureHex);
  } catch {
    return false;
  }
  let key: unknown;
  try {
    key = await subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
  } catch (err) {
    if ((err as { name?: string }).name === 'NotSupportedError') throw new Ed25519Unavailable('this runtime does not support ed25519 in Web Crypto');
    return false; // a key that is not a valid ed25519 public key
  }
  try {
    return await subtle.verify({ name: 'Ed25519' }, key, sig, message);
  } catch {
    return false;
  }
}

/** Fold an RFC 6962 section 2.1.1 audit path from a leaf to the root it implies. */
export function foldAuditPath(leafHashHex: string, leafIndex: number, treeSize: number, path: string[]): string {
  let hash = hexToBytes(leafHashHex);
  let index = leafIndex;
  let size = treeSize;
  const NODE = new Uint8Array([0x01]);
  for (const siblingHex of path) {
    const sibling = hexToBytes(siblingHex);
    // The right-hand branch when this node is a right child, OR when it is the last node at this
    // level — the case that makes an unbalanced tree fold correctly and the one most often dropped.
    const pair = index % 2 === 1 || index + 1 === size
      ? concatBytes(NODE, sibling, hash)
      : concatBytes(NODE, hash, sibling);
    hash = sha256(pair);
    index = Math.floor(index / 2);
    size = Math.floor((size + 1) / 2);
  }
  return bytesToHex(hash);
}

export async function verifyReceipt(
  client: CertenClient,
  receiptId: string,
): Promise<ReceiptVerification> {
  const checks: ReceiptCheck[] = [];
  const add = (name: string, status: ReceiptCheck['status'], detail: string) =>
    checks.push({ name, status, detail });

  const receipt: Receipt = await client.billing.receipt(receiptId);

  // ── 1. The digest follows from the body ─────────────────────────────────────────────────────
  if (receipt.body === undefined || receipt.body === null) {
    add('digest', 'skipped', 'The receipt carries no body to hash.');
  } else {
    const computed = bytesToHex(sha256(utf8(canonicalJson(receipt.body))));
    add('digest', computed === receipt.digest ? 'ok' : 'failed',
      computed === receipt.digest
        ? 'sha256(canonical_json(body)) matches the stated digest.'
        : `Recomputed ${computed}, receipt states ${receipt.digest}.`);
  }

  // ── 2. The signature is CERTEN's, against the PUBLISHED key set ─────────────────────────────
  if (!receipt.signature || !receipt.key_id) {
    add('signature', 'skipped', 'This receipt is not signed yet.');
  } else {
    let keys;
    try {
      keys = (await client.billing.verificationKeys()).keys ?? [];
    } catch (err) {
      keys = null;
      add('signature', 'skipped',
        `Could not fetch the published key set: ${(err as Error).message}`);
    }
    if (keys) {
      const key = keys.find((k) => k.key_id === receipt.key_id);
      if (!key) {
        // A signature from a key nobody published is not a weaker signature; it is no signature.
        add('signature', 'failed',
          `Signed with key ${receipt.key_id}, which is not in the published key set.`);
      } else {
        let digestBytes: Uint8Array | null = null;
        try { digestBytes = hexToBytes(receipt.digest); } catch { /* reported below */ }
        try {
          const ok = digestBytes !== null && await verifyEd25519(key.public_key, digestBytes, receipt.signature);
          add('signature', ok ? 'ok' : 'failed',
            ok ? `ed25519 signature verifies against published key ${key.key_id}.`
              : `ed25519 signature does NOT verify against published key ${key.key_id}.`);
        } catch (err) {
          // The runtime cannot verify ed25519: "I could not check", which is never the same as "it checks out".
          add('signature', 'skipped', `Could not verify the ed25519 signature: ${(err as Error).message}.`);
        }
      }
    }
  }

  // ── 3 & 4. Inclusion in a log whose root was independently fetched ──────────────────────────
  let proof: ReceiptProof | null = null;
  try {
    proof = await client.billing.receiptProof(receiptId);
  } catch {
    add('inclusion', 'skipped',
      'Not in the transparency log yet — no inclusion proof exists. The signature above still stands.');
    add('root', 'skipped', 'No inclusion proof to check a root against.');
  }

  if (proof) {
    let leaf: string;
    let folded: string;
    try {
      leaf = bytesToHex(sha256(concatBytes(new Uint8Array([0x00]), hexToBytes(proof.leaf_salt), utf8(canonicalJson(receipt.body)))));
      folded = foldAuditPath(proof.leaf_hash, proof.leaf_index, proof.tree_size, proof.audit_path ?? []);
    } catch (err) {
      // A proof with malformed hex is a failed check with a reason, not an exception out of a verifier that reports rather than throws.
      add('inclusion', 'failed', `The inclusion proof is malformed: ${(err as Error).message}.`);
      add('root', 'skipped', 'No well-formed inclusion proof to check a root against.');
      return { receipt_id: receiptId, verified: false, complete: false, checks };
    }
    add('inclusion', leaf === proof.leaf_hash ? 'ok' : 'failed',
      leaf === proof.leaf_hash
        ? `This receipt is leaf ${proof.leaf_index} of ${proof.tree_size}.`
        : `Recomputed leaf ${leaf}, proof states ${proof.leaf_hash}.`);


    // The independent fetch. Checking `folded` against `proof.root_hash` would compare the proof
    // with itself; the point is to compare it with a separately served, separately signed head.
    let head = null;
    try {
      head = await client.transparency.head(proof.tree_size);
    } catch (err) {
      add('root', 'skipped',
        `Could not fetch the signed head at tree size ${proof.tree_size}: ${(err as Error).message}`);
    }
    if (head) {
      const matches = folded === head.root_hash;
      add('root', matches ? 'ok' : 'failed',
        matches
          ? `Audit path folds to the root of the independently fetched signed head at ${proof.tree_size}.`
          : `Audit path folds to ${folded}, but the signed head at ${proof.tree_size} says ${head.root_hash}.`);
    }

    // ── Anchoring: a time bound from a third party, not from us ────────────────────────────────
    //
    // `covering_head`, never `head`. A receipt's own head may not have been written to Accumulate
    // individually while a LATER anchored root still commits to its leaf; reading `head` reports
    // every receipt between anchors as unanchored.
    const anchor = proof.covering_head;
    if (!anchor || anchor.anchor_status !== 'anchored') {
      add('anchor', 'skipped',
        'No anchored tree head covers this receipt yet. Until one does, the log is attested by '
        + "CERTEN's signature alone and carries no third-party time bound.");
    } else if (anchor.timestamp_attested) {
      add('anchor', 'ok',
        `Anchored on Accumulate in ${anchor.anchor_tx_hash}; the log existed no later than `
        + `${anchor.anchor_block_time} (the block's own timestamp).`);
    } else {
      // Reporting an unattested time as exact would overstate what the anchor proves, which is the
      // one thing a timestamp claim must never do.
      add('anchor', 'ok',
        `Anchored on Accumulate in ${anchor.anchor_tx_hash}. The time bound `
        + `${anchor.anchor_block_time} is a loose upper bound, not the block's own timestamp.`);
    }
  }

  return {
    receipt_id: receiptId,
    // Only a FAILED check makes this false. A skipped one leaves `verified` false too, via
    // `complete` — "not fully checked" must never read as "checks out".
    verified: checks.every((c) => c.status === 'ok'),
    complete: checks.every((c) => c.status !== 'skipped'),
    checks,
  };
}
