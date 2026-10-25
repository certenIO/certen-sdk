// Step 0 of the S8 verifier: the identity manifest document loaded against its pin (twin of manifest.go LoadManifest / LoadOverride / Chain).
// This file carries the loading, the pin, the schema and the chain row; the accessors the steps need are added with the steps that read them.
import { sha256 } from '@noble/hashes/sha2';
import { MANIFEST_JSON, MANIFEST_SHA256 } from './embedded.js';
import * as N from './names.js';
import { must, type StateError } from './states.js';
import { toHex } from './canon.js';

export const ManifestSchema = 'certen:identity-manifest:v1.1';
const te = new TextEncoder();

export const manifestHash = (raw: Uint8Array): string => toHex(sha256(raw));
export const embeddedManifestBytes = (): Uint8Array => te.encode(MANIFEST_JSON);
export const embeddedPin = (): string => MANIFEST_SHA256;

export const manifestCorrupt = (): StateError => must(N.CodeManifestCorrupt, '', {});
export const manifestUnknown = (chain: bigint): StateError => must(N.CodeManifestUnknown, '', { chain });

export interface ChainEntry { chainId: number; name: string; [k: string]: unknown }
export class Manifest {
  constructor(readonly doc: Record<string, unknown>, readonly sha256: string, readonly source: string) {}
  chains(): ChainEntry[] { return (this.doc['chains'] as ChainEntry[]) ?? []; }
  /** The chain row, or THROWS manifest_unknown{chain}. */
  chain(chain: bigint): ChainEntry {
    const c = this.chains().find((x) => BigInt(x.chainId) === chain);
    if (!c) throw manifestUnknown(chain);
    return c;
  }
}

function parse(raw: Uint8Array): Record<string, unknown> {
  const norm = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/\r\n/g, '\n');
  let doc: unknown;
  try { doc = JSON.parse(norm); } catch { throw manifestCorrupt(); }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || (doc as Record<string, unknown>)['schema'] !== ManifestSchema) throw manifestCorrupt();
  if (!Array.isArray((doc as Record<string, unknown>)['chains'])) throw manifestCorrupt();
  return doc as Record<string, unknown>;
}

/** The manifest bytes must hash to `pin` (64 lower-case hex digits): any other bytes are manifest_corrupt, whatever the schema says. */
export function loadManifest(raw: Uint8Array, pin: string): Manifest {
  const got = manifestHash(raw);
  if (got !== pin) throw manifestCorrupt();
  return new Manifest(parse(raw), got, N.ManifestSourceEmbedded);
}
/** A modified but self-consistent manifest: loaded by its own hash, reported as `override:<sha256>`. */
export function loadOverride(raw: Uint8Array): Manifest {
  const got = manifestHash(raw);
  return new Manifest(parse(raw), got, `override:${got}`);
}
