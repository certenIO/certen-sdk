/**
 * Locates and converts the parts of Ethereum light-client SSZ objects that the ledger tooling needs WITHOUT verifying anything (the
 * twin of the validator's pkg/finality/lcssz): the next sync committee of a LightClientUpdate, the conversion of an update to the finality
 * update that carries the same signature, and the slots of an object. It is the byte-level companion of ethl1 (which verifies); every
 * function here is pure, bounds-checked and throws an LcsszError for a blob that does not have the stated layout, never a RangeError.
 * Nothing it returns is trusted: callers hand the results to verifyFinalizedHead.
 *
 * Layouts (V2_SPEC_S7 3.2): Gloas objects are fixed-size (update 26,424 B, finality update 1,448 B, bootstrap 25,472 B); the electra
 * layout (Electra and Fulu) is variable-size and decoded through SSZ offsets.
 */

/** A blob that does not have the layout asked for (Go: a fmt.Errorf error). */
export class LcsszError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LcsszError';
  }
}

/**
 * The finalized header of an electra-layout finality update does not hold a whole execution payload header (the fixed part of the beacon
 * header, its execution branch and the execution payload header's fixed fields). Go: ErrFinalizedHeaderTooShort (matched with errors.Is).
 */
export class FinalizedHeaderTooShortError extends LcsszError {
  constructor(message: string) {
    super(message);
    this.name = 'FinalizedHeaderTooShortError';
  }
}

/** The LB layout byte of the evidence container. */
export const Electra = 1;
export const Gloas = 2;
export type Layout = number;

export const CommitteeBytes = 512 * 48 + 48;
const beaconHeader = 112;
const aggregate = 512 / 8 + 96;

export const GloasUpdateSize = 26424;
export const GloasFinalityUpdateSize = 1448;
export const GloasBootstrapSize = 25472;
const gloasHeader = 496;
const gloasNextBranch = 11 * 32;
const gloasFinalityBranch = 9 * 32;

const electraUpdateFixed = 4 + CommitteeBytes + 6 * 32 + 4 + 7 * 32 + aggregate + 8; // 25,216
const electraFinalityUpdateFixed = 4 + 4 + 7 * 32 + aggregate + 8; // 400
const electraBootstrapFixed = 4 + CommitteeBytes + 6 * 32; // 24,820
const electraHeaderFixed = beaconHeader + 4 + 4 * 32; // 244
const electraExecFixed = 584;
const electraExecNumberAt = 404;
const electraExecHashAt = 472;

/** The fixed sizes the decoders use, exported so a test can pin them to the real objects. */
export const SIZES = {
  electraUpdateFixed,
  electraFinalityUpdateFixed,
  electraBootstrapFixed,
  electraHeaderFixed,
  electraExecFixed,
  electraExecNumberAt,
  electraExecHashAt,
} as const;

const u32le = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0, true);
const u64le = (b: Uint8Array, at: number): bigint => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);

/** A LightClientUpdate's layout by size: exactly 26,424 bytes is Gloas, anything longer is the electra layout. */
export function layoutOfUpdate(b: Uint8Array): Layout {
  return b.length === GloasUpdateSize ? Gloas : Electra;
}

/** layoutOfUpdate for a LightClientFinalityUpdate (1,448 bytes is Gloas). */
export function layoutOfFinalityUpdate(b: Uint8Array): Layout {
  return b.length === GloasFinalityUpdateSize ? Gloas : Electra;
}

/** layoutOfUpdate for a LightClientBootstrap (25,472 bytes is Gloas). */
export function layoutOfBootstrap(b: Uint8Array): Layout {
  return b.length === GloasBootstrapSize ? Gloas : Electra;
}

/** The 24,624-byte next_sync_committee of a LightClientUpdate. */
export function nextCommittee(l: Layout, update: Uint8Array): Uint8Array {
  switch (l) {
    case Gloas:
      if (update.length !== GloasUpdateSize) throw new LcsszError(`lcssz: a gloas update is ${GloasUpdateSize} bytes, got ${update.length}`);
      return update.subarray(gloasHeader, gloasHeader + CommitteeBytes);
    case Electra:
      if (update.length < electraUpdateFixed) throw new LcsszError(`lcssz: an electra update is at least ${electraUpdateFixed} bytes, got ${update.length}`);
      return update.subarray(4, 4 + CommitteeBytes);
  }
  throw new LcsszError(`lcssz: unknown layout ${l}`);
}

