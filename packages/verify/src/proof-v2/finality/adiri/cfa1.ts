/**
 * The compact committee chain CFA1 (V2_SPEC_S7 3.3; the twin of pkg/finality/adiri cfa1.go): the distinct committee orderings and records
 * 0..E. Decoding is strict: magic, bounded table and record counts, non-empty tables, table indices in range, signer indices strictly
 * increasing and below the committee size, no trailing byte, and encode(decode(x)) == x for every x accepted.
 */
import { Reader, Writer, type Limits } from '../codec.js';
import { EvidenceReason, evidenceTooLarge, malformed, malformedAt } from '../state.js';
import { CheckSignerIndexInvalid, chainBroken, type NumHash } from './states.js';

export const CFA1Magic = 'CFA1';
/** a compressed G2 public key and a compressed G1 signature */
export const KeyBytes = 96;
export const SigBytes = 48;

export const ReasonCFA1BadMagic = 'cfa1_bad_magic';
export const ReasonCFA1KeyLength = 'cfa1_key_length';
export const ReasonCFA1NoRecords = 'cfa1_no_records';
export const ReasonCFA1NoTables = 'cfa1_no_tables';
export const ReasonCFA1SignersTooMany = 'cfa1_signers_too_many';
export const ReasonCFA1TableEmpty = 'cfa1_table_empty';
export const ReasonCFA1TableIndexOutOfRange = 'cfa1_table_index_out_of_range';
export const ReasonCFA1TableSize = 'cfa1_table_size';
export const ReasonCFA1TooLargeToEncode = 'cfa1_too_large_to_encode';

/** One EpochRecord as CFA1 carries it: what the verifier cannot recompute. */
export interface EpochRec {
  committeeIdx: number;
  nextIdx: number;
  finalState: NumHash;
  finalConsensus: NumHash;
  signature: Uint8Array;
  signers: Uint8Array;
}

export interface CFA1 {
  /** each table: 1..255 keys of KeyBytes */
  tables: Uint8Array[][];
  records: EpochRec[];
}

/** Record i's committee (a table), or undefined when the index is out of range. */
export function committeeOf(c: CFA1, i: number): Uint8Array[] | undefined {
  if (i < 0 || i >= c.records.length || c.records[i]!.committeeIdx >= c.tables.length) return undefined;
  return c.tables[c.records[i]!.committeeIdx];
}

/** Record i's next_committee. */
export function nextOf(c: CFA1, i: number): Uint8Array[] | undefined {
  if (i < 0 || i >= c.records.length || c.records[i]!.nextIdx >= c.tables.length) return undefined;
  return c.tables[c.records[i]!.nextIdx];
}

/** The canonical byte form: "CFA1" || u16 n_tables || tables(u8 n || n x 96 B) || u32 n_records || per record (...). */
export function encodeCFA1(c: CFA1): Uint8Array {
  if (c.tables.length > 0xffff || c.records.length > 0xffffffff) throw malformed('cfa1', ReasonCFA1TooLargeToEncode, c.tables.length, 0xffff);
  const w = new Writer();
  w.fixed(new TextEncoder().encode(CFA1Magic));
  w.fixed(Uint8Array.of(c.tables.length >> 8, c.tables.length & 0xff));
  c.tables.forEach((t, i) => {
    if (t.length === 0 || t.length > 255) throw malformedAt('cfa1.table', i, ReasonCFA1TableSize, t.length, 255);
    w.u8(t.length);
    for (const k of t) {
      if (k.length !== KeyBytes) throw malformedAt('cfa1.table.key', i, ReasonCFA1KeyLength, k.length, KeyBytes);
      w.fixed(k);
    }
  });
  w.u32(c.records.length);
  c.records.forEach((r, i) => {
    if (r.signers.length > 255) throw malformedAt('cfa1.record.signers', i, ReasonCFA1SignersTooMany, r.signers.length, 255);
    w.u8(r.committeeIdx);
    w.u8(r.nextIdx);
    w.u64(r.finalState.number);
    w.b32(r.finalState.hash);
    w.u64(r.finalConsensus.number);
    w.b32(r.finalConsensus.hash);
    w.fixed(r.signature);
    w.u8(r.signers.length);
    w.fixed(r.signers);
  });
  return w.bytes();
}

