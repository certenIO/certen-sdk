/**
 * Verify a proof v2 Accumulate proof in portable form (certen-validator pkg/proof/v2: portable.go, evidence.go
 * VerifyFromGenesis, page.go, and pkg/proof ValidatorSetProof.Verify). Each step names the Go code it mirrors. Any
 * failure throws VerifyError; there is no weaker answer for the transaction, its certification or its pages. The
 * validator-set check's verdict is reported as is.
 */
import { account, encodeObject, keccak256, networkDefinition, networkGlobals, sameUrl, sequencedMessage, transactionHash } from './accumulate.js';
import { accumulateSetRoot, validatorsOf } from './accset.js';
import { equal, fail, hexBytes, merkleHashList, type Receipt, receiptFromJSON, receiptPrefixTo, receiptValid, sha256, toHex } from './bytes.js';
import { genesisGlobals, Spine } from './spine.js';

export const PORTABLE_FORMAT = 'certen-proof-v2-accumulate-portable/1';
export const VERSION = '2.0';
const INCARNATION_DOMAIN = 'certen:incarnation:v1';
const GENESIS_BLOCK = 1;

export type SetVerdict =
  | 'verified'
  | 'validator_set_asserted'
  | 'validator_set_unbound'
  | 'incarnation_unknown'
  | 'incarnation_unverified'
  | 'foreign_incarnation';

export interface Report {
  incarnation: string;
  majors: number;
  certifiedBlock: number;
  certifiedRoot: string;
  checkBlock: number;
  setVerdict: SetVerdict;
  validators: number;
  threshold: number;
  /** The transaction's partition, and the block of its anchor the transaction's receipt passes through: the
   * transaction executed at or before it, and every page is its state as of it. */
  partition: string;
  anchorBlock: number;
  /** The proven pages, as the SDK rebuilt them from their JSON. */
  pages: unknown[];
  /** Per page, in the same order: whether its chains are proven at anchorBlock. */
  pageChains: PageChain[];
  /** The transaction the receipt starts at; the partition anchor transaction proven into the certified root, and that
   * anchor's state tree anchor (the partition's state root at anchorBlock, which every page is proven into). govRoot
   * v3 commits all three. Hex32. */
  txHash: string;
  anchorTxHash: string;
  anchorStateRoot: string;
  /** The certen:accval:v1 root of the validator set the spine derived, with its threshold, under the pinned
   * incarnation: the value a V8.2 anchor must have committed for the proof to be about this set. Hex32. */
  accumulateSetRoot: string;
}

/** What the verifier established about one page's chains (Go proofv2.PageChain). */
export interface PageChain {
  url: string;
  /** The chain roots are proven at the anchor's block. */
  bound: boolean;
  /** When bound: the main chain's height at the anchor's block; 0 otherwise. */
  mainHeight: number;
  /** When not bound: why (from the capture). */
  note?: string;
}

