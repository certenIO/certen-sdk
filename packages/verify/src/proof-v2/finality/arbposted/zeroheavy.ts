/**
 * The zero-heavy layer of a batch payload (the twin of pkg/finality/arbposted/zeroheavy.go; nitro@ccc5c82 zeroheavy.ZeroheavyDecoder over a
 * byte slice, read to its end or to max+1 bytes). The format (legacy calldata gas saving) writes a zero byte as two bits, 0x01 as eight and
 * a byte below 0x80 as nine, and a byte from 0x80 as nine; the decoder is lenient by construction: bits left over at the end (the encoder's
 * "0 then 1s" padding) are never emitted, so every input decodes to something. exceeded is true when the output would pass max bytes.
 *
 * Unlike the reference, which keeps one bool per pending bit, the bits waiting to be read are kept as runs (a bit value and a count): a
 * hostile input of 0xff bytes grows the run of deferred ones by eight per input byte and the reference then appends them one at a time,
 * so the runs bound the memory by the number of runs, not by the number of bits. The sequence of bits the decoder hands out is the same.
 */

/** The result of zeroheavyDecode: the bytes (empty when exceeded) and whether the output would have passed max bytes. */
export interface ZeroheavyResult {
  out: Uint8Array;
  exceeded: boolean;
}

class Decoder {
  private pos = 0;
  /** pending bits as runs: run i is (bit runBit[i], count runCount[i]); the first live run is at head */
  private runBit: number[] = [];
  private runCount: number[] = [];
  private head = 0;
  private eofAfterBuffer = false;
  private deferredZero = false;
  private numDeferredOnes = 0;

  constructor(private readonly src: Uint8Array) {}

  private pushRun(bit: number, count: number): void {
    if (count <= 0) return;
    const last = this.runBit.length - 1;
    if (last >= this.head && this.runBit[last] === bit) {
      this.runCount[last]! += count;
      return;
    }
    this.runBit.push(bit);
    this.runCount.push(count);
  }

  private bufferEmpty(): boolean {
    return this.head >= this.runBit.length;
  }

  private pushBit(b: boolean): void {
    if (this.deferredZero) {
      if (b) {
        this.numDeferredOnes++;
        return;
      }
      this.pushRun(0, 1);
      this.pushRun(1, this.numDeferredOnes);
      this.numDeferredOnes = 0;
      return;
    }
    if (b) {
      this.pushRun(1, 1);
    } else {
      this.deferredZero = true;
    }
  }

  private push7Bits(b: number): void {
    for (let i = 0; i < 7; i++) this.pushBit((b & (1 << (6 - i))) !== 0);
  }

  /** reads one source byte into the bit buffer and reports whether the source is at its end */
  private refill(): boolean {
    if (this.pos >= this.src.length) return true;
    const b = this.src[this.pos++]!;
    if (b === 0) {
      this.pushBit(false);
      this.pushBit(false);
    } else if (b === 1) {
      this.pushBit(false);
      this.pushBit(true);
      for (let i = 0; i < 6; i++) this.pushBit(false);
    } else if (b < 0x80) {
      this.pushBit(false);
      this.pushBit(true);
      this.push7Bits(b);
    } else {
      this.pushBit(true);
      this.push7Bits(b & 0x7f);
    }
    return false;
  }

  /** the next bit, or -1 when the source and the buffer are both exhausted */
  private nextBit(): number {
    while (this.bufferEmpty()) {
      if (this.eofAfterBuffer) return -1;
      this.eofAfterBuffer = this.refill();
    }
    const h = this.head;
    const bit = this.runBit[h]!;
    if (--this.runCount[h]! === 0) {
      this.head = h + 1;
      if (this.head >= 4096 && this.head * 2 >= this.runBit.length) {
        this.runBit = this.runBit.slice(this.head);
        this.runCount = this.runCount.slice(this.head);
        this.head = 0;
      }
    }
    return bit;
  }

  /** one output byte, or -1 when fewer than eight bits remain */
  readOne(): number {
    let ret = 0;
    for (let i = 0; i < 8; i++) {
      const b = this.nextBit();
      if (b < 0) return -1;
      ret = (ret << 1) | b;
    }
    return ret;
  }
}

/**
 * zeroheavyDecode: the bytes the layer decodes `input` to, capped at `max` bytes. The output grows with what is read, never from a
 * length the input states, so the work and the memory are bounded by `max` and the input.
 */
export function zeroheavyDecode(input: Uint8Array, max: number): ZeroheavyResult {
  const d = new Decoder(input);
  let out = new Uint8Array(Math.min(Math.max(input.length, 16), max + 1));
  let n = 0;
  for (;;) {
    const b = d.readOne();
    if (b < 0) return { out: out.slice(0, n), exceeded: false };
    if (n === max) return { out: new Uint8Array(0), exceeded: true };
    if (n === out.length) {
      const bigger = new Uint8Array(Math.min(out.length * 2, max + 1));
      bigger.set(out);
      out = bigger;
    }
    out[n++] = b;
  }
}
