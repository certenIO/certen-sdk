/**
 * Unit tests of the non-cryptographic parts of the ethl1 port that the vector set reaches only indirectly: the fault constructors and
 * their canonical form (the twin of fault_test.go), CheckNetwork, the LC codec, the exported container helpers, hash_tree_root, the
 * branch checks, and the conversion of the framework's eth_sepolia pins section.
 */
import { describe, expect, it } from 'vitest';
import {
  AllCodes,
  BeaconBlockHeaderSize,
  LightClientBootstrapSize,
  LightClientFinalityUpdateSize,
  LightClientHeaderSize,
  LightClientUpdateSize,
  Layout,
  SepoliaChainID,
  SyncCommitteeBytes,
  bootstrapInvalid,
  checkNetwork,
  decodeLC,
  decodeLCUnder,
  encodeLC,
  ethl1PinsFrom,
  evidenceMalformed,
  evidenceTooLarge,
  forkAt,
  forkUnsupported,
  hashTreeRootBeaconBlockHeader,
  hashTreeRootSyncCommitteeChecked,
  headerChainBroken,
  isValidNormalizedMerkleBranch,
  l1FinalityUnproven,
  ledgerBehind,
  ledgerHead,
  linkInvalid,
  networkMismatch,
  participationInsufficient,
  periodGap,
  pinMismatch,
  pinUnknown,
  pinWindow,
  blockNotCovered,
  rootFromNormalizedBranch,
  signatureInvalid,
  syncCommitteeSigningRoot,
  validateContainer,
  type LC,
} from '../../../src/proof-v2/finality/ethl1/index.js';
import { embeddedPins, sepoliaPins, type EthSepoliaPins } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError, hexLower } from '../../../src/proof-v2/finality/state.js';
import { loadPins, readSet, hex } from './helpers.js';

const z32 = new Uint8Array(32);
const code = (f: () => unknown): FinalityStateError => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('did not throw');
};

describe('fault field names (spec section 7) and canonical form', () => {
  it('pins the field names of every L1-head code, as the Go fault_test does', () => {
    const cases: [FinalityStateError, string, string, boolean][] = [
      [networkMismatch(1n, 2n), 'finality_network_mismatch', 'chain_id,want_chain_id', false],
      [forkUnsupported(1n, 2n, 'gloas'), 'finality_fork_unsupported', 'epoch,layout,slot', false],
      [evidenceMalformed('p', 1, 'r', 2, 3), 'finality_evidence_malformed', 'got_len,index,part,reason,want_len', false],
      [pinUnknown(1, 2n, z32), 'finality_pin_unknown', 'kind,period,root', false],
      [pinMismatch(1n, z32, z32), 'finality_pin_mismatch', 'got_root,period,want_root', false],
      [pinWindow(1n, 2n, 3n), 'finality_pin_window', 'anchor_epoch,finalized_epoch,wsp_epochs', false],
      [bootstrapInvalid('c', 1n), 'finality_bootstrap_invalid', 'check,slot', false],
      [linkInvalid(0, 'c', 1n, 2n, 3n), 'finality_link_invalid', 'check,index', true],
      [participationInsufficient(0, 1, 342, 512), 'finality_participation_insufficient', 'committee,index,participants,required', false],
      [signatureInvalid(0, 1n, new Uint8Array(4), 2), 'finality_signature_invalid', 'fork_version,index,participants,signature_slot', false],
      [periodGap(1n, 2n), 'finality_period_gap', 'signature_period,store_period', false],
      [blockNotCovered(1n, 2n), 'finality_block_not_covered', 'block_number,finalized_exec_number', false],
      [ledgerBehind(1n, 2n), 'finality_ledger_behind', 'ledger_head_period,needed_period', false],
      [headerChainBroken('l1', 1n, z32, z32, 'hash'), 'finality_header_chain_broken', 'at_number,got_hash,reason,spine,want_hash', false],
      [evidenceTooLarge('p', 1, 2), 'finality_evidence_too_large', 'count,limit,part', false],
      [l1FinalityUnproven('finality_pin_window'), 'l1_finality_unproven', 'reason', false],
    ];
    const seen = new Set<string>();
    for (const [f, c, want, over] of cases) {
      expect(f.code).toBe(c);
      const have = Object.keys(f.fields).sort();
      if (over) for (const w of want.split(',')) expect(have, `${c} ${w}`).toContain(w);
      else expect(have.join(','), c).toBe(want);
      seen.add(c);
    }
    for (const c of AllCodes) expect(seen.has(c), `code ${c} has no field-name pin`).toBe(true);
    expect(AllCodes.length).toBe(16);
    expect(new Set(AllCodes).size).toBe(16);
  });

  it('renders integers of any width as decimal strings and byte strings as 0x-hex, keys sorted', () => {
    const f = pinWindow(2n ** 64n - 1n, 7n, 0n);
    expect(f.canonical()).toBe('{"code":"finality_pin_window","fields":{"anchor_epoch":"18446744073709551615","finalized_epoch":"7","wsp_epochs":"0"}}');
    expect(signatureInvalid(1, 11394241n, Uint8Array.of(0x90, 0, 0, 0x76), 342).canonical()).toBe(
      '{"code":"finality_signature_invalid","fields":{"fork_version":"0x90000076","index":"1","participants":"342","signature_slot":"11394241"}}',
    );
    expect(evidenceMalformed('anchor_body', 0, 'length', 5, 24624).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"5","index":"0","part":"anchor_body","reason":"length","want_len":"24624"}}',
    );
    // Go: CheckNetwork(p, chainID) reports chain_id = the chain judged and want_chain_id = the pins' chain
    expect(networkMismatch(11155111n, 1n).canonical()).toBe('{"code":"finality_network_mismatch","fields":{"chain_id":"11155111","want_chain_id":"1"}}');
  });
});

