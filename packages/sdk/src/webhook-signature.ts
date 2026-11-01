/**
 * Signing and verifying CERTEN webhooks.
 *
 * The gateway has always signed every delivery, and its customer guide (`docs/verify-webhook.md`) has always told receivers to
 * `import { verifyWebhookSignature } from '@certen.io/sdk'`. The SDK had no such export, so every receiver hand-rolled the HMAC —
 * and the one mistake that matters here (hashing a re-serialized body instead of the bytes that arrived) is exactly what a
 * hand-rolled receiver gets wrong, because the framework parsed the body before the handler ran.
 *
 * **The scheme** (gateway `src/webhooks/webhook-signature.ts` and `webhook.service.ts`; this file is checked against both):
 *
 *     X-Certen-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>
 *
 * `body` is the request body. The gateway sends the *canonical JSON* of the payload (keys sorted at every level, no whitespace) as the
 * body itself, so a receiver hashes the raw bytes and never has to canonicalize anything. Each attempt is signed afresh with a new `t`,
 * which is why a delivery redelivered hours later still verifies.
 *
 * **What the signature covers, and what it does not.** `t` and the body, and nothing else. `X-Certen-Event`, `X-Certen-Delivery` and
 * `X-Certen-Timestamp` are plain headers: anyone who can replay a captured (body, signature) pair inside the tolerance window can
 * attach any of them. `ReceivedWebhook` therefore keeps them apart from the verified `payload`, and `timestamp` is the one taken from
 * the signed header.
 *
 * Portable: nothing here touches `node:crypto`, `Buffer` or `process`. HMAC is built on `sha256.ts` (synchronous, so a verifier is a
 * plain function in a Node handler, a Cloudflare Worker and the browser entry alike), and `webhook-signature.test.ts` holds it to
 * RFC 4231 and to `node:crypto` at every length around the block boundary.
 */

import { sha256 } from './sha256.js';
import { bytesToHex, concatBytes, hexToBytes, utf8 } from './bytes.js';
import { CertenError, CertenWebhookSignatureError } from './errors.js';
import type { WebhookSignatureFailure } from './errors.js';
import type { WebhookEventName, WebhookEventPayloads } from './webhook-events.js';

/** The only signature version the gateway emits today. A future one arrives alongside it in the same header as `v2=…`. */
export const WEBHOOK_SIGNATURE_VERSION = 'v1';
/** How far `t` may sit from now, either side, before an authentic signature is refused as a replay. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_SIGNATURE_HEADER = 'X-Certen-Signature';
/** The event name. NOT covered by the signature. */
export const WEBHOOK_EVENT_HEADER = 'X-Certen-Event';
/** One id per delivery, stable across retries and redelivery. NOT covered by the signature. Absent on the verification ping. */
export const WEBHOOK_DELIVERY_HEADER = 'X-Certen-Delivery';
/** A copy of `t`. NOT covered by the signature — read `t` from the signature header, which is. */
export const WEBHOOK_TIMESTAMP_HEADER = 'X-Certen-Timestamp';

/** The gateway refuses to sign with less (and `rotate-secret` refuses to be given less than 16). A shorter secret is a misconfiguration. */
const MIN_SECRET_LENGTH = 8;
/** The failure diagnostics re-parse the body; bound the work an unauthenticated sender can make a verifier do. */
const DIAGNOSE_MAX_BYTES = 256 * 1024;
const MAX_TIMESTAMP_DIGITS = 15;
const MAX_NESTING = 512;

// ── HMAC-SHA256 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const HMAC_BLOCK = 64;

