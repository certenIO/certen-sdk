/**
 * A raw snappy BLOCK decoder (the format of every .ssz_snappy file of the consensus-spec vectors): a uvarint decoded length, then
 * literal and copy elements. No dependency: this is the whole format. The twin of snappyDecode in the validator's official_test.go.
 */
export function snappyDecode(src: Uint8Array): Uint8Array {
  // preamble: uvarint
  let dLen = 0;
  let shift = 0;
  let s = 0;
  for (;;) {
    if (s >= src.length || shift > 28) throw new Error('snappy: bad preamble');
    const b = src[s++]!;
    dLen += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  if (dLen > 2 ** 30) throw new Error('snappy: bad preamble');
  const dst = new Uint8Array(dLen);
  let d = 0;
  while (s < src.length) {
    const tag = src[s++]!;
    let length: number;
    let offset: number;
    switch (tag & 3) {
      case 0: {
        length = tag >> 2;
        if (length < 60) {
          length++;
        } else {
          const extra = length - 59; // 60 -> 1 byte ... 63 -> 4 bytes
          if (s + extra > src.length) throw new Error('snappy: truncated literal length');
          length = 0;
          for (let i = 0; i < extra; i++) length += src[s + i]! * 2 ** (8 * i);
          length++;
          s += extra;
        }
        if (length <= 0 || s + length > src.length) throw new Error('snappy: literal overruns the input');
        if (d + length > dLen) throw new Error('snappy: output overruns the preamble length');
        dst.set(src.subarray(s, s + length), d);
        d += length;
        s += length;
        continue;
      }
      case 1:
        if (s + 1 > src.length) throw new Error('snappy: truncated copy1');
        length = 4 + ((tag >> 2) & 7);
        offset = ((tag >> 5) << 8) | src[s]!;
        s++;
        break;
      case 2:
        if (s + 2 > src.length) throw new Error('snappy: truncated copy2');
        length = 1 + (tag >> 2);
        offset = src[s]! | (src[s + 1]! << 8);
        s += 2;
        break;
      default:
        if (s + 4 > src.length) throw new Error('snappy: truncated copy4');
        length = 1 + (tag >> 2);
        offset = src[s]! + src[s + 1]! * 2 ** 8 + src[s + 2]! * 2 ** 16 + src[s + 3]! * 2 ** 24;
        s += 4;
    }
    if (offset <= 0 || offset > d) throw new Error('snappy: copy offset out of range');
    if (d + length > dLen) throw new Error('snappy: output overruns the preamble length');
    for (let i = 0; i < length; i++) {
      dst[d] = dst[d - offset]!; // may overlap its own output
      d++;
    }
  }
  if (d !== dLen) throw new Error(`snappy: decoded ${d} bytes, preamble says ${dLen}`);
  return dst;
}