/** The 24,624-byte current_sync_committee of a LightClientBootstrap. */
export function bootstrapCommittee(l: Layout, boot: Uint8Array): Uint8Array {
  switch (l) {
    case Gloas:
      if (boot.length !== GloasBootstrapSize) throw new LcsszError(`lcssz: a gloas bootstrap is ${GloasBootstrapSize} bytes, got ${boot.length}`);
      return boot.subarray(gloasHeader, gloasHeader + CommitteeBytes);
    case Electra:
      if (boot.length < electraBootstrapFixed) throw new LcsszError(`lcssz: an electra bootstrap is at least ${electraBootstrapFixed} bytes, got ${boot.length}`);
      return boot.subarray(4, 4 + CommitteeBytes);
  }
  throw new LcsszError(`lcssz: unknown layout ${l}`);
}

/**
 * Converts a LightClientUpdate to the LightClientFinalityUpdate that carries the same attested header, finalized header, finality
 * branch, sync aggregate and signature slot (the next committee and its branch are dropped): the update's finality projection. The
 * signature stays valid because the signed message is the attested beacon header.
 */
export function updateToFinalityUpdate(l: Layout, update: Uint8Array): Uint8Array {
  switch (l) {
    case Gloas: {
      if (update.length !== GloasUpdateSize) throw new LcsszError(`lcssz: a gloas update is ${GloasUpdateSize} bytes, got ${update.length}`);
      const finAt = gloasHeader + CommitteeBytes + gloasNextBranch;
      const parts = [
        update.subarray(0, gloasHeader), // attested
        update.subarray(finAt, finAt + gloasHeader), // finalized
        update.subarray(finAt + gloasHeader, finAt + gloasHeader + gloasFinalityBranch), // finality branch
        update.subarray(finAt + gloasHeader + gloasFinalityBranch), // aggregate + signature slot
      ];
      const out = new Uint8Array(GloasFinalityUpdateSize);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    }
    case Electra: {
      if (update.length < electraUpdateFixed) throw new LcsszError(`lcssz: an electra update is at least ${electraUpdateFixed} bytes, got ${update.length}`);
      const finOffAt = 4 + CommitteeBytes + 6 * 32;
      const attOff = u32le(update, 0);
      const finOff = u32le(update, finOffAt);
      if (attOff !== electraUpdateFixed || finOff < attOff || finOff > update.length) {
        throw new LcsszError(`lcssz: electra update offsets ${attOff},${finOff} do not fit ${update.length} bytes`);
      }
      const att = update.subarray(attOff, finOff);
      const fin = update.subarray(finOff);
      const branchAt = finOffAt + 4;
      const tail = update.subarray(branchAt, branchAt + 7 * 32 + aggregate + 8);
      const out = new Uint8Array(electraFinalityUpdateFixed + att.length + fin.length);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, electraFinalityUpdateFixed, true);
      dv.setUint32(4, (electraFinalityUpdateFixed + att.length) >>> 0, true);
      out.set(tail, 8);
      out.set(att, electraFinalityUpdateFixed);
      out.set(fin, electraFinalityUpdateFixed + att.length);
      return out;
    }
  }
  throw new LcsszError(`lcssz: unknown layout ${l}`);
}

/** The attested slot, finalized slot and signature slot of a LightClientFinalityUpdate. */
export function finalityUpdateSlots(l: Layout, fu: Uint8Array): { attested: bigint; finalized: bigint; signature: bigint } {
  switch (l) {
    case Gloas:
      if (fu.length !== GloasFinalityUpdateSize) throw new LcsszError(`lcssz: a gloas finality update is ${GloasFinalityUpdateSize} bytes, got ${fu.length}`);
      return { attested: u64le(fu, 0), finalized: u64le(fu, gloasHeader), signature: u64le(fu, fu.length - 8) };
    case Electra: {
      const min = electraFinalityUpdateFixed + 2 * (electraHeaderFixed + electraExecFixed);
      if (fu.length < min) throw new LcsszError(`lcssz: an electra finality update is at least ${min} bytes, got ${fu.length}`);
      const attOff = u32le(fu, 0);
      const finOff = u32le(fu, 4);
      if (attOff !== electraFinalityUpdateFixed || finOff <= attOff || finOff + 8 > fu.length) {
        throw new LcsszError(`lcssz: electra finality update offsets ${attOff},${finOff} do not fit ${fu.length} bytes`);
      }
      return { attested: u64le(fu, attOff), finalized: u64le(fu, finOff), signature: u64le(fu, electraFinalityUpdateFixed - 8) };
    }
  }
  throw new LcsszError(`lcssz: unknown layout ${l}`);
}