/** HMAC-SHA256 (RFC 2104 / RFC 4231). Exported for the tests and for callers who need the primitive; not part of the package entry. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const k = key.length > HMAC_BLOCK ? sha256(key) : key;
  const inner = new Uint8Array(HMAC_BLOCK);
  const outer = new Uint8Array(HMAC_BLOCK);
  for (let i = 0; i < HMAC_BLOCK; i++) {
    const b = i < k.length ? k[i] : 0;
    inner[i] = b ^ 0x36;
    outer[i] = b ^ 0x5c;
  }
  return sha256(concatBytes(outer, sha256(concatBytes(inner, message))));
}

/** Equal-length byte comparison that does not stop at the first difference. Unequal lengths are unequal (a length is not a secret). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── Canonical JSON ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The gateway's canonical JSON: keys sorted at every object level, arrays in order, no whitespace. This is the string the gateway puts
 * on the wire and signs, so `signWebhookPayload` needs it and a receiver that has only a parsed object can rebuild it.
 *
 * Matches the gateway byte for byte on JSON values (`webhook-signature.test.ts` fuzzes it against a verbatim copy of the gateway's
 * implementation). It is STRICTER on what is not JSON: where the gateway turns a `Date`, `Map` or `Set` into `{}` — silently, so a
 * signature over it verifies against nothing a receiver could rebuild — this throws.
 *
 * Prefer verifying the raw bytes. Rebuilding from a parsed object is only as faithful as the parse: a number beyond 2^53 or a duplicate
 * key has already been altered by `JSON.parse` before this runs.
 */
export function canonicalizeWebhookPayload(value: unknown): string {
  return canonical(value, [], 0);
}

