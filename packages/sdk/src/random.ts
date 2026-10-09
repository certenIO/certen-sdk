import { bytesToHex } from './bytes.js';

/**
 * Cryptographically random values from Web Crypto, which Node (>= 19) and every current browser expose as `globalThis.crypto`.
 *
 * The client used `randomBytes` from `node:crypto` and `randomUUID` from `crypto`, which a browser bundle cannot resolve. There is
 * no weaker fallback here: where `crypto.getRandomValues` is absent the call throws, because an idempotency key drawn from
 * `Math.random` would let two clients collide on the key that stops a payment being made twice.
 */
/** The few Web Crypto members this SDK uses, declared structurally because the SDK's type environment has no DOM lib. */
export interface WebCryptoLike {
  getRandomValues(array: Uint8Array): Uint8Array;
  randomUUID?: () => string;
  subtle?: {
    importKey(format: 'raw', key: Uint8Array, algorithm: { name: string }, extractable: boolean, usages: string[]): Promise<unknown>;
    verify(algorithm: { name: string }, key: unknown, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  };
}

/** `globalThis.crypto` when the runtime has it, otherwise undefined. */
export function maybeWebCrypto(): WebCryptoLike | undefined {
  return (globalThis as { crypto?: WebCryptoLike }).crypto;
}

function webCrypto(): WebCryptoLike {
  const c = maybeWebCrypto();
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('certen: this runtime has no Web Crypto (globalThis.crypto.getRandomValues), so no secure random value can be made');
  }
  return c;
}

export function randomBytes(n: number): Uint8Array {
  return webCrypto().getRandomValues(new Uint8Array(n));
}

export function randomHex(n: number): string {
  return bytesToHex(randomBytes(n));
}

/** An RFC 4122 version 4 UUID. `crypto.randomUUID` needs a secure context in browsers; building it from random bytes does not. */
export function uuid(): string {
  const c = webCrypto();
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
