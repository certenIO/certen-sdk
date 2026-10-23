/**
 * The rolling ledger (twin of pkg/finality/ledger.go; tests ported from ledger_test.go, ledger_fix_test.go and ledger_vectors_test.go):
 * the embedded ledger re-derives from its root pin, the root pin's bootstrap is judged as the kind-2 anchor even when it is the only
 * entry (V-C2-A1 D1), a block_root on an appended entry is refused wherever it stands (D2), and every reason of the closed set is reachable
 * with the period it names.
 */
import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { embeddedLedgerLinks, extendPins, ledgerStep, ledgerStepLC, nonLedgerEqual, verifyLedger } from '../../../src/proof-v2/finality/ledger.js';
import { embeddedPins, embeddedPinsBytes, parsePinsOverride, type AnchorPin, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { EMBEDDED_LINKS_BASE64 } from '../../../src/proof-v2/finality/pins-links-embedded.js';
import { LedgerReason, hexLower } from '../../../src/proof-v2/finality/state.js';
import { ethl1PinsFrom, verifyBootstrapAnchor, Layout } from '../../../src/proof-v2/finality/ethl1/index.js';
import * as lcssz from '../../../src/proof-v2/finality/ethsepolia/lcssz.js';
import { marshalIndent, read, sha256Hex } from './vectorset.js';
import { stateOf } from './recorded.js';

// real verifications of 3 MB objects: a loaded machine must not read a slow decode as a failure
vi.setConfig({ testTimeout: 300_000 });

const bootCommitteeBranchAt = 4 + 24624;
const bootHeaderAt = 4 + 24624 + 6 * 32;
const bootParentRootAt = bootHeaderAt + 16;
const bootExecBranchAt = bootHeaderAt + 112 + 4;

function embeddedPinsAndLinks(): { p: Pins; links: Map<bigint, Uint8Array> } {
  return { p: embeddedPins(), links: embeddedLedgerLinks() };
}

function relink(a: AnchorPin, bootstrap: Uint8Array): void {
  a.linkSha256 = sha256Hex(bootstrap);
}

function wantRefusal(f: () => unknown, period: bigint, reason: string, inner?: string): void {
  const s = stateOf(f);
  expect(s.code).toBe('finality_ledger_extension_invalid');
  expect([s.fields.period, s.fields.reason]).toEqual([period, reason]);
  if (inner !== undefined) expect(s.fields.inner).toBe(inner);
}

const vectorLedger = (): { pins: Pins; links: Map<bigint, Uint8Array> } => {
  const pins = parsePinsOverride(read('eth_sepolia1', 'pins/main.json'));
  const links = new Map<bigint, Uint8Array>();
  for (let p = 1378n; p <= 1391n; p++) links.set(p, Uint8Array.from(read('eth_sepolia1', `raw/links/${p}.ssz`)));
  return { pins, links };
};
const bogusBlockRoot = '0x00000000000000000000000000000000000000000000000000000000000000ab';

describe('the embedded ledger', () => {
  it('holds the root bootstrap only, byte-identical to the fixture, and the root anchor names it', () => {
    const links = embeddedLedgerLinks();
    expect([...links.keys()]).toEqual([1378n]);
    expect(Object.keys(EMBEDDED_LINKS_BASE64)).toEqual(['1378']);
    expect(Buffer.from(links.get(1378n)!).equals(read('eth_sepolia1', 'raw/links/1378.ssz'))).toBe(true);
    expect(sha256Hex(links.get(1378n)!)).toBe('e55bc5ef6ede9cf7b1f09ba302d1723001bd03268672f2dd4875c8c38889c81d');
    const a = embeddedPins().ethSepolia!.anchors;
    expect(a.length).toBe(1);
    expect([a[0]!.period, a[0]!.linkSha256]).toEqual([1378n, sha256Hex(links.get(1378n)!)]);
    expect(a[0]!.blockRoot).not.toBe('');
  });

  it('re-derives from its root pin through the links embedded beside it', () => {
    const { p, links } = embeddedPinsAndLinks();
    expect(() => verifyLedger(p, links)).not.toThrow();
  });

  it('a root bootstrap with one byte changed, or none, is not the root pin', () => {
    const { p, links } = embeddedPinsAndLinks();
    const bad = Uint8Array.from(links.get(1378n)!);
    bad[100]! ^= 1;
    links.set(1378n, bad);
    wantRefusal(() => verifyLedger(p, links), 1378n, LedgerReason.RootPinUnverifiable);
    links.delete(1378n);
    wantRefusal(() => verifyLedger(p, links), 1378n, LedgerReason.RootPinUnverifiable);
  });

  it('an extension that appends nothing and changes nothing extends its base; one that changes anything else does not', () => {
    const p = embeddedPins();
    const raw = embeddedPinsBytes();
    const q = extendPins(p, raw, new Map());
    expect(q.source.startsWith('extension:')).toBe(true);
    expect(q.source).toBe(`extension:${hexLower(sha256(raw))}`);
    const text = new TextDecoder().decode(raw);
    const changed = text.replace('"published_utc": "2', '"published_utc": "3');
    expect(changed).not.toBe(text);
    wantRefusal(() => extendPins(p, new TextEncoder().encode(changed), new Map()), 0n, LedgerReason.NonLedgerContentDiffers);
  });
});

describe('D1: a single-entry ledger judges its bootstrap as the kind-2 anchor', () => {
  const cases: [string, (a: AnchorPin, boot: Uint8Array) => void, string][] = [
    ['bogus_block_root', (a) => (a.blockRoot = a.blockRoot.slice(0, -1) + (a.blockRoot.endsWith('1') ? '0' : '1')), 'finality_pin_mismatch'],
    ['committee_branch_byte_flipped', (a, b) => { b[bootCommitteeBranchAt + 5]! ^= 1; relink(a, b); }, 'finality_bootstrap_invalid'],
    ['header_parent_root_byte_flipped', (a, b) => { b[bootParentRootAt + 3]! ^= 1; relink(a, b); }, 'finality_pin_mismatch'],
    ['header_exec_branch_byte_flipped', (a, b) => { b[bootExecBranchAt + 10]! ^= 1; relink(a, b); }, 'finality_bootstrap_invalid'],
  ];
  for (const [name, tweak, inner] of cases) {
    it(name, () => {
      const { p, links } = embeddedPinsAndLinks();
      const boot = Uint8Array.from(links.get(1378n)!);
      tweak(p.ethSepolia!.anchors[0]!, boot);
      links.set(1378n, boot);
      wantRefusal(() => verifyLedger(p, links), 1378n, LedgerReason.RootPinUnverifiable, inner);
    });
  }
  it('period_of_the_header_is_not_the_entrys', () => {
    const { p, links } = embeddedPinsAndLinks();
    p.ethSepolia!.anchors[0]!.period = 1377n;
    links.set(1377n, links.get(1378n)!);
    links.delete(1378n);
    wantRefusal(() => verifyLedger(p, links), 1377n, LedgerReason.RootPinUnverifiable, 'finality_bootstrap_invalid');
  });
  it('a bootstrap that is not an electra or gloas object is refused with its malformed part, never a thrown RangeError', () => {
    const { p, links } = embeddedPinsAndLinks();
    for (const bad of [new Uint8Array(0), new Uint8Array(24819), new Uint8Array(25471), links.get(1378n)!.subarray(0, 25000)]) {
      const copy = Uint8Array.from(bad);
      p.ethSepolia!.anchors[0]!.linkSha256 = sha256Hex(copy);
      links.set(1378n, copy);
      const s = stateOf(() => verifyLedger(p, links));
      expect([s.code, s.fields.reason], String(bad.length)).toEqual(['finality_ledger_extension_invalid', LedgerReason.RootPinUnverifiable]);
    }
  });
});

describe('the vector ledger (periods 1378..1391)', () => {
  it('re-derives from its root pin and a changed link anywhere breaks the step that uses it, at its period', () => {
    const { pins, links } = vectorLedger();
    expect(() => verifyLedger(pins, links)).not.toThrow();
    const bad = new Map(links);
    const l = Uint8Array.from(links.get(1385n)!);
    l[26340]! ^= 1;
    bad.set(1385n, l);
    const s = stateOf(() => verifyLedger(pins, bad));
    expect([s.code, s.fields.period, s.fields.reason]).toEqual(['finality_ledger_extension_invalid', 1385n, LedgerReason.LinkSha256Mismatch]);
    expect(s.fields.want_sha256).toBeInstanceOf(Uint8Array);
    expect(s.fields.got_sha256).toBeInstanceOf(Uint8Array);
    bad.delete(1385n);
    wantRefusal(() => verifyLedger(pins, bad), 1385n, LedgerReason.LinkMissing);
    // a ledger whose first entry has no block_root is not a root pin
    const noRoot = parsePinsOverride(read('eth_sepolia1', 'extend/base_1386.json'));
    noRoot.ethSepolia!.anchors = noRoot.ethSepolia!.anchors.slice(1);
    wantRefusal(() => verifyLedger(noRoot, links), noRoot.ethSepolia!.anchors[0]!.period, LedgerReason.RootPinUnverifiable);
  });

  it('D2: a block_root on an appended entry is refused wherever it stands', () => {
    for (const period of [1379n, 1385n, 1391n]) {
      const { pins, links } = vectorLedger();
      for (const a of pins.ethSepolia!.anchors) if (a.period === period) a.blockRoot = bogusBlockRoot;
      wantRefusal(() => verifyLedger(pins, links), period, LedgerReason.BlockRootOnAppendedEntry);
    }
  });

  it('a bogus root pin of a long ledger is named at the root pin, not at the first link that uses it', () => {
    const { pins, links } = vectorLedger();
    pins.ethSepolia!.anchors[0]!.blockRoot = bogusBlockRoot;
    wantRefusal(() => verifyLedger(pins, links), 1378n, LedgerReason.RootPinUnverifiable, 'finality_pin_mismatch');
  });

  it('D2: an extension appending a block_root entry is refused, whichever appended entry carries it', () => {
    for (const period of [1387, 1389, 1391]) {
      const base = parsePinsOverride(read('eth_sepolia1', 'extend/base_1386.json'));
      const doc = JSON.parse(read('eth_sepolia1', 'extend/extend_valid.pins.json').toString('utf8'));
      for (const a of doc.eth_sepolia.anchors) if (a.period === period) a.block_root = bogusBlockRoot;
      const raw = new TextEncoder().encode(`${marshalIndent(doc)}\n`);
      const { links } = vectorLedger();
      wantRefusal(() => extendPins(base, raw, links), BigInt(period), LedgerReason.BlockRootOnAppendedEntry);
    }
  });
});

describe('extendPins: the remaining reasons and the states that are not ledger reasons', () => {
  const base = (): Pins => parsePinsOverride(read('eth_sepolia1', 'extend/base_1386.json'));
  const valid = (): any => JSON.parse(read('eth_sepolia1', 'extend/extend_valid.pins.json').toString('utf8'));
  const enc = (doc: unknown): Uint8Array => new TextEncoder().encode(`${marshalIndent(doc)}\n`);
  const { links } = vectorLedger();

  it('a missing base is finality_pin_unknown; a base or extension without the section is not extendable', () => {
    for (const p of [null, undefined, { ...base(), ethSepolia: null } as Pins]) {
      const s = stateOf(() => extendPins(p, enc(valid()), links));
      expect([s.code, s.fields.kind]).toEqual(['finality_pin_unknown', 'eth_sepolia']);
    }
    const noSection = valid();
    delete noSection.eth_sepolia;
    wantRefusal(() => extendPins(base(), enc(noSection), links), 0n, LedgerReason.NonLedgerContentDiffers);
  });

  it('an extension that does not parse is finality_pins_corrupt, not a ledger reason', () => {
    expect(stateOf(() => extendPins(base(), new TextEncoder().encode('{'), links)).code).toBe('finality_pins_corrupt');
    const unsorted = enc(valid());
    expect(stateOf(() => extendPins(base(), unsorted.subarray(0, 10), links)).code).toBe('finality_pins_corrupt');
  });

  it('a base without anchors cannot be extended: predecessor_committee_unavailable at the first appended period', () => {
    const b = base();
    b.ethSepolia!.anchors = [];
    // the file bytes of b still hold its anchors, so the file differs outside nothing: judge the empty-base path through the raw bytes
    const doc = JSON.parse(read('eth_sepolia1', 'extend/base_1386.json').toString('utf8'));
    doc.eth_sepolia.anchors = [];
    const emptyBase = parsePinsOverride(enc(doc));
    const ext = JSON.parse(read('eth_sepolia1', 'extend/base_1386.json').toString('utf8'));
    wantRefusal(() => extendPins(emptyBase, enc(ext), links), BigInt(ext.eth_sepolia.anchors[0].period), LedgerReason.PredecessorCommitteeUnavailable);
  });

  it('the base must be a prefix of the extension, named at the first entry that differs with its index', () => {
    const doc = valid();
    doc.eth_sepolia.anchors[2].wsp_epochs += 1;
    const s = stateOf(() => extendPins(base(), enc(doc), links));
    expect([s.fields.reason, s.fields.index]).toEqual([LedgerReason.BaseNotPrefix, 2n]);
    expect(s.fields.period).toBe(BigInt(doc.eth_sepolia.anchors[2].period));
    const shorter = valid();
    shorter.eth_sepolia.anchors = shorter.eth_sepolia.anchors.slice(0, 3);
    wantRefusal(() => extendPins(base(), enc(shorter), links), 0n, LedgerReason.BaseNotPrefix);
  });

  it('the appended wsp_epochs may equal the base maximum and not exceed it (N passes, N+1 fails)', () => {
    const b = base();
    const max = b.ethSepolia!.anchors.reduce((m, a) => (a.wspEpochs > m ? a.wspEpochs : m), 0n);
    const at = valid();
    at.eth_sepolia.anchors[b.ethSepolia!.anchors.length].wsp_epochs = Number(max);
    // the equal value is not refused for its width (it may still fail later for another reason)
    const over = valid();
    over.eth_sepolia.anchors[b.ethSepolia!.anchors.length].wsp_epochs = Number(max) + 1;
    const first = over.eth_sepolia.anchors[b.ethSepolia!.anchors.length];
    const s = stateOf(() => extendPins(base(), enc(over), links));
    expect([s.fields.reason, s.fields.period, s.fields.wsp_epochs, s.fields.limit]).toEqual([LedgerReason.WspWidened, BigInt(first.period), max + 1n, max]);
    expect(() => extendPins(base(), enc(at), links)).not.toThrow();
  });
});

describe('ledgerStep and ledgerStepLC', () => {
  const { pins, links } = vectorLedger();
  const a = pins.ethSepolia!.anchors;
  const e = pins.ethSepolia!;
  const rootBoot = links.get(1378n)!;
  const body1378 = lcssz.bootstrapCommittee(lcssz.layoutOfBootstrap(rootBoot), rootBoot);

  it('walks one step from the root pin: the learned committee is the next entry\'s, and an error names the period', () => {
    const body = ledgerStep(e, a[0]!, a[1]!, body1378, rootBoot, links.get(1379n));
    expect(body.length).toBe(24624);
    expect(Buffer.from(body).equals(Buffer.from(lcssz.nextCommittee(lcssz.layoutOfUpdate(links.get(1379n)!), links.get(1379n)!)))).toBe(true);
    // the next step starts from the learned committee (a kind-1 predecessor)
    expect(() => ledgerStep(e, a[1]!, a[2]!, body, undefined, links.get(1380n))).not.toThrow();
    wantRefusal(() => ledgerStep(e, a[0]!, a[2]!, body1378, rootBoot, links.get(1380n)), a[2]!.period, LedgerReason.PeriodNotNext);
    const s = stateOf(() => ledgerStep(e, a[0]!, a[2]!, body1378, rootBoot, links.get(1380n)));
    expect(s.fields.predecessor_period).toBe(1378n);
    wantRefusal(() => ledgerStep(e, a[0]!, a[1]!, body1378, rootBoot, undefined), 1379n, LedgerReason.LinkMissing);
    wantRefusal(() => ledgerStep(e, a[0]!, a[1]!, body1378, rootBoot, new Uint8Array(0)), 1379n, LedgerReason.LinkMissing);
  });

  it('a link that is no light-client update is link_refused{inner: finality_evidence_malformed}', () => {
    const junk = new Uint8Array(100);
    const cand = { ...a[1]!, linkSha256: sha256Hex(junk) };
    wantRefusal(() => ledgerStep(e, a[0]!, cand, body1378, rootBoot, junk), 1379n, LedgerReason.LinkRefused, 'finality_evidence_malformed');
  });

  it('a predecessor body that is not a committee is refused by the light-client verifier, with its code as inner', () => {
    const s = stateOf(() => ledgerStep(e, a[1]!, a[2]!, new Uint8Array(24623), undefined, links.get(1380n)));
    expect([s.fields.reason, s.fields.inner]).toEqual([LedgerReason.LinkRefused, 'finality_evidence_malformed']);
  });

  it('a committee_root that the link does not carry is committee_root_mismatch', () => {
    const cand = { ...a[1]!, committeeRoot: a[2]!.committeeRoot };
    wantRefusal(() => ledgerStep(e, a[0]!, cand, body1378, rootBoot, links.get(1379n)), 1379n, LedgerReason.CommitteeRootMismatch);
  });

  it('ledgerStepLC: a kind-2 predecessor carries its bootstrap, a kind-1 one the bare committee, both walk the link then its finality projection', () => {
    const k2 = ledgerStepLC(a[0]!, body1378, rootBoot, links.get(1379n)!);
    expect([k2.profile, k2.anchorKind, k2.anchorPeriod, k2.links.length]).toEqual(['eth-lc/1', 2, 1378n, 1]);
    expect(k2.anchorBody.layout).toBe(Layout.Electra);
    expect(k2.anchorBody.ssz).toBe(rootBoot);
    expect(Buffer.from(k2.anchorRoot).toString('hex')).toBe(a[0]!.blockRoot.slice(2));
    const k1 = ledgerStepLC(a[1]!, body1378, undefined, links.get(1380n)!);
    expect([k1.anchorKind, k1.anchorBody.layout, k1.anchorBody.ssz.length]).toEqual([1, Layout.None, 24624]);
    expect(Buffer.from(k1.anchorRoot).toString('hex')).toBe(a[1]!.committeeRoot.slice(2));
    expect(k1.finalUpdate.ssz.length).toBe(1448);
    expect(k1.finalUpdate.layout).toBe(Layout.Gloas);
    expect(() => ledgerStepLC(a[0]!, body1378, rootBoot, new Uint8Array(10))).toThrow(lcssz.LcsszError);
  });
});

describe('verifyBootstrapAnchor', () => {
  const { p } = embeddedPinsAndLinks();
  const boot = embeddedLedgerLinks().get(1378n)!;
  const l1 = ethl1PinsFrom(p.ethSepolia!);
  const lb = { layout: Layout.Electra, ssz: boot };

  it('accepts the real root bootstrap and nothing else of the walk is run', () => {
    expect(() => verifyBootstrapAnchor(l1, 1378n, lb)).not.toThrow();
  });
  it('an entry without a block_root or without an anchor is finality_pin_unknown{kind 2, period}', () => {
    const noRoot = ethl1PinsFrom(p.ethSepolia!);
    noRoot.anchors[0]!.blockRoot = null;
    for (const [pins, period] of [[noRoot, 1378n], [l1, 1379n]] as const) {
      const s = stateOf(() => verifyBootstrapAnchor(pins, period, lb));
      expect([s.code, s.fields.kind, s.fields.period, s.fields.root]).toEqual(['finality_pin_unknown', 2, period, new Uint8Array(32)]);
    }
  });
  it('another network is finality_network_mismatch before anything else', () => {
    const other = ethl1PinsFrom(p.ethSepolia!);
    other.network.chainId = 1n;
    expect(stateOf(() => verifyBootstrapAnchor(other, 1378n, lb)).code).toBe('finality_network_mismatch');
  });
  it('a layout byte that is zero or unknown is malformed with its reason', () => {
    for (const [layout, reason] of [[0, 'layout_byte_zero'], [3, 'layout_byte_unknown']] as const) {
      const s = stateOf(() => verifyBootstrapAnchor(l1, 1378n, { layout, ssz: boot }));
      expect([s.code, s.fields.part, s.fields.reason]).toEqual(['finality_evidence_malformed', 'anchor_body', reason]);
    }
  });
  it('a bootstrap in the wrong layout is refused and the real one in the gloas layout is not accepted by its size', () => {
    expect(stateOf(() => verifyBootstrapAnchor(l1, 1378n, { layout: Layout.Gloas, ssz: boot })).code).toBe('finality_evidence_malformed');
  });
});

describe('nonLedgerEqual (Go json.Unmarshal into map[string]any, then reflect.DeepEqual without eth_sepolia.anchors)', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  it('ignores exactly eth_sepolia.anchors', () => {
    expect(nonLedgerEqual(enc('{"a":1,"eth_sepolia":{"anchors":[1],"x":2}}'), enc('{"a":1,"eth_sepolia":{"anchors":[],"x":2}}'))).toBe(true);
    expect(nonLedgerEqual(enc('{"a":1,"eth_sepolia":{"anchors":[1],"x":2}}'), enc('{"a":1,"eth_sepolia":{"anchors":[1],"x":3}}'))).toBe(false);
    expect(nonLedgerEqual(enc('{"a":1,"b":{"anchors":[1]}}'), enc('{"a":1,"b":{"anchors":[2]}}'))).toBe(false);
    expect(nonLedgerEqual(enc('{"a":1}'), enc('{"a":1,"c":null}'))).toBe(false);
    expect(nonLedgerEqual(enc('{"a":[1,2]}'), enc('{"a":[2,1]}'))).toBe(false);
    expect(nonLedgerEqual(enc('{"a":[]}'), enc('{"a":{}}'))).toBe(false);
  });
  it('compares numbers as float64 (1 equals 1.0 and 1e0) and refuses a number float64 cannot hold', () => {
    expect(nonLedgerEqual(enc('{"a":1}'), enc('{"a":1.0}'))).toBe(true);
    expect(nonLedgerEqual(enc('{"a":1}'), enc('{"a":1e0}'))).toBe(true);
    expect(nonLedgerEqual(enc('{"a":9007199254740993}'), enc('{"a":9007199254740992}'))).toBe(true); // both round to one double, as Go
    expect(nonLedgerEqual(enc('{"a":1e999}'), enc('{"a":1e999}'))).toBe(false);
    expect(nonLedgerEqual(enc('{"a":1e-999}'), enc('{"a":0}'))).toBe(true);
  });
  it('is false for a document that is not an object or not JSON, and reads a lone surrogate as U+FFFD', () => {
    expect(nonLedgerEqual(enc('[1]'), enc('[1]'))).toBe(false);
    expect(nonLedgerEqual(enc('{'), enc('{}'))).toBe(false);
    expect(nonLedgerEqual(enc('{"a":"\\ud800"}'), enc('{"a":"\\ufffd"}'))).toBe(true);
  });
});