function canonical(value: unknown, ancestors: unknown[], depth: number): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalizeWebhookPayload: NaN and Infinity are not JSON');
      return JSON.stringify(value);
    case 'string': return JSON.stringify(value);
    case 'bigint': return value.toString();
    case 'object': break;
    default: throw new TypeError(`canonicalizeWebhookPayload: a ${typeof value} is not JSON`);
  }
  if (depth > MAX_NESTING) throw new TypeError(`canonicalizeWebhookPayload: nested more than ${MAX_NESTING} levels deep`);
  if (ancestors.includes(value)) throw new TypeError('canonicalizeWebhookPayload: circular structure');
  ancestors.push(value);
  try {
    if (Array.isArray(value)) return `[${value.map((v) => canonical(v, ancestors, depth + 1)).join(',')}]`;
    // Cross-realm safe (a vm context's Object.prototype is not ours), and it refuses Date / Map / Set / typed arrays outright.
    const tag = Object.prototype.toString.call(value);
    if (tag !== '[object Object]') throw new TypeError(`canonicalizeWebhookPayload: a ${tag.slice(8, -1)} is not JSON — convert it first`);
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue; // an absent property, as JSON.stringify treats it
      parts.push(`${JSON.stringify(key)}:${canonical(v, ancestors, depth + 1)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    ancestors.pop();
  }
}

// ── Inputs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The request body exactly as received. A `Buffer` is a `Uint8Array`. */
export type WebhookBody = string | Uint8Array | ArrayBuffer;

/**
 * Request headers in any of the shapes a Node or Web framework hands over: a Fetch `Headers`, or a plain object such as Node's
 * `req.headers` (names are matched case-insensitively; a repeated header arrives as an array and is joined).
 */
export type WebhookHeaders =
  | { get(name: string): string | null | undefined }
  | { readonly [name: string]: string | readonly string[] | undefined };

function misuse(code: string, message: string): CertenError {
  return new CertenError(message, 0, code);
}

function readHeader(headers: WebhookHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const h = headers as Record<string, unknown> & { get?: unknown };
  if (typeof h.get === 'function') {
    const v = (h.get as (n: string) => unknown).call(headers, name);
    return v === null || v === undefined ? undefined : String(v);
  }
  const want = name.toLowerCase();
  for (const key of Object.keys(h)) {
    if (key.toLowerCase() !== want) continue;
    const v = h[key];
    if (Array.isArray(v)) return v.join(',');
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function toBytes(body: unknown): Uint8Array {
  if (typeof body === 'string') return utf8(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (Object.prototype.toString.call(body) === '[object ArrayBuffer]') return new Uint8Array(body as ArrayBuffer);
  throw new TypeError('webhook body must be a string, a byte array (a Uint8Array, which includes a Node.js buffer) or an ArrayBuffer — the raw bytes of the request');
}

/** What the HMAC is over: `<t as written>.<body bytes>`. Bytes, not a decoded string, so a body that is not valid UTF-8 is hashed as received. */
function signedBytes(timestampText: string, body: Uint8Array): Uint8Array {
  return concatBytes(utf8(`${timestampText}.`), body);
}

/**
 * Check the secret(s) BEFORE any comparison. The reference snippets read `process.env.CERTEN_WEBHOOK_SECRET ?? ''`; HMAC with an empty
 * key is perfectly computable, so an unset variable would make every forged delivery verify. A secret that cannot have signed anything
 * is a deployment error and is raised as one — on every delivery, loudly — never answered with a quiet `ok: false` that is
 * indistinguishable from an attack. Never echoes the secret.
 */
function secretKeys(secret: unknown): { keys: Uint8Array[]; raw: string[] } {
  const list = Array.isArray(secret) ? secret : [secret];
  if (list.length === 0) throw misuse('WEBHOOK_SECRET_INVALID', 'No webhook secret was given. Pass the signing secret returned when the endpoint was registered.');
  const raw: string[] = [];
  for (const [i, s] of list.entries()) {
    if (typeof s !== 'string' || s.length === 0) {
      throw misuse('WEBHOOK_SECRET_INVALID',
        `Webhook secret${list.length > 1 ? ` #${i + 1}` : ''} is ${typeof s === 'string' ? 'empty' : `${s === undefined ? 'undefined' : s === null ? 'null' : `${typeof s === 'object' ? 'an' : 'a'} ${typeof s}`}, not a string`}. `
        + 'Is the environment variable or secret-store entry it is read from set? Refusing to verify against it.');
    }
    if (s.length < MIN_SECRET_LENGTH) {
      throw misuse('WEBHOOK_SECRET_INVALID',
        `Webhook secret${list.length > 1 ? ` #${i + 1}` : ''} is ${s.length} characters; the gateway never signs with fewer than ${MIN_SECRET_LENGTH}, `
        + 'so this is not the endpoint\'s secret. Refusing to verify against it.');
    }
    raw.push(s);
  }
  return { keys: raw.map(utf8), raw };
}

/** Throw `WEBHOOK_SECRET_INVALID` if `secret` could not have signed anything. For a caller that wants to fail before doing other work. */
export function assertWebhookSecret(secret: string | readonly string[]): void {
  secretKeys(secret);
}

function nowSeconds(now: number | Date | undefined): number {
  if (now === undefined) return Math.floor(Date.now() / 1000);
  const ms = typeof now === 'number' ? now * 1000 : typeof now?.getTime === 'function' ? now.getTime() : NaN;
  if (!Number.isFinite(ms)) throw misuse('INVALID_WEBHOOK_OPTION', '`now` must be unix seconds (a number) or a Date.');
  return Math.floor(ms / 1000);
}

function toleranceOf(seconds: number | undefined): number {
  if (seconds === undefined) return DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  // Infinity is refused on purpose. A verifier with no replay window accepts a captured request forever; a test that replays an old
  // fixture says what time it is with `now`, which keeps the window honest.
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw misuse('INVALID_WEBHOOK_OPTION', '`toleranceSeconds` must be a finite number >= 0. To verify an old capture, pass `now` rather than widening the window.');
  }
  return seconds;
}

// ── Header ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ParsedWebhookSignature =
  | {
    ok: true;
    /** `t`, unix seconds. */
    timestamp: number;
    /** `t` exactly as written — the string that was hashed. */
    timestampText: string;
    /** Every `vN=` pair in header order. Only `v1` is understood; the rest are carried so a caller can say a newer scheme exists. */
    signatures: Array<{ version: string; value: string }>;
  }
  | { ok: false; reason: 'malformed-signature'; message: string };

/**
 * Split `t=<unix>,v1=<hex>[,v2=…]`. Strict about the parts that are signed over (one `t`, plain decimal digits; a `v1` that is 64 hex
 * characters) because a lenient parse is how two parsers end up disagreeing about what was signed; ignorant of any key it does not
 * know, so a header that gains a field keeps verifying.
 */
export function parseWebhookSignatureHeader(header: string): ParsedWebhookSignature {
  const bad = (message: string): ParsedWebhookSignature => ({ ok: false, reason: 'malformed-signature', message });
  let timestampText: string | undefined;
  const signatures: Array<{ version: string; value: string }> = [];
  for (const raw of header.split(',')) {
    const part = raw.trim();
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq <= 0) return bad(`The signature header has a part ("${part.slice(0, 24)}") that is not name=value.`);
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === 't') {
      if (timestampText !== undefined) return bad('The signature header has more than one t=, so it is ambiguous what was signed.');
      if (!new RegExp(`^[0-9]{1,${MAX_TIMESTAMP_DIGITS}}$`).test(value)) return bad('The signature header\'s t= is not a unix time in whole seconds.');
      timestampText = value;
    } else if (/^v[0-9]+$/.test(name)) {
      if (name === WEBHOOK_SIGNATURE_VERSION && !/^[0-9a-fA-F]{64}$/.test(value)) return bad('The signature header\'s v1= is not 64 hexadecimal characters.');
      signatures.push({ version: name, value });
    }
  }
  if (timestampText === undefined) return bad('The signature header has no t=. Expected t=<unix seconds>,v1=<hex>.');
  if (signatures.length === 0) return bad('The signature header has no v1=. Expected t=<unix seconds>,v1=<hex>.');
  return { ok: true, timestamp: Number(timestampText), timestampText, signatures };
}

// ── Sign ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SignedWebhook {
  /** The `X-Certen-Signature` value: `t=<unix>,v1=<hex>`. */
  header: string;
  timestamp: number;
  signatureHex: string;
  /** The canonical JSON of the payload. Send EXACTLY this as the request body — the signature is over these bytes. */
  canonicalPayload: string;
  version: typeof WEBHOOK_SIGNATURE_VERSION;
  /** The headers the gateway sends with a delivery, ready to hand to an HTTP client. */
  headers: Record<string, string>;
}

export interface SignWebhookOptions {
  /** Unix seconds to sign at. Default: now. */
  timestamp?: number;
  /** Adds `X-Certen-Event`. */
  event?: string;
  /** Adds `X-Certen-Delivery`. */
  deliveryId?: string;
}

/**
 * Sign a payload the way the gateway signs a delivery, so a receiver can be exercised without waiting for a real event: send
 * `canonicalPayload` as the body with `headers`, and `verifyWebhookSignature` on the far side accepts it.
 *
 * This produces a signature that a receiver holding the same secret will trust. It is a test tool — the gateway is the only party that
 * signs deliveries for a real endpoint — and the secret it needs is the one you stored when the endpoint was registered.
 */
export function signWebhookPayload(secret: string, payload: unknown, options: SignWebhookOptions = {}): SignedWebhook {
  if (Array.isArray(secret)) throw misuse('WEBHOOK_SECRET_INVALID', 'signWebhookPayload signs with exactly one secret.');
  const { keys } = secretKeys(secret);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || String(timestamp).length > MAX_TIMESTAMP_DIGITS) {
    throw misuse('INVALID_WEBHOOK_OPTION', '`timestamp` must be a whole number of unix seconds.');
  }
  const canonicalPayload = canonicalizeWebhookPayload(payload);
  const signatureHex = bytesToHex(hmacSha256(keys[0], signedBytes(String(timestamp), utf8(canonicalPayload))));
  const header = `t=${timestamp},${WEBHOOK_SIGNATURE_VERSION}=${signatureHex}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [WEBHOOK_SIGNATURE_HEADER]: header,
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
  };
  if (options.event !== undefined) headers[WEBHOOK_EVENT_HEADER] = options.event;
  if (options.deliveryId !== undefined) headers[WEBHOOK_DELIVERY_HEADER] = options.deliveryId;
  return { header, timestamp, signatureHex, canonicalPayload, version: WEBHOOK_SIGNATURE_VERSION, headers };
}

