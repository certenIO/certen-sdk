/**
 * Registers every finality verifier Kind that has a TypeScript port into a Registry: the twin of the validator's pkg/finality/allkinds.
 *
 * The call is explicit (no module side effect, nothing is wired into `defaultRegistry` by importing this package) and the order is the
 * validator's: adiri/finalized/v1, base-sepolia/l1_posted/v1, base-sepolia/finalized/v1, arb-sepolia/l1_posted/v1. The first refusal (a Kind
 * already registered, a row that is not in the V2_SPEC_S7 section 1 table, or the Adiri genesis link failing its load check against `pins`)
 * rejects and nothing after it is registered; a registry that rejected is not to be used.
 *
 * Two rows of the table have no TypeScript Kind yet: arb-sepolia/finalized/v1 and eth-sepolia/finalized/v1 (`UNPORTED_KIND_ROWS`). Judging
 * evidence of those rows answers finality_evidence_unrecognised from the registry, a named state, never a pass; the list is pinned by
 * test/finality/allkinds.test.ts so that porting one of them cannot leave this module behind.
 */
import { registerAdiri } from './adiri/kind.js';
import { registerArbPosted } from './arbposted/verify.js';
import { registerBaseFinal } from './basefinal/verify.js';
import { registerBasePosted } from './baseposted/verify.js';
import type { Pins } from './pins.js';
import type { Registry } from './registry.js';

/** The Kind names registerAllKinds adds, in registration order. */
export const REGISTERED_KIND_NAMES: readonly string[] = [
  'adiri/finalized/v1',
  'base-sepolia/l1_posted/v1',
  'base-sepolia/finalized/v1',
  'arb-sepolia/l1_posted/v1',
];

/** The rows of the V2_SPEC_S7 section 1 table that no TypeScript Kind covers yet (the Go side has both). */
export const UNPORTED_KIND_ROWS: readonly string[] = ['arb-sepolia/finalized/v1', 'eth-sepolia/finalized/v1'];

/**
 * Adds every ported Kind to `reg`. `pins` is the pins the verifier will judge under (embeddedPins() or an override the caller trusts): the
 * Adiri registration checks its embedded genesis link against them and fails closed, which is why this is asynchronous.
 */
export async function registerAllKinds(reg: Registry, pins: Pins | null | undefined): Promise<void> {
  await registerAdiri(reg, pins);
  registerBasePosted(reg);
  registerBaseFinal(reg);
  registerArbPosted(reg);
}
