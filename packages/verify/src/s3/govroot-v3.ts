/**
 * govRoot v3 over a report of the types of this directory (validator pkg/intentcert govroot_v3.go: GovRootV3FromHashes, PagesRootV3): the root a
 * certificate of evidence 2.0 commits. ProofV2Root commits a 2.0 document by it and a 2.1 document by govRoot v4 (govroot-v4.ts); the slots
 * and the pages root are the 2.0 verifier's (src/proof-v2/govroot-v3.ts), here over the report and evidence this directory's decoder produces.
 */
import { equal, fail, merkleHashList, sha256, toHex } from '../proof-v2/bytes.js';
import { canonicalAccSpelling, computeGovRootV3, G1_HISTORICAL_UNAVAILABLE, GOVROOT_V3_TAGS, govRootV3SlotHash, hashUrlString, type GovRootV3, type GovRootV3Slots } from '../proof-v2/govroot-v3.js';
import { encodeNode } from '../sigtypes/wire.js';
import { goStringCompare } from './acc.js';
import { goHex, goHexError } from './gojson.js';
import type { GovRootReport, GovRootV4Inputs, PageCounts, PagesRootPage } from './govroot-v4.js';
import { accountUrl } from './model.js';

const canon = canonicalAccSpelling;
const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));
const cat = (...p: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(p));
const zero32 = new Uint8Array(32);

function u64be(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

function strictHex32(s: unknown): Uint8Array | undefined {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s) ? new Uint8Array(Buffer.from(s, 'hex')) : undefined;
}

/** PagesRootV3: the proven pages sorted by canonical URL, each record sha256(canonicalURL) ‖ sha256(state) ‖ bound ‖ uint64(mainHeight). */
function pagesRootV3(pages: PagesRootPage[], counts: PageCounts): Uint8Array {
  if (pages.length === 0) fail(`govRoot v3: ${G1_HISTORICAL_UNAVAILABLE}: no pages were captured as of the transaction's block`);
  if (counts.chains !== pages.length || counts.evidence !== pages.length) {
    fail(`govRoot v3: the report proves ${pages.length} pages with ${counts.chains} chain results, the evidence carries ${counts.evidence}`);
  }
  const recs = pages.map((pg, i) => {
    const u = canon(accountUrl(pg.account).toString());
    if (canon(pg.chain.url) !== u || canon(pg.evidence.url) !== u) {
      fail(`govRoot v3: page ${i} is ${u} in the report, but its chains are ${pg.chain.url} and its evidence ${pg.evidence.url}`);
    }
    const state = goHex(pg.evidence.state);
    if (!state) fail(`govRoot v3: ${u}: state: ${goHexError(pg.evidence.state)}`);
    if (!equal(state, encodeNode(pg.account))) fail(`govRoot v3: ${u}: the evidence's state is not the account the report proved`);
    const bound = pg.chain.bound ? 1 : 0;
    const height = pg.chain.bound ? pg.chain.mainHeight : 0;
    return { url: u, leaf: sha256(cat(sha256(utf8(u)), sha256(state), Uint8Array.of(bound), u64be(height))) };
  });
  recs.sort((a, b) => goStringCompare(a.url, b.url));
  for (let i = 1; i < recs.length; i++) {
    if (recs[i]!.url === recs[i - 1]!.url) fail(`govRoot v3: page ${recs[i]!.url} is captured twice`);
  }
  return merkleHashList(recs.map((r) => r.leaf));
}

/** GovRootV3FromHashes (after GovRootV3FromPortable's reading of the four hashes): every slot built from the verified report. */
export function govRootV3FromHashes(rep: GovRootReport, pages: PagesRootPage[], counts: PageCounts, inputs: GovRootV4Inputs): GovRootV3 {
  const h: Record<string, Uint8Array> = {};
  for (const name of ['g0Hash', 'g1Hash', 'g2Hash', 'operationId'] as const) {
    const b = strictHex32(inputs[name]);
    if (!b) fail(`govRoot v3: govRootV3Inputs.${name} is not 32 bytes of hex`);
    h[name] = b;
  }
  const need: [string, Uint8Array | undefined][] = [
    ['transaction hash', strictHex32(rep.txHash)],
    ['partition anchor transaction hash', strictHex32(rep.anchorTxHash)],
    ['partition state tree anchor', strictHex32(rep.anchorStateRoot)],
    ['certified root chain anchor', strictHex32(rep.certifiedRoot)],
    ['accumulate set root', strictHex32(rep.accumulateSetRoot)],
    ['incarnation', strictHex32(rep.incarnation)],
    ['G0 hash', h.g0Hash],
    ['G1 hash', h.g1Hash],
    ['G2 hash', h.g2Hash],
  ];
  for (const [name, v] of need) if (!v || equal(v, zero32)) fail(`govRoot v3: the ${name} is required`);
  if (rep.anchorBlock === 0 || rep.certifiedBlock === 0) fail('govRoot v3: the report names no anchor block or certified block');
  if (rep.setVerdict !== 'verified') fail(`govRoot v3: the validator set check is ${rep.setVerdict}, not verified`);
  const pagesRoot = pagesRootV3(pages, counts);
  const tx = strictHex32(rep.txHash)!;
  const anchorTx = strictHex32(rep.anchorTxHash)!;
  const stateRoot = strictHex32(rep.anchorStateRoot)!;
  const certRoot = strictHex32(rep.certifiedRoot)!;
  const setRoot = strictHex32(rep.accumulateSetRoot)!;
  const inc = strictHex32(rep.incarnation)!;
  const g1 = govRootV3SlotHash(GOVROOT_V3_TAGS.g1, cat(h.g1Hash!, pagesRoot));
  const slots: GovRootV3Slots = {
    l1: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l1, cat(tx, anchorTx, u64be(rep.anchorBlock)))),
    l2: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l2, cat(certRoot, u64be(rep.certifiedBlock)))),
    l3: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l3, cat(stateRoot, u64be(rep.anchorBlock)))),
    l4: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.l4, cat(setRoot, inc, u64be(rep.certifiedBlock)))),
    g0: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.g0, cat(h.g0Hash!, tx, certRoot))),
    g1: toHex(g1),
    g2: toHex(govRootV3SlotHash(GOVROOT_V3_TAGS.g2, cat(h.g2Hash!, g1))),
    keyPage: toHex(hashUrlString(canon(String(inputs.keyPageUrl ?? '')))),
    keyBook: toHex(hashUrlString(canon(String(inputs.keyBookUrl ?? '')))),
    operationId: toHex(h.operationId!),
  };
  return { root: computeGovRootV3(slots), pagesRoot: toHex(pagesRoot), slots };
}