// ── Verify ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VerifyWebhookOptions {
  /**
   * The endpoint's signing secret. An array accepts any of several — for the window after `rotateSecret`, or while two endpoints (old
   * and new secret) point at one receiver. The gateway signs with exactly one secret at a time, so listing the previous secret only
   * helps a receiver that has not yet been switched over; remove it once it has.
   */
  secret: string | readonly string[];
  /** The raw request body. Mutually exclusive with `payload`. */
  body?: WebhookBody;
  /**
   * An already-parsed body, for a handler whose framework parsed it before you could read it. The canonical form is rebuilt and
   * checked, which is only as faithful as the parse (see `canonicalizeWebhookPayload`). Prefer `body`.
   */
  payload?: unknown;
  /** The `X-Certen-Signature` header value. Give this or `headers`. */
  signature?: string | null;
  /** Request headers, from which `X-Certen-Signature` is read. */
  headers?: WebhookHeaders;
  /** Either side of now that `t` may sit. Default 300. Must be finite; to verify an old capture pass `now`. */
  toleranceSeconds?: number;
  /** What time it is, as unix seconds or a Date. Default: the real clock. For tests and for checking a stored capture. */
  now?: number | Date;
}

export type WebhookVerification =
  | {
    ok: true;
    /** `t` from the signed header, unix seconds. */
    timestamp: number;
    /** `now - t`. Positive means signed in the past. */
    ageSeconds: number;
    version: typeof WEBHOOK_SIGNATURE_VERSION;
    /** Which of the supplied secrets verified, 0-based. 0 when only one was given. */
    secretIndex: number;
  }
  | {
    ok: false;
    reason: Exclude<WebhookSignatureFailure, 'invalid-payload'>;
    message: string;
    /** When the failure looks like one of the usual mistakes, which. Safe to log. */
    hint?: string;
    /** Present when the signature was authentic but stale: `t` and how old it is. */
    timestamp?: number;
    ageSeconds?: number;
  };

