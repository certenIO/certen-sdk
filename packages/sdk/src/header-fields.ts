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

/** The gateway's limit on DISTINCT books, counted after normalisation. More is refused with a 400. */
export const MAX_ADDITIONAL_AUTHORITIES = 8;
/** The gateway's longest accepted authority URL, checked on the raw entry. */
export const MAX_AUTHORITY_URL_LENGTH = 512;

/**
 * The gateway's default deadline window: 60 s to 7 days from its clock, in whole seconds
 * (`INTENT_EXPIRY_MIN_S` / `INTENT_EXPIRY_MAX_S`, refused as `EXPIRES_AT_OUT_OF_RANGE`).
 */
export const GATEWAY_EXPIRY_MIN_S = 60;
export const GATEWAY_EXPIRY_MAX_S = 7 * 24 * 3600;
/**
 * The minimum refused LOCALLY. Higher than the gateway's 60 s on purpose: the deadline is measured
 * when the call is made and checked when the request lands, and a signing prompt, a funding check
 * and the round trip all sit in between. A deadline that passes the local check and fails the remote
 * one costs a request and reads as a gateway fault; 30 s of margin makes that practically impossible.
 */
export const LOCAL_EXPIRY_MIN_S = 90;

/** RFC 3339 date-time with a timezone — the gateway's exact pattern. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
/** An Accumulate URL with a non-empty host and no whitespace — the gateway's exact pattern. */
const ACC_URL = /^acc:\/\/[^\s/][^\s]*$/;

/** The gateway's normalisation: trim, lowercase, strip trailing slashes. */
function normalizeUrl(u: string): string {
  return u.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Validate and normalise `additionalAuthorities` exactly as the gateway does: each entry a string of
 * at most 512 characters; trimmed, lowercased and stripped of trailing slashes; then an `acc://` URL
 * with a non-empty host; de-duplicated in caller order; and only THEN at most eight distinct books.
 *
 * Returns `undefined` for an absent or empty list, so the request body carries the field only when
 * it means something. (The gateway additionally refuses the identity's own key book, which needs
 * server-side knowledge and is not mirrored here.)
 */
export function normalizeAdditionalAuthorities(value: unknown, where = 'additionalAuthorities'): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new CertenError(`${where} must be an array of acc:// key book URLs`, 0, 'INVALID_ADDITIONAL_AUTHORITIES');
  }
  const out: string[] = [];
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.length > MAX_AUTHORITY_URL_LENGTH) {
      throw new CertenError(
        `${where}[${i}] must be a string of at most ${MAX_AUTHORITY_URL_LENGTH} characters`,
        0, 'INVALID_ADDITIONAL_AUTHORITIES',
      );
    }
    const url = normalizeUrl(entry);
    if (!ACC_URL.test(url)) {
      throw new CertenError(
        `${where}[${i}] ${JSON.stringify(entry)} is not an Accumulate URL — expected acc://<host>…, e.g. acc://firm.acme/book`,
        0, 'INVALID_ADDITIONAL_AUTHORITIES',
      );
    }
    if (!out.includes(url)) out.push(url);
  }
  if (out.length > MAX_ADDITIONAL_AUTHORITIES) {
    throw new CertenError(
      `${where} names ${out.length} distinct books; at most ${MAX_ADDITIONAL_AUTHORITIES} are allowed`,
      0, 'INVALID_ADDITIONAL_AUTHORITIES',
    );
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate `expiresAt` and render it as RFC 3339.
 *
 * A `Date` becomes its ISO string; a string must be RFC 3339 with a timezone and is passed through
 * trimmed. The deadline, in whole seconds as the gateway counts it, must be between 90 s (local
 * margin over the gateway's 60 s minimum) and 7 days from now.
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
    iso = value.trim();
    at = Date.parse(iso);
    if (!RFC3339.test(iso) || !Number.isFinite(at)) {
      throw new CertenError(
        `${where} "${value}" is not an RFC 3339 date-time with a timezone, e.g. 2026-09-14T12:00:00Z`,
        0, 'INVALID_EXPIRES_AT',
      );
    }
  } else {
    throw new CertenError(`${where} must be a Date or an RFC 3339 string`, 0, 'INVALID_EXPIRES_AT');
  }
  const deltaS = Math.floor(at / 1000) - Math.floor(now / 1000);
  if (deltaS <= 0) {
    throw new CertenError(
      `${where} ${iso} is in the past — it must be between ${LOCAL_EXPIRY_MIN_S}s and ${GATEWAY_EXPIRY_MAX_S}s (7 days) from now`,
      0, 'INVALID_EXPIRES_AT',
    );
  }
  if (deltaS < LOCAL_EXPIRY_MIN_S) {
    throw new CertenError(
      `${where} is only ${deltaS}s away. The gateway requires at least ${GATEWAY_EXPIRY_MIN_S}s when the request arrives; `
      + `the SDK asks for ${LOCAL_EXPIRY_MIN_S}s so signing and network time cannot push it under. Use a later deadline.`,
      0, 'INVALID_EXPIRES_AT',
    );
  }
  if (deltaS > GATEWAY_EXPIRY_MAX_S) {
    throw new CertenError(
      `${where} is ${deltaS}s away; the gateway allows at most ${GATEWAY_EXPIRY_MAX_S}s (7 days)`,
      0, 'INVALID_EXPIRES_AT',
    );
  }
  return iso;
}

/** Codes of the local header-field refusals above. Status 0: raised before any request. */
export const HEADER_FIELD_ERROR_CODES: readonly string[] = [
  'INVALID_ADDITIONAL_AUTHORITIES', 'INVALID_EXPIRES_AT', 'INVALID_DURATION',
];

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
