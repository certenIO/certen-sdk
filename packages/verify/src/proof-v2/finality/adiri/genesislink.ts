/**
 * The Adiri genesis link (V2_SPEC_S7 4.2, annex A7; the twin of pkg/finality/adiri genesislink.go): the 290 headers of blocks 1..epoch0 as a
 * concatenation of raw RLP headers (176,758 B), hash-pinned by the pins file's genesis_link_sha256. It binds the pinned committee chain to
 * THIS incarnation's genesis block: the first header has number 1 and parentHash = genesis_hash, every header links to the previous one,
 * and the last is epoch0_final_state. It is checked ONCE, when the verifier is wired to its embedded pins (registerAdiri), never per proof:
 * the evidence carries no genesis material and a proof pays nothing for it.
 *
 * The file is an asset: genesis-link-data.ts holds its base64 and is imported DYNAMICALLY by embeddedGenesisLink(), never from a barrel
 * eagerly, so a consumer that never registers the Adiri kind never loads the 236 KB module.
 */
import { sha256 } from '@noble/hashes/sha2';
import { RlpError, splitList } from '../../../s6/rlp.js';
import { sameBytes } from '../evidence.js';
import type { Pins } from '../pins.js';
import { FinalityStateError, PinsReason, hexLower, pinsCorrupt } from '../state.js';
import { readHeader, type HeaderFields } from '../rlpheader.js';
import { parsePins } from './record.js';
import type { NumHash } from './states.js';

/** A genesis link that does not verify (the reason, for a message; the load check maps it to finality_pins_corrupt). */
export class GenesisLinkError extends Error {}

/** The key finality_pins_corrupt names for a link file whose sha256 is not the pinned one, and for one that does not run genesis -> epoch0. */
export const KeyGenesisLinkSHA = 'adiri.genesis_link_sha256';
export const KeyGenesisLink = 'adiri.genesis_link';

/**
 * Splits a concatenation of raw RLP headers (the genesis link file) into headers. Every header must be a single well-formed RLP list; a
 * declared length that does not fit is an error, never an out-of-range read.
 */
export function splitHeaders(file: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let rest = file;
  while (rest.length > 0) {
    let item: ReturnType<typeof splitList>;
    try {
      item = splitList(rest);
    } catch (e) {
      if (e instanceof RlpError) throw new GenesisLinkError(`header ${out.length}: ${e.message}`);
      throw e;
    }
    out.push(Uint8Array.from(item.raw));
    rest = item.rest;
  }
  return out;
}

/**
 * Checks a genesis link file: it hashes to wantSha and holds the headers of blocks 1..epoch0.number as a parentHash chain whose first header
 * has parentHash = the genesis block hash and number 1 and whose last is epoch0 (number and hash). Returns the number of headers.
 */
export function verifyGenesisLink(file: Uint8Array, wantSha: string, genesisHash: Uint8Array, epoch0: NumHash): number {
  const sum = hexLower(sha256(file));
  if (sum !== wantSha) throw new GenesisLinkError(`genesis link sha256 ${sum}, want ${wantSha}`);
  const hs = splitHeaders(file);
  if (hs.length === 0) throw new GenesisLinkError('the genesis link is empty');
  let prev: HeaderFields | undefined;
  for (let i = 0; i < hs.length; i++) {
    let h: HeaderFields;
    try {
      h = readHeader(hs[i]!);
    } catch (e) {
      if (e instanceof FinalityStateError) throw new GenesisLinkError(`header ${i}: ${e.toString()}`);
      throw e;
    }
    if (prev === undefined) {
      if (!sameBytes(h.parentHash, genesisHash) || h.number !== 1n) {
        throw new GenesisLinkError(`the first header is ${h.number}, want block 1 with the genesis hash`);
      }
    } else if (!sameBytes(h.parentHash, prev.hash) || h.number !== prev.number + 1n) {
      throw new GenesisLinkError(`header ${h.number} does not link to header ${prev.number}`);
    }
    prev = h;
  }
  if (prev!.number !== epoch0.number || !sameBytes(prev!.hash, epoch0.hash)) {
    throw new GenesisLinkError(`the link ends at ${prev!.number}, want epoch0_final_state ${epoch0.number}`);
  }
  return hs.length;
}

/**
 * Judges a genesis link file against the adiri section of p: a file whose sha256 is not genesis_link_sha256 is
 * finality_pins_corrupt{reason:bad_value, key:"adiri.genesis_link_sha256"}, and a file that hashes right but does not run from genesis_hash
 * (block 1) to epoch0_final_state through linked headers is finality_pins_corrupt{reason:bad_value, key:"adiri.genesis_link"}. A pins
 * file with no adiri section, or a malformed one, is the state parsePins names.
 */
export function checkGenesisLink(file: Uint8Array, p: Pins | null | undefined): void {
  const par = parsePins(p);
  if (hexLower(sha256(file)) !== par.genesisLinkSha) throw pinsCorrupt(PinsReason.BadValue, { key: KeyGenesisLinkSHA });
  try {
    verifyGenesisLink(file, par.genesisLinkSha, par.genesisHash, par.epoch0FinalState);
  } catch (e) {
    if (e instanceof GenesisLinkError) throw pinsCorrupt(PinsReason.BadValue, { key: KeyGenesisLink });
    throw e;
  }
}

/** The embedded genesis link file (a fresh copy), loaded on first use from the generated data module. */
export async function embeddedGenesisLink(): Promise<Uint8Array> {
  const { GENESIS_LINK_BASE64 } = await import('./genesis-link-data.js');
  return Uint8Array.from(atob(GENESIS_LINK_BASE64), (c) => c.charCodeAt(0));
}

/**
 * The load-time check of the embedded pins: the embedded genesis link must be the one the pins file hash-pins and must link genesis_hash to
 * epoch0_final_state. It costs one sha256 and 290 header hashes, once per registration; a verifier that fails it refuses to start, exactly as
 * one whose embedded pins do not hash to PINS_SHA256.
 */
export async function checkEmbeddedGenesisLink(p: Pins | null | undefined): Promise<void> {
  checkGenesisLink(await embeddedGenesisLink(), p);
}