/**
 * Is this delivery from CERTEN, intact, and recent?
 *
 *     const v = verifyWebhookSignature({ body: rawBody, headers: req.headers, secret: process.env.CERTEN_WEBHOOK_SECRET! });
 *     if (!v.ok) return res.status(400).send(v.reason);
 *
 * Returns the verdict as data for the failures an attacker or a misconfigured proxy can cause (a bad header, a bad signature, a stale
 * timestamp). THROWS for the failures only the caller can cause — no secret, a secret too short to be real, a nonsensical option —
 * because those must not read as "someone sent a bad request".
 *
 * The signature is checked before the clock, so `timestamp-outside-tolerance` always means the sender holds a genuine signature: an
 * old replay or a skewed clock, never a forgery. A match is found in constant time.
 */
export function verifyWebhookSignature(options: VerifyWebhookOptions): WebhookVerification {
  const { keys, raw } = secretKeys(options.secret);
  const tolerance = toleranceOf(options.toleranceSeconds);
  const now = nowSeconds(options.now);
  const hasBody = options.body !== undefined;
  const hasPayload = options.payload !== undefined;
  if (hasBody === hasPayload) throw misuse('INVALID_WEBHOOK_OPTION', 'Pass exactly one of `body` (the raw request bytes — preferred) or `payload` (an already-parsed body).');

  const header = options.signature ?? readHeader(options.headers, WEBHOOK_SIGNATURE_HEADER);
  if (typeof header !== 'string' || header.trim() === '') {
    return {
      ok: false, reason: 'missing-signature',
      message: `No ${WEBHOOK_SIGNATURE_HEADER} header.`,
      hint: options.signature === undefined && options.headers === undefined
        ? 'Neither `signature` nor `headers` was passed to the verifier.'
        : 'A proxy or gateway in front of the receiver may be stripping it, or the handler is reading the wrong header name.',
    };
  }
  const parsed = parseWebhookSignatureHeader(header);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.message };
  const candidates = parsed.signatures.filter((s) => s.version === WEBHOOK_SIGNATURE_VERSION).map((s) => hexToBytes(s.value));
  if (candidates.length === 0) {
    return {
      ok: false, reason: 'unsupported-version',
      message: `The signature header carries only ${parsed.signatures.map((s) => s.version).join(', ')}; this SDK verifies ${WEBHOOK_SIGNATURE_VERSION}.`,
      hint: 'The gateway is newer than this SDK. Upgrade @certen.io/sdk.',
    };
  }

  let bodyBytes: Uint8Array;
  if (hasBody) {
    bodyBytes = toBytes(options.body);
  } else {
    try {
      bodyBytes = utf8(canonicalizeWebhookPayload(options.payload));
    } catch (err) {
      // Nothing the gateway sent could have been this, so no signature of its can match it.
      return { ok: false, reason: 'signature-mismatch', message: 'The parsed payload cannot be reduced to JSON.', hint: (err as Error).message };
    }
  }

  const signed = signedBytes(parsed.timestampText, bodyBytes);
  let secretIndex = -1;
  for (let i = 0; i < keys.length && secretIndex < 0; i++) {
    const expected = hmacSha256(keys[i], signed);
    let hit = false;
    for (const c of candidates) if (timingSafeEqual(expected, c)) hit = true; // no early exit between candidates
    if (hit) secretIndex = i;
  }

  if (secretIndex < 0) {
    return {
      ok: false, reason: 'signature-mismatch',
      message: 'The signature does not match this body and secret.',
      hint: diagnose(hasBody, bodyBytes, parsed.timestampText, keys, raw, candidates),
    };
  }

  const ageSeconds = now - parsed.timestamp;
  if (Math.abs(ageSeconds) > tolerance) {
    return {
      ok: false, reason: 'timestamp-outside-tolerance',
      message: `The signature is authentic but was made ${Math.abs(ageSeconds)}s ${ageSeconds >= 0 ? 'ago' : 'in the future'}; the tolerance is ${tolerance}s.`,
      hint: ageSeconds >= 0
        ? 'A replayed request, or this machine\'s clock is ahead of the gateway\'s.'
        : 'This machine\'s clock is behind the gateway\'s.',
      timestamp: parsed.timestamp, ageSeconds,
    };
  }
  return { ok: true, timestamp: parsed.timestamp, ageSeconds, version: WEBHOOK_SIGNATURE_VERSION, secretIndex };
}

