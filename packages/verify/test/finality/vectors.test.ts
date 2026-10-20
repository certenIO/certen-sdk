/**
 * The validator's finality conformance vectors, judged here by the TypeScript twin and compared with the Go-written expected string
 * BYTE FOR BYTE (the programme's parity oracle; a difference on any vector is stop-the-line, never papered over). The files are
 * copies of certen-validator pv2/rb11-b-finality-framework@4377bb3 `pkg/finality/testdata/{finality_chain1,finality_chain2,finality}`
 * and are never edited: their manifests are pinned below to the validator's hashes.
 */
import { describe, expect, it } from 'vitest';
import {
  Reader,
  Writer,
  decodeContainer,
  encodeContainer,
  encodeNodes,
} from '../../src/proof-v2/finality/codec.js';
import { readHeader } from '../../src/proof-v2/finality/rlpheader.js';
import { checkLegChain, legBinding, ownHash, parseAddendum, parseProofId, parseSection, carriedLegRef } from '../../src/proof-v2/finality/addendum.js';
import { Registry } from '../../src/proof-v2/finality/registry.js';
import { kindFor } from '../../src/proof-v2/finality/table.js';
import { parsePinsOverride } from '../../src/proof-v2/finality/pins.js';
import { FinalityStateError, canonOf, canonValue, hexLower, lvl, type FieldValue } from '../../src/proof-v2/finality/state.js';
import { parseLevel } from '../../src/proof-v2/finality/level.js';
import { fixtureJSON, hexToBytes, limitsFrom, readFixture, sha256Hex } from './helpers.js';

/** The sha256 of the validator's MANIFEST.json files at certen-validator pv2/rb11-b-finality-framework@4377bb3. */
const VALIDATOR = {
  commit: '4377bb3',
  chain1Manifest: 'd6b275d6b2878960c3dba61d26f55ae9bef0e206b95e9fa09ed2aacb272666ca',
  chain2Manifest: '468b49a89905f69583bfe9d3c4de05bb91464ad0a82e3099cc6cd0c7774c23dd',
  states: 'd0e2d25048ba1dfe40e910538e6870675b2fbe3a4b0b47cdb9b1e0ffb084b73a',
} as const;

