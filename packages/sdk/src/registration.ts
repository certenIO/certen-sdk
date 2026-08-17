import axios, { AxiosError } from 'axios';
import { DEFAULT_BASE_URL } from './client.js';
import { CertenError } from './errors.js';
import type { RedeemedRegistration } from './types.js';

/**
 * Redeem a registration token for a new organization and its first API key.
 *
 * **Standalone, and necessarily so.** Every other call in this SDK goes through `CertenClient`,
 * which requires a credential — and the entire point of this one is that the caller does not have
 * one yet. Routing it through a constructor that demands `apiKey` would ask for the exact thing it
 * exists to produce. Same reasoning as `fetchSharedProof` and `fetchOAuthToken`.
 *
 * Before this existed, an organization could only be born inside a browser: the Firebase login
 * exchange created one just-in-time when no membership was found. So a platform could not provision
 * its customers, a CI job could not create a scratch org, and an agent could not take its first
 * step — every automated path stopped and waited for a person.
 *
 * A human still decides that an org may exist, by minting the token. What changed is that the
 * decision and the provisioning no longer have to happen at the same keyboard at the same moment.
 *
 * ```ts
 * const { org, api_key } = await redeemRegistrationToken('crt_…');
 * const certen = new CertenClient({ apiKey: api_key });
 * ```
 *
 * **The API key is returned once.** Store it before doing anything else; no endpoint will repeat
 * it. The token is single-use, so a failed store cannot be fixed by redeeming again.
 */
export async function redeemRegistrationToken(
  token: string,
  options: {
    /** Overrides the organization name the minter pinned. */
    orgName?: string;
    /** Defaults to the SDK's configured gateway. */
    baseUrl?: string;
    timeoutMs?: number;
  } = {},
): Promise<RedeemedRegistration> {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const { data } = await axios.post(
      `${base}/v1/registration-tokens/redeem`,
      { token, ...(options.orgName ? { org_name: options.orgName } : {}) },
      { timeout: options.timeoutMs ?? 30_000, headers: { 'Content-Type': 'application/json' } },
    );
    return data as RedeemedRegistration;
  } catch (err) {
    const e = err as AxiosError<{ error?: string; code?: string }>;
    const status = e.response?.status ?? 0;
    const payload = e.response?.data;
    // A 404 here does NOT mean "wrong URL". The gateway deliberately reports unknown, expired,
    // revoked and already-redeemed tokens identically, so that an endpoint needing no credential
    // cannot be used to probe which guesses were close. Say that plainly, or the caller will go
    // looking for a typo in the base URL.
    const message = status === 404
      ? 'certen: this registration token cannot be redeemed — it is unknown, expired, revoked, or '
        + 'already used. These are reported identically on purpose. Ask for a new token.'
      : payload?.error ?? e.message;
    throw new CertenError(
      status === 404 ? message : `certen: ${message}`,
      status,
      payload?.code ?? (status ? 'REGISTRATION_FAILED' : 'NETWORK_ERROR'),
      { body: payload },
    );
  }
}
