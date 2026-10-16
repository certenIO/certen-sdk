import { keccak256 } from './execution-proof.js';

/**
 * EVM addresses: is this one, and does its checksum hold?
 *
 * A recipient typed into `certen send` is the one value in the whole flow that nothing downstream can correct: the signature authorises exactly
 * what was asked for, and what was asked for was a typo. EIP-55 puts a checksum in the capitalisation of an address, so a mixed-case address
 * that does not match its own hash is a mistyped one, caught before anything is signed.
 *
 * An all-lower-case or all-upper-case address carries no checksum and is accepted: refusing it would refuse every address copied from a tool
 * that does not capitalise, and those are most of them. The mixed-case form is the only one that makes a claim, so it is the only one checked.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The EIP-55 mixed-case spelling of an address (40 hex digits, with or without `0x`). Throws on anything that is not 40 hex digits. */
export function toChecksumAddress(address: string): string {
  const hex = address.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`certen: "${address}" is not 40 hex digits, so it has no checksum form.`);
  const hash = Array.from(keccak256(utf8(hex)), (b) => b.toString(16).padStart(2, '0')).join('');
  let out = '0x';
  for (let i = 0; i < 40; i += 1) out += parseInt(hash[i]!, 16) >= 8 ? hex[i]!.toUpperCase() : hex[i]!;
  return out;
}

/**
 * What is wrong with this as an EVM address, or undefined when nothing is.
 *
 * Two different mistakes, told apart: not an address at all (wrong length, not hex), and an address whose capitalisation claims a checksum it
 * does not have. The second names the correct spelling, so a person who copied the address from somewhere reliable can see which characters
 * differ and one who typed it can see what they most likely meant. It is never silently corrected: a corrected address would be the client
 * deciding where value goes.
 */
export function evmAddressProblem(value: unknown): string | undefined {
  const address = typeof value === 'string' ? value : '';
  if (!ADDRESS.test(address)) {
    // Not JSON.stringify(value) for a non-string: it throws on a BigInt and prints `undefined` for nothing, and a refusal must never throw.
    const shown = typeof value === 'string' ? JSON.stringify(value) : `a value of type ${typeof value}`;
    return `${shown} is not an EVM address. Expected 0x followed by 40 hex characters.`;
  }
  const body = address.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && toChecksumAddress(address) !== address) {
    return `${address} has capital letters that do not match its checksum (EIP-55), which means a character was mistyped or it was copied badly. `
      + `The correctly capitalised address would be ${toChecksumAddress(address)}. Check the address; if it is right, write it in all lower case.`;
  }
  return undefined;
}
