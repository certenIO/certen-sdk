/**
 * The committee chain (V2_SPEC_S7 5.8 O1-O3; the twin of pkg/finality/adiri chain.go). Order of judgement: the codec pin; record 0
 * against the pinned genesis (O1); then for every record in ascending order key validity, duplicates, committee compatibility, minimum
 * size and quorum (O2); only then every signature (O3), so the structural verdict never depends on the signature mode.
 */
import { Code, FinalityStateError, newState, malformed } from '../state.js';
import { ReasonCFA1NoRecords, checkRecordSigners, checkRecordTables, committeeOf, nextOf, type CFA1 } from './cfa1.js';
import { Codec, Name, recordDigests, signedMessage, type Params } from './record.js';
import { KeyCache, firstFailure, type KeyEntry, type Mode, type Rand, type SigItem } from './sigs.js';
import {
  CheckBelowQuorum,
  CheckCommitteeIncompatible,
  CheckDuplicateKey,
  CheckPublicKeyInvalid,
  CheckSignatureInvalid,
  ReasonBelowMinCommitteeSize,
  ReasonBelowTwoThirds,
  ReasonLargerThanExpected,
  ReasonNotSubset,
  ReasonSetMismatch,
  chainBroken,
  codecUnsupported,
  incarnationMismatch,
  pinMismatch,
  shrunk,
  type NumHash,
} from './states.js';


/** What the committee chain established. */
export interface ChainResult {
  /** E = the last record */
  epoch: number;
  digests: Uint8Array[];
  /** committee_shrunk attributes, ascending epoch */
  shrunk: FinalityStateError[];
  /** signers of record E */
  signers: number;
  /** size of committee(E) */
  committeeSize: number;
  /** record(E).final_state */
  final: NumHash;
  finalConsensus: NumHash;
}

/** Strictly more than two thirds of n: 2n/3 + 1. */
export const quorum = (n: number): number => Math.floor((2 * n) / 3) + 1;

const keyStr = (k: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < k.length; i++) s += String.fromCharCode(k[i]!);
  return s;
};

const keySet = (keys: readonly Uint8Array[]): Set<string> => new Set(keys.map(keyStr));

/** Set equality (duplicates collapse). */
export function sameSet(a: readonly Uint8Array[], b: readonly Uint8Array[]): boolean {
  const sa = keySet(a);
  const sb = keySet(b);
  if (sa.size !== sb.size) return false;
  for (const k of sa) if (!sb.has(k)) return false;
  return true;
}

/** The index of the first key that repeats an earlier one, or -1. */
export function firstDuplicate(keys: readonly Uint8Array[]): number {
  const seen = new Set<string>();
  for (let i = 0; i < keys.length; i++) {
    const s = keyStr(keys[i]!);
    if (seen.has(s)) return i;
    seen.add(s);
  }
  return -1;
}

function incompatible(epoch: number, reason: string, size: number, expected: number, min: bigint): FinalityStateError {
  return chainBroken(epoch, CheckCommitteeIncompatible, { reason, size: BigInt(size), expected: BigInt(expected), min_committee_size: min });
}

/** a pinned int compared with a committee size (sizes are at most 255, so a clamp at 2^53 changes no comparison) */
const asCount = (v: bigint): number => (v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v));

const sameNumHash = (a: NumHash, b: NumHash): boolean => a.number === b.number && a.hash.length === b.hash.length && a.hash.every((x, i) => x === b.hash[i]);

/**
 * Judges records 0..E of c against the pins par. The structural checks of ALL records run before any signature is verified, so the
 * verdict does not depend on the mode; mode only chooses how signatures are verified.
 */
