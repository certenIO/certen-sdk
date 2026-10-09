/**
 * Byte helpers that work the same in Node and in a browser.
 *
 * The client used to reach for `Buffer`, which a browser does not have; `Uint8Array`, `TextEncoder` and `atob` are in every runtime
 * this SDK supports (Node >= 22 and current browsers). Nothing here touches the network or any key.
 */

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

/** Parse hex into bytes. Odd length or a non-hex character throws, rather than silently dropping the tail as `Buffer.from(x, 'hex')` does. */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`not valid hex (${h.length} characters)`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Standard base64 (the alphabet `Buffer.from(x, 'base64')` accepts, including URL-safe `-` and `_`). Throws on anything else. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  if (/[^A-Za-z0-9+/=]/.test(clean)) throw new Error('not valid base64');
  const bin = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
