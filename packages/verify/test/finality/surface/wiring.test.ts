/**
 * Wiring is lazy and fail-closed: the Kinds are registered only when a Settlement makes them necessary, once (a success is remembered, a refusal is not), and a
 * registration or pins failure is a named result of the section - never an exception, never a skipped section, never a pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from '../../../src/proof-v2/finality/registry.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';

const ctl = vi.hoisted(() => ({ calls: 0, mode: 'ok' as 'ok' | 'named' | 'plain', pins: 'ok' as 'ok' | 'named' }));

vi.mock('../../../src/proof-v2/finality/allkinds.js', async (orig) => {
  const real = await orig<typeof import('../../../src/proof-v2/finality/allkinds.js')>();
  return {
    ...real,
    registerAllKinds: async (reg: Parameters<typeof real.registerAllKinds>[0], pins: Parameters<typeof real.registerAllKinds>[1]) => {
      ctl.calls++;
      // built from the state module of the graph that is calling: after vi.resetModules() a class imported at the top is another class
      const { FinalityStateError: Err } = await import('../../../src/proof-v2/finality/state.js');
      if (ctl.mode === 'named') throw new Err('finality_pins_corrupt', { key: 'adiri.genesis_link', reason: 'bad_value' });
      if (ctl.mode === 'plain') throw new Error('boom');
      return real.registerAllKinds(reg, pins);
    },
  };
});

vi.mock('../../../src/proof-v2/finality/pins.js', async (orig) => {
  const real = await orig<typeof import('../../../src/proof-v2/finality/pins.js')>();
  return {
    ...real,
    embeddedPins: () => {
      if (ctl.pins === 'named') throw new FinalityStateError('finality_pins_corrupt', { reason: 'sha256_mismatch' });
      return real.embeddedPins();
    },
  };
});

const { judgeFinalityText } = await import('../../../src/proof-v2/finality/docreport.js');
const { cases, docOf, legSettlement } = await import('./support.js');
const { readFileSync } = await import('node:fs');
const { gunzipSync } = await import('node:zlib');

const goodCase = cases().find((c) => c.id === 'go/chain_verifies_to_finalized')!;
const settlement = () => legSettlement(goodCase.settlement, BigInt(goodCase.chain));
const dir = new URL('../../fixtures/proofv2/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
const core = (): Record<string, unknown> => JSON.parse(gunzipSync(readFileSync(new URL(manifest.base, dir))).toString('utf8'));

/** Forget what an earlier test wired: the module remembers a successful registration, so each test that needs a fresh one runs in a fresh module graph. */
beforeEach(() => {
  ctl.calls = 0;
  ctl.mode = 'ok';
  ctl.pins = 'ok';
});

describe('registration', () => {
  it('is not attempted when no Settlement is supplied: nothing would be judged', async () => {
    vi.resetModules();
    const fresh = await import('../../../src/proof-v2/finality/surface.js');
    const w = await fresh.wireFinalityOptions({});
    expect('options' in w).toBe(true);
    const r = await fresh.judgeFinalityDocumentWithKinds(JSON.parse(docOf(goodCase)));
    expect(r.class).toBe('summary_only');
    expect(ctl.calls).toBe(0);
  });

  it('a named refusal is a failed result carrying the state, and is not remembered; a success is remembered', async () => {
    vi.resetModules();
    const fresh = await import('../../../src/proof-v2/finality/surface.js');
    ctl.mode = 'named';
    const w = await fresh.wireFinalityOptions({ settlement: settlement(), subject: 'DOC' });
    expect('failure' in w).toBe(true);
    const f = (w as { failure: import('../../../src/proof-v2/finality/docreport.js').DocumentFinality }).failure;
    expect([f.class, f.exit]).toEqual(['failed', 1]);
    expect(f.text).toBe('FAILED (finality)  DOC\n  the verifier cannot be wired: its Kinds do not register: finality_pins_corrupt{key="adiri.genesis_link",reason="bad_value"}\n');
    expect(f.state?.code).toBe('finality_pins_corrupt');
    expect(f.wiring?.stage).toBe('kinds');
    expect(JSON.parse(JSON.stringify(f))).toEqual({ class: 'failed', exit: 1, text: f.text });
    expect(ctl.calls).toBe(1);

    ctl.mode = 'ok';
    const again = await fresh.wireFinalityOptions({ settlement: settlement() });
    expect('options' in again).toBe(true);
    expect(ctl.calls).toBe(2);
    const third = await fresh.wireFinalityOptions({ settlement: settlement() });
    expect('options' in third).toBe(true);
    expect(ctl.calls).toBe(2);
    const r = await fresh.judgeFinalityDocumentWithKinds(JSON.parse(docOf(goodCase)), { settlement: settlement(), subject: 'DOC' });
    expect(r.exit).not.toBe(0);
    expect(r.wiring).toBeUndefined();
  });

  it('an error that is not a named state is reported by its message, still as a result', async () => {
    vi.resetModules();
    const fresh = await import('../../../src/proof-v2/finality/surface.js');
    ctl.mode = 'plain';
    const w = await fresh.wireFinalityOptions({ settlement: settlement() });
    const f = (w as { failure: import('../../../src/proof-v2/finality/docreport.js').DocumentFinality }).failure;
    expect(f.class).toBe('failed');
    expect(f.state).toBeUndefined();
    expect(f.wiring).toEqual({ stage: 'kinds', message: 'boom' });
    expect(f.text).toContain('its Kinds do not register: boom');
  });

  it('a caller-supplied registry is used as it is: nothing is registered', async () => {
    vi.resetModules();
    const fresh = await import('../../../src/proof-v2/finality/surface.js');
    const reg = new Registry();
    const w = await fresh.wireFinalityOptions({ settlement: settlement(), registry: reg });
    expect('options' in w && w.options.registry).toBe(reg);
    expect(ctl.calls).toBe(0);
  });

  it('the registry is built once and shared by every caller of registerKinds', async () => {
    vi.resetModules();
    const fresh = await import('../../../src/proof-v2/finality/surface.js');
    const [a, b] = await Promise.all([fresh.registerKinds(), fresh.registerKinds()]);
    expect(a).toBe(b);
    expect(ctl.calls).toBe(1);
    expect(a.kind('base-sepolia/l1_posted/v1')).toBeDefined();
    expect(a.kind('adiri/finalized/v1')).toBeDefined();
  });
});

