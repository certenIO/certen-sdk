import {
  CertenError,
  normalizeAdditionalAuthorities,
  normalizeExpiresAt,
  parseDuration,
  describeReasonCode,
} from '@certen.io/sdk';
import { UsageError } from './errors.js';
import { hint, isJsonMode } from './output.js';

/**
 * `--authority` and `--expires-in`: the transaction-header fields, as flags.
 *
 * The rules live in the SDK (`header-fields.ts`) and are only translated here, so the CLI, the SDK
 * and the MCP server refuse exactly the same inputs. Translation matters for one reason: the SDK
 * reports a local refusal with status 0, which the CLI's exit-code mapping reads as "gateway
 * unreachable" (exit 3). A bad flag is a usage error (exit 2), and is raised as one here before any
 * request is made, any passphrase is asked for, or any Idempotency-Key is spent.
 */

/** commander's collector for a repeatable option. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export const AUTHORITY_HELP =
  'Extra header authority (acc://… key book) that must also sign; repeatable, at most 8. '
  + 'REFUSED BY DEFAULT by the gateway (HEADER_AUTHORITY_NOT_EXECUTABLE) — see below';

export const EXPIRES_IN_HELP =
  'Deadline for signatures, from now: 90s to 7d, e.g. 30m, 2h. Unsigned past it, the intent ends failed/expired';

export const HEADER_FIELDS_HELP = `
Header authorities and deadlines:
  --authority adds a key book to the Accumulate transaction header. The gateway refuses it by
  default (HTTP 422, HEADER_AUTHORITY_NOT_EXECUTABLE) because CERTEN validators do not yet execute
  intents that carry header authorities: the intent would collect every signature and still never
  run. To require a co-signer, make its key book an authority on the ACCOUNT instead
  (certen governance add-authority), or have it accept in a separate transaction first.

  --expires-in sets expires_at = now + duration, measured when the intent is opened (after any
  passphrase prompt). Allowed: 90s to 7d (the gateway accepts 60s to 7d; the CLI keeps a margin for
  latency). If a required signature is still missing when it passes, the intent ends failed with
  reason_code "expired": nothing executes, no fee or gas.
`;

function asUsage(err: unknown, flag: string, code: string): never {
  if (err instanceof CertenError) {
    throw new UsageError(err.message.startsWith(flag) ? err.message : `${flag}: ${err.message}`, code);
  }
  throw err;
}

/** `--authority` values, validated and normalised (lowercased, de-duplicated). Undefined when none. */
export function parseAuthorityFlags(values: string[] | undefined): string[] | undefined {
  try {
    return normalizeAdditionalAuthorities(values, '--authority');
  } catch (err) {
    return asUsage(err, '--authority', 'INVALID_AUTHORITY');
  }
}

/** `--expires-in 30m` → an RFC 3339 `expires_at` that many units from `now`. Undefined when absent. */
export function parseExpiresIn(value: string | undefined, now: number = Date.now()): string | undefined {
  if (value === undefined) return undefined;
  let ms: number;
  try {
    ms = parseDuration(value);
  } catch (err) {
    return asUsage(err, '--expires-in', 'INVALID_EXPIRES_IN');
  }
  try {
    return normalizeExpiresAt(new Date(now + ms), now);
  } catch (err) {
    return asUsage(err, '--expires-in', 'INVALID_EXPIRES_IN');
  }
}

const HEADER_KEYS = ['reason_code', 'completion_basis', 'expires_at', 'additional_authorities'] as const;

/**
 * The transaction as `tx status` reports it: the gateway's object, with the header and outcome
 * fields always present (null when the gateway did not send them), so a script can read them
 * without first checking the gateway version. Purely additive.
 */
export function withOutcomeFields(tx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...tx };
  for (const key of HEADER_KEYS) if (out[key] === undefined) out[key] = null;
  return out;
}

/** A human line per outcome field worth reading. stderr, table mode only. */
export function emitOutcomeHints(tx: Record<string, unknown>): void {
  if (isJsonMode()) return;
  const reason = typeof tx.reason_code === 'string' ? tx.reason_code : undefined;
  if (reason) {
    hint('');
    hint(`  Reason: ${reason} — ${describeReasonCode(reason)}`);
  }
  if (typeof tx.completion_basis === 'string') {
    hint(`  Completed on: ${tx.completion_basis}`);
  }
  if (typeof tx.expires_at === 'string' && !['completed', 'delivered', 'proven'].includes(String(tx.status))) {
    hint(`  Expires at: ${tx.expires_at}`);
  }
}
