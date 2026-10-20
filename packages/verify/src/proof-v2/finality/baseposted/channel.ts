/**
 * OP Stack channel frames and channel decompression (derive/frame.go and the derivation spec's channel format), the twin of the frame and
 * decompress parts of the validator's pkg/finality/baseposted/channel.go. Zlib and Brotli run on node:zlib with the output cap enforced
 * WHILE streaming (maxOutputLength), so a decompression bomb never allocates more than the cap.
 */
import { brotliDecompressSync, inflateSync } from 'node:zlib';

/** OP MaxFrameLen: a frame's data is at most one million bytes. */
export const MAX_FRAME_DATA = 1_000_000;

export class ChannelError extends Error {}

/** One channel frame: channel_id(16) || frame_number(u16) || frame_data_length(u32) || frame_data || is_last(u8). */
export interface Frame {
  id: Uint8Array;
  number: number;
  data: Uint8Array;
  isLast: boolean;
}

/** The frame's binary form. */
export function marshalFrame(f: Frame): Uint8Array {
  const out = new Uint8Array(16 + 2 + 4 + f.data.length + 1);
  out.set(f.id, 0);
  const dv = new DataView(out.buffer);
  dv.setUint16(16, f.number, false);
  dv.setUint32(18, f.data.length, false);
  out.set(f.data, 22);
  out[22 + f.data.length] = f.isLast ? 1 : 0;
  return out;
}

/** OP ParseFrames: derivation version byte 0, then frames to the end of the data. */
export function parseFrames(data: Uint8Array): Frame[] {
  if (data.length === 0 || data[0] !== 0) throw new ChannelError('derivation version');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 1;
  const out: Frame[] = [];
  while (pos < data.length) {
    if (data.length - pos < 16 + 2 + 4) throw new ChannelError('frame header');
    const id = Uint8Array.from(data.subarray(pos, pos + 16));
    const number = dv.getUint16(pos + 16, false);
    const n = dv.getUint32(pos + 18, false);
    pos += 22;
    if (n > MAX_FRAME_DATA || n + 1 > data.length - pos) throw new ChannelError('frame length');
    const body = Uint8Array.from(data.subarray(pos, pos + n));
    const last = data[pos + n]!;
    if (last !== 0 && last !== 1) throw new ChannelError('frame is_last');
    out.push({ id, number, data: body, isLast: last === 1 });
    pos += n + 1;
  }
  if (out.length === 0) throw new ChannelError('no frames');
  return out;
}

/**
 * The channel decompression of the derivation spec: zlib when b0&0x0f == 8 (and the CINFO nibble is at most 7), Brotli when b0 == 1
 * (version byte, then the Brotli stream). The output is capped at max bytes: one more is a bomb.
 */
export function decompress(ch: Uint8Array, max: bigint): Uint8Array {
  if (ch.length === 0) throw new ChannelError('empty channel');
  // node caps the output at a Number: a pin above 2^53 would be a pins error long before this
  const cap = Number(max) + 1;
  let out: Uint8Array;
  try {
    if ((ch[0]! & 0x0f) === 8) {
      if (ch[0]! >> 4 > 7) throw new ChannelError('zlib window');
      out = inflateSync(ch, { maxOutputLength: cap });
    } else if (ch[0] === 1) {
      out = brotliDecompressSync(ch.subarray(1), { maxOutputLength: cap });
    } else {
      throw new ChannelError('compression type');
    }
  } catch (e) {
    if (e instanceof ChannelError) throw e;
    throw new ChannelError(`decompress: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (BigInt(out.length) > max) throw new ChannelError('channel exceeds max_rlp_bytes_per_channel');
  return out;
}