export function verifyCommitteeChain(par: Params, c: CFA1, mode: Mode, rnd?: Rand): ChainResult {
  if (par.codec !== Codec) throw codecUnsupported(0, par.codec, Codec);
  if (c.records.length === 0) throw malformed('cfa1.n_records', ReasonCFA1NoRecords, 0, 1);
  // exported, and judges any CFA1 (not only one decodeCFA1 returned): the decoder's table and signer rules are applied again, for every
  // record, before recordDigests indexes the tables and before a signer list indexes a committee
  c.records.forEach((rec, i) => {
    checkRecordTables(i, rec, c.tables.length);
    checkRecordSigners(i, rec.signers, c.tables[rec.committeeIdx]!.length);
  });
  const keys = new KeyCache();
  const digests = recordDigests(c);
  const shrunkList: FinalityStateError[] = [];
  const minCommittee = asCount(par.minCommittee);

  // O1: committee(0) as a SET equals the pinned genesis committee; record(0).final_state equals the pinned one
  const c0 = committeeOf(c, 0)!;
  const dup0 = firstDuplicate(c0);
  if (dup0 >= 0) throw chainBroken(0, CheckDuplicateKey, { index: BigInt(dup0) });
  if (!sameSet(c0, par.genesisCommittee)) throw pinMismatch('genesis_committee', BigInt(par.genesisCommittee.length), BigInt(c0.length));
  if (!sameNumHash(c.records[0]!.finalState, par.epoch0FinalState)) throw incarnationMismatch(par.epoch0FinalState, c.records[0]!.finalState);

  const items: SigItem[] = [];
  for (let i = 0; i < c.records.length; i++) {
    const rec = c.records[i]!;
    const committee = committeeOf(c, i)!;
    const entries: KeyEntry[] = [];
    for (let j = 0; j < committee.length; j++) {
      const e = keys.get(committee[j]!);
      if (e === undefined) throw chainBroken(i, CheckPublicKeyInvalid, { index: BigInt(j) });
      entries.push(e);
    }
    const dup = firstDuplicate(committee);
    if (dup >= 0) throw chainBroken(i, CheckDuplicateKey, { index: BigInt(dup) });
    if (i > 0) {
      const expected = keySet(nextOf(c, i - 1)!);
      const size = committee.length;
      if (size > expected.size) {
        throw incompatible(i, ReasonLargerThanExpected, size, expected.size, par.minCommittee);
      } else if (size === expected.size) {
        for (const k of committee) if (!expected.has(keyStr(k))) throw incompatible(i, ReasonSetMismatch, size, expected.size, par.minCommittee);
      } else {
        for (const k of committee) if (!expected.has(keyStr(k))) throw incompatible(i, ReasonNotSubset, size, expected.size, par.minCommittee);
        if (3 * size < 2 * expected.size) throw incompatible(i, ReasonBelowTwoThirds, size, expected.size, par.minCommittee);
        if (size < minCommittee) throw incompatible(i, ReasonBelowMinCommitteeSize, size, expected.size, par.minCommittee);
        shrunkList.push(shrunk(i, size, expected.size));
      }
    }
    if (committee.length < minCommittee) throw incompatible(i, ReasonBelowMinCommitteeSize, committee.length, committee.length, par.minCommittee);
    const need = quorum(committee.length);
    if (rec.signers.length < need) throw chainBroken(i, CheckBelowQuorum, { got: BigInt(rec.signers.length), need: BigInt(need) });
    const signer: KeyEntry[] = Array.from(rec.signers, (s) => entries[s]!);
    items.push({ epoch: i, sig: rec.signature, signer, msg: signedMessage(digests[i]!) });
  }

  let fail: ReturnType<typeof firstFailure>;
  try {
    fail = firstFailure(items, mode, rnd);
  } catch (e) {
    if (e instanceof FinalityStateError) throw e;
    throw newState(Code.VerifierFailed, { chain: par.chainId, kind: Name, cause: e instanceof Error ? e.message : String(e) });
  }
  if (fail !== undefined) throw chainBroken(items[fail.index]!.epoch, CheckSignatureInvalid, { reason: fail.reason });
  const last = c.records[c.records.length - 1]!;
  return {
    epoch: c.records.length - 1,
    digests,
    shrunk: shrunkList,
    signers: last.signers.length,
    committeeSize: committeeOf(c, c.records.length - 1)!.length,
    final: last.finalState,
    finalConsensus: last.finalConsensus,
  };
}