describe('checkNetwork', () => {
  it('accepts the Sepolia pins and refuses another chain id with the judged chain first', () => {
    const p = loadPins('pins/main.json');
    expect(() => checkNetwork(p, SepoliaChainID)).not.toThrow();
    const e = code(() => checkNetwork(p, 1n));
    expect(e.code).toBe('finality_network_mismatch');
    expect(e.canonical()).toBe('{"code":"finality_network_mismatch","fields":{"chain_id":"1","want_chain_id":"11155111"}}');
  });
});

const sample = (): LC => ({
  profile: 'eth-lc/1',
  anchorKind: 2,
  anchorPeriod: 1378n,
  anchorRoot: new Uint8Array(32).fill(9),
  anchorBody: { layout: Layout.Electra, ssz: Uint8Array.of(1, 2, 3) },
  links: [
    { layout: Layout.Gloas, ssz: new Uint8Array(0) },
    { layout: Layout.Electra, ssz: Uint8Array.of(7) },
  ],
  finalUpdate: { layout: Layout.Gloas, ssz: Uint8Array.of(4, 5) },
});

describe('the LC codec', () => {
  it('round-trips and decodes the exact fields', () => {
    const lc = sample();
    const raw = encodeLC(lc);
    const back = decodeLC(raw, 64);
    expect(back.profile).toBe('eth-lc/1');
    expect(back.anchorKind).toBe(2);
    expect(back.anchorPeriod).toBe(1378n);
    expect(hexLower(back.anchorRoot)).toBe('09'.repeat(32));
    expect(back.anchorBody.layout).toBe(Layout.Electra);
    expect(Array.from(back.anchorBody.ssz)).toEqual([1, 2, 3]);
    expect(back.links.map((l) => [l.layout, Array.from(l.ssz)])).toEqual([[2, []], [1, [7]]]);
    expect(back.finalUpdate.layout).toBe(Layout.Gloas);
    expect(Array.from(back.finalUpdate.ssz)).toEqual([4, 5]);
    expect(Buffer.from(encodeLC(back))).toEqual(Buffer.from(raw));
    // the exact byte layout: u32be 8, "eth-lc/1", u8 kind, u64be period, 32 root, u8 layout, u32be 3, ...
    expect(hexLower(raw.subarray(0, 4 + 8 + 1 + 8))).toBe('00000008' + '6574682d6c632f31' + '02' + '0000000000000562');
  });

  it('refuses trailing bytes, every truncation, and bounds the link count before reading any link', () => {
    const raw = encodeLC(sample());
    expect(code(() => decodeLC(Uint8Array.of(...raw, 0), 64)).canonical()).toBe(
      `{"code":"finality_evidence_malformed","fields":{"got_len":"${raw.length + 1}","index":"0","part":"lc","reason":"trailing_bytes","want_len":"${raw.length}"}}`,
    );
    for (let cut = 0; cut < raw.length; cut++) {
      const e = code(() => decodeLC(raw.subarray(0, cut), 64));
      expect(e.code, `cut ${cut}`).toBe('finality_evidence_malformed');
      expect(e.fields.reason, `cut ${cut}`).toBe('truncated');
    }
    // a huge link count is refused as too large without allocating
    const huge = Uint8Array.from(raw);
    const countAt = 4 + 8 + 1 + 8 + 32 + 1 + 4 + 3;
    new DataView(huge.buffer).setUint32(countAt, 0xffffffff, false);
    expect(code(() => decodeLC(huge, 64)).canonical()).toBe('{"code":"finality_evidence_too_large","fields":{"count":"4294967295","limit":"64","part":"links"}}');
    // exactly the bound is accepted, one over is refused
    expect(decodeLC(raw, 2).links.length).toBe(2);
    expect(code(() => decodeLC(raw, 1)).fields).toEqual({ part: 'links', count: 2, limit: 1 });
    // the pins carry the bound
    const p = loadPins('pins/max_links_1.json');
    expect(code(() => decodeLCUnder(p, raw)).code).toBe('finality_evidence_too_large');
    expect(decodeLCUnder(loadPins('pins/main.json'), raw).links.length).toBe(2);
  });

  it('needs 41 bytes for the anchor fields: kind, period and the 32-byte root', () => {
    const raw = encodeLC(sample());
    const cut = 4 + 8 + 40;
    expect(code(() => decodeLC(raw.subarray(0, cut), 64)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"40","index":"0","part":"anchor","reason":"truncated","want_len":"41"}}',
    );
    expect(code(() => decodeLC(raw.subarray(0, cut + 1), 64)).fields.part).toBe('anchor_body');
  });

  it('names the part that is truncated and keeps a non-UTF-8 profile byte-faithful', () => {
    const lc = sample();
    lc.profile = '\xff\xfe';
    const raw = encodeLC(lc);
    expect(raw.subarray(0, 6)).toEqual(Uint8Array.of(0, 0, 0, 2, 0xff, 0xfe));
    const back = decodeLC(raw, 64);
    expect(back.profile.length).toBe(2);
    expect(Buffer.from(encodeLC(back))).toEqual(Buffer.from(raw));
    const parts = new Map<number, string>();
    for (let cut = 0; cut < raw.length; cut++) {
      try {
        decodeLC(raw.subarray(0, cut), 64);
      } catch (e) {
        parts.set(cut, String((e as FinalityStateError).fields.part));
      }
    }
    expect([...new Set(parts.values())].sort()).toEqual(['anchor', 'anchor_body', 'final_update', 'link', 'links', 'profile']);
  });
});