/** The attested slot, finalized slot and signature slot of a LightClientUpdate. */
export function updateSlots(l: Layout, up: Uint8Array): { attested: bigint; finalized: bigint; signature: bigint } {
  return finalityUpdateSlots(l, updateToFinalityUpdate(l, up));
}

/**
 * What a finality update's finalized header says about its execution block: the hash always, and the block number only in the electra
 * layout (a Gloas header carries only execution_block_hash); hasNumber reports which. An electra object whose finalized header does not
 * hold the 828 fixed bytes is a FinalizedHeaderTooShortError (V-C2-A1 D3: a 2,056-byte update with finalized offset 2,048 panicked in Go).
 */
export function finalizedExec(l: Layout, fu: Uint8Array): { hash: Uint8Array; number: bigint; hasNumber: boolean } {
  switch (l) {
    case Gloas:
      if (fu.length !== GloasFinalityUpdateSize) throw new LcsszError(`lcssz: a gloas finality update is ${GloasFinalityUpdateSize} bytes, got ${fu.length}`);
      return { hash: Uint8Array.from(fu.subarray(gloasHeader + beaconHeader, gloasHeader + beaconHeader + 32)), number: 0n, hasNumber: false };
    case Electra: {
      finalityUpdateSlots(l, fu);
      // finalityUpdateSlots only established finOff+8 <= len(fu); the execution payload header's fixed part must lie inside the object
      // before it is sliced
      const finOff = u32le(fu, 4);
      if (finOff > fu.length - (electraHeaderFixed + electraExecFixed)) {
        throw new FinalizedHeaderTooShortError(
          `lcssz: the finalized header is too short for an execution payload header: ${fu.length - finOff} bytes at offset ${finOff}, need ${electraHeaderFixed + electraExecFixed}`,
        );
      }
      const ex = fu.subarray(finOff + electraHeaderFixed);
      return { hash: Uint8Array.from(ex.subarray(electraExecHashAt, electraExecHashAt + 32)), number: u64le(ex, electraExecNumberAt), hasNumber: true };
    }
  }
  throw new LcsszError(`lcssz: unknown layout ${l}`);
}

/**
 * Parses the framed /light_client/updates response body: per update a little-endian u64 length, a 4-byte fork digest and the SSZ object.
 * The digest is returned beside the object for diagnostics only; it is never evidence. No length from the body sizes anything before it is
 * compared with what remains.
 */
export function splitFramedUpdates(body: Uint8Array): { objs: Uint8Array[]; digests: Uint8Array[] } {
  const objs: Uint8Array[] = [];
  const digests: Uint8Array[] = [];
  let pos = 0;
  while (pos < body.length) {
    if (pos + 12 > body.length) throw new LcsszError(`lcssz: updates frame truncated at ${pos}`);
    const n = u64le(body, pos);
    if (n < 4n || n > BigInt(body.length - pos - 8)) throw new LcsszError(`lcssz: updates frame length ${n} at ${pos} overruns the body`);
    digests.push(Uint8Array.from(body.subarray(pos + 8, pos + 12)));
    objs.push(body.subarray(pos + 12, pos + 8 + Number(n)));
    pos += 8 + Number(n);
  }
  return { objs, digests };
}

/** The number of set sync_committee_bits of a LightClientFinalityUpdate. */
export function finalityUpdateParticipants(l: Layout, fu: Uint8Array): number {
  let at: number;
  switch (l) {
    case Gloas:
      if (fu.length !== GloasFinalityUpdateSize) throw new LcsszError(`lcssz: a gloas finality update is ${GloasFinalityUpdateSize} bytes, got ${fu.length}`);
      at = 2 * gloasHeader + gloasFinalityBranch;
      break;
    case Electra:
      if (fu.length < electraFinalityUpdateFixed) throw new LcsszError(`lcssz: an electra finality update is at least ${electraFinalityUpdateFixed} bytes, got ${fu.length}`);
      at = 8 + 7 * 32;
      break;
    default:
      throw new LcsszError(`lcssz: unknown layout ${l}`);
  }
  let n = 0;
  for (const b0 of fu.subarray(at, at + 512 / 8)) for (let b = b0; b !== 0; b &= b - 1) n++;
  return n;
}
