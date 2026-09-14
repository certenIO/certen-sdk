import { CertenError } from './errors.js';

/**
 * Transaction-header fields an intent may carry: extra authorities and a deadline.
 *
 * Both are forwarded to Accumulate as part of the transaction header. They are validated here with
 * the same rules the gateway applies, so a mistake is refused before an Idempotency-Key is spent and
 * before anything is signed — not after a round trip that names a snake_case field the caller never
 * typed.
 *
 * Header authorities are REFUSED by the gateway by default (HTTP 422,
 * `HEADER_AUTHORITY_NOT_EXECUTABLE`): the validators do not yet count a header authority's
 * signature, so an intent carrying one would sit pending, collect every signature, and then never
 * execute. Put a party that must co-sign on the ACCOUNT's authorities instead. The field is exposed
 * so a deployment that has turned the gateway guard off can use it, and so the SDK does not need a
 * release when the validator fix lands.
 */

/** The gateway's limit. More than this is refused with a 400. */
export const MAX_ADDITIONAL_AUTHORITIES = 8;

/** RFC 3339 date-time with an explicit offset — what the gateway's `format: date-time` accepts. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

/**
 * Validate and normalise `additionalAuthorities` the way the server does: every entry an
 * `acc://` URL, at most eight, lowercased and de-duplicated.
 *
 * Returns `undefined` for an absent or empty list, so the request body carries the field only when
 * it means something.
 */
export function normalizeAdditionalAuthorities(value: unknown, where = 'additionalAuthorities'): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new CertenError(`${where} must be an array of acc:// key book URLs`, 0, 'INVALID_ADDITIONAL_AUTHORITIES');
  }
  if (value.length > MAX_ADDITIONAL_AUTHORITIES) {
    throw new CertenError(
      `${where} names ${value.length} authorities; at most ${MAX_ADDITIONAL_AUTHORITIES} are allowed`,
      0, 'INVALID_ADDITIONAL_AUTHORITIES',
    );
  }
  const out: string[] = [];
  for (const entry of value) {
    const url = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!/^acc:\/\/\S+$/.test(url)) {
      throw new CertenError(
        `${where}: ${JSON.stringify(entry)} is not an Accumulate URL — expected acc://…, e.g. acc://firm.acme/book`,
        0, 'INVALID_ADDITIONAL_AUTHORITIES',
      );
    }
    if (!out.includes(url)) out.push(url);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate `expiresAt` and render it as RFC 3339.
 *
 * A `Date` becomes its ISO string; a string must already be RFC 3339 with an offset and is passed
 * through as written. Either must be in the future: a deadline that has already passed produces an
 * intent that can only ever end `failed/expired`, and refusing it is cheaper than paying to learn it.
 */
export function normalizeExpiresAt(value: unknown, now: number = Date.now(), where = 'expiresAt'): string | undefined {
  if (value === undefined || value === null) return undefined;
  let iso: string;
  let at: number;
  if (value instanceof Date) {
    at = value.getTime();
    if (!Number.isFinite(at)) throw new CertenError(`${where} is an invalid Date`, 0, 'INVALID_EXPIRES_AT');
    iso = value.toISOString();
  } else if (typeof value === 'string') {
    at = Date.parse(value);
    if (!RFC3339.test(value) || !Number.isFinite(at)) {
      throw new CertenError(
        `${where} "${value}" is not an RFC 3339 date-time, e.g. 2026-09-14T12:00:00Z`,
        0, 'INVALID_EXPIRES_AT',
      );
    }
    iso = value;
  } else {
    throw new CertenError(`${where} must be a Date or an RFC 3339 string`, 0, 'INVALID_EXPIRES_AT');
  }
  if (at <= now) {
    throw new CertenError(
      `${where} ${iso} is not in the future — an intent with a passed deadline can only end failed/expired`,
      0, 'INVALID_EXPIRES_AT',
    );
  }
  return iso;
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `"90s"`, `"30m"`, `"2h"`, `"7d"` → milliseconds. One positive integer and one unit; anything else
 * throws, because a deadline is not a place to guess what a caller meant.
 */
export function parseDuration(text: string): number {
  const m = /^\s*(\d+)\s*([smhd])\s*$/i.exec(String(text ?? ''));
  const n = m ? Number(m[1]) : NaN;
  if (!m || !Number.isSafeInteger(n) || n <= 0) {
    throw new CertenError(
      `duration "${text}" is not valid — use a positive whole number followed by s, m, h or d, e.g. 30m`,
      0, 'INVALID_DURATION',
    );
  }
  return n * UNIT_MS[m[2].toLowerCase()];
}

/** A deadline `duration` from now, for `expiresAt`: `expiresAt: expiresIn('30m')`. */
export function expiresIn(duration: string | number, now: number = Date.now()): Date {
  const ms = typeof duration === 'number' ? duration : parseDuration(duration);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new CertenError(`expiresIn needs a positive duration, got ${JSON.stringify(duration)}`, 0, 'INVALID_DURATION');
  }
  return new Date(now + ms);
}

/** Both header fields, validated, as the snake_case body keys the gateway expects. */
export function headerFieldsBody(p: { additionalAuthorities?: unknown; expiresAt?: unknown }): {
  additional_authorities?: string[];
  expires_at?: string;
} {
  return {
    additional_authorities: normalizeAdditionalAuthorities(p.additionalAuthorities),
    expires_at: normalizeExpiresAt(p.expiresAt),
  };
}
