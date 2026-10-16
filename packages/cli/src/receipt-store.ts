import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RECEIPT_VERSION, type Receipt } from '@certen.io/sdk';
import { CliError, UsageError, EXIT } from './errors.js';
import { uuidArg } from './next-step.js';

/**
 * `~/.certen/receipts/<intent>.json`: the record the docs have always told people to keep, kept.
 *
 * A receipt holds ids, addresses, hashes, verdicts and the gateway's address. It holds no secret (no key, no passphrase, no API key, and
 * no node URL, which can carry one), so it is safe to attach to a ticket or paste into a chat. It is still written 0600 in a 0700 directory:
 * it says who paid whom, and that is the owner's business.
 *
 * **Written atomically.** A receipt is rewritten as the proof arrives, and a Ctrl-C or a full disk in the middle of a write must leave the
 * previous receipt intact rather than half of a new one. The file is written beside its name and renamed over it.
 *
 * **Resolved when called, not when loaded.** The directory follows the current home so a test that points `HOME` at a temporary directory
 * cannot write the developer's real one.
 */

const UUID_LIKE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;

export function receiptsDir(): string {
  return join(homedir(), '.certen', 'receipts');
}

/** The path for an intent id. The id becomes a file name, so anything that is not plainly an id is refused rather than sanitised. */
export function receiptPath(intentId: string): string {
  if (!UUID_LIKE.test(intentId)) {
    throw new UsageError(`"${intentId}" is not an intent id. It looks like 7c1e3b0a-5d2f-4c6e-9a1b-0e8f2d4a6b13.`, 'INVALID_INTENT_ID');
  }
  return join(receiptsDir(), `${intentId}.json`);
}

/** Write (or replace) the receipt for its intent. Returns the path written. */
export function saveReceipt(receipt: Receipt): string {
  const path = receiptPath(receipt.intent_id);
  const dir = receiptsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* Windows or a filesystem without modes: best effort, as config.json does. */ }
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw new CliError(
      `Could not save the receipt to ${path}: ${err instanceof Error ? err.message : String(err)}. The transaction itself is unaffected; keep the intent id ${receipt.intent_id}.`,
      'RECEIPT_NOT_SAVED',
      EXIT.FAILED,
      false,
      undefined,
      `certen receipt ${uuidArg(receipt.intent_id, '<intent-id>')}`,
    );
  }
  return path;
}

export type LoadedReceipt =
  | { state: 'absent' }
  | { state: 'ok'; receipt: Receipt; path: string }
  | { state: 'unusable'; path: string; reason: string };

/**
 * Read a saved receipt.
 *
 * A file that cannot be used (not JSON, another intent's, written by a newer CLI) is reported as unusable with the reason, never as absent and
 * never half-used: the caller says so and rebuilds from the gateway, and the unusable file is left alone for a person to look at.
 */
export function loadReceipt(intentId: string): LoadedReceipt {
  const path = receiptPath(intentId);
  if (!existsSync(path)) return { state: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { state: 'unusable', path, reason: `it is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const r = parsed as Partial<Receipt> | null;
  if (!r || typeof r !== 'object') return { state: 'unusable', path, reason: 'it is not a receipt' };
  if (typeof r.receipt_version !== 'number' || r.receipt_version > RECEIPT_VERSION) {
    return { state: 'unusable', path, reason: `it is receipt version ${String(r.receipt_version)}, and this certen reads up to ${RECEIPT_VERSION}: upgrade @certen.io/cli` };
  }
  if (r.intent_id !== intentId) return { state: 'unusable', path, reason: `it describes intent ${String(r.intent_id)}, not ${intentId}` };
  return { state: 'ok', receipt: r as Receipt, path };
}

export interface ReceiptListing {
  intent_id: string;
  updated_at: string;
  verdict: string;
  kind: string;
  headline: string;
  path: string;
}

/** Every receipt that can be read, newest first. A file that cannot be read is skipped here (it is reported by `loadReceipt`). */
export function listReceipts(): ReceiptListing[] {
  const dir = receiptsDir();
  if (!existsSync(dir)) return [];
  const out: ReceiptListing[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!UUID_LIKE.test(id)) continue;
    const loaded = loadReceipt(id);
    if (loaded.state !== 'ok') continue;
    const r = loaded.receipt;
    out.push({ intent_id: id, updated_at: r.updated_at, verdict: r.verdict, kind: r.kind, headline: r.headline, path: loaded.path });
  }
  return out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}
