import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyAgentPack, mandateHashOf, exceptionHashOf, AGENT_PACK_NOT_VERIFIED } from '../src/index.js';

/**
 * The specification's vectors: transaction-controls docs/agentic/vectors/agent-evidence.json (AGT-4, pl/agt-4-exceptions-evidence b5491a3),
 * pinned by sha256. Every case must give the specification's own verdict and reason; then mutations the vectors do not cover.
 */
const FILE = new URL('./fixtures/agent-pack/agent-evidence.json', import.meta.url);
const bytes = readFileSync(FILE);
const V = JSON.parse(bytes.toString('utf8')) as { cases: Array<{ id: string; title: string; input: unknown; expect: { ok: boolean; reason?: string; exception?: { hash: string; officers: string[] } } }> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clone = (o: unknown): any => JSON.parse(JSON.stringify(o));

describe('agent-pack: the specification vectors', () => {
  it('is the pinned copy', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('b4b08a3c2c4ef1621862d52e5a81a376395a1f66d30dffaef7e513a6a6517fa3');
    expect(V.cases.length).toBe(24);
  });
  for (const c of V.cases) {
    it(`${c.id} ${c.title}`, () => {
      const r = verifyAgentPack(clone(c.input));
      expect(r.ok).toBe(c.expect.ok);
      if (!r.ok) expect(r.reason).toBe(c.expect.reason);
      else {
        expect(r.exception?.hash).toBe(c.expect.exception?.hash);
        expect(r.exception?.officers).toEqual(c.expect.exception?.officers);
      }
    });
  }
});

describe('agent-pack: mutations beyond the vectors', () => {
  const base = () => clone(V.cases[0]!.input);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rehash = (i: any) => { i.pack.exception.hash = exceptionHashOf(i.pack.exception.object); };

  it('the accepted pack names the mandate hash and what offline cannot establish', () => {
    const r = verifyAgentPack(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mandateHash).toBe(mandateHashOf(base().pack.mandate));
      for (const n of AGENT_PACK_NOT_VERIFIED) expect(r.notVerified).toContain(n);
    }
  });
  it('a second exception.consume entry is refused', () => {
    const i = base();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const k = i.log.entries.find((e: any) => e.kind === 'exception.consume');
    i.log.entries.push({ ...clone(k), seq: 99 });
    expect(verifyAgentPack(i).ok).toBe(false);
  });
  it('one officer approving with two keys is not two officers', () => {
    const i = base();
    const o = i.pack.exception.officers;
    o[0].identities.push(...o[1].identities);
    o.splice(1, 1);
    expect(verifyAgentPack(i).ok).toBe(false);
  });
  it('a relay at the window end is refused', () => {
    const i = base();
    const end = i.pack.decision.expiresAt;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oc = i.log.entries.find((e: any) => e.kind === 'outcome.recorded');
    oc.payload.relayedAt = end;
    i.pack.timing.relayedAt = end;
    i.pack.timing.delaySeconds = end - i.pack.timing.approvedAt;
    expect(verifyAgentPack(i).ok).toBe(false);
  });
  it('an exception lifting more than the per-payment limit is refused, rehashed', () => {
    const i = base();
    i.pack.exception.object.lifts = ['perTransaction', 'cumulative'];
    rehash(i);
    const r = verifyAgentPack(i);
    expect(r.ok === false && r.reason).toBe('agent_exception_lift_not_per_payment');
  });
  it('threshold one is refused, rehashed', () => {
    const i = base();
    i.pack.exception.object.threshold = 1;
    rehash(i);
    const r = verifyAgentPack(i);
    expect(r.ok === false && r.reason).toBe('agent_exception_threshold_below_two');
  });
  it('an unknown extra element is refused', () => {
    const i = base();
    i.pack.extra = {};
    const r = verifyAgentPack(i);
    expect(r.ok === false && r.reason).toBe('agent_evidence_element_unknown');
  });
  it('one changed hex digit in a log entry breaks the chain', () => {
    const i = base();
    const e = i.log.entries[2];
    e.hash = e.hash.slice(0, -1) + (e.hash.endsWith('0') ? '1' : '0');
    const r = verifyAgentPack(i);
    expect(r.ok === false && r.reason).toBe('agent_evidence_record_invalid');
  });
  it('unreadable input is refused, never accepted', () => {
    for (const b of [null, undefined, 7, {}, { pack: {} }, { pack: base().pack, grant: null, log: { entries: [] } }]) expect(verifyAgentPack(b).ok).toBe(false);
  });
});