describe('container helpers', () => {
  it('knows the six Gloas fixed sizes and refuses anything else', () => {
    expect([BeaconBlockHeaderSize, LightClientHeaderSize, SyncCommitteeBytes, LightClientBootstrapSize, LightClientUpdateSize, LightClientFinalityUpdateSize]).toEqual([
      112, 496, 24624, 25472, 26424, 1448,
    ]);
    const sizes: Record<string, number> = {
      BeaconBlockHeader: 112,
      LightClientHeader: 496,
      SyncCommittee: 24624,
      LightClientBootstrap: 25472,
      LightClientUpdate: 26424,
      LightClientFinalityUpdate: 1448,
    };
    for (const [k, n] of Object.entries(sizes)) {
      expect(() => validateContainer(k, new Uint8Array(n))).not.toThrow();
      expect(code(() => validateContainer(k, new Uint8Array(n + 1))).canonical()).toBe(
        `{"code":"finality_evidence_malformed","fields":{"got_len":"${n + 1}","index":"0","part":"${k}","reason":"length","want_len":"${n}"}}`,
      );
      expect(code(() => validateContainer(k, new Uint8Array(n - 1))).fields.reason).toBe('length');
    }
    for (const k of ['Nope', 'constructor', 'toString', '__proto__', '']) {
      expect(code(() => validateContainer(k, new Uint8Array(112))).canonical()).toBe(
        '{"code":"finality_evidence_malformed","fields":{"got_len":"0","index":"0","part":"container","reason":"unknown_kind","want_len":"0"}}',
      );
    }
    expect(code(() => hashTreeRootSyncCommitteeChecked(new Uint8Array(24623))).fields.part).toBe('sync_committee');
    expect(code(() => hashTreeRootBeaconBlockHeader(new Uint8Array(111))).fields.part).toBe('beacon_block_header');
  });

  it('computes the roots the ledger pins (period 1378 committee, its checkpoint block header)', () => {
    const boot = readSet('raw/bootstrap_fulu.ssz');
    // electra bootstrap: offset(4) || committee || branch(6) || header
    const committee = boot.subarray(4, 4 + SyncCommitteeBytes);
    expect(hexLower(hashTreeRootSyncCommitteeChecked(committee))).toBe('cabeda493c59d9927d0d771f833c37015c1e1e0e1b66336601c1b04981ecbcdc');
    const header = boot.subarray(24820, 24820 + BeaconBlockHeaderSize);
    expect(hexLower(hashTreeRootBeaconBlockHeader(header))).toBe('5f71d7f650f9252b48749b5f062c0c234e01afd69f364ab600e2b6051494b20d');
  });

  it('folds and checks normalized branches: zero extension allowed, wrong depth and non-zero extension refused', () => {
    const leaf = new Uint8Array(32).fill(1);
    const br = [3, 4, 5, 6].map((b) => new Uint8Array(32).fill(b));
    // gindex 25 = 0b11001, depth 4, index 9
    const root = rootFromNormalizedBranch(leaf, br, 25n);
    expect(isValidNormalizedMerkleBranch(leaf, br, 25n, root)).toBe(true);
    expect(isValidNormalizedMerkleBranch(leaf, br, 24n, root)).toBe(false);
    const ext = [new Uint8Array(32), ...br];
    expect(isValidNormalizedMerkleBranch(leaf, ext, 25n, root)).toBe(true);
    expect(hexLower(rootFromNormalizedBranch(leaf, ext, 25n))).toBe(hexLower(root));
    const bad = [new Uint8Array(32).fill(2), ...br];
    expect(isValidNormalizedMerkleBranch(leaf, bad, 25n, root)).toBe(false);
    expect(isValidNormalizedMerkleBranch(leaf, br.slice(1), 25n, root)).toBe(false);
    const tweaked = Uint8Array.from(root);
    tweaked[31]! ^= 1;
    expect(isValidNormalizedMerkleBranch(leaf, br, 25n, tweaked)).toBe(false);
  });

  it('derives the sync-committee signing root from a 112-byte header, version and genesis root', () => {
    const hdr = new Uint8Array(112);
    const r1 = syncCommitteeSigningRoot(hdr, Uint8Array.of(0x90, 0, 0, 0x76), hex('0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078'));
    const r2 = syncCommitteeSigningRoot(hdr, Uint8Array.of(0x90, 0, 0, 0x75), hex('0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078'));
    expect(r1.length).toBe(32);
    expect(hexLower(r1)).not.toBe(hexLower(r2));
    expect(code(() => syncCommitteeSigningRoot(new Uint8Array(111), new Uint8Array(4), z32)).fields.part).toBe('beacon_block_header');
  });
});

