import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  accumulateSetRoot,
  canonicalAccSpelling,
  computeGovRootV3,
  G1_HISTORICAL_UNAVAILABLE,
  govRootV3,
  govRootV3FromPortable,
  govRootV3SlotHash,
  GOVROOT_V3_TAGS,
  pagesRootV3,
  verifyPortable,
  VerifyError,
} from '../src/index.js';
import type { GovRootV3Inputs, GovRootV3Slots, Report } from '../src/index.js';

/**
 * govRoot v3 and the Accumulate set root, pinned to the vectors certen-validator's Go tests pin
 * (pkg/execution/contracts govroot_v3_test.go and v8_2_binding_test.go, pkg/intentcert govroot_v3_test.go), with each
 * of Go's refusals asserted by its meaning.
 */
const dir = new URL('./fixtures/proofv2/', import.meta.url);
const base = gunzipSync(readFileSync(new URL('valid.json.gz', dir))).toString('utf8');

const fill = (b: number) => Buffer.alloc(32, b).toString('hex');
const flip = (h: string) => h.slice(0, 62) + (parseInt(h.slice(62), 16) ^ 1).toString(16).padStart(2, '0');

function refuses(f: () => unknown, want: string): void {
  expect(f).toThrow(VerifyError);
  expect(f).toThrow(want);
}

describe('govRoot v3 slot layout (pkg/execution/contracts)', () => {
  it('reproduces the pinned root over slots 1..10', () => {
    const slots: GovRootV3Slots = {
      l1: fill(1), l2: fill(2), l3: fill(3), l4: fill(4), g0: fill(5), g1: fill(6), g2: fill(7),
      keyPage: fill(8), keyBook: fill(9), operationId: fill(10),
    };
    expect(computeGovRootV3(slots)).toBe('5bad3659b119abbf9207480ace6151817eeac50836d6ea1a7f59d5a8fe124fde');
  });

  it('reproduces each pinned slot vector', () => {
    const u64 = (n: number) => Buffer.from(n.toString(16).padStart(16, '0'), 'hex');
    const b = (n: number) => Buffer.alloc(32, n);
    const hex = (x: Uint8Array) => Buffer.from(x).toString('hex');
    const g1 = govRootV3SlotHash(GOVROOT_V3_TAGS.g1, Buffer.concat([b(14), b(15)]));
    expect(hex(govRootV3SlotHash(GOVROOT_V3_TAGS.l1, Buffer.concat([b(1), b(2), u64(3)])))).toBe('eabce42df409fcf82d56edf56344422f75c19bbd8613efdf2a98083f7cef317e');
    expect(hex(govRootV3SlotHash(GOVROOT_V3_TAGS.l2, Buffer.concat([b(4), u64(5)])))).toBe('41831ea7f130a4898a7e2b4a165a739fc326b70f9fb36557822482bf4f506ed1');
    expect(hex(govRootV3SlotHash(GOVROOT_V3_TAGS.l3, Buffer.concat([b(6), u64(7)])))).toBe('30cb3147c36f01830bc02be9c536a00dd7a696f6506bd331025233042481370b');
    expect(hex(govRootV3SlotHash(GOVROOT_V3_TAGS.l4, Buffer.concat([b(8), b(9), u64(10)])))).toBe('cb553fcec3c6d5e2beb6f1365b6be10be979b57b3215721246ffcb8db43cd882');
    expect(hex(govRootV3SlotHash(GOVROOT_V3_TAGS.g0, Buffer.concat([b(11), b(12), b(13)])))).toBe('d6ddecf4f6b7c655162687b8cef6298a1d4e25ff40171afda5979a7760ed2e75');
    expect(hex(g1)).toBe('c8b774e424148496b33dab887456579f1cdd6faf42f82a9b46216ca4f16b614d');
    expect(hex(govRootV3SlotHash(GOVROOT_V3_TAGS.g2, Buffer.concat([b(16), g1])))).toBe('97fd49d155f3a2e6b36fdc17ec57639a564344ebd20bb801781527bfe805068a');
  });

  it('requires every slot, naming the first missing one in a fixed order', () => {
    const names = ['L1', 'L2', 'L3', 'L4', 'G0', 'G1', 'G2', 'key page', 'key book', 'operation id'];
    const keys: (keyof GovRootV3Slots)[] = ['l1', 'l2', 'l3', 'l4', 'g0', 'g1', 'g2', 'keyPage', 'keyBook', 'operationId'];
    keys.forEach((k, i) => {
      const slots = Object.fromEntries(keys.map((x, j) => [x, fill(j + 1)])) as unknown as GovRootV3Slots;
      slots[k] = fill(0);
      refuses(() => computeGovRootV3(slots), `govRoot v3: the ${names[i]} slot is required`);
    });
    const empty = Object.fromEntries(keys.map((x) => [x, fill(0)])) as unknown as GovRootV3Slots;
    refuses(() => computeGovRootV3(empty), 'the L1 slot');
  });
});

