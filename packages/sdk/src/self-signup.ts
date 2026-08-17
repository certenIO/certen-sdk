import axios, { AxiosError } from 'axios';
import { DEFAULT_BASE_URL } from './client.js';
import { CertenError } from './errors.js';
import type { SignupChallenge, RedeemedRegistration } from './types.js';

/**
 * Provisioning an organization by proving you hold a key — no browser, no email, nobody at CERTEN.
 *
 * CERTEN is non-custodial: we never hold a customer's keys. A signup that required a human — ours
 * in an approvals queue, theirs in a browser, or an existing customer handing over a registration
 * token — contradicted that, and made CERTEN a friction point in the one flow where it should be
 * invisible.
 *
 * The anchor is an Ed25519 keypair, which is free to create, impossible for us to hold, needs no
 * inbox, and is a credential the caller needs anyway: every CERTEN identity is an Ed25519 key. One
 * step does two jobs.
 *
 * Standalone rather than client methods, for the reason that recurs across this SDK: the caller
 * holds no credential, and obtaining the first one is the entire purpose.
 */

interface Endpoint {
  /** Defaults to the SDK's configured gateway. */
  baseUrl?: string;
  timeoutMs?: number;
}

function fail(err: unknown, fallbackCode: string): never {
  const e = err as AxiosError<{ error?: string; code?: string }>;
  const status = e.response?.status ?? 0;
  const payload = e.response?.data;
  throw new CertenError(
    `certen: ${payload?.error ?? e.message}`,
    status,
    payload?.code ?? (status ? fallbackCode : 'NETWORK_ERROR'),
    { body: payload },
  );
}

/**
 * Ask for a nonce to sign.
 *
 * Pass `publicKey` — it binds the challenge to your key, so nobody who observes the nonce in flight
 * can answer it with their own.
 */
export async function requestSignupChallenge(
  publicKey?: string,
  options: Endpoint = {},
): Promise<SignupChallenge> {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const { data } = await axios.post(
      `${base}/v1/signup/challenge`,
      publicKey ? { public_key: publicKey } : {},
      { timeout: options.timeoutMs ?? 30_000, headers: { 'Content-Type': 'application/json' } },
    );
    return data as SignupChallenge;
  } catch (err) {
    return fail(err, 'SIGNUP_CHALLENGE_FAILED');
  }
}

/**
 * Answer a challenge and receive a new organization with its first API key.
 *
 * `signature` is a DETACHED Ed25519 signature over the raw bytes of the nonce — decode the hex
 * first. Signing the hex text instead is the one mistake worth calling out, and the gateway says so
 * explicitly when it happens.
 *
 * **The API key is returned once.** The nonce is spent by this call whether or not it succeeded, so
 * a retry needs a fresh challenge.
 */
export async function completeSignup(
  params: { publicKey: string; nonce: string; signature: string; orgName?: string },
  options: Endpoint = {},
): Promise<RedeemedRegistration> {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const { data } = await axios.post(
      `${base}/v1/signup`,
      {
        public_key: params.publicKey,
        nonce: params.nonce,
        signature: params.signature,
        ...(params.orgName ? { org_name: params.orgName } : {}),
      },
      { timeout: options.timeoutMs ?? 30_000, headers: { 'Content-Type': 'application/json' } },
    );
    return data as RedeemedRegistration;
  } catch (err) {
    return fail(err, 'SIGNUP_FAILED');
  }
}

/**
 * Both steps, for a caller that can sign.
 *
 * ```ts
 * const { org, api_key } = await selfSignup({
 *   publicKey: myPublicKeyHex,
 *   sign: (nonceHex) => signWithMyKey(nonceHex),   // detached ed25519 over the nonce BYTES
 *   orgName: 'my-agent',
 * });
 * ```
 *
 * `sign` receives the nonce as hex and must return the signature as hex. That signature is made
 * with a private key this SDK never sees — which is the point, and why signing is a callback rather
 * than a key parameter.
 */
export async function selfSignup(
  params: {
    publicKey: string;
    sign: (nonceHex: string) => string | Promise<string>;
    orgName?: string;
  },
  options: Endpoint = {},
): Promise<RedeemedRegistration> {
  const challenge = await requestSignupChallenge(params.publicKey, options);
  const signature = await params.sign(challenge.nonce);
  return completeSignup(
    {
      publicKey: params.publicKey,
      nonce: challenge.nonce,
      signature,
      orgName: params.orgName,
    },
    options,
  );
}
