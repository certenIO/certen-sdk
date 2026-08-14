import { createHash, verify as edVerify, createPublicKey } from 'crypto';
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

/** ed25519 SPKI prefix, so a raw 32-byte key can be handed to node's verifier. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyEd25519(publicKeyHex: string, message: Buffer, signatureHex: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return edVerify(null, message, key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/** Fold an RFC 6962 section 2.1.1 audit path from a leaf to the root it implies. */
export function foldAuditPath(leafHashHex: string, leafIndex: number, treeSize: number, path: string[]): string {
  let hash = Buffer.from(leafHashHex, 'hex');
  let index = leafIndex;
  let size = treeSize;
  for (const siblingHex of path) {
    const sibling = Buffer.from(siblingHex, 'hex');
    // The right-hand branch when this node is a right child, OR when it is the last node at this
    // level — the case that makes an unbalanced tree fold correctly and the one most often dropped.
    const pair = index % 2 === 1 || index + 1 === size
      ? Buffer.concat([Buffer.from([0x01]), sibling, hash])
      : Buffer.concat([Buffer.from([0x01]), hash, sibling]);
    hash = createHash('sha256').update(pair).digest();
    index = Math.floor(index / 2);
    size = Math.floor((size + 1) / 2);
  }
  return hash.toString('hex');
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
    const computed = createHash('sha256').update(canonicalJson(receipt.body)).digest('hex');
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
        const ok = verifyEd25519(key.public_key, Buffer.from(receipt.digest, 'hex'), receipt.signature);
        add('signature', ok ? 'ok' : 'failed',
          ok ? `ed25519 signature verifies against published key ${key.key_id}.`
            : `ed25519 signature does NOT verify against published key ${key.key_id}.`);
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
    const leaf = createHash('sha256')
      .update(Buffer.concat([
        Buffer.from([0x00]),
        Buffer.from(proof.leaf_salt, 'hex'),
        Buffer.from(canonicalJson(receipt.body), 'utf8'),
      ]))
      .digest('hex');
    add('inclusion', leaf === proof.leaf_hash ? 'ok' : 'failed',
      leaf === proof.leaf_hash
        ? `This receipt is leaf ${proof.leaf_index} of ${proof.tree_size}.`
        : `Recomputed leaf ${leaf}, proof states ${proof.leaf_hash}.`);

    const folded = foldAuditPath(proof.leaf_hash, proof.leaf_index, proof.tree_size, proof.audit_path ?? []);

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
