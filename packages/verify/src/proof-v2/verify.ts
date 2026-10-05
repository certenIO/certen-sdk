/**
 * Verify a proof v2 Accumulate proof in portable form (certen-validator pkg/proof/v2: portable.go, evidence.go
 * VerifyFromGenesis, page.go, and pkg/proof ValidatorSetProof.Verify). Each step names the Go code it mirrors. Any
 * failure throws VerifyError; there is no weaker answer for the transaction, its certification or its pages. The
 * validator-set check's verdict is reported as is.
 */
import { account, encodeObject, keccak256, networkDefinition, networkGlobals, normalize, sameUrl, sequencedMessage, transactionHash } from './accumulate.js';
import { equal, fail, hexBytes, merkleHashList, receiptFromJSON, receiptPrefixTo, receiptValid, sha256, toHex } from './bytes.js';
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
  const n = normalize(ev.anchor.message) as any;
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
  const stateRoot = hexBytes(body.stateTreeAnchor, 'partition anchor stateTreeAnchor', 32);

  // G1(a): each page as of the anchor's block (page.go verifyPage).
  const pages: unknown[] = [];
  for (const [i, p] of (Array.isArray(ev.pages) ? ev.pages : []).entries()) {
    const acct = account(p.account, `page ${i}`);
    const state = encodeObject(acct);
    const pr = receiptFromJSON(p.receipt, `page ${i} receipt`);
    if (!equal(pr.start, sha256(state))) fail(`page: ${p.url}: the receipt does not start at the state's hash`);
    if (!equal(pr.anchor, stateRoot)) fail(`page: ${p.url}: the receipt ends at ${toHex(pr.anchor)}, not the block's state root ${toHex(stateRoot)}`);
    if (!receiptValid(pr)) fail(`page: ${p.url}: the receipt does not validate`);
    const url = String((normalize(p.account) as any).url ?? '');
    if (typeof p.url !== 'string' || !sameUrl(url, p.url)) fail(`page: the proven state is ${url}, not ${p.url}`);
    pages.push(acct);
  }

  // The validator set: walked to a certified block at or after the certified one, proven there, equal to the set the
  // walk derived, with every write accounted for.
  const chk = at.get(checkMajors)!.clone();
  if (!Array.isArray(ev.check.hops) || ev.check.hops.length === 0) fail('set check has no minor-root run');
  ev.check.hops.forEach((h: unknown, i: number) => chk.advanceEpoch(h, `set check hop ${i}`));
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
  const n = normalize(pa.account) as any;
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

  // 13. the chain history is bound: the state hasher is [main, secondaryState, chains, pending].
  if (r.entries.length < 2) fail(`validatorSetProof.${label}: state receipt has ${r.entries.length} steps`);
  const sec = hexBytes(pa.secondaryHash, `${label}.secondaryHash`, 32);
  if (!equal(r.entries[0].hash, sec)) fail(`validatorSetProof.${label}: secondaryHash is not the receipt's first sibling`);
  let mainHeight: number | undefined;
  const leaves: Uint8Array[] = [];
  for (const [i, c] of (Array.isArray(pa.chains) ? pa.chains : []).entries()) {
    const { count, anchor } = chainRoot(c, `${label}.chains[${i}]`);
    if (c.name === 'main') mainHeight = count;
    leaves.push(count === 0 ? new Uint8Array(32) : anchor);
  }
  const pend = hexBytes(pa.pendingHash, `${label}.pendingHash`, 32);
  if (!equal(sha256(merkleHashList(leaves), pend), r.entries[1].hash)) {
    fail(`validatorSetProof.${label}: H(chains||pending) is not the receipt's second sibling - the chain heights are NOT bound`);
  }
  return { root: r.anchor, entry, record: normalize(pa.record), mainHeight };
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
  if (count !== Number(c?.count)) fail(`chain ${c?.name}: restated count ${c?.count} but its merkle state says ${count} - the height is not what the proof claims`);
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