describe('the pins of the section', () => {
  it('pins that do not load are a failed result that names the stage; no verdict is given', () => {
    ctl.pins = 'named';
    const r = judgeFinalityText(docOf(goodCase), { subject: 'DOC', settlement: settlement(), registry: new Registry() });
    expect(r.class).toBe('failed');
    expect(r.wiring?.stage).toBe('pins');
    expect(r.state?.code).toBe('finality_pins_corrupt');
    expect(r.text).toBe('FAILED (finality)  DOC\n  the verifier cannot be wired: its pins do not load: finality_pins_corrupt{reason="sha256_mismatch"}\n');
    expect(r.report).toBeUndefined();
  });

  it('with no Settlement the pins are not consulted: the section judges nothing either way', () => {
    ctl.pins = 'named';
    const r = judgeFinalityText(docOf(goodCase), { subject: 'DOC' });
    expect(r.class).toBe('summary_only');
    expect(r.wiring).toBeUndefined();
  });
});

describe('the asynchronous entries carry a wiring failure into the layers and the report', () => {
  it('verifyProofDocumentWithKinds: layer S7 failed with the reason, overall failed, failure.layer S7, every core layer still verified', async () => {
    vi.resetModules();
    const fresh = await import('../../../src/proof-v2/finality/surface.js');
    ctl.mode = 'named';
    const doc = core();
    doc.finality = JSON.parse(docOf(goodCase)).finality;
    const v = await fresh.verifyProofDocumentWithKinds(doc, { finality: { settlement: settlement(), subject: 'DOC' } });
    expect(v.overall).toBe('failed');
    expect(v.failure?.layer).toBe('S7');
    const s7 = v.layers.find((l) => l.id === 'S7')!;
    expect(s7.verdict).toBe('failed');
    expect(s7.reason).toContain('the verifier cannot be wired');
    expect(v.layers.filter((l) => l.id !== 'S7' && l.verdict === 'verified').length).toBeGreaterThanOrEqual(9);
    expect(v.finality?.wiring?.stage).toBe('kinds');
    expect(v.covers).toEqual([]);
  }, 120_000);

  it('verifyPortableWithKinds: the report carries the failure; the core report is untouched', async () => {
    vi.resetModules();
    const fresh = await import('../../../src/proof-v2/finality/surface.js');
    ctl.mode = 'named';
    const doc = core();
    doc.finality = JSON.parse(docOf(goodCase)).finality;
    const r = await fresh.verifyPortableWithKinds(doc, undefined, { finality: { settlement: settlement() } });
    expect(r.finality?.class).toBe('failed');
    expect(r.finality?.wiring?.stage).toBe('kinds');
    expect(r.setVerdict).toBe('verified');
  }, 120_000);
});
