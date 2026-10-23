/**
 * C2d: the Sepolia pins must agree with what the L1 head verifier runs on (twin of pins_ethl1_agreement_test.go): a pins file that says
 * committee 256, 64 epochs per period, 171 participants, another spec or genesis time, or max_links above the specification bound of 64 is
 * finality_pins_corrupt, by the name of the key; the values at the bounds are accepted; every published pins file still agrees.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { embeddedPinsBytes, parsePinsOverride, MAX_LINKS_BOUND, SEPOLIA_GENESIS_TIME, SEPOLIA_SPEC_PIN, MIN_WSP_EPOCHS } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { FIXTURES, marshalIndent } from './vectorset.js';

function edit(set: (sec: Record<string, unknown>) => void): FinalityStateError | undefined {
  const m = JSON.parse(new TextDecoder().decode(embeddedPinsBytes()));
  set(m.eth_sepolia);
  try {
    parsePinsOverride(new TextEncoder().encode(`${marshalIndent(m)}\n`));
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  return undefined;
}

describe('a pins file that disagrees with what the L1 head verifier runs on is corrupt', () => {
  it('the embedded pins themselves are accepted by the same edit path', () => {
    expect(edit(() => {})).toBeUndefined();
  });

  const cases: [string, string, (s: Record<string, unknown>) => void][] = [
    ['committee 256 with 171 participants', 'sync_committee_size', (s) => { s.sync_committee_size = 256; s.min_participants = 171; }],
    ['committee 1024', 'sync_committee_size', (s) => { s.sync_committee_size = 1024; s.min_participants = 683; }],
    ['epochs per period 64', 'epochs_per_period', (s) => { s.epochs_per_period = 64; }],
    ['epochs per period 512', 'epochs_per_period', (s) => { s.epochs_per_period = 512; }],
    ['spec garbage', 'spec', (s) => { s.spec = 'garbage'; }],
    ['spec empty', 'spec', (s) => { s.spec = ''; }],
    ['spec with one character changed', 'spec', (s) => { s.spec = `${SEPOLIA_SPEC_PIN.slice(0, -1)}d`; }],
    ['genesis time zero', 'genesis_time', (s) => { s.genesis_time = 0; }],
    ['genesis time off by one', 'genesis_time', (s) => { s.genesis_time = Number(SEPOLIA_GENESIS_TIME) + 1; }],
    ['genesis time one second early', 'genesis_time', (s) => { s.genesis_time = Number(SEPOLIA_GENESIS_TIME) - 1; }],
    ['max_links above the spec 8.2 bound', 'max_links', (s) => { s.max_links = Number(MAX_LINKS_BOUND) + 1; }],
    ['max_links 10 million', 'max_links', (s) => { s.max_links = 10_000_000; }],
  ];
  for (const [name, key, set] of cases) {
    it(name, () => {
      const e = edit(set);
      expect(e?.code).toBe('finality_pins_corrupt');
      expect([e!.fields.reason, e!.fields.key]).toEqual(['bad_value', key]);
    });
  }

  it('171 and 341 participants of 512 are corrupt (any reason), 342 and 512 are accepted', () => {
    for (const n of [171, 341]) expect(edit((s) => { s.min_participants = n; })?.code, String(n)).toBe('finality_pins_corrupt');
    for (const n of [342, 512]) expect(edit((s) => { s.min_participants = n; }), String(n)).toBeUndefined();
    expect(edit((s) => { s.min_participants = 513; })?.fields.reason).toBe('participation_floor_invalid');
  });

  it('max_links 64 (the bound) and 1 are accepted, 65 is refused, zero is bound_missing', () => {
    for (const n of [64, 1]) expect(edit((s) => { s.max_links = n; }), String(n)).toBeUndefined();
    expect(edit((s) => { s.max_links = 65; })?.fields.key).toBe('max_links');
    expect(edit((s) => { s.max_links = 0; })?.fields.reason).toBe('bound_missing');
  });

  it('the order of the checks: a missing bound is named before a disagreement, a disagreement before the participation floor', () => {
    expect(edit((s) => { s.sync_committee_size = 0; })?.fields).toMatchObject({ reason: 'bound_missing', key: 'sync_committee_size' });
    expect(edit((s) => { s.sync_committee_size = 256; s.min_participants = 100; })?.fields).toMatchObject({ reason: 'bad_value', key: 'sync_committee_size' });
    expect(edit((s) => { s.epochs_per_period = 64; s.spec = 'x'; })?.fields.key).toBe('epochs_per_period');
    expect(edit((s) => { s.spec = 'x'; s.genesis_time = 1; })?.fields.key).toBe('spec');
    expect(edit((s) => { s.genesis_time = 1; s.max_links = 65; })?.fields.key).toBe('genesis_time');
    expect(MIN_WSP_EPOCHS).toBe(256n);
  });
});

describe('every published pins file that carries the Sepolia section still satisfies the agreement', () => {
  it('scans the fixtures of every set', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n.endsWith('.json') && p.replace(/\\/g, '/').toLowerCase().includes('pins')) files.push(p);
      }
    };
    walk(FIXTURES);
    let scanned = 0;
    for (const f of files) {
      const raw = readFileSync(f);
      if (!raw.includes('"eth_sepolia"')) continue;
      scanned++;
      try {
        parsePinsOverride(Uint8Array.from(raw));
      } catch (e) {
        const key = e instanceof FinalityStateError ? e.fields.key : undefined;
        expect(['sync_committee_size', 'epochs_per_period', 'spec', 'genesis_time', 'max_links'], f).not.toContain(key);
      }
    }
    expect(scanned).toBeGreaterThanOrEqual(10);
  });
});
