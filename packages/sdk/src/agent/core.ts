/**
 * This package's OWN shim for the copied mandate shape (scripts/sync-core.mjs): src/agent/mandate.ts imports the core only through
 * './core.js', and here that is this package's pinned copy of the core (src/core, src/core/PIN.json). Not copied, not pinned.
 */
export { canonicalize } from '../core/jcs.js';
export { digestHex, taggedPreimage } from '../core/hashes.js';
