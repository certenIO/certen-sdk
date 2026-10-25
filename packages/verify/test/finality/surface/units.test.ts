/**
 * Hostile input and boundaries of the finality section's readers: the document member (judgeFinalityText), the Settlement JSON reader and its base64, and what a
 * result may carry. Every refusal is a class with a named state, none is an exception, and what is not established is never reported as verified.
 */
import { describe, expect, it } from 'vitest';
import { parseSection } from '../../../src/proof-v2/finality/addendum.js';
import { carriesFinality, judgeFinalityDocument, judgeFinalityText, notCoveredByThePins } from '../../../src/proof-v2/finality/docreport.js';
import { deriveIncluded } from '../../../src/proof-v2/finality/evidence.js';
import { Registry } from '../../../src/proof-v2/finality/registry.js';
import { base64Std, parseSettlementJSON, SettlementJsonError } from '../../../src/proof-v2/finality/settlementjson.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { ChainBaseSepolia } from '../../../src/proof-v2/finality/table.js';
import { allKindsRegistry, cases, docOf, fakeBaseRegistry, legSettlement, pinsNamed, readSet } from './support.js';

const FORMAT = 'certen-finality-addenda/1';
const HASH = 'ab'.repeat(32);
const leg = `{"chain":84532,"blockNumber":1,"blockHash":"${HASH}"}`;
const section = (addenda = '[]'): string => `{"format":"${FORMAT}","leg":${leg},"addenda":${addenda}}`;
const docWith = (member: string): string => `{"format":"certen-proof-v2-accumulate-portable/1","finality":${member}}`;
const judge = (text: string, opts = {}) => judgeFinalityText(text, { subject: 'DOC', ...opts });
const state = (member: string): string => {
  try {
    parseSection(member);
  } catch (e) {
    if (e instanceof FinalityStateError) return e.toString();
    throw e;
  }
  return 'parsed';
};

describe('the document is read as Go reads it', () => {
  it('no member, null member, null document: summary-only, never verified', () => {
    for (const t of [`{}`, `{"x":1}`, docWith('null'), `null`, `{"finality":null,"finality":null}`]) {
      const r = judge(t);
      expect([r.class, r.exit], t).toEqual(['summary_only', 3]);
      expect(r.text).toBe('SUMMARY-ONLY (finality)  DOC\n  the document carries no finality section: no level beyond the proof itself is evidenced.\n');
      expect(r.headline).toBeUndefined();
    }
  });

  it('a document that is not a JSON object, or not JSON, fails by class with the document text untouched', () => {
    for (const t of ['', ' ', '{', '[1,2]', '"x"', '5', 'true', '{"finality":}', '{} {}', '{"a":1,}', '﻿{}', '{"finality":1}garbage', 'nul', '{"finality":NaN}']) {
      const r = judge(t);
      // `5`, `"x"` and `true` decode to Go's struct with an error; `{"finality":1}garbage` has trailing data: every one is a refusal
      expect([r.class, r.exit], JSON.stringify(t)).toEqual(['failed', 1]);
      expect(r.text.startsWith('FAILED (finality)  DOC\n  not a portable document: ') || r.text.startsWith('FAILED (finality)  DOC\n  finality_addendum_malformed{'), JSON.stringify(t)).toBe(true);
      expect(r.text).not.toContain('VERIFIED');
    }
  });

  it('a depth bomb is a refusal, not a stack overflow', () => {
    const r = judge('['.repeat(200_000));
    expect(r.class).toBe('failed');
    const nested = `{"finality":${'['.repeat(20_000)}${']'.repeat(20_000)}}`;
    expect(judge(nested).class).toBe('failed');
  });

  it('the member is `finality`: exact name, else any case, and the last occurrence decides', () => {
    const s = section();
    expect(judge(`{"FINALITY":${s}}`).text).toContain('no_settlement_to_recompute_d0');
    expect(judge(`{"Finality":${s}}`).text).toContain('no_settlement_to_recompute_d0');
    expect(judge(`{"finality":null,"finality":${s}}`).text).toContain('no_settlement_to_recompute_d0');
    expect(judge(`{"finality":${s},"finality":null}`).class).toBe('summary_only');
    expect(judge(`{"finality":${s},"finality":null}`).text).toContain('no finality section');
    expect(judge(`{"finalit":${s}}`).text).toContain('no finality section');
    expect(judge(`{"finality ":${s}}`).text).toContain('no finality section');
    // a key spelled with an escape is the key it decodes to
    expect(judge(`{"\\u0066inality":${s}}`).text).toContain('no_settlement_to_recompute_d0');
  });

  it('the bytes of a document and its text are the same input', () => {
    const t = docWith(section());
    expect(judgeFinalityText(new TextEncoder().encode(t), { subject: 'DOC' }).text).toBe(judge(t).text);
  });
});

