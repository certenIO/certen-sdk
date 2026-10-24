/**
 * The Nitro batch payload decoder the verifier replays (annex A6.3 steps 4-6; the twin of pkg/finality/arbposted/nitro.go): blobs ->
 * RLP payload -> brotli -> segments -> L2 messages -> signed transactions. Sources: nitro@ccc5c82 util/blobs/blobs.go (DecodeBlobs),
 * arbstate/inbox.go (parseSequencerMessage / segment kinds), arbos/parse_l2.go (L2 message kinds), daprovider header bytes.
 *
 * Every step is bounded against hostile input: the brotli output is capped WHILE streaming (node:zlib maxOutputLength, so a bomb never
 * allocates more than the cap), the segment count is capped, a nested message larger than nitro's MaxL2MessageSize is dropped, nesting
 * stops at nitro's depth limit, and no length is trusted against the bytes that remain.
 */
import { RlpError, split, splitString } from '../../../s6/rlp.js';
import { StrictBrotliError, decompress } from '../strictbrotli.js';
import { parseL2Msg } from './derive.js';
import { txType } from './delayed.js';
import { zeroheavyDecode } from './zeroheavy.js';
import { BLOB_BYTES } from './wire.js';

// Payload header bytes (the first byte of a decoded batch payload or of calldata batch data).
export const HEADER_BROTLI = 0x00;
export const HEADER_ZEROHEAVY = 0x20;
export const HEADER_DACERT = 0x01;
export const HEADER_DAS = 0x80;
export const HEADER_DAS_TREE = 0x88;

// Segment kinds of a decompressed batch (nitro inbox.go).
export const SEG_L2_MESSAGE = 0;
export const SEG_L2_MESSAGE_BROTLI = 1;
export const SEG_DELAYED = 2;
export const SEG_ADVANCE_TIME = 3;
export const SEG_ADVANCE_L1_BLOCK = 4;

// L2 message kinds (nitro arbos/parse_l2.go).
export const L2_BATCH = 3;
export const L2_SIGNED_TX = 4;

/** nitro's MaxL2MessageSize (256 KiB): a top-level message, a nested message or a brotli-compressed segment larger than this is dropped. */
export const MAX_L2_MESSAGE_SIZE = 256 * 1024;

/** nitro's nesting limit for batch messages inside batch messages. */
export const MAX_L2_DEPTH = 16;

// Blob field-element layout (EIP-4844): 4096 elements of 32 bytes; nitro stores 31 data bytes per element and the 6 spare low bits of
// byte 0 of each element as a packed bit stream.
const FIELD_ELEMENTS = 4096;
const BLOB_DATA_BYTES = FIELD_ELEMENTS * 31;
const BLOB_BITSTREAM_LEN = (FIELD_ELEMENTS * 6) / 8;

/** decodeBlobs failed: the blobs do not hold one RLP byte string followed by zero padding. */
export class BlobPayloadError extends Error {}

/**
 * nitro's DecodeBlobs: per blob, the 31 high bytes of every field element followed by the packed 6-bit groups; the concatenation is one RLP
 * byte string, whose content is the payload. Bytes after the string must be zero padding.
 */
export function decodeBlobs(blobs: readonly Uint8Array[]): Uint8Array {
  const per = BLOB_DATA_BYTES + BLOB_BITSTREAM_LEN;
  const rlpData = new Uint8Array(blobs.length * per);
  let o = 0;
  for (const blob of blobs) {
    if (blob.length !== BLOB_BYTES) throw new BlobPayloadError('blob length');
    for (let fe = 0; fe < FIELD_ELEMENTS; fe++) {
      rlpData.set(blob.subarray(fe * 32 + 1, fe * 32 + 32), o);
      o += 31;
    }
    let acc = 0;
    let accBits = 0;
    for (let fe = 0; fe < FIELD_ELEMENTS; fe++) {
      acc = (acc | ((blob[fe * 32]! & 0x3f) << accBits)) & 0xffff;
      accBits += 6;
      if (accBits >= 8) {
        rlpData[o++] = acc & 0xff;
        acc >>= 8;
        accBits -= 8;
      }
    }
  }
  let payload: Uint8Array;
  let rest: Uint8Array;
  try {
    const it = splitString(rlpData);
    payload = it.content;
    rest = it.rest;
  } catch (e) {
    if (e instanceof RlpError) throw new BlobPayloadError(e.message);
    throw e;
  }
  for (const c of rest) if (c !== 0) throw new BlobPayloadError('non-zero bytes after the payload');
  return payload;
}