/** JSON with sorted keys and no whitespace: two files that differ only in member order compare equal. */
const norm = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(norm).join(',')}]` : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${norm((v as any)[k])}`).join(',')}}` : JSON.stringify(v);

const asLeg = (o: { chain: number; blockNumber: number; blockHash: string }) =>
  carriedLegRef({ chain: BigInt(o.chain), blockNumber: BigInt(o.blockNumber), blockHash: o.blockHash });

describe('the vector manifests equal the validator\'s', () => {
  it('pins the manifests, every file they list, the registry and the supersession', () => {
    expect(sha256Hex(readFixture('finality_chain1', 'MANIFEST.json'))).toBe(VALIDATOR.chain1Manifest);
    expect(sha256Hex(readFixture('finality_chain2', 'MANIFEST.json'))).toBe(VALIDATOR.chain2Manifest);
    expect(readFixture('finality_chain1', 'MANIFEST.json.sha256').toString('utf8').trim()).toBe(VALIDATOR.chain1Manifest);
    expect(readFixture('finality_chain2', 'MANIFEST.json.sha256').toString('utf8').trim()).toBe(VALIDATOR.chain2Manifest);
    expect(sha256Hex(readFixture('finality', 'states.json'))).toBe(VALIDATOR.states);

    for (const set of ['finality_chain1', 'finality_chain2']) {
      const m = fixtureJSON<{ files: Record<string, string>; set: string }>(set, 'MANIFEST.json');
      expect(m.set).toBe(set);
      for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(readFixture(set, f)), `${set}/${f}`).toBe(want);
    }
    const m1 = fixtureJSON<{ files: Record<string, string> }>('finality_chain1', 'MANIFEST.json');
    const m2 = fixtureJSON<{
      files: Record<string, string>;
      registry: { path: string; sha256: string };
      supersedes: { set: string; manifest_sha256: string; replaced_expectations: number };
    }>('finality_chain2', 'MANIFEST.json');
    expect(Object.keys(m1.files).length).toBe(5);
    expect(Object.keys(m2.files).length).toBe(9);
    expect(m2.registry).toEqual({ path: 'testdata/finality/states.json', sha256: VALIDATOR.states });
    expect(m2.supersedes).toEqual({
      goldens: 'finality_chain1/goldens.json is unchanged and still the golden of G0 and G1',
      manifest_sha256: VALIDATOR.chain1Manifest,
      replaced_expectations: 13,
      set: 'finality_chain1',
    });
  });
});

describe('goldens G0 and G1 (V2_SPEC_S7 2.2)', () => {
  const g = fixtureJSON('finality_chain1', 'goldens.json');
  it('reproduces ownHash over the 187-byte preimage and the leg binding over the 85-byte one', () => {
    const a = { proofId: new Uint8Array(16), seq: 1n, level: 3 as const, chain: 11155111n, kind: 'eth-sepolia/finalized/v1', evidence: new TextEncoder().encode('CFE1-test-vector'), prevHash: new Uint8Array(32), ownHash: new Uint8Array(32) };
    const d0 = new Uint8Array(32).fill(0x11);
    expect(hexLower(ownHash(d0, a))).toBe('0fa894743892da569d5278c87a2b5a2068e0ffef9ba524ca245e4004b4749539');
    expect(g.g0.ownHash).toBe('0fa894743892da569d5278c87a2b5a2068e0ffef9ba524ca245e4004b4749539');
    expect(g.g0.preimageLen).toBe(187);
    const d1 = legBinding(11155111n, 11845679n, new Uint8Array(32).fill(0x22));
    expect(hexLower(d1)).toBe('1cea0a369d4a4167f9f3b9be09de1670dfb5718a866bbf7d2a6519b540643445');
    expect(g.g1.d0).toBe(hexLower(d1));
    expect(g.g1.d0PreimageLen).toBe(85);
    expect(hexLower(ownHash(d1, a))).toBe('27b59e3b7779b06113e9230f73df87a437166871b293f17ffbfc98913725cdc7');
    expect(g.g1.ownHash).toBe('27b59e3b7779b06113e9230f73df87a437166871b293f17ffbfc98913725cdc7');
  });
});

describe('finality_chain2 is chain1 re-issued, differing in exactly the 13 superseded expectations', () => {
  it('changes only `expect`, in 13 vectors, and only adds vectors', () => {
    let changed = 0;
    for (const f of ['chains.json', 'containers.json', 'codec_probe.json', 'table.json']) {
      const a = fixtureJSON('finality_chain1', f);
      const b = fixtureJSON('finality_chain2', f);
      const old = [...(a.vectors ?? []), ...(a.queries ?? [])];
      const nw = [...(b.vectors ?? []), ...(b.queries ?? [])];
      expect(nw.length, f).toBeGreaterThanOrEqual(old.length);
      old.forEach((o: any, i: number) => {
        for (const [k, ov] of Object.entries(o)) {
          const nv = (nw[i] as any)[k];
          if (k !== 'expect') expect(norm(nv), `${f}[${i}].${k}`).toBe(norm(ov));
          else if (nv !== ov) changed++;
        }
      });
    }
    expect(changed).toBe(13);
  });
});

// ---- chains.json: CheckLegChain with strict addendum reading ----

function judgeChain(v: any): string {
  const leg = asLeg(v.leg);
  const carried = asLeg(v.carried);
  const adds = [];
  for (const el of v.addenda ?? []) {
    try {
      adds.push(parseAddendum(JSON.stringify(el)));
    } catch (e) {
      return canonOf(e);
    }
  }
  try {
    checkLegChain(leg, carried, adds);
    return 'ok';
  } catch (e) {
    return canonOf(e);
  }
}

describe('finality_chain2/chains.json', () => {
  const vectors = fixtureJSON('finality_chain2', 'chains.json').vectors as any[];
  it('has the vectors the Go suite names', () => {
    const names = new Set(vectors.map((v) => v.name));
    for (const want of [
      'tamper_seq_gap', 'tamper_prev_hash', 'tamper_own_hash', 'tamper_level_duplicate', 'tamper_kind_unregistered_version',
      'leg_binding_altered_leg_member', 'wrong_d0_with_matching_leg', 'chain_unsupported', 'kind_level1_refused',
      'valid_base_l1_posted_then_finalized', 'valid_base_finalized_then_l1_posted', 'valid_sepolia_finalized',
      'kind_l1_posted_on_sepolia_real_kind', 'kind_adiri_l1_posted_real_kind',
    ]) expect(names.has(want), want).toBe(true);
    expect(vectors.length).toBe(19);
  });
  it.each(vectors.map((v) => [v.name, v]))('%s', (_name, v) => {
    expect(judgeChain(v)).toBe(v.expect);
  });
});

// ---- containers.json and codec_probe.json ----

function judgeContainer(hex: string, limits: any): string {
  const raw = hexToBytes(hex);
  try {
    const c = decodeContainer(raw, limitsFrom(limits));
    const re = encodeContainer(c);
    expect(hexLower(re), 'encode(decode(x)) == x').toBe(hex);
    return canonValue({ kind: c.header.kind, chain: c.header.chain, level: BigInt(c.header.level), blockNumber: c.header.blockNumber, blockHash: c.header.blockHash, body: c.body });
  } catch (e) {
    if (!(e instanceof FinalityStateError)) throw e;
    return canonOf(e);
  }
}

/** The test grammar of codec_probe.json: LIST<LP> || NODES || u64 || end. */
function judgeProbe(hex: string, limits: any): string {
  const raw = hexToBytes(hex);
  try {
    const r = new Reader(raw, limitsFrom(limits));
    const items = r.lpList('probe.list', 4, 16);
    const nodes = r.nodes('probe.nodes', 8);
    const n = r.u64('probe.n');
    r.end('probe.end');
    const w = new Writer();
    w.lpList(items);
    w.nodes(nodes);
    w.u64(n);
    expect(hexLower(w.bytes()), 'encode(decode(x)) == x').toBe(hex);
    return 'ok';
  } catch (e) {
    if (!(e instanceof FinalityStateError)) throw e;
    return canonOf(e);
  }
}

describe('finality_chain2/containers.json', () => {
  const vectors = fixtureJSON('finality_chain2', 'containers.json').vectors as any[];
  it.each(vectors.map((v) => [v.name, v]))('%s', (_n, v) => {
    expect(judgeContainer(v.hex, v.limits)).toBe(v.expect);
  });
});

describe('finality_chain2/codec_probe.json', () => {
  const vectors = fixtureJSON('finality_chain2', 'codec_probe.json').vectors as any[];
  it.each(vectors.map((v) => [v.name, v]))('%s', (_n, v) => {
    expect(judgeProbe(v.hex, v.limits)).toBe(v.expect);
  });
  it('encodeNodes produces the canonical NODES order', () => {
    const out = encodeNodes([Uint8Array.of(0x7a, 0x7a), Uint8Array.of(0x61), Uint8Array.of(0x7a, 0x7a), Uint8Array.of(0x6d, 0x6d)]);
    expect(out.length).toBe(3);
    const w = new Writer();
    w.nodes(out);
    expect(() => new Reader(w.bytes(), decodeLimits()).nodes('n', 8)).not.toThrow();
  });
});

function decodeLimits() {
  return limitsFrom({});
}

// ---- table.json ----

describe('finality_chain2/table.json', () => {
  const queries = fixtureJSON('finality_chain2', 'table.json').queries as any[];
  it.each(queries.map((q) => [`${q.chain}/${q.level}`, q]))('chain/level %s', (_n, q) => {
    let got: string;
    try {
      got = `kind:${kindFor(BigInt(q.chain), q.level)}`;
    } catch (e) {
      got = canonOf(e);
    }
    expect(got).toBe(q.expect);
  });
});

// ---- header.json ----

describe('finality_chain2/header.json', () => {
  const vectors = fixtureJSON('finality_chain2', 'header.json').vectors as any[];
  it.each(vectors.map((v) => [v.name, v]))('%s', (_n, v) => {
    let got: string;
    try {
      const h = readHeader(hexToBytes(v.hex));
      const wd = h.withdrawalsRoot === undefined ? 'null' : `"0x${hexLower(h.withdrawalsRoot)}"`;
      got = `{"items":"${h.items}","number":"${h.number}","timestamp":"${h.timestamp}","withdrawalsRoot":${wd}}`;
    } catch (e) {
      got = canonOf(e);
    }
    expect(got).toBe(v.expect);
  });
});

// ---- json.json (strict addendum, section and proof id) ----

describe('finality_chain2/json.json', () => {
  const vectors = fixtureJSON('finality_chain2', 'json.json').vectors as any[];
  it('has the 57 vectors of the Go suite', () => expect(vectors.length).toBe(57));
  it.each(vectors.map((v) => [v.name, v]))('%s', (_n, v) => {
    let got = 'ok';
    try {
      if (v.target === 'addendum') parseAddendum(v.input);
      else if (v.target === 'section') parseSection(v.input);
      else if (v.target === 'proofId') parseProofId(v.input);
      else throw new Error(`target ${v.target}`);
    } catch (e) {
      got = canonOf(e);
    }
    expect(got).toBe(v.expect);
  });
});

// ---- judge.json ----

describe('finality_chain2/judge.json', () => {
  const vectors = fixtureJSON('finality_chain2', 'judge.json').vectors as any[];
  it('has at least the 8 judge vectors of the Go suite', () => expect(vectors.length).toBeGreaterThanOrEqual(8));
  it.each(vectors.map((v) => [v.name, v]))('%s', (_n, v) => {
    const leg = asLeg(v.leg);
    const a = parseAddendum(JSON.stringify(v.addendum));
    let got = 'ok';
    try {
      new Registry().judgeAddendum(leg, a, null);
    } catch (e) {
      got = canonOf(e);
    }
    expect(got).toBe(v.expect);
  });
});

// ---- pins.json ----

describe('finality_chain2/pins.json', () => {
  const vectors = fixtureJSON('finality_chain2', 'pins.json').vectors as any[];
  it('has the 36 vectors of the Go suite', () => expect(vectors.length).toBe(36));
  it.each(vectors.map((v) => [v.name, v]))('%s', (_n, v) => {
    let got = 'ok';
    try {
      parsePinsOverride(new TextEncoder().encode(v.text));
    } catch (e) {
      got = canonOf(e);
    }
    expect(got).toBe(v.expect);
  });
});

// ---- finality_chain1: the superseded set, judged too ----

describe('finality_chain1 (superseded by chain2) is judged as well', () => {
  // chain2 re-issues every chain1 vector in order, changing only the 13 expectations Go superseded; each chain1 vector must give
  // chain2's expectation and, unless it is one of the 13, chain1's own written string
  const judgers: Record<string, (v: any) => string> = {
    'chains.json': judgeChain,
    'containers.json': (v) => judgeContainer(v.hex, v.limits),
    'codec_probe.json': (v) => judgeProbe(v.hex, v.limits),
    'table.json': (q) => {
      try {
        return `kind:${kindFor(BigInt(q.chain), q.level)}`;
      } catch (e) {
        return canonOf(e);
      }
    },
  };
  it('gives the written (or the superseded) expectation for all 49 vectors', () => {
    let judged = 0;
    let superseded = 0;
    for (const [f, judge] of Object.entries(judgers)) {
      const a = fixtureJSON('finality_chain1', f);
      const b = fixtureJSON('finality_chain2', f);
      const old = (a.vectors ?? a.queries) as any[];
      const nw = (b.vectors ?? b.queries) as any[];
      old.forEach((v, i) => {
        const got = judge(v);
        expect(got, `${f}[${i}] ${v.name ?? ''}`).toBe(nw[i].expect);
        if (v.expect === got) judged++;
        else superseded++;
      });
    }
    expect(judged + superseded).toBe(49);
    expect(superseded).toBe(13);
  });
});

// ---- canonical.json ----

function fieldOf(f: { key: string; type: string; value?: any }): FieldValue {
  const v = f.value;
  switch (f.type) {
    case 'u64': case 'u32': case 'u16': case 'u8': case 'int': case 'i64': case 'i32':
      return BigInt(v);
    case 'level': {
      const l = parseLevel(v);
      if (l === undefined) throw new Error(`level ${v}`);
      return lvl(l);
    }
    case 'bytes32': case 'bytes4': case 'bytes':
      return hexToBytes(v);
    case 'bool':
      return v === 'true';
    case 'null':
      return null;
    case 'string':
      return v;
    case 'time':
      return new Date(v);
    case 'u64list':
      return (v as string[]).map((e) => BigInt(e));
    case 'map':
      return Object.fromEntries((v as any[]).map((e) => [e.key, fieldOf(e)]));
  }
  throw new Error(`unknown canonical field type ${f.type}`);
}

describe('finality_chain2/canonical.json', () => {
  const vectors = fixtureJSON('finality_chain2', 'canonical.json').vectors as any[];
  it.each(vectors.map((v) => [v.name, v]))('%s', (_n, v) => {
    const fields: Record<string, FieldValue> = {};
    for (const f of v.fields) fields[f.key] = fieldOf(f);
    expect(new FinalityStateError(v.code, fields).canonical()).toBe(v.expect);
  });
});
