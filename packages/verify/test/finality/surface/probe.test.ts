/**
 * The Settlement JSON reader against Go on 261 hand-made texts (doc_report1/settlement_probe.json): for each, whether encoding/json decodes it into *ethproof.Settlement,
 * whether the result is nil, whether the Settlement verifies as the included level and the named state when it does not. The texts cover every rule the reader's header names:
 * hexutil raw tokens (0x / 0X, odd, escaped, empty, null), [32]byte arrays (short, long, junk past the end, null elements), base64 (padding, CR/LF, other whitespace, URL alphabet),
 * uint64 literals, `verified`, member folding (Kelvin sign, long s), repeated members and merging, unknown members, and non-objects.
 */
import { describe, expect, it } from 'vitest';
import { deriveIncluded } from '../../../src/proof-v2/finality/evidence.js';
import { parseSettlementJSON } from '../../../src/proof-v2/finality/settlementjson.js';
import { asNamed } from '../../../src/proof-v2/finality/state.js';
import { ChainBaseSepolia } from '../../../src/proof-v2/finality/table.js';
import { readSet } from './support.js';

interface Probe {
  name: string;
  text: string;
  go: { parsed: boolean; nil: boolean; verifies: boolean; code: string };
}
const probes = JSON.parse(readSet('settlement_probe.json').toString('utf8')) as Probe[];

function ours(text: string): Probe['go'] {
  let s;
  try {
    s = parseSettlementJSON(text);
  } catch {
    return { parsed: false, nil: false, verifies: false, code: '' };
  }
  try {
    deriveIncluded(ChainBaseSepolia, s);
    return { parsed: true, nil: s === null, verifies: true, code: '' };
  } catch (e) {
    return { parsed: true, nil: s === null, verifies: false, code: asNamed(e)?.code ?? 'other' };
  }
}

describe('the Settlement reader reaches the answers of encoding/json on every probe', () => {
  it('has the 261 probes, among them verifying, refused and nil ones', () => {
    expect(probes.length).toBe(261);
    expect(probes.filter((p) => p.go.verifies).length).toBeGreaterThan(20);
    expect(probes.filter((p) => !p.go.parsed).length).toBeGreaterThan(80);
    expect(probes.filter((p) => p.go.parsed && !p.go.verifies).length).toBeGreaterThan(20);
    expect(probes.filter((p) => p.go.nil).length).toBe(2);
  });
  for (const p of probes) it(p.name, () => expect(ours(p.text)).toEqual(p.go));
});