export interface Uncompressed {
  out: Uint8Array;
  /** the stream would produce more than max bytes */
  exceeded: boolean;
  /** the stream is not one complete brotli stream (empty, truncated, corrupt, or followed by a byte) */
  failed: boolean;
}

/**
 * Brotli decompression capped at max bytes (the twin of Go's uncompress over package strictbrotli, which both Arbitrum batches and OP
 * channels use through ../strictbrotli.ts): exceeded when the stream would produce more than max; a stream that is incomplete, empty or
 * followed by extra bytes has failed.
 */
export function uncompress(input: Uint8Array, max: number): Uncompressed {
  try {
    const r = decompress(input, max);
    return { out: r.out, exceeded: r.exceeded, failed: false };
  } catch (e) {
    if (e instanceof StrictBrotliError) return { out: new Uint8Array(0), exceeded: false, failed: true };
    throw e;
  }
}

/** One decoded batch segment. */
export interface Segment {
  kind: number;
  body: Uint8Array;
}

/**
 * Reads the decompressed stream as RLP byte strings, exactly as nitro's parseSequencerMessage does: the first string that fails to parse
 * (or is a list) ends the batch, what was read stays. More than maxSegments strings is reported as exceeded (nitro stops at the limit; the
 * verifier refuses, spec 8.2). The limit is checked BEFORE the empty-segment skip, as in the reference.
 */
export function splitSegments(stream: Uint8Array, maxSegments: number): { segs: Segment[]; exceeded: boolean } {
  const segs: Segment[] = [];
  let rest = stream;
  while (rest.length > 0) {
    let it;
    try {
      it = split(rest);
    } catch (e) {
      if (e instanceof RlpError) return { segs, exceeded: false };
      throw e;
    }
    if (it.kind === 'list') return { segs, exceeded: false };
    rest = it.rest;
    if (segs.length >= maxSegments) return { segs, exceeded: true };
    if (it.content.length === 0) continue; // an empty segment carries no kind
    segs.push({ kind: it.content[0]!, body: it.content.subarray(1) });
  }
  return { segs, exceeded: false };
}

/** One decoded L2 message and its signed transactions (each as the bytes the message carries). */
export interface L2Message {
  ordinal: number;
  txs: Uint8Array[];
}

/**
 * The signed transactions of one sequencer-batch L2 message, as Nitro's parseL2Message (arbos/parse_l2.go) builds it with no L1 request id:
 * kind 4 is one transaction, kind 3 a batch of nested messages (depth < 16; a length prefix that is cut, oversize or past the data ends the
 * batch quietly), kind 0 is an unsigned transaction whose fields must parse (it is built from the poster and is not a signed transaction,
 * so it contributes none). Everything else fails the message: kind 1 (a contract transaction needs a request id), 2, 6 (heartbeats are
 * disabled), 7, unknown kinds, a short field, and ANY nested failure fails the WHOLE message. A failed message has no transactions: a
 * malformed message is not a message (null).
 */