/**
 * On a mismatch, say which of the two usual mistakes it looks like. Runs only on the failure path and only on a bounded body, so it
 * gives an unauthenticated sender no more work than verifying already did.
 */
function diagnose(
  hasBody: boolean, bytes: Uint8Array, timestampText: string, keys: Uint8Array[], raw: string[], candidates: Uint8Array[],
): string | undefined {
  const notes: string[] = [];
  if (raw.some((s) => s !== s.trim())) {
    notes.push('The secret has leading or trailing whitespace — a newline left on a value read from a file or a prompt is the usual cause.');
  }
  if (hasBody && bytes.length <= DIAGNOSE_MAX_BYTES) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const canon = canonicalizeWebhookPayload(JSON.parse(text));
      if (canon !== text) {
        const expected = keys.map((k) => hmacSha256(k, signedBytes(timestampText, utf8(canon))));
        const hit = candidates.some((c) => expected.some((e) => timingSafeEqual(e, c)));
        notes.push(hit
          ? 'The signature IS valid for the canonical form of this body, so the body was re-serialized before it reached the verifier (a JSON-parsing '
            + 'middleware ran first). Verify the raw bytes — express.raw({ type: \'application/json\' }), or request.arrayBuffer() — or pass `payload`.'
          : 'The body is not in the gateway\'s canonical form (sorted keys, no whitespace), so it was probably re-serialized on the way. Verify the raw '
            + 'request bytes, not JSON.stringify of a parsed body.');
      }
    } catch { /* not JSON: nothing more to say */ }
  }
  return notes.length ? notes.join(' ') : undefined;
}