describe('the Accumulate set root, certen:accval:v1 (pkg/execution/contracts)', () => {
  const inc = 'e3f3119213a1ead44647659d67e47f4269a2affb13f150aa87b20baacf93cf81';
  const set = () => [
    { publicKey: 'c'.repeat(64), activeOn: ['BVN3', 'Directory'] },
    { publicKey: 'a'.repeat(64), activeOn: ['Directory', 'BVN1'] },
    { publicKey: 'b'.repeat(64), activeOn: ['BVN2', 'Directory'] },
  ];

  it('reproduces the V8.2 fixed vector, independent of input order, without reordering the input', () => {
    const s = set();
    expect(accumulateSetRoot(s, { numerator: 2, denominator: 3 }, inc)).toBe('0074e2d6a7b1388c113c4f9f3621b3988d4aae715df060b395a181aaafced0f2');
    expect(s[0].publicKey).toBe('c'.repeat(64));
    expect(s[0].activeOn[0]).toBe('BVN3');
    const shuffled = set().reverse().map((v) => ({ ...v, activeOn: [...v.activeOn].reverse() }));
    expect(accumulateSetRoot(shuffled, { numerator: 2, denominator: 3 }, inc)).toBe('0074e2d6a7b1388c113c4f9f3621b3988d4aae715df060b395a181aaafced0f2');
  });

  it('commits the threshold and length-prefixes partitions', () => {
    const r = accumulateSetRoot(set(), { numerator: 2, denominator: 3 }, inc);
    expect(accumulateSetRoot(set(), { numerator: 1, denominator: 2 }, inc)).not.toBe(r);
    const one = (parts: string[]) => accumulateSetRoot([{ publicKey: 'a'.repeat(64), activeOn: parts }], { numerator: 2, denominator: 3 }, inc);
    expect(one(['BVN1', 'BVN2'])).not.toBe(one(['BVN1BVN2']));
  });

  it('refuses each input Go refuses', () => {
    const t = { numerator: 2, denominator: 3 };
    refuses(() => accumulateSetRoot([], t, inc), 'accumulate validator set: empty');
    refuses(() => accumulateSetRoot([{ publicKey: 'ab', activeOn: [] }], t, inc), 'validator 0: public key must be 32 bytes of hex');
    refuses(() => accumulateSetRoot(set(), t, fill(0)), 'incarnation is required');
    refuses(() => accumulateSetRoot(set(), { numerator: 2, denominator: 0 }, inc), 'zero threshold denominator');
    refuses(() => accumulateSetRoot(set(), { numerator: 0, denominator: 3 }, inc), 'zero threshold numerator');
    refuses(() => accumulateSetRoot(set(), { numerator: 4, denominator: 3 }, inc), 'threshold numerator 4 exceeds denominator 3');
    refuses(() => accumulateSetRoot([...set(), set()[0]], t, inc), 'duplicate public key');
    refuses(() => accumulateSetRoot([{ publicKey: 'a'.repeat(64), activeOn: ['BVN1', 'BVN1'] }], t, inc), 'lists partition "BVN1" twice');
  });
});

