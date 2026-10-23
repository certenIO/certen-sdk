/**
 * The ONE Brotli decompression the finality verifiers use (Arbitrum batches and messages, OP channels): the twin of the validator's
 * pkg/finality/strictbrotli.
 *
 * Why it exists. The reference Go reader (andybalholm/brotli through io.ReadAll) answers a clean EOF when its source is exhausted while the
 * decoder still needs input, so a stream cut short decodes to a PREFIX with a nil error; the Go package refuses every incomplete stream, the
 * empty stream and any byte after a complete one. node:zlib has the opposite gaps: it refuses a stream cut short and the empty input, but
 * silently ignores every byte after the end of a complete stream. Both decoders implement the reference algorithm, so they agree on which
 * bytes form a complete stream; the verdict here is the Go one:
 *
 *   - empty input                       -> StrictBrotliError('empty')       (Go ErrEmpty)
 *   - a stream that ends before its last metablock is complete -> StrictBrotliError('incomplete')  (Go ErrIncomplete)
 *   - any byte after a complete stream  -> StrictBrotliError('trailing')    (Go ErrTrailing)
 *   - a corrupt stream                  -> StrictBrotliError('decode')      (Go: the library's own error)
 *   - output above max                  -> exceeded (the stream is not read to its end)
 *
 * How each is established with node. A complete stream decodes under BROTLI_OPERATION_FINISH and the decoder reports how many input bytes
 * it consumed (engine.bytesWritten): fewer than the input is a byte after the end. A stream cut short is Z_BUF_ERROR under FINISH; the same
 * input under BROTLI_OPERATION_FLUSH returns what the decoder could emit before it ran out of input, exactly the prefix the Go reader hands
 * out, so "exceeded" for a cut stream is judged on that prefix (Go counts the output before the failure: classify's first test). The output cap
 * is enforced while streaming (maxOutputLength), so a decompression bomb never allocates more than the cap.
 */
import { kMaxLength } from 'node:buffer';
import { brotliDecompressSync, constants } from 'node:zlib';

/** The reason a stream is refused (Go: ErrEmpty, ErrIncomplete, ErrTrailing, and the library's own decode error). */
export type StrictBrotliReason = 'empty' | 'incomplete' | 'trailing' | 'decode';

/** The Go error texts, so a caller can name the reason as Go does. */
export const ERR_EMPTY = 'brotli: empty stream';
export const ERR_INCOMPLETE = 'brotli: stream is incomplete';
export const ERR_TRAILING = 'brotli: bytes after the end of the stream';

const TEXT: Record<StrictBrotliReason, string> = {
  empty: ERR_EMPTY,
  incomplete: ERR_INCOMPLETE,
  trailing: ERR_TRAILING,
  decode: 'brotli: corrupt stream',
};

/** A stream that is empty, incomplete, corrupt or followed by a byte. */
export class StrictBrotliError extends Error {
  readonly reason: StrictBrotliReason;
  constructor(reason: StrictBrotliReason, detail?: string) {
    super(detail === undefined ? TEXT[reason] : `${TEXT[reason]}: ${detail}`);
    this.name = 'StrictBrotliError';
    this.reason = reason;
  }
}

/** The decompressed bytes (empty when exceeded) and whether the stream would produce more than max bytes. */
export interface Decompressed {
  out: Uint8Array;
  exceeded: boolean;
}

const NODE_MAX_LENGTH = BigInt(kMaxLength);

/**
 * node's output cap for a stream cap of `max` bytes: one byte past it proves an excess. A cap beyond what a Buffer can hold is no cap at
 * all (Go reads under any int cap, the largest of which no stream reaches), so it is clamped to the largest Buffer.
 */
const capOf = (max: bigint): number => Number(max + 1n > NODE_MAX_LENGTH ? NODE_MAX_LENGTH : max + 1n);

interface Info {
  buffer: Buffer;
  engine: { bytesWritten: number };
}