describe('the finality member is read strictly (named states, in schema order)', () => {
  const bad: Record<string, string> = {
    'a number': '5',
    'a string': '"x"',
    'an array (the withdrawn flat form)': '[]',
    'a boolean': 'true',
    'an empty object': '{}',
    'the wrong format': `{"format":"certen-finality-addenda/2","leg":${leg},"addenda":[]}`,
    'a repeated key': `{"format":"${FORMAT}","format":"${FORMAT}","leg":${leg},"addenda":[]}`,
    'an unknown key': `{"format":"${FORMAT}","leg":${leg},"addenda":[],"originalProofDigest":"00"}`,
    'a differently cased key': `{"Format":"${FORMAT}","leg":${leg},"addenda":[]}`,
    'a missing leg': `{"format":"${FORMAT}","addenda":[]}`,
    'a leg that is not an object': `{"format":"${FORMAT}","leg":[],"addenda":[]}`,
    'a leg chain that is a float': `{"format":"${FORMAT}","leg":{"chain":84532.0,"blockNumber":1,"blockHash":"${HASH}"},"addenda":[]}`,
    'a leg chain above 2^64-1': `{"format":"${FORMAT}","leg":{"chain":18446744073709551616,"blockNumber":1,"blockHash":"${HASH}"},"addenda":[]}`,
    'a leg hash in capitals': `{"format":"${FORMAT}","leg":{"chain":84532,"blockNumber":1,"blockHash":"${HASH.toUpperCase()}"},"addenda":[]}`,
    'a short leg hash': `{"format":"${FORMAT}","leg":{"chain":84532,"blockNumber":1,"blockHash":"abab"},"addenda":[]}`,
    'addenda that is null': `{"format":"${FORMAT}","leg":${leg},"addenda":null}`,
    'addenda that is an object': `{"format":"${FORMAT}","leg":${leg},"addenda":{}}`,
    'an addendum that is null': section('[null]'),
    'an addendum that is empty': section('[{}]'),
  };
  for (const [name, member] of Object.entries(bad)) {
    it(`${name}: failed, and the state is the one parseSection names`, () => {
      const r = judge(docWith(member));
      expect([r.class, r.exit]).toEqual(['failed', 1]);
      expect(state(member)).not.toBe('parsed');
      expect(r.text).toBe(`FAILED (finality)  DOC\n  ${state(member)}\n`);
      expect(r.state?.toString()).toBe(state(member));
    });
  }

  it('a huge addenda array is refused at its first bad element without reading the rest', () => {
    const t = Date.now();
    const r = judge(docWith(section(`[${'null,'.repeat(300_000)}null]`)));
    expect(r.class).toBe('failed');
    expect(r.text).toContain('index="0"');
    expect(Date.now() - t).toBeLessThan(20_000);
  });

  it('an empty chain with a Settlement is VERIFIED at included and says every other level is pending', () => {
    const s = legSettlement('base_sepolia_47368146', 84532n);
    const sec = `{"format":"${FORMAT}","leg":{"chain":84532,"blockNumber":47368146,"blockHash":"3892cf2ea71bb8bbb66b1ce5df138522ef8ce7b6137ec791a23d19d2c58de942"},"addenda":[]}`;
    const r = judge(docWith(sec), { settlement: s, registry: fakeBaseRegistry() });
    expect([r.class, r.exit, r.headline]).toEqual(['verified', 0, 1]);
    expect(r.text).toContain('level reached: included');
    expect(r.text.match(/no_evidence_in_file/g)?.length).toBe(2);
  });
});