function u64be(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

/** pkg/proof ComputeIncarnation. */
export function computeIncarnation(g: any, networkRecord: Uint8Array, globalsRecord: Uint8Array): Uint8Array {
  const root = hexBytes(g.rootChainAnchor, 'genesis.rootChainAnchor', 32);
  const state = hexBytes(g.stateTreeAnchor, 'genesis.stateTreeAnchor', 32);
  if (Number(g.minorBlockIndex) !== GENESIS_BLOCK) fail(`incarnation: the genesis anchor is for block ${g.minorBlockIndex}, not the genesis block ${GENESIS_BLOCK}`);
  if (equal(root, new Uint8Array(32)) || equal(state, new Uint8Array(32))) fail('incarnation: the genesis root chain anchor and state tree anchor are both required');
  if (!g.timeUnix) fail('incarnation: the genesis time is required');
  if (networkRecord.length === 0 || globalsRecord.length === 0) fail('incarnation: the genesis network definition and globals records are both required');
  return keccak256(
    Buffer.concat([
      Buffer.from(INCARNATION_DOMAIN),
      u64be(g.minorBlockIndex),
      root,
      state,
      u64be(g.timeUnix),
      sha256(networkRecord),
      sha256(globalsRecord),
    ]),
  );
}

export function verifyPortable(doc: any): Report {
  if (!doc || doc.format !== PORTABLE_FORMAT) fail(`portable format ${JSON.stringify(doc?.format)} is not ${PORTABLE_FORMAT}`);
  const ev = doc.evidence;
  if (!ev || ev.version !== VERSION) fail('not a v2 Accumulate proof');
  const pin = hexBytes(doc.pin, 'pin', 32);

  // The trust base: the genesis values, bound to the pin by the incarnation identity.
  const g = doc.genesis ?? fail('no genesis');
  const networkRecord = hexBytes(g.networkRecord, 'genesis.networkRecord');
  const globalsRecord = hexBytes(g.globalsRecord, 'genesis.globalsRecord');
  const id = computeIncarnation(g, networkRecord, globalsRecord);
  if (!equal(id, pin)) fail(`incarnation evidence is for ${toHex(id)}, not the pinned ${toHex(pin)}`);
  const genesis = genesisGlobals(g.network, networkRecord, g.globals, globalsRecord);

  // The spine to the larger of the two starting points, keeping the state at each.
  const majors: unknown[] = Array.isArray(doc.majors) ? doc.majors : [];
  const evMajors = Number(ev.majors);
  const checkMajors = Number(ev.check?.majors);
  const need = Math.max(evMajors, checkMajors);
  if (!need || need > majors.length) fail(`evidence builds on ${need} major blocks; the archive has ${majors.length}`);
  const sp = new Spine(genesis, 1);
  const at = new Map<number, Spine>();
  for (let i = 0; i < need; i++) {
    sp.advance(majors[i], `spine: major ${i + 1}`);
    if (i + 1 === evMajors || i + 1 === checkMajors) at.set(i + 1, sp.clone());
  }

  // S1-S2: the receipt from the transaction to a certified root.
  const cert = at.get(evMajors)!.clone();
  if (!Array.isArray(ev.certify) || ev.certify.length === 0) fail('certify: no minor-root run');
  ev.certify.forEach((r: unknown, i: number) => cert.advanceEpoch(r, `certify run ${i}`));
  const r = receiptFromJSON(ev.receipt, 'receipt');
  const tx = hexBytes(ev.txHash, 'txHash', 32);
  if (!equal(r.start, tx)) fail(`receipt starts at ${toHex(r.start)}, not the transaction ${toHex(tx)}`);
  if (!equal(r.anchor, cert.rootChainAnchor)) fail(`receipt ends at ${toHex(r.anchor)}, not the root ${toHex(cert.rootChainAnchor)} certified at DN ${cert.lastMinorBlock}`);
  if (!receiptValid(r)) fail('receipt does not validate');

  // The partition anchor (page.go anchorBody), proven into the same certified root.
  const msg = sequencedMessage(ev.anchor?.message, 'partition anchor');
  const n = ev.anchor.message as any;
  const body = n.message?.transaction?.body;
  if (n.message?.type !== 'transaction' || !body) fail('partition anchor is not a transaction');
  if (body.type !== 'blockValidatorAnchor') fail(`partition anchor is ${body.type}, not a block validator anchor`);
  if (!sameUrl(n.destination, 'acc://dn.acme') || !sameUrl(n.message.transaction.header?.principal, 'acc://dn.acme/anchors')) {
    fail("partition anchor is not delivered to the Directory's anchor pool");
  }
  const anchorTx = transactionHash(msg.message.transaction);
  const ar = receiptFromJSON(ev.anchor.receipt, 'partition anchor receipt');
  if (!equal(ar.start, anchorTx) || !equal(ar.anchor, cert.rootChainAnchor) || !receiptValid(ar)) {
    fail('partition anchor: its receipt does not prove the anchor transaction into the certified root');
  }
  const anchorRoot = hexBytes(body.rootChainAnchor, 'partition anchor rootChainAnchor', 32);
  if (!receiptPrefixTo(r, anchorRoot)) fail(`the transaction's receipt does not pass through the anchor's root chain anchor ${toHex(anchorRoot)}`);
  if (anchorTx.length !== 32) fail(`partition anchor: its transaction hash is ${anchorTx.length} bytes, not 32`);
  const stateRoot = hexBytes(body.stateTreeAnchor, 'partition anchor stateTreeAnchor', 32);

  // G1(a): each page as of the anchor's block (page.go verifyPage).
  const pages: unknown[] = [];
  const pageChains: PageChain[] = [];
  for (const [i, p] of (Array.isArray(ev.pages) ? ev.pages : []).entries()) {
    const acct = account(p.account, `page ${i}`);
    const state = encodeObject(acct);
    const pr = receiptFromJSON(p.receipt, `page ${i} receipt`);
    if (!equal(pr.start, sha256(state))) fail(`page: ${p.url}: the receipt does not start at the state's hash`);
    if (!equal(pr.anchor, stateRoot)) fail(`page: ${p.url}: the receipt ends at ${toHex(pr.anchor)}, not the block's state root ${toHex(stateRoot)}`);
    if (!receiptValid(pr)) fail(`page: ${p.url}: the receipt does not validate`);
    const url = String((p.account as any).url ?? '');
    if (typeof p.url !== 'string' || !sameUrl(url, p.url)) fail(`page: the proven state is ${url}, not ${p.url}`);
    pages.push(acct);
    pageChains.push(pageChain(p, pr));
  }

  // The validator set: walked to a certified block at or after the certified one, proven there, equal to the set the
  // walk derived, with every write accounted for. The set is checked either at the certified block itself (no runs:
  // the check reuses the certification) or at a later certified block reached by its own runs.
  const hops: unknown[] = Array.isArray(ev.check.hops) ? ev.check.hops : [];
  let chk: Spine;
  if (hops.length === 0) {
    if (checkMajors !== evMajors) {
      fail(`set check has no minor-root run of its own but builds on ${ev.check.majors} major blocks, not the certification's ${ev.majors}`);
    }
    chk = cert.clone();
  } else {
    chk = at.get(checkMajors)!.clone();
  }
  hops.forEach((h: unknown, i: number) => chk.advanceEpoch(h, `set check hop ${i}`));
  if (chk.lastMinorBlock < cert.lastMinorBlock) {
    fail(`the set is checked at DN ${chk.lastMinorBlock}, before the certified DN ${cert.lastMinorBlock}: updates between are unaccounted`);
  }
  const net = provenAccount(ev.check.network, 'network');
  const glob = provenAccount(ev.check.globals, 'globals');
  const verdict = setVerdict(ev.check, net, glob, chk.stateTreeAnchor, pin);

  // The proven accounts must hold exactly what the walk derived: with no write applied, the genesis records.
  if (!equal(net.entry, genesis.networkRecord)) fail('set check: network: the proven record differs from the one the walk derived');
  if (!equal(glob.entry, genesis.globalsRecord)) fail('set check: globals: the proven record differs from the one the walk derived');
  const height = net.mainHeight;
  if (height === undefined) fail('set check: no main chain on the network account');
  const applied = chk.applied.filter((a) => sameUrl(a.principal, 'acc://dn.acme/network')).length;
  if (height !== 1 + applied) fail(`set check: the network account's main chain has ${height} entries but the walk applied ${applied} updates after genesis`);
  const thr = glob.record.validatorAcceptThreshold;
  const setRoot = accumulateSetRoot(validatorsOf(net.record), { numerator: thr.numerator, denominator: thr.denominator }, toHex(pin));

  return {
    incarnation: toHex(id),
    majors: need,
    certifiedBlock: cert.lastMinorBlock,
    certifiedRoot: toHex(cert.rootChainAnchor),
    checkBlock: chk.lastMinorBlock,
    setVerdict: verdict,
    validators: chk.validators().length,
    threshold: chk.directoryThreshold(),
    partition: String(n.source),
    anchorBlock: Number(body.minorBlockIndex),
    pages,
    pageChains,
    txHash: toHex(tx),
    anchorTxHash: toHex(anchorTx),
    anchorStateRoot: toHex(stateRoot),
    accumulateSetRoot: setRoot,
  };
}

interface Proven {
  root: Uint8Array; // the BPT root the account is proven into
  entry: Uint8Array; // the data account's single entry
  record: any; // that entry, decoded (JSON)
  mainHeight?: number;
}

/** AccountStateProof.verify, with the account and its record rebuilt from JSON and re-encoded. */
function provenAccount(pa: any, label: string): Proven {
  if (!pa) fail(`set check ${label}: missing`);
  const acct = account(pa.account, `set check ${label}`);
  const state = encodeObject(acct);
  const n = pa.account as any;
  if (n.type !== 'dataAccount' || !n.entry || !Array.isArray(n.entry.data) || n.entry.data.length !== 1) {
    fail(`set check ${label}: ${pa.accountUrl} is not a one-entry data account`);
  }
  const entry = hexBytes(n.entry.data[0], `set check ${label} entry`);
  const rec = label === 'network' ? networkDefinition(pa.record) : networkGlobals(pa.record);
  if (!equal(encodeObject(rec), entry)) fail(`set check ${label}: ${pa.accountUrl}: record: the JSON does not re-encode to the record's bytes`);

  // 11. the state hashes to the leaf being proven; 12. the path validates.
  const r = receiptFromJSON(pa.stateReceipt, `set check ${label} stateReceipt`);
  if (!equal(sha256(state), r.start)) fail(`validatorSetProof.${label}: accountState does not hash to the proven leaf`);
  if (!receiptValid(r)) fail(`validatorSetProof.${label}: state receipt does not recompute`);

  // 13. the chain history is bound.
  const mainHeight = chainBinding(r, pa.chains, pa.secondaryHash, pa.pendingHash, `validatorSetProof.${label}`);
  return { root: r.anchor, entry, record: pa.record, mainHeight };
}

/**
 * AccountStateProof.verifyChainBinding: the state hasher is [main, secondaryState, chains, pending], so the receipt's
 * first sibling is the secondary component and its second H(merkle(chain anchors) || pending). Returns the height of
 * the chain named main, when there is one.
 */
function chainBinding(r: Receipt, chains: unknown, secondaryHash: unknown, pendingHash: unknown, label: string): number | undefined {
  if (r.entries.length < 2) fail(`${label}: state receipt has ${r.entries.length} steps; the state hasher needs at least 2`);
  if (!secondaryHash || !pendingHash) {
    fail(`${label}: secondaryHash and pendingHash are required: the receipt's second step is H(chains || pending), so the chain roots alone cannot be checked`);
  }
  const sec = hexBytes(secondaryHash, `${label}.secondaryHash`, 32);
  if (!equal(r.entries[0].hash, sec)) fail(`${label}: secondaryHash is not the receipt's first sibling`);
  let mainHeight: number | undefined;
  const leaves: Uint8Array[] = [];
  for (const [i, c] of (Array.isArray(chains) ? chains : []).entries()) {
    const { count, anchor } = chainRoot(c, `${label}.chains[${i}]`);
    if (c.name === 'main' && mainHeight === undefined) mainHeight = count;
    leaves.push(count === 0 ? new Uint8Array(32) : anchor);
  }
  const pend = hexBytes(pendingHash, `${label}.pendingHash`, 32);
  if (!equal(sha256(merkleHashList(leaves), pend), r.entries[1].hash)) {
    fail(`${label}: H(chains||pending) is not the receipt's second sibling - the chain heights are NOT bound`);
  }
  return mainHeight;
}

/**
 * page.go verifyPage, the chains: a page captured with its chain roots must bind them to its receipt, which proves
 * them the roots at the anchor's block (proof.VerifyChainBinding, the secondary component taken from the receipt
 * itself); a page captured without them is named unbound, with the capture's reason.
 */
function pageChain(p: any, r: Receipt): PageChain {
  const url = String(p.url);
  if (!Array.isArray(p.chains) || p.chains.length === 0) {
    const note = typeof p.chainError === 'string' && p.chainError !== '' ? p.chainError : 'g1_chain_uncaptured';
    return { url, bound: false, mainHeight: 0, note };
  }
  if (r.entries.length < 2) fail(`page: ${url}: chains: state receipt has ${r.entries.length} steps; the state hasher needs at least 2`);
  const h = chainBinding(r, p.chains, toHex(r.entries[0].hash), p.pendingHash, `page: ${url}: chains`);
  if (h === undefined) fail(`page: ${url}: no main chain among the bound chains`);
  return { url, bound: true, mainHeight: h };
}

/** ChainRoot.derive: count and anchor from Pending alone; the restated values must agree. */
function chainRoot(c: any, label: string): { count: number; anchor: Uint8Array } {
  let count = 0;
  let anchor: Uint8Array | undefined;
  for (const [i, v] of (Array.isArray(c?.pending) ? c.pending : []).entries()) {
    if (v === null || v === undefined) continue;
    count += 2 ** i;
    const h = hexBytes(v, `${label}.pending[${i}]`, 32);
    anchor = anchor === undefined ? h : sha256(h, anchor);
  }
  const a = anchor ?? new Uint8Array(32);
  if (count !== Number(c?.count ?? 0)) fail(`chain ${c?.name}: restated count ${c?.count} but its merkle state says ${count} - the height is not what the proof claims`);
  const restated = String(c?.anchor ?? '').toLowerCase().replace(/^0x/, '');
  if (restated !== '' && count > 0 && restated !== toHex(a)) fail(`chain ${c?.name}: restated anchor does not match its merkle state`);
  return { count, anchor: a };
}

/** ValidatorSetProof.Verify steps 11-17, with the asserted set being the derived one (as proofv2.Verify passes it). */
function setVerdict(check: any, net: Proven, glob: Proven, bound: Uint8Array, pin: Uint8Array): SetVerdict {
  if (!equal(net.root, glob.root)) fail('validatorSetProof: the two accounts are proven into different BPT roots');
  // 14. the set and threshold decode (decodeValidators, decodeAcceptThreshold).
  const vs = net.record.validators;
  if (!Array.isArray(vs) || vs.length === 0) fail('network account: NetworkDefinition carries no validators');
  vs.forEach((v: any, i: number) => {
    if (hexBytes(v.publicKey, `validator ${i} publicKey`).length !== 32) fail(`network account: validator ${i} has a non-32-byte public key`);
  });
  const t = glob.record.validatorAcceptThreshold ?? {};
  const num = Number(t.numerator ?? 0);
  const den = Number(t.denominator ?? 0);
  if (den === 0) fail('globals account: zero validatorAcceptThreshold denominator');
  if (num === 0) fail('globals account: zero validatorAcceptThreshold numerator would admit an unsigned anchor');
  if (num > den) fail(`globals account: validatorAcceptThreshold numerator ${num} exceeds denominator ${den}`);
  // 15. the root is bound to the certified anchor.
  if (!equal(net.root, bound)) fail('validatorSetProof: the BPT root the set was proven into is not the one the quorum signed');
  // 16. base case: a set that changed after genesis is asserted, not derived, here.
  if (net.mainHeight === undefined) fail("validatorSetProof: no main chain in the network account's chain set");
  if (net.mainHeight !== 1) return 'validator_set_asserted';
  // 17. the incarnation.
  if (!check.incarnation) return 'incarnation_unknown';
  if (!equal(hexBytes(check.incarnation, 'incarnation', 32), pin)) return 'foreign_incarnation';
  return 'verified';
}
