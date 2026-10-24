/**
 * The cost of a verification does not multiply with the number of proof reads (RB12-TS-FIX-ARBSEP, audit N-5). Before the fix every read of the
 * Rollup storage (about 13 per verification: the two identity checks, the node and config slots, the two leaf proofs, the wallet identity, the
 * fast-confirmer slot, the two node-bound walks) keccak-hashed every NODES element again, so a hostile evidence of 8,022 nodes (31 MiB) cost
 * the verifier minutes. The property is pinned here in keccak calls and keccak input bytes, not in seconds, so a busy machine cannot flake it:
 * each NODES element is hashed once by the strict NODES-order check of the decoder and once when the proof database of the verification is
 * built, and by nothing else (an oversize element is hashed once more by the node-bound check that names it).
 */
import { describe, expect, it, vi } from 'vitest';

const counter = vi.hoisted(() => ({ calls: 0, bytes: 0 }));
vi.mock('@noble/hashes/sha3', async (importOriginal) => {
  const m = await importOriginal<typeof import('@noble/hashes/sha3')>();
  const wrapped = Object.assign((d: Uint8Array): Uint8Array => {
    counter.calls++;
    counter.bytes += d.length;
    return m.keccak_256(d);
  }, m.keccak_256);
  return { ...m, keccak_256: wrapped };
});

import { decodeContainer, defaultLimits, encodeContainer, encodeNodes } from '../../../src/proof-v2/finality/codec.js';
import { ethl1PinsFrom } from '../../../src/proof-v2/finality/ethl1/index.js';
import { sepoliaPins } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { FINAL1, FINAL3, evidenceOf, legOf, load, pinsOf, vectorByName, type SetInfo } from './vectorset.js';

/** Deterministic distinct junk: element i of a given size (LCG bytes seeded by i, so never an accidental trie node or a duplicate). */
const junk = (n: number, size: number, salt: number): Uint8Array[] =>
  Array.from({ length: n }, (_, i) => {
    let x = (Math.imul(i + 1, 2654435761) ^ Math.imul(salt, 40503)) >>> 0;
    const out = new Uint8Array(size);
    for (let j = 0; j < size; j++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      out[j] = x >>> 24;
    }
    return out;
  });

interface Measured {
  verdict: string;
  calls: number;
  bytes: number;
}

/** The verification of the vector with `extra` NODES elements added; the counters are reset right before the verification and read right after. */
const measure = async (set: SetInfo, name: string, extra: Uint8Array[]): Promise<Measured> => {
  const A = await load();
  const v = vectorByName(set, name);
  const pins = pinsOf(set, v);
  const arb = A.loadArbFinalPins(pins);
  const ep = ethl1PinsFrom(sepoliaPins(pins));
  const c = decodeContainer(evidenceOf(set, v), defaultLimits());
  const e = A.decodeEvidence(c.body, A.boundsFor(ep.maxLinks, ep.maxSpineHeaders, arb));
  const bytes = encodeContainer({ header: c.header, body: A.encodeEvidence({ ...e, nodes: encodeNodes([...e.nodes, ...extra]) }) });
  counter.calls = 0;
  counter.bytes = 0;
  let verdict: string;
  try {
    const r = new A.ArbFinalKind().verify(pins, legOf(v), bytes);
    verdict = `${r.fields.confirmation_route}`;
  } catch (err) {
    verdict = err instanceof FinalityStateError ? err.code + '/' + String(err.fields.part ?? err.fields.reason ?? '') : String(err);
  }
  return { verdict, calls: counter.calls, bytes: counter.bytes };
};

const WALLET = 'synth_valid_wallet_execute_transaction_proven';

describe('a verification hashes each NODES element twice at most (decoder order check, proof database), however many proofs it reads', () => {
  it('the wallet world (all five state proofs and both leaf proofs) with 400 extra nodes of 512 bytes: the extra hashing is at most 2 calls and 2 x bytes per node', async () => {
    const base = await measure(FINAL3, WALLET, []);
    expect(base.verdict).toBe('wallet');
    const n = 400;
    const size = 512;
    const withJunk = await measure(FINAL3, WALLET, junk(n, size, 1));
    expect(withJunk.verdict).toBe('wallet');
    const dCalls = withJunk.calls - base.calls;
    const dBytes = withJunk.bytes - base.bytes;
    // lower bound: the junk is really hashed (the counter is not vacuous): once by the decoder's order check, once by the proof database
    expect(dCalls).toBeGreaterThanOrEqual(n);
    expect(dBytes).toBeGreaterThanOrEqual(n * size);
    // upper bound: before the fix this was about 14 x n calls and 14 x n x size bytes
    expect(dCalls).toBeLessThanOrEqual(2 * n + 8);
    expect(dBytes).toBeLessThanOrEqual(2 * n * size + 1024);
  });

  it('the direct world of set 1 (real evidence) with 300 extra nodes of 1024 bytes: the same bound', async () => {
    const base = await measure(FINAL1, 'real_valid', []);
    expect(base.verdict).toBe('direct');
    const n = 300;
    const size = 1024;
    const withJunk = await measure(FINAL1, 'real_valid', junk(n, size, 2));
    expect(withJunk.verdict).toBe('direct');
    expect(withJunk.calls - base.calls).toBeLessThanOrEqual(2 * n + 8);
    expect(withJunk.bytes - base.bytes).toBeLessThanOrEqual(2 * n * size + 1024);
    expect(withJunk.calls - base.calls).toBeGreaterThanOrEqual(n);
  });

  it('oversize nodes off the proof paths (refused by the node-bound check before any state proof is read): decoder once, proof database once, each further oversize node once more', async () => {
    const max = defaultLimits().maxNodeBytes;
    const small = junk(150, 300, 3);
    const big = junk(20, max + 1, 4);
    // the refused verification stops before the state proofs: its baseline is the world refused with ONE oversize node, not the accepted world
    const base = await measure(FINAL3, WALLET, [big[0]!]);
    expect(base.verdict.startsWith('finality_evidence_too_large/nodes')).toBe(true);
    const r = await measure(FINAL3, WALLET, [...small, ...big]);
    expect(r.verdict.startsWith('finality_evidence_too_large/nodes')).toBe(true);
    const added = small.length + big.length - 1;
    const addedBig = big.length - 1;
    const dCalls = r.calls - base.calls;
    const dBytes = r.bytes - base.bytes;
    expect(dCalls).toBeGreaterThanOrEqual(added);
    // decoder: added; one proof database: added; the node-bound check hashes the oversize nodes it inspects (at most the added ones): <= addedBig
    expect(dCalls).toBeLessThanOrEqual(2 * added + addedBig + 8);
    expect(dBytes).toBeLessThanOrEqual(2 * (small.length * 300 + addedBig * (max + 1)) + addedBig * (max + 1) + 1024);
  });

  it('a hostile world of the size of the audit (8,000 nodes of 256 bytes) costs under 2 hashes per node and under 2 x its bytes', async () => {
    const n = 8000;
    const size = 256;
    const base = await measure(FINAL3, WALLET, []);
    const r = await measure(FINAL3, WALLET, junk(n, size, 5));
    expect(r.verdict).toBe('wallet');
    expect(r.calls - base.calls).toBeLessThanOrEqual(2 * n + 8);
    expect(r.bytes - base.bytes).toBeLessThanOrEqual(2 * n * size + 1024);
  }, 300_000);
});
