import { CertenError } from './errors.js';
import { DEFAULT_BASE_URL } from './defaults.js';

/**
 * Split a share link into its token and the gateway it came from. Pure string work, so it is safe to load anywhere; fetching and
 * decoding a shared proof (which gunzips) is in shared-proof.ts, which is Node-only.
 */
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