describe('what a result carries', () => {
  const sec = (): string => readSet('cases.json').toString('utf8');
  it('without a registry the call says so by name and every addendum is unrecognised: summary-only, never verified', async () => {
    const cases = JSON.parse(sec()).cases as { id: string; doc?: string; settlement: string; chain: string }[];
    const c = cases.find((x) => x.id === 'go/chain_verifies_to_finalized')!;
    const r = judgeFinalityText(c.doc!, { subject: 'DOC', settlement: legSettlement(c.settlement, BigInt(c.chain)) });
    expect([r.class, r.exit, r.noKinds]).toEqual(['summary_only', 3, true]);
    expect(r.text).toContain('no verifier Kind is registered in this call');
    expect(r.text).toContain('finality_evidence_unrecognised');
    expect(r.headline).toBe(1);
  });

  it('JSON.stringify of a result is safe (no bigint, no map) and carries class, exit, text and headline; the structured members are reachable by name', () => {
    const cases = JSON.parse(sec()).cases as { id: string; doc?: string; settlement: string; chain: string }[];
    const c = cases.find((x) => x.id === 'go/chain_verifies_to_finalized')!;
    const r = judgeFinalityText(c.doc!, { subject: 'DOC', settlement: legSettlement(c.settlement, BigInt(c.chain)), registry: fakeBaseRegistry() });
    expect(Object.keys(JSON.parse(JSON.stringify(r))).sort()).toEqual(['class', 'exit', 'headline', 'text']);
    expect(r.report?.headline).toBe(3);
    const s = judge(docWith(section()));
    expect(Object.keys(JSON.parse(JSON.stringify(s))).sort()).toEqual(['class', 'exit', 'text']);
    expect(s.state?.code).toBe('finality_included_unavailable');
  });

  it('a decoded document is judged on the text JSON.stringify gives it, as verifyPortable reads it', () => {
    const t = docWith(section());
    expect(judgeFinalityDocument(JSON.parse(t), { subject: 'DOC' }).text).toBe(judge(JSON.stringify(JSON.parse(t))).text);
    expect(judgeFinalityDocument(undefined, { subject: 'DOC' }).class).toBe('failed');
    expect(judgeFinalityDocument(() => 1, { subject: 'DOC' }).class).toBe('failed');
    expect(judgeFinalityDocument(10n === 10n ? 'x' : 'y', { subject: 'DOC' }).class).toBe('failed');
  });

  it('carriesFinality is the member Go would read: exact or case-folded, not null', () => {
    expect(carriesFinality({ finality: {} })).toBe(true);
    expect(carriesFinality({ FINALITY: 1 })).toBe(true);
    expect(carriesFinality({ finality: null })).toBe(false);
    expect(carriesFinality({ finalit: {} })).toBe(false);
    expect(carriesFinality({})).toBe(false);
    for (const x of [null, undefined, 5, 'finality', [], [{ finality: 1 }]]) expect(carriesFinality(x)).toBe(false);
  });

  it('notCoveredByThePins: only the four classes of Go are summary-only', () => {
    const st = (code: string, fields = {}) => new FinalityStateError(code, fields);
    expect(notCoveredByThePins(undefined)).toBe(false);
    expect(notCoveredByThePins(st('finality_evidence_unrecognised'))).toBe(true);
    expect(notCoveredByThePins(st('finality_pin_unknown'))).toBe(true);
    expect(notCoveredByThePins(st('finality_ledger_behind'))).toBe(true);
    expect(notCoveredByThePins(st('l1_finality_unproven', { inner: 'finality_ledger_behind' }))).toBe(true);
    expect(notCoveredByThePins(st('l1_finality_unproven', { inner: 'finality_pin_unknown' }))).toBe(false);
    expect(notCoveredByThePins(st('l1_finality_unproven'))).toBe(false);
    expect(notCoveredByThePins(st('finality_pin_mismatch'))).toBe(false);
  });
});

