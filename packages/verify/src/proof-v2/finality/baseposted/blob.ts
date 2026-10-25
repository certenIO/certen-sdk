/**
 * OP Stack blob data encoding (op-service/eth/blob.go ToData / FromData), the twin of blobToData / encodeBlob in the validator's
 * pkg/finality/baseposted/channel.go. A blob holds up to blobMaxData bytes: version byte 0 at offset 1, a 3-byte big-endian length at
 * offsets 2..4, then 4 rounds of field elements whose two high bits are zero, reassembled 127 bytes per 128.
 */
import { BLOB_SIZE } from './wire.js';

/** OP MaxBlobDataSize: (4*31+3)*1024 - 4. */
export const BLOB_MAX_DATA = (4 * 31 + 3) * 1024 - 4;

export class BlobDecodeError extends Error {}

/** Go copy(dst[off:], src): copies as many bytes as fit, never throws. */
function copyInto(dst: Uint8Array, off: number, src: Uint8Array): void {
  const n = Math.min(src.length, dst.length - off);
  if (n > 0) dst.set(src.subarray(0, n), off);
}

/** OP Blob.ToData; any deviation from the encoding (version, length, field-element top bits, non-zero padding) is a BlobDecodeError. */
export function blobToData(b: Uint8Array): Uint8Array {
  if (b.length !== BLOB_SIZE) throw new BlobDecodeError('blob length');
  if (b[1] !== 0) throw new BlobDecodeError('blob encoding version');
  const outLen = (b[2]! << 16) | (b[3]! << 8) | b[4]!;
  if (outLen > BLOB_MAX_DATA) throw new BlobDecodeError('blob data length');
  const out = new Uint8Array(BLOB_MAX_DATA);
  copyInto(out, 0, b.subarray(5, 32));
  let opos = 28;
  let ipos = 32;
  const enc = new Uint8Array(4);
  enc[0] = b[0]!;
  if ((enc[0]! & 0xc0) !== 0) throw new BlobDecodeError('blob field element');
  const field = (): number => {
    if ((b[ipos]! & 0xc0) !== 0) throw new BlobDecodeError('blob field element');
    copyInto(out, opos, b.subarray(ipos + 1, ipos + 32));
    const c = b[ipos]!;
    opos += 32;
    ipos += 32;
    return c;
  };
  const reassemble = (): void => {
    opos--;
    const x = (enc[0]! & 0x3f) | ((enc[1]! & 0x30) << 2);
    const y = (enc[1]! & 0x0f) | ((enc[3]! & 0x0f) << 4);
    const z = (enc[2]! & 0x3f) | ((enc[3]! & 0x30) << 2);
    out[opos - 32] = z;
    out[opos - 64] = y;
    out[opos - 96] = x;
  };
  for (let i = 1; i < 4; i++) enc[i] = field();
  reassemble();
  for (let i = 1; i < 1024 && opos < outLen; i++) {
    for (let j = 0; j < 4; j++) enc[j] = field();
    reassemble();
  }
  for (let i = outLen; i < out.length; i++) if (out[i] !== 0) throw new BlobDecodeError('blob data tail');
  for (let i = ipos; i < b.length; i++) if (b[i] !== 0) throw new BlobDecodeError('blob input tail');
  return out.subarray(0, outLen);
}

/** OP Blob.FromData: the inverse of blobToData; vector generators and tests use it. */
export function encodeBlob(data: Uint8Array): Uint8Array {
  if (data.length > BLOB_MAX_DATA) throw new BlobDecodeError('blob data too long');
  const b = new Uint8Array(BLOB_SIZE);
  let readOffset = 0;
  let writeOffset = 0;
  let buf31 = new Uint8Array(31);
  const read1 = (): number => (readOffset >= data.length ? 0 : data[readOffset++]!);
  const read31 = (): void => {
    buf31 = new Uint8Array(31);
    if (readOffset >= data.length) return;
    const chunk = data.subarray(readOffset, readOffset + 31);
    buf31.set(chunk);
    readOffset += chunk.length;
  };
  const write1 = (v: number): void => {
    b[writeOffset++] = v;
  };
  const write31 = (): void => {
    b.set(buf31, writeOffset);
    writeOffset += 31;
  };
  for (let round = 0; round < 1024 && readOffset < data.length; round++) {
    if (round === 0) {
      buf31 = new Uint8Array(31);
      const ilen = data.length;
      buf31[0] = 0;
      buf31[1] = (ilen >> 16) & 0xff;
      buf31[2] = (ilen >> 8) & 0xff;
      buf31[3] = ilen & 0xff;
      const chunk = data.subarray(0, 27);
      buf31.set(chunk, 4);
      readOffset += chunk.length;
    } else {
      read31();
    }
    const x = read1();
    write1(x & 0x3f);
    write31();
    read31();
    const y = read1();
    write1((y & 0x0f) | ((x & 0xc0) >> 2));
    write31();
    read31();
    const z = read1();
    write1(z & 0x3f);
    write31();
    read31();
    write1(((z & 0xc0) >> 2) | ((y & 0xf0) >> 4));
    write31();
  }
  if (readOffset < data.length) throw new BlobDecodeError('blob data does not fit');
  return b;
}
