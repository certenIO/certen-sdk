import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyAgentPack, mandateHashOf, exceptionHashOf, AGENT_PACK_NOT_VERIFIED } from '../src/index.js';

/**
 * The specification's vectors: transaction-controls docs/agentic/vectors/agent-evidence.json (pl/agt-7-last-outcome 03e5fa6: ae-01..ae-24 of
 * AGT-4 pl/agt-4-exceptions-evidence b5491a3 unchanged, ae-25..ae-28 appended by AGT-F116, ae-29..ae-32 appended by AGT-F125), pinned by sha256. Every case must give the specification's own verdict and reason; then mutations the vectors do not cover.
 */
const FILE = new URL('./fixtures/agent-pack/agent-evidence.json', import.meta.url);
const bytes = readFileSync(FILE);
const V = JSON.parse(bytes.toString('utf8')) as { cases: Array<{ id: string; title: string; input: unknown; expect: { ok: boolean; reason?: string; exception?: { hash: string; officers: string[] } } }> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clone = (o: unknown): any => JSON.parse(JSON.stringify(o));

describe('agent-pack: the specification vectors', () => {
  it('is the pinned copy', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('71abc4e5764ac35d16a72fa9086de6464b4178c4c8c050d449f20b131e4d1c42');
    expect(V.cases.length).toBe(32);
    expect(V.cases.map((c) => c.id)).toEqual(Array.from({ length: 32 }, (_, k) => `ae-${String(k + 1).padStart(2, '0')}`));
  });
  for (const c of V.cases) {
    it(`${c.id} ${c.title}`, () => {
      const r = verifyAgentPack(clone(c.input));
      expect(r.ok).toBe(c.expect.ok);
      if (!r.ok) {
        expect(r.reason).toBe(c.expect.reason);
        if (c.expect.reason === 'agent_evidence_destination_missing') expect(r.element).toBe('record.outcome.destinationTx');
        if (c.id === 'ae-30') expect(r.element).toBe('timing.relayedAt');
      }
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
  it('AGT-F116: an executed outcome must name a 0x + 64 lower-hex destinationTx; a failed one may name none', () => {
    const ae25 = V.cases.find((c) => c.id === 'ae-25')!;
    for (const d of [undefined, '']) {
      const i = clone(ae25.input);
      if (d !== undefined) i.pack.record.outcome.destinationTx = d;
      const r = verifyAgentPack(i);
      expect(r.ok === false && [r.reason, r.element]).toEqual(['agent_evidence_destination_missing', 'record.outcome.destinationTx']);
    }
    // the executed base pack with its destination verifies; the failed ae-28 pack without one verifies
    expect(verifyAgentPack(base()).ok).toBe(true);
    const f = verifyAgentPack(clone(V.cases.find((c) => c.id === 'ae-28')!.input));
    expect(f.ok && f.outcome).toEqual({ status: 'failed', destinationTx: '' });
  });
  it('unreadable input is refused, never accepted', () => {
    for (const b of [null, undefined, 7, {}, { pack: {} }, { pack: base().pack, grant: null, log: { entries: [] } }]) expect(verifyAgentPack(b).ok).toBe(false);
  });
});

describe('agent-pack: the effective decision and outcome are the LAST entries for the request up to the head (EVIDENCE-AGT.md section 6, EV-10, AGT-F125)', () => {
  // a real gate-run executed pack (FICTIONAL parties): the Console appended a second outcome entry when the destination transaction was found
  const REAL = JSON.parse(readFileSync(new URL('./fixtures/agent-pack/agt-f125-e1c0535a-executed.json', import.meta.url), 'utf8'));
  const vec = (id: string) => clone(V.cases.find((c) => c.id === id)!.input);

  it('the real executed pack with two outcome entries verifies', () => {
    expect(REAL.log.entries.filter((e: { kind: string }) => e.kind === 'outcome.recorded').length).toBe(2);
    const r = verifyAgentPack(clone(REAL));
    expect(r).toMatchObject({ ok: true });
  });
  it('the relay time is the last outcome entry, never the first: ae-30 is refused at timing.relayedAt', () => {
    expect(verifyAgentPack(vec('ae-30'))).toMatchObject({ ok: false, reason: 'agent_evidence_timing_mismatch', element: 'timing.relayedAt' });
  });
  it('a reissued decision: the pack naming the last verifies, the pack naming the first is refused', () => {
    expect(verifyAgentPack(vec('ae-31'))).toMatchObject({ ok: true });
    expect(verifyAgentPack(vec('ae-32')).ok).toBe(false);
  });
});