describe('base64.StdEncoding as Go decodes it', () => {
  const ok = (s: string): number[] => [...base64Std(s)];
  it('N passes, N-1 fails: padding is required and exact', () => {
    expect(ok('')).toEqual([]);
    expect(ok('QQ==')).toEqual([0x41]);
    expect(ok('QUI=')).toEqual([0x41, 0x42]);
    expect(ok('QUJD')).toEqual([0x41, 0x42, 0x43]);
    for (const bad of ['QQ=', 'QQ', 'QQ===', 'Q===', 'Q', 'QUI', 'QUJ', '=QQQ', 'QQ=Q', 'QQ==QUJD', 'QUJD=']) expect(() => base64Std(bad), bad).toThrow(SettlementJsonError);
  });
  it('CR and LF are ignored anywhere, other whitespace and the URL alphabet are not', () => {
    expect(ok('QU\r\nJD')).toEqual([0x41, 0x42, 0x43]);
    expect(ok('\nQQ=\r=\n')).toEqual([0x41]);
    for (const bad of ['QU JD', 'QU\tJD', 'QU-D', 'QU_D', 'QUJé']) expect(() => base64Std(bad), bad).toThrow(SettlementJsonError);
  });
  it('trailing bits are not checked (Go is not strict)', () => {
    expect(ok('QR==')).toEqual([0x41]);
    expect(ok('QUJ=')).toEqual([0x41, 0x42]);
  });
});