// ── Receive ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The proof that a webhook was authentic, as `verifyWebhookSignature` reported it. */
export type VerifiedWebhookSignature = Extract<WebhookVerification, { ok: true }>;

/**
 * A webhook that passed verification.
 *
 * `payload` and `timestamp` are authenticated. `type` and `deliveryId` are NOT: they are copied from headers the signature does not
 * cover, so a party who can replay a captured delivery inside the tolerance window can relabel it. Use `type` to route, and let the
 * handler read what it needs from `payload` (every transaction event carries its own `status`). Dedupe on `deliveryId` — it is stable
 * across the gateway's retries and `redeliver`, which is what makes it the right idempotency key — but not to authorize.
 */
export interface ReceivedWebhook<P = unknown> {
  /** `X-Certen-Event`, or null if the header was not passed. UNSIGNED. */
  type: string | null;
  /** `X-Certen-Delivery`, or null (the verification ping has none). UNSIGNED. */
  deliveryId: string | null;
  /** `t` from the signed header, unix seconds. Authenticated. */
  timestamp: number;
  payload: P;
  verification: VerifiedWebhookSignature;
}

export interface ConstructWebhookEventOptions {
  secret: string | readonly string[];
  /** The raw request body. */
  body: WebhookBody;
  /** Request headers: the signature is read from here, and `X-Certen-Event` / `X-Certen-Delivery` for the result. */
  headers?: WebhookHeaders;
  /** Alternative to reading the signature from `headers`. */
  signature?: string | null;
  toleranceSeconds?: number;
  now?: number | Date;
}

/**
 * Verify a delivery and parse it: the one call a handler needs.
 *
 *     const hook = constructWebhookEvent({ body: rawBody, headers: req.headers, secret });
 *     if (isWebhookEvent(hook, 'transaction.completed')) await settle(hook.payload.intent_id);
 *
 * Throws `CertenWebhookSignatureError` (status 400, `.reason`) when the delivery is not accepted — answer 400 and nothing is
 * processed — and `CertenError` (`WEBHOOK_SECRET_INVALID`) when the secret itself is unusable. Does not read `body` as text until the
 * signature has held.
 */
export function constructWebhookEvent<P = unknown>(options: ConstructWebhookEventOptions): ReceivedWebhook<P> {
  const v = verifyWebhookSignature({
    secret: options.secret, body: options.body, headers: options.headers, signature: options.signature,
    toleranceSeconds: options.toleranceSeconds, now: options.now,
  });
  if (!v.ok) throw new CertenWebhookSignatureError(v.message, v.reason, v.hint);
  let payload: P;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(toBytes(options.body))) as P;
  } catch {
    throw new CertenWebhookSignatureError('The signature held, but the body is not JSON.', 'invalid-payload');
  }
  return {
    type: readHeader(options.headers, WEBHOOK_EVENT_HEADER) ?? null,
    deliveryId: readHeader(options.headers, WEBHOOK_DELIVERY_HEADER) ?? null,
    timestamp: v.timestamp,
    payload,
    verification: v,
  };
}

