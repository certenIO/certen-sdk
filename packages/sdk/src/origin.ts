import { CertenForeignOriginError } from './errors.js';

/**
 * The client only ever talks to its own gateway.
 *
 * The API key travels on every request the client sends, and axios sends an instance's default headers to an ABSOLUTE url on any
 * host (axios 1.19.0 and 1.20.0 alike; reproduced against a local listener in RUNLOG_RB7b F16). Some responses name a url the client
 * is expected to follow (`submit_url` on an intent and on a sign request). A compromised or buggy gateway, or anything able to
 * alter a response, could therefore name `https://evil.example/x` and receive the key with the signature.
 *
 * So every url the client is about to request must resolve to the client's own base origin, and is refused by name before any
 * request is sent otherwise (`FOREIGN_ORIGIN_URL`, with the url in `details`). Refusing is the only safe answer: a url that
 * "looks right" but points elsewhere is the attack.
 */

/** How axios decides a url is absolute: a scheme, or a protocol-relative `//host`. */
const AXIOS_ABSOLUTE = /^([a-z][a-z\d+\-.]*:)?\/\//i;

/** Resolve `url` the way axios would build the request, so the check is on the url that is actually sent. */
function effectiveUrl(url: string, baseURL: string): URL {
  const base = new URL(baseURL);
  if (AXIOS_ABSOLUTE.test(url)) return new URL(url, base); // `//host/x` takes the base's scheme
  // axios `combineURLs`: base without trailing slashes + '/' + url without leading slashes.
  return new URL(`${baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`);
}

export interface OriginCheck { ok: boolean; reason?: string; resolved?: string }

/** Would a request for `url` stay on `baseURL`'s origin, with no credentials smuggled in the url? */
export function checkOwnOrigin(url: string | undefined, baseURL: string | undefined): OriginCheck {
  if (!baseURL) return { ok: true }; // a client with no base url sends absolute urls by construction; nothing to compare against
  if (url === undefined || url === '') return { ok: true };
  let target: URL;
  let base: URL;
  try {
    base = new URL(baseURL);
    target = effectiveUrl(url, baseURL);
  } catch {
    return { ok: false, reason: 'is not a url this client can resolve' };
  }
  if (target.origin !== base.origin) {
    return { ok: false, reason: `leaves ${base.origin} for ${target.origin}`, resolved: target.href };
  }
  if (target.username || target.password) {
    return { ok: false, reason: 'carries credentials in the url', resolved: target.href };
  }
  return { ok: true, resolved: target.href };
}

/**
 * Throw `CertenForeignOriginError` unless `url` stays on the client's own origin.
 * `what` names where the url came from (`submit_url`, `request`, `redirect`), so the message says what to distrust.
 */
export function assertOwnOrigin(url: string | undefined, baseURL: string | undefined, what: string): void {
  const r = checkOwnOrigin(url, baseURL);
  if (!r.ok) {
    throw new CertenForeignOriginError(
      `certen: refusing to send a request to ${JSON.stringify(url)} (${what}): it ${r.reason}. `
      + 'The client only talks to its own gateway, so nothing was sent and no credential left this process.',
      String(url), baseURL ?? '', what,
    );
  }
}

/**
 * Is a redirect from `from` to `to` safe for a request carrying credentials?
 * Same origin, or an http -> https upgrade of the same host on the default ports (a gateway configured as `http://` that
 * redirects to its own TLS port); never another host, and never https -> http.
 */
export function redirectStaysOnOrigin(from: string, to: string): boolean {
  let a: URL;
  let b: URL;
  try { a = new URL(from); b = new URL(to); } catch { return false; }
  if (b.username || b.password) return false;
  if (a.origin === b.origin) return true;
  return a.protocol === 'http:' && b.protocol === 'https:' && a.hostname === b.hostname
    && (a.port === '' || a.port === '80') && (b.port === '' || b.port === '443');
}