describe('govRoot v3 of the live Kermit proof (pkg/intentcert)', () => {
  let doc: any;
  let rep: Report;
  let inputs: GovRootV3Inputs;
  const fresh = () => ({ ...rep, pages: [...rep.pages], pageChains: rep.pageChains.map((c) => ({ ...c })) });
  beforeAll(() => {
    doc = JSON.parse(base);
    rep = verifyPortable(doc);
    inputs = doc.govRootV3Inputs;
  });

  it('reproduces the golden slots, pages root and root', () => {
    const g = govRootV3FromPortable(rep, doc);
    expect(g.pagesRoot).toBe('098140cec776ff0e54890ba7e1524fc1a5df4bf67406fbaf700edf78e2f5842d');
    expect(g.slots).toEqual({
      l1: 'f121d4b96688a1c64d61cff382bd887d075eee5be8bf8dd35d1a263667adb02a',
      l2: '1b602cf696b9809f9d9a3a0516fa70115df922495e394e26005909969b5125cb',
      l3: 'b89a9fb22a6b03621c37441ae5576f21bd69544920cfa9543895f4428f0f8c01',
      l4: '219ae1d36a27a5fd21fb9ce15a9614cd72cb268f1c7571be04481f0b25de2730',
      g0: 'b8b04f234b4010ac19bca4e5d536dd020963f86cb76d125398bfe474fd9bd492',
      g1: '158ab6196ec3797b1356af9aa5c24a54a088ce40a2d4d58f187db9c2b0ee2fd4',
      g2: '12a810adc09cc3d31f9b08307c15cc70d5c0475ba00339b026d8592b5dc5961c',
      keyPage: '7c57efb65d2b0b2c0b656d95a1e0d9a37b8235b244188bcaa1ba1aa9c3b4fab1',
      keyBook: '9150443fb53795d49b65b3f1a87332cbb8f7a260deeca6ff21a2fea97280487c',
      operationId: '0700000000000000000000000000000000000000000000000000000000000000',
    });
    expect(g.root).toBe('0477ea2c8f1d2ad8d3a84a5dc3f87f241e57efc97688016f88cb4001521dcee2');
  });

  it('reports the facts govRoot v3 commits', () => {
    expect(rep.txHash).toBe(doc.evidence.txHash);
    expect(rep.anchorTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rep.anchorStateRoot).toBe(doc.evidence.anchor.message.message.transaction.body.stateTreeAnchor);
    expect(rep.accumulateSetRoot).toBe('afa6bd344b04b6ff9645c97b09254af9c25a214991e0b442538e9084d4136bf5');
    // The fixture's pages were captured without their chains: each is named unbound, never assumed bound.
    expect(rep.pageChains.map((c) => [c.url, c.bound, c.mainHeight, c.note])).toEqual(
      doc.evidence.pages.map((p: any) => [p.url, false, 0, 'g1_chain_uncaptured']),
    );
  });

  it('refuses each incomplete input by name, as Go does', () => {
    const cases: [string, () => unknown, string][] = [
      ['no inputs block', () => govRootV3FromPortable(rep, { ...doc, govRootV3Inputs: undefined }), 'carries no govRootV3Inputs'],
      ['no G0', () => govRootV3(rep, doc.evidence.pages, { ...inputs, g0Hash: '' }), 'govRootV3Inputs.g0Hash is not 32 bytes of hex'],
      ['no G1', () => govRootV3(rep, doc.evidence.pages, { ...inputs, g1Hash: 'zz' }), 'govRootV3Inputs.g1Hash is not 32 bytes of hex'],
      ['no G2', () => govRootV3(rep, doc.evidence.pages, { ...inputs, g2Hash: '0x' + inputs.g2Hash }), 'govRootV3Inputs.g2Hash is not 32 bytes of hex'],
      ['zero G0', () => govRootV3(rep, doc.evidence.pages, { ...inputs, g0Hash: fill(0) }), 'the G0 hash is required'],
      ['no report', () => govRootV3(undefined as unknown as Report, doc.evidence.pages, inputs), 'no verified proof v2 report'],
      ['no evidence', () => govRootV3(rep, undefined, inputs), 'needs the verified report and its evidence'],
      ['no key page', () => govRootV3(rep, doc.evidence.pages, { ...inputs, keyPageUrl: '' }), 'the key page slot is required'],
      ['no key book', () => govRootV3(rep, doc.evidence.pages, { ...inputs, keyBookUrl: ' / ' }), 'the key book slot is required'],
      ['no operation id', () => govRootV3(rep, doc.evidence.pages, { ...inputs, operationId: fill(0) }), 'the operation id slot is required'],
      ['no tx hash', () => govRootV3({ ...fresh(), txHash: fill(0) }, doc.evidence.pages, inputs), 'the transaction hash is required'],
      ['no anchor tx hash', () => govRootV3({ ...fresh(), anchorTxHash: fill(0) }, doc.evidence.pages, inputs), 'the partition anchor transaction hash is required'],
      ['no state root', () => govRootV3({ ...fresh(), anchorStateRoot: fill(0) }, doc.evidence.pages, inputs), 'the partition state tree anchor is required'],
      ['no certified root', () => govRootV3({ ...fresh(), certifiedRoot: fill(0) }, doc.evidence.pages, inputs), 'the certified root chain anchor is required'],
      ['no set root', () => govRootV3({ ...fresh(), accumulateSetRoot: fill(0) }, doc.evidence.pages, inputs), 'the accumulate set root is required'],
      ['no incarnation', () => govRootV3({ ...fresh(), incarnation: fill(0) }, doc.evidence.pages, inputs), 'the incarnation is required'],
      ['no anchor block', () => govRootV3({ ...fresh(), anchorBlock: 0 }, doc.evidence.pages, inputs), 'no anchor block'],
      ['set only asserted', () => govRootV3({ ...fresh(), setVerdict: 'validator_set_asserted' }, doc.evidence.pages, inputs), 'validator_set_asserted, not verified'],
      ['no captured pages', () => govRootV3({ ...fresh(), pages: [], pageChains: [] }, [], inputs), G1_HISTORICAL_UNAVAILABLE],
      ['evidence page gone', () => govRootV3(fresh(), doc.evidence.pages.slice(1), inputs), 'the evidence carries 2'],
      ['evidence state differs', () => {
        const pages = structuredClone(doc.evidence.pages);
        pages[0].account.creditBalance = Number(pages[0].account.creditBalance ?? 0) + 1;
        return govRootV3(fresh(), pages, inputs);
      }, 'not the account the report proved'],
      ['evidence page swapped', () => {
        const pages = [...doc.evidence.pages];
        [pages[0], pages[1]] = [pages[1], pages[0]];
        return govRootV3(fresh(), pages, inputs);
      }, 'its evidence'],
      ['page captured twice', () => {
        const r = fresh();
        r.pages[1] = r.pages[0];
        r.pageChains[1] = { ...r.pageChains[0] };
        return govRootV3(r, [doc.evidence.pages[0], doc.evidence.pages[0], doc.evidence.pages[2]], inputs);
      }, 'is captured twice'],
    ];
    for (const [, f, want] of cases) refuses(f, want);
  });

  it('changes with every input', () => {
    const baseRoot = govRootV3FromPortable(rep, doc).root;
    const variants: [string, () => string][] = [
      ['tx hash', () => govRootV3({ ...fresh(), txHash: flip(rep.txHash) }, doc.evidence.pages, inputs).root],
      ['anchor tx hash', () => govRootV3({ ...fresh(), anchorTxHash: flip(rep.anchorTxHash) }, doc.evidence.pages, inputs).root],
      ['anchor block', () => govRootV3({ ...fresh(), anchorBlock: rep.anchorBlock + 1 }, doc.evidence.pages, inputs).root],
      ['state root', () => govRootV3({ ...fresh(), anchorStateRoot: flip(rep.anchorStateRoot) }, doc.evidence.pages, inputs).root],
      ['certified root', () => govRootV3({ ...fresh(), certifiedRoot: flip(rep.certifiedRoot) }, doc.evidence.pages, inputs).root],
      ['certified block', () => govRootV3({ ...fresh(), certifiedBlock: rep.certifiedBlock + 1 }, doc.evidence.pages, inputs).root],
      ['set root', () => govRootV3({ ...fresh(), accumulateSetRoot: flip(rep.accumulateSetRoot) }, doc.evidence.pages, inputs).root],
      ['incarnation', () => govRootV3({ ...fresh(), incarnation: flip(rep.incarnation) }, doc.evidence.pages, inputs).root],
      ['G0', () => govRootV3(rep, doc.evidence.pages, { ...inputs, g0Hash: flip(inputs.g0Hash) }).root],
      ['G1', () => govRootV3(rep, doc.evidence.pages, { ...inputs, g1Hash: flip(inputs.g1Hash) }).root],
      ['G2', () => govRootV3(rep, doc.evidence.pages, { ...inputs, g2Hash: flip(inputs.g2Hash) }).root],
      ['key page', () => govRootV3(rep, doc.evidence.pages, { ...inputs, keyPageUrl: inputs.keyPageUrl + 'x' }).root],
      ['key book', () => govRootV3(rep, doc.evidence.pages, { ...inputs, keyBookUrl: inputs.keyBookUrl + 'x' }).root],
      ['operation id', () => govRootV3(rep, doc.evidence.pages, { ...inputs, operationId: flip(inputs.operationId) }).root],
      ['page bound', () => {
        const r = fresh();
        r.pageChains[0] = { ...r.pageChains[0], bound: true, mainHeight: 0 };
        return govRootV3(r, doc.evidence.pages, inputs).root;
      }],
      ['page bound height', () => {
        const r = fresh();
        r.pageChains[0] = { ...r.pageChains[0], bound: true, mainHeight: 1 };
        return govRootV3(r, doc.evidence.pages, inputs).root;
      }],
      ['page dropped', () => {
        const r = fresh();
        return govRootV3({ ...r, pages: r.pages.slice(1), pageChains: r.pageChains.slice(1) }, doc.evidence.pages.slice(1), inputs).root;
      }],
    ];
    for (const [name, f] of variants) expect(f(), name).not.toBe(baseRoot);
  });

  it('commits the key page and book in canonical spelling', () => {
    const baseRoot = govRootV3FromPortable(rep, doc).root;
    const loud = { ...inputs, keyPageUrl: `  ${inputs.keyPageUrl.toUpperCase()}/ `, keyBookUrl: `${inputs.keyBookUrl.toUpperCase()}/` };
    expect(govRootV3(rep, doc.evidence.pages, loud).root).toBe(baseRoot);
    expect(canonicalAccSpelling('\u0085ACC://X.ACME/\u00a0')).toBe('acc://x.acme');
    // Go's unicode.ToLower maps one code point to one: U+0130 is "i", not "i" with a combining dot.
    expect(canonicalAccSpelling('acc://\u0130.acme')).toBe('acc://i.acme');
    // Go's strings.TrimSpace does not trim U+FEFF.
    expect(canonicalAccSpelling('\ufeffacc://x.acme')).toBe('\ufeffacc://x.acme');
  });

  it('commits the pages in canonical URL order, not capture order', () => {
    const want = govRootV3FromPortable(rep, doc).root;
    for (const perm of [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const r = { ...fresh(), pages: perm.map((j) => rep.pages[j]), pageChains: perm.map((j) => ({ ...rep.pageChains[j] })) };
      expect(govRootV3(r, perm.map((j) => doc.evidence.pages[j]), inputs).root).toBe(want);
    }
  });

  it("names an unbound page in the commitment: its bound byte, and a bound page's height, but never an unbound one's", () => {
    const root = (bound: boolean, mainHeight: number) => {
      const r = fresh();
      r.pageChains[0] = { ...r.pageChains[0], bound, mainHeight };
      return Buffer.from(pagesRootV3(r, doc.evidence.pages)).toString('hex');
    };
    const unbound = Buffer.from(pagesRootV3(rep, doc.evidence.pages)).toString('hex');
    expect(root(false, 0)).toBe(unbound);
    expect(root(true, 0)).not.toBe(unbound);
    expect(root(true, 1)).not.toBe(root(true, 2));
    expect(root(false, 99)).toBe(unbound);
  });
});

describe('proof v2 behaviour govRoot v3 relies on (pkg/proof/v2, cross-checked against the Go verifier)', () => {
  it('checks the set at the certified block itself when the check has no runs of its own', () => {
    const want = verifyPortable(JSON.parse(base));
    const doc = JSON.parse(base);
    doc.evidence.check.hops = [];
    const r = verifyPortable(doc);
    expect([r.checkBlock, r.setVerdict, r.accumulateSetRoot]).toEqual([want.certifiedBlock, 'verified', want.accumulateSetRoot]);
    expect(govRootV3FromPortable(r, doc).root).toBe('0477ea2c8f1d2ad8d3a84a5dc3f87f241e57efc97688016f88cb4001521dcee2');
  });

  it("keeps a page's capture error as its note, outside the commitment", () => {
    const doc = JSON.parse(base);
    doc.evidence.pages[0].chainError = 'g1_chain_unread: test';
    const r = verifyPortable(doc);
    expect(r.pageChains[0]).toEqual({ url: doc.evidence.pages[0].url, bound: false, mainHeight: 0, note: 'g1_chain_unread: test' });
    expect(govRootV3FromPortable(r, doc).root).toBe('0477ea2c8f1d2ad8d3a84a5dc3f87f241e57efc97688016f88cb4001521dcee2');
  });

  it('refuses a page whose captured chains do not bind to its receipt', () => {
    const chains = [{ name: 'main', count: 1, anchor: fill(5), pending: [fill(5)] }];
    const doc = JSON.parse(base);
    Object.assign(doc.evidence.pages[0], { chains, pendingHash: fill(0) });
    refuses(() => verifyPortable(doc), 'the chain heights are NOT bound');
    delete doc.evidence.pages[0].pendingHash;
    refuses(() => verifyPortable(doc), 'secondaryHash and pendingHash are required');
    Object.assign(doc.evidence.pages[0], { chains: [{ ...chains[0], count: 2 }], pendingHash: fill(0) });
    refuses(() => verifyPortable(doc), 'restated count 2');
  });
});
