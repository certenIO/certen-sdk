import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeReplayGuardEvidence, decodeS6Settlement, verifyReplayGuardEvidence } from '../src/index.js';
import type { S6Settlement, S6Verdict } from '../src/index.js';

/**
 * RB12-F4 (WP-S8-CLI): the S6 verifier returns what `s6_proven` needs, exactly as pkg/ethproof ReplayGuardCheck does: the contract, the replay slot (its LeafConsumed key and
 * the slot), the settlement block, the block the slot is proven at and the code hash the contract holds there. A named state carries none of them. The published vector sets are
 * read, never edited: every vector whose published verdict is `proven` must return a link that is the evidence's own and the settlement's own.
 */
const SETS = ['s6replay1', 's6replay2', 's6replay3'];
type Vector = { name: string; settlement: S6Settlement; evidence: string; expect: S6Verdict };
const hx = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const vectors = (set: string): Vector[] => {
  const dir = new URL(`./fixtures/${set}/`, import.meta.url);
  return readdirSync(dir)
    .filter((f) => /^\d{3}_.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Vector);
};

describe('the S6 check carries the link of a proven slot', () => {
  it('returns the contract, slot, settlement block, proven-at block and code hash of the evidence on every proven vector', () => {
    let proven = 0;
    for (const set of SETS) {
      for (const v of vectors(set)) {
        if (v.expect.result !== 'proven') continue;
        const s = decodeS6Settlement(v.settlement);
        const ev = decodeReplayGuardEvidence(new TextEncoder().encode(v.evidence));
        const chk = verifyReplayGuardEvidence(ev, s);
        const p = ev.proof!;
        const at = `${set}/${v.name}`;
        expect(chk.state, at).toBe('proven');
        expect(chk.named, at).toBeUndefined();
        expect(chk.contract && hx(chk.contract), at).toBe(hx(p.contract));
        expect(chk.generation, at).toBe(p.generation);
        expect(chk.chainId, at).toBe(p.chainId);
        expect(chk.slot && hx(chk.slot.key), at).toBe(hx(p.slot.key));
        expect(chk.slot && hx(chk.slot.slot), at).toBe(hx(p.slot.slot));
        // the settlement block is the block of the settlement the receipt was proven into, not a number the evidence states
        expect(chk.settlementBlock?.number, at).toBe(Number(s.header.numberU64));
        expect(chk.settlementBlock && hx(chk.settlementBlock.hash), at).toBe(hx(s.header.hash));
        expect(chk.provenAt?.number, at).toBe(p.provenAt.number);
        expect(chk.provenAt && hx(chk.provenAt.hash), at).toBe(hx(p.provenAt.hash));
        // the code hash is the one the After proof proves the contract holds at the proven-at block
        expect(chk.codeHash && hx(chk.codeHash), at).toBe(hx(p.after.codeHash));
        expect(chk.codeHash?.length, at).toBe(32);
        expect(chk.codeHash?.some((b) => b !== 0), at).toBe(true);
        proven++;
      }
    }
    expect(proven, 'proven vectors read').toBeGreaterThanOrEqual(20);
  });

  it('a named state carries no link', () => {
    let named = 0;
    for (const set of SETS) {
      for (const v of vectors(set)) {
        if (v.expect.result !== 'stated') continue;
        let chk;
        try {
          chk = verifyReplayGuardEvidence(decodeReplayGuardEvidence(new TextEncoder().encode(v.evidence)), decodeS6Settlement(v.settlement));
        } catch {
          continue;
        }
        if (chk.named === undefined) continue;
        const at = `${set}/${v.name}`;
        for (const f of ['contract', 'generation', 'chainId', 'slot', 'settlementBlock', 'provenAt', 'codeHash'] as const) expect(chk[f], `${at}: ${f}`).toBeUndefined();
        named++;
      }
    }
    expect(named, 'named-state vectors read').toBeGreaterThan(0);
  });
});
