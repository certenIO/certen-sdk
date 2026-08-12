import { UsageError } from './errors.js';

/**
 * Parse a Solidity function signature and check arguments against it.
 *
 * This exists so a wrong argument fails HERE, naming the flag the user typed, rather than
 * travelling to the proof service and coming back as a decoding failure with no visible
 * connection to `--arg`. The check is deliberately shallow — it validates the shapes a human
 * gets wrong at the command line (an address that is not 20 bytes, a bytes32 that is 31, a
 * negative uint, a malformed bool) and does not attempt to be an ABI encoder. Encoding is the
 * gateway's job and duplicating it here would be a second implementation to keep in sync.
 */

export interface ParsedSignature {
  name: string;
  types: string[];
}

/**
 * `confirm(bytes32)` → `{ name: 'confirm', types: ['bytes32'] }`.
 *
 * Nested tuples are rejected rather than half-supported: `--arg` is a flat list of strings, so a
 * tuple has no unambiguous spelling at the command line. Someone who needs one should build the
 * intent JSON and pass `--intent`, and saying so is more useful than accepting a value that will
 * be encoded wrongly.
 */
export function parseSignature(signature: string): ParsedSignature {
  const trimmed = signature.trim();
  const match = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\((.*)\)$/s);
  if (!match) {
    throw new UsageError(
      `"${signature}" is not a Solidity function signature. `
      + 'Write it as name(type,type) — for example: confirm(bytes32) or transfer(address,uint256)',
      'INVALID_FUNCTION_SIGNATURE',
    );
  }

  const [, name, rawTypes] = match;
  const inner = rawTypes.trim();
  if (inner.includes('(')) {
    throw new UsageError(
      'Tuple arguments cannot be expressed with --arg. Build the intent as JSON and pass '
      + '--intent @file.json instead.',
      'TUPLE_NOT_SUPPORTED',
    );
  }

  // Split WITHOUT filtering, so an empty entry survives to be reported. Filtering first — which
  // this did — silently swallowed `transfer(address,)` into a one-parameter signature, which is
  // exactly the shift-every-argument-by-one bug the check below exists to prevent.
  const types = inner.length === 0 ? [] : inner.split(',').map((t) => t.trim());

  // `transfer(address, )` and friends: a stray comma means the caller thinks there is a parameter
  // there, and silently dropping it would shift every later argument by one position.
  if (types.some((t) => t.length === 0)) {
    throw new UsageError(`"${signature}" has an empty parameter. Remove the stray comma.`, 'INVALID_FUNCTION_SIGNATURE');
  }

  return { name, types };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]*$/;

function checkOne(type: string, value: string, position: number): void {
  const where = `argument ${position + 1} (${type})`;

  // Arrays: the element type is checked, the bracket syntax is not further interpreted. A
  // comma-separated list is the only spelling available at the command line.
  if (type.endsWith('[]')) {
    const element = type.slice(0, -2);
    for (const [i, item] of value.split(',').entries()) {
      checkOne(element, item.trim(), position + i);
    }
    return;
  }

  if (type === 'address') {
    if (!ADDRESS.test(value)) {
      throw new UsageError(
        `${where}: "${value}" is not an address. Expected 0x followed by 40 hex characters.`,
        'INVALID_ARGUMENT',
      );
    }
    return;
  }

  if (type === 'bool') {
    if (!['true', 'false'].includes(value)) {
      throw new UsageError(`${where}: "${value}" is not a bool. Use true or false.`, 'INVALID_ARGUMENT');
    }
    return;
  }

  const bytesN = type.match(/^bytes(\d+)$/);
  if (bytesN) {
    const want = Number(bytesN[1]) * 2;
    if (!HEX.test(value) || value.length - 2 !== want) {
      throw new UsageError(
        `${where}: expected 0x followed by ${want} hex characters (${bytesN[1]} bytes), `
        + `got ${Math.max(0, value.length - 2)}.`,
        'INVALID_ARGUMENT',
      );
    }
    return;
  }

  if (type === 'bytes') {
    if (!HEX.test(value) || value.length % 2 !== 0) {
      throw new UsageError(
        `${where}: expected 0x followed by an even number of hex characters.`,
        'INVALID_ARGUMENT',
      );
    }
    return;
  }

  const intType = type.match(/^(u?)int(\d*)$/);
  if (intType) {
    const unsigned = intType[1] === 'u';
    // Decimal only. A hex integer at the command line is far more often a mistyped bytes32 than a
    // deliberate choice, and BigInt would happily accept it.
    if (!/^-?\d+$/.test(value)) {
      throw new UsageError(
        `${where}: "${value}" is not a whole number. Pass it in base units, as digits.`,
        'INVALID_ARGUMENT',
      );
    }
    if (unsigned && value.startsWith('-')) {
      throw new UsageError(`${where}: ${type} cannot be negative.`, 'INVALID_ARGUMENT');
    }
    const bits = intType[2] ? Number(intType[2]) : 256;
    const limit = unsigned ? 2n ** BigInt(bits) - 1n : 2n ** BigInt(bits - 1) - 1n;
    if (BigInt(value) > limit) {
      throw new UsageError(`${where}: ${value} does not fit in ${type}.`, 'INVALID_ARGUMENT');
    }
    return;
  }

  // `string` and anything this function does not model are passed through. Rejecting an unknown
  // type would make the CLI the thing that limits which contracts can be called, which is a much
  // worse failure than letting the gateway decode it.
}

/**
 * Check that the supplied `--arg` values match the signature, and return them.
 *
 * Values are returned as the strings they arrived as. Converting `uint256` to a JS number here
 * would silently lose precision past 2^53 — the exact bug the rest of this codebase takes care to
 * avoid by keeping amounts as strings.
 */
export function checkArgs(signature: ParsedSignature, args: string[]): string[] {
  if (args.length !== signature.types.length) {
    throw new UsageError(
      `${signature.name}(${signature.types.join(',')}) takes ${signature.types.length} argument(s), `
      + `but ${args.length} --arg value(s) were given.`,
      'ARGUMENT_COUNT_MISMATCH',
    );
  }
  signature.types.forEach((type, i) => checkOne(type, args[i], i));
  return args;
}
