// The canonical comparison form of the S8 verifier (twin of pkg/contractidentity/canon.go): object keys sorted, every integer a decimal
// STRING, every byte string "0x" + lowercase hex, strings as JSON strings (no HTML escaping), booleans, lists, null. A JSON number never
// appears in the canonical form; a JS number is accepted only when it is an integer and then prints as its decimal string.
export type CanonValue = null | undefined | boolean | number | bigint | string | Uint8Array | readonly CanonValue[] | { readonly [k: string]: CanonValue };

const HEX = '0123456789abcdef';

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i]! >> 4]! + HEX[b[i]! & 15]!;
  return s;
}

function str(s: string): string {
  // JSON.stringify escapes " \ and C0 controls as Go does; Go also writes U+2028 and U+2029 as escapes.
  return JSON.stringify(s).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
}

export function canonical(v: CanonValue): string {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      return str(v.toString(10));
    case 'number':
      if (!Number.isInteger(v)) throw new Error(`contractidentity: canonical form: ${v} is not an integer`);
      return str(String(v));
    case 'string':
      return str(v);
    default:
  }
  if (v instanceof Uint8Array) return str('0x' + toHex(v));
  if (Array.isArray(v)) return '[' + (v as readonly CanonValue[]).map(canonical).join(',') + ']';
  const o = v as { readonly [k: string]: CanonValue };
  const keys = Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + keys.map((k) => str(k) + ':' + canonical(o[k])).join(',') + '}';
}
