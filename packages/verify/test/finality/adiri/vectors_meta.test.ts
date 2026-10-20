/** The identity of the copied vector set, its registry and its pins; and that the Go-written expectations are inside the closed registry. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADIRI_PINS_SHA256, MANIFEST_SHA256, REGISTRY_DIR, STATES_SHA256, readSet, sha256Hex, vectors } from './vectorset.js';
import { registry } from './regcheck.js';

describe('finality_adiri3 identity', () => {
  it('MANIFEST.json hashes to the Go-written MANIFEST.json.sha256 and the pinned value', () => {
    expect(sha256Hex(readSet('MANIFEST.json'))).toBe(MANIFEST_SHA256);
    expect(readSet('MANIFEST.json.sha256').toString('utf8').trim()).toBe(MANIFEST_SHA256);
  });

  it('every file the manifest lists is byte-identical, and the manifest lists every file', () => {
    const m = JSON.parse(readSet('MANIFEST.json').toString('utf8')) as { files: Record<string, string>; format: string };
    expect(m.format).toBe('finality_adiri3/manifest/1');
    for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(readSet(f)), f).toBe(want);
    expect(Object.keys(m.files).length).toBe(21);
  });

  it('holds 60 vectors: 3 live, 28 synthetic-or-adversarial groups as the Go set names them', () => {
    const vs = vectors();
    expect(vs.length).toBe(60);
    const groups = new Map<string, number>();
    for (const v of vs) groups.set(v.group, (groups.get(v.group) ?? 0) + 1);
    expect(groups.get('live')).toBe(3);
    expect(groups.get('adversarial')! + groups.get('synthetic')!).toBe(57);
    expect(new Set(vs.map((v) => v.name)).size).toBe(60);
  });

  it('the registry and the embedded pins fixtures are byte-identical to pv2/rb11-int@ee6d106', () => {
    expect(sha256Hex(readFileSync(join(REGISTRY_DIR, 'states.json')))).toBe(STATES_SHA256);
    expect(sha256Hex(readFileSync(join(REGISTRY_DIR, 'finality-pins.json')))).toBe(ADIRI_PINS_SHA256);
  });

  it('every expectation is "finalized" or a state of the closed registry with only registered fields and enum values', () => {
    for (const v of vectors()) {
      const j = JSON.parse(v.expect) as { code: string; fields: Record<string, unknown> };
      if (j.code === 'finalized') continue;
      const r = registry.states[j.code];
      expect(r, `${v.name}: ${j.code}`).toBeDefined();
      const allowed = new Set([...r!.required, ...r!.optional]);
      for (const f of r!.required) expect(Object.keys(j.fields), `${v.name} lacks ${f}`).toContain(f);
      for (const [f, val] of Object.entries(j.fields)) {
        expect(allowed.has(f), `${v.name}: ${j.code} carries unregistered ${f}`).toBe(true);
        const set = r!.enums?.[f];
        if (set) expect(set, `${v.name}: ${j.code}.${f}`).toContain(val);
      }
    }
  });
});