describe('the Settlement reader reads what encoding/json reads into ethproof.Settlement', () => {
  const file = JSON.parse(readSet('settlements', 'base_sepolia_47368146.json').toString('utf8')) as { settlement: Record<string, any> };
  const good = (): Record<string, any> => structuredClone(file.settlement);
  const read = (o: unknown) => parseSettlementJSON(JSON.stringify(o));
  const verifies = (o: unknown): boolean => {
    try {
      const s = read(o);
      deriveIncluded(ChainBaseSepolia, s);
      return true;
    } catch {
      return false;
    }
  };

  it('the recorded Settlement verifies, and null is "no Settlement"', () => {
    expect(verifies(good())).toBe(true);
    expect(parseSettlementJSON('null')).toBeNull();
    expect(parseSettlementJSON(' null ')).toBeNull();
  });

  it('text that is not an object is refused; unknown and `verified` members are ignored or type-checked as Go does', () => {
    for (const t of ['', '[]', '5', '"x"', 'true', '{', '{} x']) expect(() => parseSettlementJSON(t), t).toThrow();
    const g = good();
    g.extra = { anything: [1, 2, 3] };
    expect(verifies(g)).toBe(true);
    const v = good();
    v.tx_inclusion_proof.verified = 'yes';
    expect(() => read(v)).toThrow(SettlementJsonError);
    const n = good();
    n.tx_inclusion_proof.verified = null;
    expect(verifies(n)).toBe(true);
  });

  it('hashes and the header are hexutil text: 0x, exact length, either case, never null, never written with an escape', () => {
    const upper = good();
    upper.block_hash = '0x' + upper.block_hash.slice(2).toUpperCase();
    expect(verifies(upper)).toBe(true);
    for (const k of ['block_hash', 'tx_hash']) {
      for (const bad of [null, 5, [], {}, '', '0x', good()[k].slice(2), good()[k].slice(0, -2), good()[k] + '00', '0x' + 'zz'.repeat(32), good()[k].slice(0, -1)]) {
        const o = good();
        o[k] = bad;
        expect(() => read(o), `${k}=${JSON.stringify(bad)}`).toThrow(SettlementJsonError);
      }
    }
    const h = good();
    h.block_header_rlp = h.block_header_rlp.slice(0, -1);
    expect(() => read(h)).toThrow(SettlementJsonError);
    h.block_header_rlp = null;
    expect(() => read(h)).toThrow(SettlementJsonError);
    h.block_header_rlp = '0x';
    expect(read(h)?.headerRlp.length).toBe(0);
    // hexutil.Bytes reads the empty string as no bytes (the hand probe found this against Go); a hash does not
    h.block_header_rlp = '';
    expect(read(h)?.headerRlp.length).toBe(0);
    // `0x` written with an escape: Go reads the raw token and refuses it where the unescaped string would pass
    const text = JSON.stringify(good()).replace('"block_hash":"0x', '"block_hash":"\\u0030x');
    expect(() => parseSettlementJSON(text)).toThrow(SettlementJsonError);
  });

  it('[32]byte is an array of numbers: a long array is cut, a short one is zero-filled, null keeps the byte, every other element is refused', () => {
    const lh = good().tx_inclusion_proof.leaf_hash as number[];
    expect(lh.length).toBe(32);
    const longer = good();
    longer.tx_inclusion_proof.leaf_hash = [...lh, 7, 8, 9];
    expect(verifies(longer)).toBe(true);
    const shorter = good();
    shorter.tx_inclusion_proof.leaf_hash = lh.slice(0, 31);
    expect(read(shorter)?.tx?.leafHash[31]).toBe(0);
    expect(verifies(shorter)).toBe(lh[31] === 0);
    const withNull = good();
    withNull.tx_inclusion_proof.leaf_hash = [null, ...lh.slice(1)];
    expect(read(withNull)?.tx?.leafHash[0]).toBe(0);
    for (const bad of ['0x00', 5, {}, true, [256], [-1], [1.5], ['1'], [[1]], [true], lh.slice(0, 31).concat([256])]) {
      const o = good();
      o.tx_inclusion_proof.leaf_hash = bad;
      expect(() => read(o), JSON.stringify(bad)).toThrow(SettlementJsonError);
    }
    // an element beyond the 32nd is skipped, not decoded: whatever it is, Go does not refuse it (the differential found this; the first reader refused it)
    for (const extra of ['x', null, 256, -1, 1.5, [1], {}, true]) {
      const beyond = good();
      beyond.tx_inclusion_proof.leaf_hash = [...lh, extra];
      expect(verifies(beyond), JSON.stringify(extra)).toBe(true);
    }
    const edge = good();
    edge.tx_inclusion_proof.leaf_hash = [...lh.slice(0, 31), 255];
    expect(read(edge)?.tx?.leafHash[31]).toBe(255);
  });

  it('[]byte is base64 or an array of numbers; null is nil; proof_nodes and proof_hashes are arrays of those', () => {
    const o = good();
    const node0 = Buffer.from(o.tx_inclusion_proof.proof_nodes[0], 'base64');
    o.tx_inclusion_proof.proof_nodes[0] = [...node0];
    expect(verifies(o)).toBe(true);
    const crlf = good();
    crlf.tx_inclusion_proof.leaf_value = crlf.tx_inclusion_proof.leaf_value.replace(/^(.{8})/, '$1\r\n');
    expect(verifies(crlf)).toBe(true);
    const unpadded = good();
    const lv: string = unpadded.tx_inclusion_proof.leaf_value;
    if (lv.endsWith('=')) {
      unpadded.tx_inclusion_proof.leaf_value = lv.replace(/=+$/, '');
      expect(() => read(unpadded)).toThrow(SettlementJsonError);
    }
    for (const bad of [5, {}, true, 'not base64!', [300], ['x']]) {
      const b = good();
      b.tx_inclusion_proof.proof_nodes[0] = bad;
      expect(() => read(b), JSON.stringify(bad)).toThrow(SettlementJsonError);
    }
    const nul = good();
    nul.tx_inclusion_proof.proof_nodes = null;
    expect(read(nul)?.tx?.proofNodes).toEqual([]);
    expect(verifies(nul)).toBe(false);
    for (const bad of [5, {}, 'x', true]) {
      const b = good();
      b.tx_inclusion_proof.proof_hashes = bad;
      expect(() => read(b), JSON.stringify(bad)).toThrow(SettlementJsonError);
    }
  });

  it('leaf_index is a uint64 literal: 2^64-1 reads, 2^64, signs, fractions and exponents are refused; null leaves it', () => {
    const t = JSON.stringify(good());
    const withIndex = (lit: string): string => t.replace(/"leaf_index":\d+/, `"leaf_index":${lit}`);
    expect(parseSettlementJSON(withIndex('18446744073709551615'))?.tx?.leafIndex).toBe(18446744073709551615n);
    for (const lit of ['18446744073709551616', '-1', '1.0', '1e2', '"7"', '[]', 'true']) expect(() => parseSettlementJSON(withIndex(lit)), lit).toThrow(SettlementJsonError);
    expect(parseSettlementJSON(withIndex('null'))?.tx?.leafIndex).toBe(0n);
  });

  it('members match by exact name, else any case; repeats are read in order and a repeated proof object merges', () => {
    const g = good();
    const folded: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(g)) folded[k.toUpperCase()] = v;
    expect(verifies(folded)).toBe(true);
    // Kelvin sign and long s fold to k and s: "BLOCK_HASH" spelled with U+212A
    const kelvin = JSON.stringify(g).replace('"block_hash"', '"blocK_hash"');
    expect(verifies(JSON.parse(kelvin))).toBe(true);
    const text = JSON.stringify(g);
    const dupBad = text.slice(0, -1) + `,"tx_hash":"0x${'00'.repeat(32)}"}`;
    expect(() => deriveIncluded(ChainBaseSepolia, parseSettlementJSON(dupBad))).toThrow(FinalityStateError);
    // an exponent is not a uint8 literal, whatever number it denotes
    expect(() => parseSettlementJSON(text.replace(/"leaf_hash":\[\d+/, '"leaf_hash":[1e2'))).toThrow(SettlementJsonError);
    const lastWins = `{"tx_hash":"0x${'00'.repeat(32)}",` + text.slice(1);
    expect(deriveIncluded(ChainBaseSepolia, parseSettlementJSON(lastWins)).number).toBe(47368146n);
    const merged = text.replace('{"block_hash"', `{"tx_inclusion_proof":{"leaf_index":99},"block_hash"`);
    expect(verifies(JSON.parse(merged))).toBe(true);
    const nulled = text.replace('{"block_hash"', `{"tx_inclusion_proof":null,"block_hash"`);
    expect(verifies(JSON.parse(nulled))).toBe(true);
    const nullAfter = text.slice(0, -1) + ',"tx_inclusion_proof":null}';
    expect(read(JSON.parse(nullAfter))?.tx).toBeNull();
  });

  it('a Settlement that does not verify is judged as included_invalid, a null one as unavailable, by the section', () => {
    const cases = JSON.parse(readSet('cases.json').toString('utf8')).cases as { id: string; doc: string }[];
    const doc = cases.find((c) => c.id === 'go/chain_verifies_to_finality' || c.id === 'go/chain_verifies_to_finalized')!.doc;
    const none = judgeFinalityText(doc, { subject: 'DOC', registry: new Registry(), settlement: { chain: 84532n, settlement: null } });
    expect(none.class).toBe('failed');
    expect(none.text).toContain('finality_included_unavailable{chain="84532",reason="no_settlement"}');
    const zero = judgeFinalityText(doc, { subject: 'DOC', registry: new Registry(), settlement: { chain: 84532n, settlement: parseSettlementJSON('{}') } });
    expect(zero.class).toBe('failed');
    expect(zero.text).toContain('finality_included_invalid{');
  });
});

