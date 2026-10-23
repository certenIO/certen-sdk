/**
 * The ABI of the four ValidatorWallet entry points as go-ethereum v1.17.7 accounts/abi reads and writes them (the twin of the
 * `abi.Arguments{...}.Unpack` / `.Pack` pair that pkg/finality/arbfinal decodeWalletCalls uses): executeTransaction(bytes,address,uint256),
 * executeTransactionWithGasRefunder(address,bytes,address,uint256), executeTransactions(bytes[],address[],uint256[]) and
 * executeTransactionsWithGasRefunder(address,bytes[],address[],uint256[]) (nitro-contracts v3.1.0 src/rollup/ValidatorWallet.sol).
 *
 * Unpack is ported as geth does it, not as the ABI specification says it: an address is the LAST 20 bytes of its word (dirty upper bits are
 * read and dropped), a bytes value is the slice at the offset the head names with NO padding check, offsets and lengths are 256-bit words
 * bounded only by the data (lengthPrefixPointsTo, forEachUnpack), and trailing data is not noticed. Pack is the canonical encoding. The
 * canonical re-pack rule of decodeWalletCalls (unpack, then pack, must equal the input) is what makes the accepted set exactly the set of
 * canonical encodings; every wrap-prone quantity here is a bigint until it is bounded by the data length.
 */

/** The data does not decode as the arguments (any geth Unpack error). */
export class AbiError extends Error {}

const fail = (m: string): never => {
  throw new AbiError(m);
};

/** The six argument types of the four entry points. */
export type AbiType = 'bytes' | 'address' | 'uint256' | 'bytes[]' | 'address[]' | 'uint256[]';

/** A decoded value: bytes, address (20 bytes), uint256, and the slices of those. */
export type AbiValue = Uint8Array | bigint | Uint8Array[] | bigint[];

const WORD = 32;

const dynamic = (t: AbiType): boolean => t === 'bytes' || t.endsWith('[]');

const wordBig = (b: Uint8Array): bigint => {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
};

const bigWord = (v: bigint): Uint8Array => {
  const out = new Uint8Array(WORD);
  let x = BigInt.asUintN(256, v);
  for (let i = WORD - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};

/** lengthPrefixPointsTo: the word at `index` is an offset, the word there a length; both must lie wholly inside `output`. */
function lengthPrefixPointsTo(index: number, output: Uint8Array): { start: number; length: number } {
  const offsetEnd = wordBig(output.subarray(index, index + WORD)) + 32n;
  const outLen = BigInt(output.length);
  if (offsetEnd > outLen) fail('offset would go over slice boundary');
  const oe = Number(offsetEnd);
  const lengthBig = wordBig(output.subarray(oe - WORD, oe));
  const total = offsetEnd + lengthBig;
  if (total > outLen) fail('length insufficient');
  return { start: oe, length: Number(lengthBig) };
}

/** forEachUnpack for a slice: `size` elements of 32 bytes (a pointer or a static element each) read from `output`. */
function forEachUnpack(elem: AbiType, output: Uint8Array, size: number): Uint8Array[] | bigint[] {
  if (size < 0 || BigInt(WORD) * BigInt(size) > BigInt(output.length)) fail('array would go over slice boundary');
  if (elem === 'bytes') {
    const out: Uint8Array[] = [];
    for (let j = 0, i = 0; j < size; j++, i += WORD) out.push(toGoType(i, 'bytes', output) as Uint8Array);
    return out;
  }
  if (elem === 'address') {
    const out: Uint8Array[] = [];
    for (let j = 0, i = 0; j < size; j++, i += WORD) out.push(toGoType(i, 'address', output) as Uint8Array);
    return out;
  }
  const out: bigint[] = [];
  for (let j = 0, i = 0; j < size; j++, i += WORD) out.push(toGoType(i, 'uint256', output) as bigint);
  return out;
}

/** toGoType: the value of type t whose head word is at `index` of `output`. */
function toGoType(index: number, t: AbiType, output: Uint8Array): AbiValue {
  if (index + WORD > output.length) fail('length insufficient');
  if (t === 'address') return Uint8Array.from(output.subarray(index + 12, index + WORD));
  if (t === 'uint256') return wordBig(output.subarray(index, index + WORD));
  const { start, length } = lengthPrefixPointsTo(index, output);
  if (t === 'bytes') return Uint8Array.from(output.subarray(start, start + length));
  return forEachUnpack(t.slice(0, -2) as AbiType, output.subarray(start), length);
}

/** Arguments.Unpack: an empty input with arguments expected is an error; every argument is read from its head word. */
export function unpackArgs(types: readonly AbiType[], data: Uint8Array): AbiValue[] {
  if (data.length === 0) {
    if (types.length !== 0) fail('attempting to unmarshal an empty string while arguments are expected');
    return [];
  }
  return types.map((t, i) => toGoType(i * WORD, t, data));
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const leftPad = (b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(WORD);
  out.set(b, WORD - b.length);
  return out;
};

/** packBytesSlice: the length word, then the bytes right-padded with zeros to a multiple of 32. */
function packBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(WORD + Math.ceil(b.length / WORD) * WORD);
  out.set(bigWord(BigInt(b.length)), 0);
  out.set(b, WORD);
  return out;
}

/** Type.pack for one value. */
function pack(t: AbiType, v: AbiValue): Uint8Array {
  switch (t) {
    case 'address':
      return leftPad(v as Uint8Array);
    case 'uint256':
      return bigWord(v as bigint);
    case 'bytes':
      return packBytes(v as Uint8Array);
    case 'address[]':
      return concat([bigWord(BigInt((v as Uint8Array[]).length)), ...(v as Uint8Array[]).map(leftPad)]);
    case 'uint256[]':
      return concat([bigWord(BigInt((v as bigint[]).length)), ...(v as bigint[]).map(bigWord)]);
    case 'bytes[]': {
      const items = (v as Uint8Array[]).map(packBytes);
      let offset = WORD * items.length;
      const heads: Uint8Array[] = [];
      for (const it of items) {
        heads.push(bigWord(BigInt(offset)));
        offset += it.length;
      }
      return concat([bigWord(BigInt(items.length)), ...heads, ...items]);
    }
  }
}

/** Arguments.Pack: the canonical encoding: heads in order (a dynamic value's head is its offset), then the dynamic tails in order. */
export function packArgs(types: readonly AbiType[], vals: readonly AbiValue[]): Uint8Array {
  let inputOffset = WORD * types.length;
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  types.forEach((t, i) => {
    const packed = pack(t, vals[i]!);
    if (dynamic(t)) {
      head.push(bigWord(BigInt(inputOffset)));
      inputOffset += packed.length;
      tail.push(packed);
    } else {
      head.push(packed);
    }
  });
  return concat([...head, ...tail]);
}
