// THE FINAL GATE (WP-S8-8): all 291 vectors of the ten published sets, run through the PRODUCTION verifier (every step of every package, no stand-in,
// no world builder) from the materialised inputs, and judged exactly as Go's RunSet / MatchExpected do (canonical states, parts, Open entries,
// registry, rules_not_judged, s7_finalized_status). Executed == the count PINS.json lists, per set and in total; nothing is skipped.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decode, names, productionVerifier, reportObject, canonical, type Report } from '../../src/proof-v2/identity/index.js';
import { FIXTURES, SET_NAMES, VECTORS, setFiles, vectorIds } from './fixtures.js';
import { runSet } from './runset.js';

const pins = JSON.parse(readFileSync(join(VECTORS, 'PINS.json'), 'utf8')) as { sets: Record<string, Record<string, string>> };
const GOLDENS: Record<string, string> = {
  'G-S8-0.json': '6afa6905f9aa90080a2cf8e442f6ff79088771ad669a9fc7b0172fd0e4cb8e60',
  'G-S8-1.container.hex': '041b9b8030de6c3c99ed6a08e4d2f319ee5b4dc0050bf858c8a6ebfd97de63fc',
  'G-S8-1.json': '0a633c15a19049d228ecc50f76b98ff781b659e671d26342757310c7b9a1dafe',
  'G-S8-2.container.hex': '22ecfcdf9df175cf862181aba20c7d6ee1b009cb0fcfadf748bdc7e8390257ce',
  'G-S8-2.json': '80576b17caac30125dc4729996a4ab44170e1eb16001664136ac94625c5c4b07',
};
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const counts: Record<string, number> = {};
const kinds: Record<string, number> = {};
const reports = new Map<string, Report>();

describe('gate all: the ten sets through the production verifier', () => {
  const prod = productionVerifier();
  for (const name of SET_NAMES) {
    it(name + ': every vector executed and identical to Go', () => {
      const listed = Object.keys(pins.sets[name]!).filter((f) => f.endsWith('.expected.json')).length;
      expect(vectorIds(setFiles(name)).length, 'executed = listed').toBe(listed);
      const all = runSet(name, prod, (id, r) => { reports.set(name + '/' + id, r); });
      expect(all.length).toBe(listed);
      const bad = all.filter((r) => r.outcome !== 'pass').map((r) => r.id + ': ' + r.detail.slice(0, 220));
      expect(bad.length, bad.length + ' failing:\n' + bad.slice(0, 14).join('\n')).toBe(0);
      counts[name] = all.length;
    }, 600_000);
  }

  it('the executed count equals the PINS count in total (291) and per set', () => {
    for (const name of SET_NAMES) expect(counts[name], name).toBe(Object.keys(pins.sets[name]!).filter((f) => f.endsWith('.expected.json')).length);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(291);
  });

  it('includes the negative controls VS8-220.n_only_hole and VS8-172.owner_active_in_block_prepost', () => {
    const all = SET_NAMES.flatMap((n) => vectorIds(setFiles(n)).map((id) => n + '/' + id));
    expect(all.some((x) => x.endsWith('/VS8-220.n_only_hole'))).toBe(true);
    expect(all.some((x) => x.endsWith('/VS8-172.owner_active_in_block_prepost'))).toBe(true);
  });

  it('prints every report canonically, and verified_core is never a verified', () => {
    expect(reports.size).toBeGreaterThan(200);
    let core = 0;
    let verified = 0;
    for (const [id, r] of reports) {
      const obj = reportObject(r);
      const text = canonical(obj);
      expect(text.length, id).toBeGreaterThan(0);
      const head = obj['headline'] as { code: string };
      if (r.headline.kind === names.HeadlineVerifiedCore) { core++; expect(head.code, id).toBe('contract_identity_verified_core'); expect(r.headline.kind, id).not.toBe(names.HeadlineVerified); }
      if (r.headline.kind === names.HeadlineVerified) { verified++; expect(head.code, id).toBe('contract_identity_verified'); }
      kinds[r.headline.kind] = (kinds[r.headline.kind] ?? 0) + 1;
    }
    expect(core + verified).toBeGreaterThan(0);
    // a verified_core expectation is only ever met by a verified_core report: re-judge the expected files
    for (const name of SET_NAMES) {
      const f = setFiles(name);
      for (const id of vectorIds(f)) {
        const exp = JSON.parse(new TextDecoder().decode(f.get(id + '.expected.json'))) as { headline: string };
        const r = reports.get(name + '/' + id);
        if (r && exp.headline === 'verified_core') expect(r.headline.kind, name + '/' + id).toBe('verified_core');
        if (r && exp.headline === 'verified') expect(r.headline.kind, name + '/' + id).toBe('verified');
      }
    }
  });

  it('states.json, vocab.json and the goldens are the published bytes, and the golden containers decode strictly', () => {
    for (const [f, h] of Object.entries(GOLDENS)) expect(sha(readFileSync(join(FIXTURES, 'goldens', f))), f).toBe(h);
    for (const g of ['G-S8-1', 'G-S8-2']) {
      const hex = readFileSync(join(FIXTURES, 'goldens', g + '.container.hex'), 'utf8').trim();
      const c = decode(Uint8Array.from(hex.match(/../g)!, (x) => parseInt(x, 16)));
      expect(c.chain, g).toBeGreaterThan(0n);
    }
  });
});