describe('the fork schedule and the ledger', () => {
  it('selects the last fork at or before the epoch, and none before the first', () => {
    const p = loadPins('pins/main.json');
    const at = (e: bigint) => forkAt(p.network, e)?.name;
    expect(at(0n)).toBe('genesis');
    expect(at(49n)).toBe('genesis');
    expect(at(50n)).toBe('altair');
    expect(at(222463n)).toBe('deneb');
    expect(at(222464n)).toBe('electra');
    expect(at(272639n)).toBe('electra');
    expect(at(272640n)).toBe('fulu');
    expect(at(353023n)).toBe('fulu');
    expect(at(353024n)).toBe('gloas');
    expect(at(2n ** 64n - 1n)).toBe('gloas');
    expect(forkAt({ chainId: 1n, genesisValidatorsRoot: z32, forks: [] }, 5n)).toBeUndefined();
    expect(forkAt({ chainId: 1n, genesisValidatorsRoot: z32, forks: [{ name: 'x', epoch: 10n, version: new Uint8Array(4), layout: 0 }] }, 9n)).toBeUndefined();
    expect(ledgerHead(p)).toBe(1390n);
    expect(ledgerHead({ ...p, anchors: [] })).toBeUndefined();
  });
});

describe('the framework eth_sepolia pins section', () => {
  it('converts the embedded section: the vector fork table, bounds and chain', () => {
    const e = sepoliaPins(embeddedPins());
    const got = ethl1PinsFrom(e);
    const want = loadPins('pins/main.json');
    expect(got.network.chainId).toBe(want.network.chainId);
    expect(hexLower(got.network.genesisValidatorsRoot)).toBe(hexLower(want.network.genesisValidatorsRoot));
    expect(got.network.forks.map((f) => [f.name, f.epoch, hexLower(f.version), f.layout])).toEqual(
      want.network.forks.map((f) => [f.name, f.epoch, hexLower(f.version), f.layout]),
    );
    expect([got.minParticipants, got.maxLinks, got.maxSpineHeaders]).toEqual([342, 64, 16384]);
    expect(got.anchors).toEqual([]);
    expect(() => checkNetwork(got, SepoliaChainID)).not.toThrow();
  });

  it('converts ledger entries: an empty block_root is no block root', () => {
    const e = sepoliaPins(embeddedPins());
    const section: EthSepoliaPins = {
      ...e,
      anchors: [
        { period: 1378n, committeeRoot: `0x${'11'.repeat(32)}`, blockRoot: `0x${'22'.repeat(32)}`, wspEpochs: 279n, linkSha256: '', derivedBy: [] },
        { period: 1379n, committeeRoot: `0x${'33'.repeat(32)}`, blockRoot: '', wspEpochs: 300n, linkSha256: '', derivedBy: [] },
      ],
    };
    const p = ethl1PinsFrom(section);
    expect(p.anchors.length).toBe(2);
    expect(p.anchors[0]!.period).toBe(1378n);
    expect(hexLower(p.anchors[0]!.committeeRoot)).toBe('11'.repeat(32));
    expect(hexLower(p.anchors[0]!.blockRoot!)).toBe('22'.repeat(32));
    expect(p.anchors[0]!.wspEpochs).toBe(279n);
    expect(p.anchors[1]!.blockRoot).toBeNull();
    expect(hexLower(p.anchors[1]!.committeeRoot)).toBe('33'.repeat(32));
    expect(p.anchors[1]!.wspEpochs).toBe(300n);
    // a malformed root is a named pins state, never a silent zero
    const bad: EthSepoliaPins = { ...section, genesisValidatorsRoot: '0x12' };
    expect(code(() => ethl1PinsFrom(bad)).code).toBe('finality_pins_corrupt');
  });
});