/** the size of a record without signers */
const minRecordBytes = 1 + 1 + 8 + 32 + 8 + 32 + SigBytes + 1;

/** Decodes strictly (see the file comment). Every hostile count is bounded by Limits and by the bytes that remain before anything is sized. */
export function decodeCFA1(b: Uint8Array, lim: Limits): CFA1 {
  const r = new Reader(b, lim);
  const magic = r.fixed('cfa1.magic', 4);
  if (String.fromCharCode(...magic) !== CFA1Magic) throw malformed('cfa1.magic', ReasonCFA1BadMagic, 4, 4);
  const nt = r.fixed('cfa1.n_tables', 2);
  const nTables = (nt[0]! << 8) | nt[1]!;
  if (nTables > lim.maxCFA1Tables) throw evidenceTooLarge('cfa1.tables', nTables, lim.maxCFA1Tables);
  if (nTables === 0) throw malformed('cfa1.n_tables', ReasonCFA1NoTables, 0, 1);
  const tables: Uint8Array[][] = [];
  for (let i = 0; i < nTables; i++) {
    const n = r.u8('cfa1.table.n');
    if (n === 0) throw malformedAt('cfa1.table', i, ReasonCFA1TableEmpty, 0, 1);
    const keys: Uint8Array[] = [];
    for (let j = 0; j < n; j++) keys.push(r.fixed('cfa1.table.key', KeyBytes));
    tables.push(keys);
  }
  const nRec = r.u32('cfa1.n_records');
  if (nRec > lim.maxCFA1Records) throw evidenceTooLarge('cfa1.records', nRec, lim.maxCFA1Records);
  if (nRec === 0) throw malformed('cfa1.n_records', ReasonCFA1NoRecords, 0, 1);
  // nRec <= maxCFA1Records here, so the product cannot exceed 2^53; it is compared with what remains BEFORE any list is sized
  if (nRec * minRecordBytes > r.left()) throw malformed('cfa1.records', EvidenceReason.CountExceedsRemaining, r.left(), nRec * minRecordBytes);
  const records: EpochRec[] = [];
  for (let i = 0; i < nRec; i++) {
    const committeeIdx = r.u8('cfa1.record.committee_idx');
    const nextIdx = r.u8('cfa1.record.next_idx');
    if (committeeIdx >= nTables || nextIdx >= nTables) {
      throw malformedAt('cfa1.record', i, ReasonCFA1TableIndexOutOfRange, Math.max(committeeIdx, nextIdx), nTables);
    }
    const fsNumber = r.u64('cfa1.record.final_state.number');
    const fsHash = r.b32('cfa1.record.final_state.hash');
    const fcNumber = r.u64('cfa1.record.final_consensus.number');
    const fcHash = r.b32('cfa1.record.final_consensus.hash');
    const signature = r.fixed('cfa1.record.signature', SigBytes);
    const ns = r.u8('cfa1.record.n_signers');
    const signers = r.fixed('cfa1.record.signers', ns);
    const size = tables[committeeIdx]!.length;
    for (let j = 0; j < signers.length; j++) {
      const s = signers[j]!;
      if (s >= size || (j > 0 && s <= signers[j - 1]!)) {
        throw chainBroken(i, CheckSignerIndexInvalid, { index: BigInt(j), signer: BigInt(s), committee_size: BigInt(size) });
      }
    }
    records.push({
      committeeIdx,
      nextIdx,
      finalState: { number: fsNumber, hash: fsHash },
      finalConsensus: { number: fcNumber, hash: fcHash },
      signature,
      signers,
    });
  }
  r.end('cfa1');
  return { tables, records };
}
