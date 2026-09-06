import { gunzipSync } from 'node:zlib';
import axios, { AxiosError } from 'axios';
import { DEFAULT_BASE_URL } from './client.js';
import { CertenError } from './errors.js';
import type { SharedProof } from './types.js';

/**
 * Read a proof someone shared with you.
 *
 * **Deliberately not a method on `CertenClient`.** The whole point of a share link is that the
 * person redeeming it is a counterparty with no CERTEN relationship — the endpoint takes no API key
 * precisely because "requiring a Certen credential to verify a Certen proof would defeat the
 * purpose". Putting the only client-side way to redeem behind a constructor that demands an
 * `apiKey` would have reimposed exactly the requirement the endpoint exists to avoid.
 *
 * This was the asymmetry: the SDK could create a share, list shares and revoke a share — every
 * operation for the person SENDING — and had nothing at all for the person receiving, who is the
 * one the feature is for.
 *
 * Takes the share URL as handed over, or the bare token:
 *
 * ```ts
 * const { bundle } = await fetchSharedProof('https://gateway.kompendium.co/v1/proof/shared/abc123');
 * ```
 *
 * When given a URL the origin comes from it, so a counterparty configures nothing. Asking them to
 * separate the token from the link they were sent, and then tell the SDK which gateway it came
 * from, would be work created for no reason.
 */
export async function fetchSharedProof(
  tokenOrUrl: string,
  options: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<SharedProof> {
  const { token, baseUrl } = parseShareTarget(tokenOrUrl, options.baseUrl);

  try {
    const { data } = await axios.get(
      `${baseUrl.replace(/\/+$/, '')}/v1/proof/shared/${encodeURIComponent(token)}`,
      {
        timeout: options.timeoutMs ?? 30_000,
        headers: { 'Content-Type': 'application/json' },
        // No API key. See above — sending one would be harmless but misleading about what this
        // endpoint requires.
      },
    );
    return data as SharedProof;
  } catch (err) {
    throw translate(err);
  }
}

/**
 * The bundle as JSON. The share endpoint returns `bundle` as the stored bytes — serialized the
 * way Node serializes a Buffer ({ type: 'Buffer', data: [...] }), sometimes gzip-compressed —
 * and a counterparty should not have to know that. Returns null when the bytes are not JSON.
 */
export function decodeSharedBundle(bundle: unknown): Record<string, unknown> | null {
  if (bundle && typeof bundle === 'object' && !('data' in (bundle as object)) && ('proof_components' in (bundle as object) || 'bundle_id' in (bundle as object))) {
    return bundle as Record<string, unknown>;
  }
  let bytes: Buffer | null = null;
  if (bundle && typeof bundle === 'object' && Array.isArray((bundle as { data?: unknown }).data)) bytes = Buffer.from((bundle as { data: number[] }).data);
  else if (typeof bundle === 'string') bytes = /^[A-Za-z0-9+/=]+$/.test(bundle) && !bundle.trim().startsWith('{') ? Buffer.from(bundle, 'base64') : Buffer.from(bundle, 'utf8');
  if (!bytes) return null;
  let out: Buffer = bytes;
  if (out[0] === 0x1f && out[1] === 0x8b) {
    try { out = gunzipSync(out); } catch { return null; }
  }
  try { return JSON.parse(out.toString('utf8')) as Record<string, unknown>; } catch { return null; }
}

/** `https://host/v1/proof/shared/<token>`, or the token on its own. */
export function parseShareTarget(
  tokenOrUrl: string,
  baseUrlOverride?: string,
): { token: string; baseUrl: string } {
  const trimmed = tokenOrUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/v1\/proof\/shared\/([^/]+)\/?$/);
    if (!match) {
      throw new CertenError(
        `certen: ${trimmed} is not a share link — expected a path ending /v1/proof/shared/<token>`,
        0, 'INVALID_SHARE_LINK',
      );
    }
    return {
      token: decodeURIComponent(match[1]),
      // The link's own origin wins over any configured default: a proof shared from one deployment
      // must not be fetched from another, where the token means nothing.
      baseUrl: baseUrlOverride ?? url.origin,
    };
  }
  return { token: trimmed, baseUrl: baseUrlOverride ?? DEFAULT_BASE_URL };
}

function translate(err: unknown): Error {
  const axiosErr = err as AxiosError<{ error?: string; code?: string }>;
  const status = axiosErr.response?.status;
  const body = axiosErr.response?.data;

  // 410 is the case worth naming. It means the link WAS real and is now revoked, expired, or out
  // of views — so the right response is to ask for a fresh one. Collapsing it into "not found"
  // would leave a counterparty believing the proof never existed.
  if (status === 410) {
    return new CertenError(
      `certen: ${body?.error ?? 'This share link is no longer valid'} — ask for a new link.`,
      410, body?.code ?? 'SHARE_NO_LONGER_VALID',
    );
  }
  if (status === 404) {
    return new CertenError(
      'certen: no such share link. Check the link was copied in full.',
      404, 'NOT_FOUND',
    );
  }
  if (status) {
    return new CertenError(
      `certen: ${body?.error ?? axiosErr.message}`,
      status, body?.code ?? 'HTTP_ERROR',
    );
  }
  return new CertenError(`certen: ${axiosErr.message}`, 0, 'NETWORK_ERROR');
}
