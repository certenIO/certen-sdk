import axios, { AxiosError } from 'axios';
import { DEFAULT_BASE_URL } from './client.js';
import { CertenError } from './errors.js';
import type { OAuthTokens } from './types.js';

/**
 * The OAuth2 token lifecycle: obtain, refresh, revoke.
 *
 * None of it was reachable from this SDK — not the token endpoint, not revocation. A machine using
 * client credentials could get a token only by hand-rolling HTTP, and could not give it back at
 * all. That asymmetry is the dangerous half: a leaked token had no revocation path an integration
 * could call, so the response to a suspected compromise was to open a browser.
 *
 * **Standalone functions, deliberately — not methods on `CertenClient`.** Both endpoints take their
 * credential in the BODY and require no API key, which is the whole point: a service using OAuth
 * has a client id and secret, not an API key, so routing these through a constructor that demands
 * `apiKey` would ask for the one credential such a caller does not hold. Same reasoning as
 * `fetchSharedProof`.
 */

interface Endpoint {
  /** Defaults to the SDK's configured gateway. */
  baseUrl?: string;
  timeoutMs?: number;
}

async function post<T>(path: string, body: unknown, options: Endpoint): Promise<T> {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const { data } = await axios.post(`${base}${path}`, body, {
      timeout: options.timeoutMs ?? 30_000,
      headers: { 'Content-Type': 'application/json' },
    });
    return data as T;
  } catch (err) {
    const e = err as AxiosError<{ error?: string; error_description?: string; code?: string }>;
    const status = e.response?.status ?? 0;
    const payload = e.response?.data;
    // OAuth errors use `error` / `error_description` (RFC 6749) rather than this API's usual
    // `error` / `code`, so the message is assembled from whichever arrived.
    const message = payload?.error_description ?? payload?.error ?? e.message;
    throw new CertenError(
      `certen: ${message}`,
      status,
      payload?.code ?? payload?.error ?? (status ? 'OAUTH_ERROR' : 'NETWORK_ERROR'),
      { body: payload },
    );
  }
}

/**
 * Exchange client credentials for an access token.
 *
 * Returns an access token good for an hour and a refresh token good for thirty days.
 */
export function fetchOAuthToken(
  params: { clientId: string; clientSecret: string; scope?: string },
  options: Endpoint = {},
): Promise<OAuthTokens> {
  return post<OAuthTokens>('/v1/oauth/token', {
    grant_type: 'client_credentials',
    client_id: params.clientId,
    client_secret: params.clientSecret,
    ...(params.scope ? { scope: params.scope } : {}),
  }, options);
}

/**
 * Trade a refresh token for a fresh pair.
 *
 * **The old refresh token is spent the moment this succeeds.** Replaying one that has already been
 * used revokes its entire descendant chain — that is deliberate theft detection, not a bug: if a
 * stolen token is replayed, both the thief's and the victim's tokens die and the compromise
 * surfaces. So store the new pair before doing anything else, and never retry this call blindly
 * with the same token.
 */
export function refreshOAuthToken(
  refreshToken: string,
  options: Endpoint = {},
): Promise<OAuthTokens> {
  return post<OAuthTokens>('/v1/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, options);
}

/**
 * Revoke a token (RFC 7009).
 *
 * Accepts an access token or a refresh token; revoking a REFRESH token kills its whole descendant
 * chain, which is what you want when responding to a leak.
 *
 * Always resolves when the request is understood, even for a token that never existed — the
 * endpoint deliberately does not reveal whether it did, because an endpoint that distinguished them
 * would be an oracle for guessing tokens. So a successful call means "this token is not valid now",
 * not "this token was valid and now is not".
 */
export async function revokeOAuthToken(
  token: string,
  options: Endpoint & { tokenTypeHint?: 'access_token' | 'refresh_token' } = {},
): Promise<void> {
  await post<unknown>('/v1/oauth/revoke', {
    token,
    ...(options.tokenTypeHint ? { token_type_hint: options.tokenTypeHint } : {}),
  }, options);
}