export function parseL2(msg: Uint8Array, depth: number): Uint8Array[] | null {
  // ParseL2Transactions (arbos/parse_l2.go) drops a message whose L2msg is larger than MaxL2MessageSize before it reads a byte of it: the
  // limit holds for the top-level message of a sequencer batch exactly as for a nested one.
  if (msg.length > MAX_L2_MESSAGE_SIZE) return null;
  const txs = parseL2Msg(msg, new Uint8Array(20), null, 0n, depth, false);
  if (txs === null) return null;
  return txs.filter((tx) => txType(tx) <= 4);
}

export const PayloadOK = 0;
export const PayloadOffL1 = 1;
export const PayloadUnknownHeader = 2;
export const PayloadUndecodable = 3;
export const PayloadTooLarge = 4;

export interface PayloadResult {
  messages: L2Message[];
  segments: number;
  /** the number of kind-2 (delayed message) segments: the delayed messages the batch consumed */
  delayedSegments: number;
  /** the payload header byte (for data that is not on L1, or an unrecognised byte) */
  headerByte: number;
  status: number;
  /** which bound was exceeded when status is PayloadTooLarge */
  exceededUncompressed: boolean;
  exceededSegments: boolean;
}

/** Turns a batch payload (header byte then brotli) into messages; status names why a payload cannot be read as signed-transaction messages. */
export function decodePayload(payload: Uint8Array, maxUncompressed: number, maxSegments: number): PayloadResult {
  const res: PayloadResult = {
    messages: [],
    segments: 0,
    delayedSegments: 0,
    headerByte: 0,
    status: PayloadOK,
    exceededUncompressed: false,
    exceededSegments: false,
  };
  if (payload.length === 0) {
    res.status = PayloadUndecodable;
    return res;
  }
  res.headerByte = payload[0]!;
  switch (payload[0]) {
    case HEADER_BROTLI:
      break;
    case HEADER_ZEROHEAVY: {
      // Nitro decodes the zero-heavy layer once (limit 101% of the batch bound + 64) and then reads the result as an ordinary payload: it
      // must begin with the Brotli header byte, nothing else is decoded after it.
      const zh = zeroheavyDecode(payload.subarray(1), maxUncompressed + Math.floor(maxUncompressed / 100) + 64);
      if (zh.exceeded) {
        res.status = PayloadTooLarge;
        res.exceededUncompressed = true;
        return res;
      }
      if (zh.out.length === 0) {
        res.status = PayloadUndecodable;
        return res;
      }
      res.headerByte = zh.out[0]!;
      if (zh.out[0] !== HEADER_BROTLI) {
        res.status = PayloadUnknownHeader;
        return res;
      }
      payload = zh.out;
      break;
    }
    case HEADER_DAS:
    case HEADER_DAS_TREE:
    case HEADER_DACERT:
      res.status = PayloadOffL1;
      return res;
    default:
      res.status = PayloadUnknownHeader;
      return res;
  }
  const un = uncompress(payload.subarray(1), maxUncompressed);
  if (un.exceeded) {
    res.status = PayloadTooLarge;
    res.exceededUncompressed = true;
    return res;
  }
  if (un.failed) {
    res.status = PayloadUndecodable;
    return res;
  }
  const { segs, exceeded } = splitSegments(un.out, maxSegments);
  if (exceeded) {
    res.status = PayloadTooLarge;
    res.exceededSegments = true;
    return res;
  }
  res.segments = segs.length;
  let ord = 0;
  for (const sg of segs) {
    let msg: Uint8Array;
    switch (sg.kind) {
      case SEG_L2_MESSAGE:
        msg = sg.body;
        break;
      case SEG_L2_MESSAGE_BROTLI: {
        const m = uncompress(sg.body, MAX_L2_MESSAGE_SIZE);
        if (m.failed || m.exceeded) continue; // nitro drops a message it cannot decompress
        msg = m.out;
        break;
      }
      case SEG_DELAYED:
        res.delayedSegments++;
        continue;
      default:
        continue;
    }
    res.messages.push({ ordinal: ord, txs: parseL2(msg, 0) ?? [] });
    ord++;
  }
  return res;
}
