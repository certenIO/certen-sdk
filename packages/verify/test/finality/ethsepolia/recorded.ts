/** The recorded real legs of finality_eth_sepolia1/2 (raw/<leg>/evidence.bin + leg.json), decoded, for the unit tests. */
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import type { BlockRef } from '../../../src/proof-v2/finality/evidence.js';
import { decodeBody, type Body } from '../../../src/proof-v2/finality/ethsepolia/kind.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { read, refOf, type Leg, type SetName } from './vectorset.js';

export interface Recorded {
  ev: Uint8Array;
  ref: BlockRef;
  /** the body bytes after the CFE1 header */
  bodyBytes: Uint8Array;
  body: Body;
}

export function recorded(set: SetName, name: string): Recorded {
  const ev = Uint8Array.from(read(set, `raw/${name}/evidence.bin`));
  const ref = refOf(JSON.parse(read(set, `raw/${name}/leg.json`).toString('utf8')) as Leg);
  const c = decodeContainer(ev, defaultLimits());
  return { ev, ref, bodyBytes: c.body, body: decodeBody(c.body, defaultLimits(), 64, 16384) };
}

/** The named state a call throws; any other outcome (including no throw) fails the test that asked. */
export function stateOf(f: () => unknown): FinalityStateError {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw new Error(`not a named state: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error('accepted');
}