const isTooLarge = (e: unknown): boolean => (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';

/**
 * Decompress returns the whole decompressed stream, capped at max bytes: exceeded is true (and out empty) when the stream would produce
 * more than max. An incomplete stream, an empty one or one followed by extra bytes throws a StrictBrotliError. A stream that exceeds the cap
 * is reported as exceeded without being read to its end. max may be a number or a bigint (OP channels cap at a uint64).
 */
export function decompress(input: Uint8Array, max: number | bigint): Decompressed {
  const m = typeof max === 'bigint' ? max : BigInt(max);
  if (input.length === 0) throw new StrictBrotliError('empty');
  const cap = capOf(m);
  try {
    const r = brotliDecompressSync(input, { maxOutputLength: cap, info: true }) as unknown as Info;
    if (BigInt(r.buffer.length) > m) return { out: new Uint8Array(0), exceeded: true };
    if (r.engine.bytesWritten < input.length) throw new StrictBrotliError('trailing');
    return { out: new Uint8Array(r.buffer.buffer, r.buffer.byteOffset, r.buffer.length), exceeded: false };
  } catch (e) {
    if (e instanceof StrictBrotliError) throw e;
    if (isTooLarge(e)) return { out: new Uint8Array(0), exceeded: true };
    return classifyFailure(input, m, cap, e);
  }
}

/**
 * The stream did not decode under FINISH. Go's classify judges the output produced before the failure first: more than max is an excess
 * report whatever the failure was.
 *
 * Go's source serves the input, then ONE probe byte (0x00), then an error: so what the Go decoder emitted for a stream cut short is what
 * the decoder emits for input || 0x00 (an uncompressed metablock turns the probe byte into one more output byte, for instance), and the
 * stream is incomplete exactly when the decoder neither fails nor ends on it; a stream the probe byte turns into a decode error is that
 * error, not incompleteness. FLUSH returns the output the decoder could emit before it ran out of input.
 */
function classifyFailure(input: Uint8Array, max: bigint, cap: number, first: unknown): Decompressed {
  const code = (first as { code?: string }).code;
  const probed = new Uint8Array(input.length + 1);
  probed.set(input, 0);
  try {
    const r = brotliDecompressSync(probed, { maxOutputLength: cap, info: true, finishFlush: constants.BROTLI_OPERATION_FLUSH }) as unknown as Info;
    if (BigInt(r.buffer.length) > max) return { out: new Uint8Array(0), exceeded: true };
    throw new StrictBrotliError('incomplete');
  } catch (e) {
    if (e instanceof StrictBrotliError) throw e;
    if (isTooLarge(e)) return { out: new Uint8Array(0), exceeded: true };
  }
  // The decoder fails on the input (or on the probe byte). Go still counts the output it flushed before the failure.
  if (flushedBeyond(probed, max) || boundaryFlushedBeyond(input, max, cap)) return { out: new Uint8Array(0), exceeded: true };
  throw new StrictBrotliError('decode', code === undefined ? undefined : code);
}

/** The largest output buffer a probe allocates: a cap above this is never reached by a stream the decoder fails on. */
const MAX_PROBE_BUFFER = 512 * 1024 * 1024;

/**
 * Whether a decoder that FAILS on `input` had already flushed more than max bytes. node discards the output of the call that hits a
 * decode error, so it is read from the call that does NOT fail: the output buffer is given exactly max bytes (chunkSize = max) and the
 * decoder returns "needs more output" with a full buffer the moment it has more than max bytes to flush, which node counts against
 * maxOutputLength = max - 1; a decoder that flushed at most max bytes either leaves the buffer short or fills it exactly, and fails
 * without asking for room. The smallest buffer node allows is 64 bytes, so for a cap below 64 the probe judges 64 bytes or more (a
 * stream that fails after flushing between max+1 and 63 bytes is judged a decode error here, an excess by the Go reader: caps that
 * small are outside every pinned value).
 */
function flushedBeyond(input: Uint8Array, max: bigint): boolean {
  if (max > BigInt(MAX_PROBE_BUFFER)) return false;
  const size = max < 64n ? 64 : Number(max);
  const limit = max < 64n ? 1 : size - 1;
  try {
    brotliDecompressSync(input, { chunkSize: size, maxOutputLength: limit, info: true });
    return false;
  } catch (e) {
    return isTooLarge(e);
  }
}

/** The size of the Go reader's input buffer (andybalholm/brotli readBufSize): the decoder is handed the source in pieces of this size. */
const READ_BUF_SIZE = 32 * 1024;

/**
 * The output the Go reader flushed at its input boundaries. The decoder pushes its output whenever it runs out of input (reader.go reads
 * the source 32 KiB at a time, and the source serves the input and then the probe byte as separate reads), so everything decoded from the
 * input up to the last boundary BEFORE the failure is out, whatever the ring buffer's own flush points were. node hands the decoder the whole
 * input at once, so these flushes are read here: FLUSH over the prefix that ends at the boundary returns exactly the output decoded
 * so far. A prefix that already fails is never reached by the Go reader. The prefixes that decode are a prefix of the boundary list
 * (a failure persists in every longer prefix), so the last one is found by bisection, and its decoded length is the output.
 */
function boundaryFlushedBeyond(input: Uint8Array, max: bigint, cap: number): boolean {
  const bounds: number[] = [];
  for (let b = READ_BUF_SIZE; b < input.length; b += READ_BUF_SIZE) bounds.push(b);
  bounds.push(input.length);
  const decodes = (b: number): { ok: boolean; beyond: boolean } => {
    try {
      const r = brotliDecompressSync(input.subarray(0, b), { maxOutputLength: cap, info: true, finishFlush: constants.BROTLI_OPERATION_FLUSH }) as unknown as Info;
      return { ok: true, beyond: BigInt(r.buffer.length) > max };
    } catch (e) {
      return { ok: false, beyond: isTooLarge(e) };
    }
  };
  let lo = 0;
  let hi = bounds.length; // bounds[0..lo) decode, bounds[hi..] do not
  let beyond = false;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const d = decodes(bounds[mid]!);
    if (d.beyond) beyond = true;
    if (d.ok) lo = mid + 1;
    else hi = mid;
  }
  return beyond;
}
