import { CertenError } from './errors.js';

/**
 * What `POST /v1/sign` should be told about a target the user named.
 *
 * `transaction` is deliberately absent: the gateway rejects that type and points the caller at
 * `POST /v1/transaction/{id}/signature`, so there is no user-supplied string that should resolve
 * to it.
 */
export type SignTarget =
  | { type: 'pending_action'; targetId: string }
  | { type: 'pending_tx'; targetId: string };

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TXID_RE = /^acc:\/\/([0-9a-fA-F]{64})@/;
const HASH_RE = /^(?:0x)?([0-9a-fA-F]{64})$/;

const ACCEPTED =
  'accepted forms: a pending-action inbox id (UUID), a 64-character transaction hash, '
  + 'the same hash with a 0x prefix, or a TxID (acc://<hash>@<account>)';

/**
 * Resolve a user-supplied target into a `/v1/sign` type and `target_id`.
 *
 * The two id formats are disjoint, so the type can be inferred and neither the CLI nor MCP needs a
 * `--type` flag that would only be a new way to get it wrong:
 *
 * - a UUID is a `pending_actions` row id — the gateway derives identity, signer and key from it
 * - a 64-hex hash is an Accumulate transaction — the caller must supply those three itself
 *
 * The TxID form is accepted because that is what the explorer, `queryTx` and our own `/v1/sign`
 * responses hand people. Requiring a manual strip would fail as an opaque gateway 400.
 *
 * ONE implementation, in the SDK, imported by both clients. Two copies would drift, and the failure
 * mode of a drifted resolver is a signature over the wrong preimage — valid, and attached to
 * nothing.
 *
 * @throws {CertenError} code `INVALID_SIGN_TARGET` — never guesses at an unrecognised form.
 */
export function resolveSignTarget(input: string): SignTarget {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    throw new CertenError(
      `certen: no sign target given (${ACCEPTED})`,
      0,
      'INVALID_SIGN_TARGET',
    );
  }

  // UUID first: it cannot collide with either hash form (different length, and it contains dashes).
  if (UUID_RE.test(raw)) return { type: 'pending_action', targetId: raw };

  const txid = TXID_RE.exec(raw);
  if (txid) return { type: 'pending_tx', targetId: txid[1].toLowerCase() };

  const hash = HASH_RE.exec(raw);
  if (hash) return { type: 'pending_tx', targetId: hash[1].toLowerCase() };

  throw new CertenError(
    `certen: "${raw}" is not a sign target (${ACCEPTED})`,
    0,
    'INVALID_SIGN_TARGET',
  );
}
