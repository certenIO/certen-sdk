/**
 * The lossless pins supply of the harness (the twin of the Go baseposted.SupplyBaseSepoliaPins, validator pkg/finality/baseposted/vectors.go
 * at pv2/rb11-e1-raise@cbb6373): the pins file with the given base_sepolia keys added where the file lacks them, written the way Go writes it
 * (json.Decoder.UseNumber, then json.Encoder with SetEscapeHTML(false) and SetIndent("", "  ")). Number literals are KEPT AS WRITTEN (an
 * integer above 2^53 such as 2^64-1 is not rounded; a literal Go would write back is written back byte for byte), keys are sorted by their
 * UTF-8 bytes at every depth, a repeated key keeps its last value, strings are re-escaped by the encoder's rules, one LF ends the output.
 *
 * The parse is the strict RFC 8259 reader of s3/jsonx (iterative, Go's 10000-container limit, invalid UTF-8 read as U+FFFD per byte). One
 * difference, on purpose, and stricter: Go's Decoder.Decode reads ONE value and ignores whatever follows it, so a pins file with trailing
 * bytes is silently cut there; this supplier refuses it by name (the bytes after the value are not part of the pins file).
 */
import { JNum, JObj, parseGoJson, type JVal } from '../../../src/s3/jsonx.js';

/** A pins file the supplier cannot read or write back as Go does. */
export class PinsSupplyError extends Error {
  constructor(message: string) {
    super(`pins supply: ${message}`);
    this.name = 'PinsSupplyError';
  }
}

/** The text of a Go string as encoding/json writes it with HTML escaping off (Go 1.22+ short escapes for \b and \f). */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) out += `\\u00${c.toString(16).padStart(2, '0')}`;
    else if (c === 0x2028 || c === 0x2029) out += `\\u${c.toString(16)}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Byte order of the UTF-8 forms (= code point order), what sort.Strings gives Go's map keys. */
export function utf8Order(a: string, b: string): number {
  const x = Array.from(a, (ch) => ch.codePointAt(0)!);
  const y = Array.from(b, (ch) => ch.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/** The value as json.Encoder with SetIndent("", "  ") writes it, one LF after it; iterative, so a document at Go's depth limit is written, not a stack overflow. */
export function goEncode(root: JVal): string {
  const out: string[] = [];
  interface Frame {
    items: [string | undefined, JVal][];
    i: number;
    close: string;
  }
  const stack: Frame[] = [];
  const begin = (v: JVal): void => {
    if (v instanceof JObj) {
      const m = new Map<string, JVal>();
      for (const [k, x] of v.pairs) m.set(k, x);
      const keys = [...m.keys()].sort(utf8Order);
      if (keys.length === 0) out.push('{}');
      else {
        out.push('{');
        stack.push({ items: keys.map((k) => [k, m.get(k)!]), i: 0, close: '}' });
      }
    } else if (Array.isArray(v)) {
      if (v.length === 0) out.push('[]');
      else {
        out.push('[');
        stack.push({ items: v.map((x) => [undefined, x]), i: 0, close: ']' });
      }
    } else if (v === null) out.push('null');
    else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
    else if (typeof v === 'string') out.push(goQuote(v));
    else out.push(v.lit);
  };
  begin(root);
  while (stack.length > 0) {
    const f = stack[stack.length - 1]!;
    if (f.i === f.items.length) {
      stack.pop();
      out.push(`\n${'  '.repeat(stack.length)}${f.close}`);
      continue;
    }
    const [k, x] = f.items[f.i]!;
    out.push(`${f.i === 0 ? '\n' : ',\n'}${'  '.repeat(stack.length)}`);
    if (k !== undefined) out.push(`${goQuote(k)}: `);
    f.i++;
    begin(x);
  }
  return `${out.join('')}\n`;
}

/** strconv.FormatUint of a non-negative integer below 2^64; anything else is refused (the supplied values are numbers of the pins file). */
function formatUint(name: string, v: number | bigint): string {
  if (typeof v === 'number' ? !Number.isSafeInteger(v) || v < 0 : v < 0n || v >= 1n << 64n) throw new PinsSupplyError(`supply ${name} is not an unsigned 64-bit integer`);
  return BigInt(v).toString();
}

/**
 * The Go SupplyBaseSepoliaPins. A file whose base_sepolia is absent or not an object (and a top-level null) is returned as is; a top-level
 * value that is not an object is refused (Go cannot unmarshal it into a map).
 */
export function supplyPins(raw: Uint8Array, supply: Readonly<Record<string, number | bigint>>): Buffer {
  let doc: JVal;
  try {
    doc = parseGoJson(raw);
  } catch (e) {
    throw new PinsSupplyError(e instanceof Error ? e.message : String(e));
  }
  if (doc === null) return Buffer.from(raw);
  if (!(doc instanceof JObj)) throw new PinsSupplyError('the pins file is not a JSON object');
  let at = -1;
  doc.pairs.forEach(([k], i) => {
    if (k === 'base_sepolia') at = i;
  });
  const sec = at >= 0 ? doc.pairs[at]![1] : undefined;
  if (!(sec instanceof JObj)) return Buffer.from(raw);
  const present = new Set(sec.pairs.map(([k]) => k));
  const formatted = Object.entries(supply).map(([name, v]): [string, string] => [name, formatUint(name, v)]);
  const added: [string, JVal][] = formatted.filter(([name]) => !present.has(name)).map(([name, text]) => [name, new JNum(text)]);
  const pairs = doc.pairs.map((p, i): [string, JVal] => (i === at ? ['base_sepolia', new JObj([...sec.pairs, ...added])] : p));
  return Buffer.from(goEncode(new JObj(pairs)));
}