/** The part of a Fetch `Request` (or a Next.js / Hono / Workers / Bun / Deno request) this needs. */
export interface WebhookRequestLike {
  headers: WebhookHeaders;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * `constructWebhookEvent` for a Fetch-style request. It reads the body with `arrayBuffer()`, so the bytes are the ones that arrived and
 * there is no parsed copy to confuse the handler (do NOT call `request.json()` first: the stream is then spent).
 */
export async function constructWebhookEventFromRequest<P = unknown>(
  request: WebhookRequestLike,
  secret: string | readonly string[],
  options: Pick<ConstructWebhookEventOptions, 'toleranceSeconds' | 'now'> = {},
): Promise<ReceivedWebhook<P>> {
  const body = new Uint8Array(await request.arrayBuffer());
  return constructWebhookEvent<P>({ secret, body, headers: request.headers, ...options });
}

/** Narrow a received webhook to a known event and its payload type. False for an event this SDK has no type for, which is not an error. */
export function isWebhookEvent<E extends WebhookEventName>(
  hook: ReceivedWebhook, type: E,
): hook is ReceivedWebhook<WebhookEventPayloads[E]> & { type: E } {
  return hook.type === type;
}

// ── Check a stored delivery ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The signature fields of `GET /v1/webhooks/deliveries/{id}`. */
export interface DeliverySignatureRecord {
  signature_version?: string | null;
  signature_hex?: string | null;
  signed_at_unix?: number | string | null;
  signed_canonical_payload?: string | null;
  [k: string]: unknown;
}

export type WebhookDeliveryCheck =
  | { ok: true; timestamp: number; version: typeof WEBHOOK_SIGNATURE_VERSION }
  | {
    ok: false;
    /** `not-signed`: no attempt has been made yet, so there is nothing to check. */
    reason: 'not-signed' | 'unsupported-version' | 'malformed-record' | 'signature-mismatch';
    message: string;
    hint?: string;
  };

/**
 * Reproduce the signature the gateway recorded for a delivery attempt, from the signed bytes it also recorded.
 *
 * This answers "is the secret I hold the one the gateway signed this with?" without waiting for the next event: a mismatch on a
 * delivery your receiver rejected means the receiver has the wrong (or a rotated-away) secret; a match means the secret is right
 * and the fault is in how the receiver gets the body. There is no tolerance — this is history, not a request.
 *
 * The record describes the LAST attempt: each attempt re-signs and overwrites it.
 */
export function checkWebhookDelivery(delivery: DeliverySignatureRecord, secret: string | readonly string[]): WebhookDeliveryCheck {
  const { keys, raw } = secretKeys(secret);
  const { signature_hex: sig, signed_canonical_payload: payload } = delivery;
  const at = delivery.signed_at_unix;
  if (sig == null || payload == null || at == null) {
    return {
      ok: false, reason: 'not-signed',
      message: 'This delivery has no recorded signature.',
      hint: 'The gateway records it when it makes an attempt. A delivery that has not been attempted yet, or whose endpoint was gone, has none.',
    };
  }
  const version = delivery.signature_version ?? WEBHOOK_SIGNATURE_VERSION;
  if (version !== WEBHOOK_SIGNATURE_VERSION) {
    return { ok: false, reason: 'unsupported-version', message: `The delivery was signed with ${version}; this SDK verifies ${WEBHOOK_SIGNATURE_VERSION}.`, hint: 'Upgrade @certen.io/sdk.' };
  }
  const atText = String(at);
  if (typeof sig !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sig) || typeof payload !== 'string' || !new RegExp(`^[0-9]{1,${MAX_TIMESTAMP_DIGITS}}$`).test(atText)) {
    return { ok: false, reason: 'malformed-record', message: 'The delivery\'s signature fields are not in the shape the gateway records them.' };
  }
  const recorded = hexToBytes(sig);
  const signed = signedBytes(atText, utf8(payload));
  for (const k of keys) {
    if (timingSafeEqual(hmacSha256(k, signed), recorded)) return { ok: true, timestamp: Number(atText), version: WEBHOOK_SIGNATURE_VERSION };
  }
  return {
    ok: false, reason: 'signature-mismatch',
    message: 'The recorded signature was not made with this secret.',
    hint: raw.some((s) => s !== s.trim())
      ? 'The secret has leading or trailing whitespace.'
      : 'This is not the secret the endpoint was signing with at that attempt — it may have been rotated since, or belong to another endpoint.',
  };
}
