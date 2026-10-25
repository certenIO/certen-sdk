/**
 * The S8 contract-identity verifier (V2_SPEC_S8.md r3.6, S8_FREEZE.md): the TypeScript twin of the validator's pkg/contractidentity.
 * Go and TypeScript judge the same published vector sets (test/fixtures/identity, byte-identical copies) and must return the same
 * canonical report on every vector; a difference is stop-the-line. Several names (decode, Limits, Container ...) also exist in the
 * finality package, so this package is exported as the namespace `identity` and is not spread into the root.
 */
export * as names from './names.js';
export * from './canon.js';
export * from './states.js';
export * from './codec.js';
export * from './manifest.js';
export * from './report.js';
export * from './steps.js';
export * from './runner.js';
export * from './context.js';
export * from './framework.js';
export * from './steps2a_all.js';
export * as reads from './reads.js';
export * as slots from './slots.js';
export * as abidec from './abidec.js';
export * as bytes from './bytes.js';