describe('size and time', () => {
  const file = JSON.parse(readSet('settlements', 'base_sepolia_47368146.json').toString('utf8')) as { settlement: Record<string, any> };

  it('a Settlement with a huge proof_nodes array is read in time proportional to its text and then refused by name', () => {
    const o = structuredClone(file.settlement);
    o.tx_inclusion_proof.proof_nodes = Array.from({ length: 200_000 }, () => 'QQ==');
    const t = Date.now();
    const s = parseSettlementJSON(JSON.stringify(o));
    expect(s?.tx?.proofNodes.length).toBe(200_000);
    expect(() => deriveIncluded(ChainBaseSepolia, s)).toThrow(FinalityStateError);
    expect(Date.now() - t).toBeLessThan(30_000);
  });

  it('a 4 MiB leaf_value and a 100,000-element leaf_hash are read without allocating from a declared length (the array is 32 bytes whatever it says)', () => {
    const o = structuredClone(file.settlement);
    o.tx_inclusion_proof.leaf_value = Buffer.alloc(4 * 1024 * 1024, 7).toString('base64');
    expect(parseSettlementJSON(JSON.stringify(o))?.tx?.leafValue.length).toBe(4 * 1024 * 1024);
    o.tx_inclusion_proof.leaf_hash = Array.from({ length: 100_000 }, () => 1);
    expect(parseSettlementJSON(JSON.stringify(o))?.tx?.leafHash.length).toBe(32);
  });

  it('the real valid vector of the largest document (base_final_47604755, 190 KB of evidence) is judged in seconds, not minutes', async () => {
    const c = cases().find((x) => x.id === 'e2e/base_final_47604755/vector_pins')!;
    const reg = await allKindsRegistry();
    const t = Date.now();
    const r = judgeFinalityText(docOf(c), { registry: reg, pins: pinsNamed(c.pins), subject: 'DOC', settlement: legSettlement(c.settlement, BigInt(c.chain)) });
    const ms = Date.now() - t;
    expect(r.exit).toBe(0);
    expect(ms).toBeLessThan(60_000);
  }, 120_000);
});
