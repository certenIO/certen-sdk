/**
 * Verifying a portable proof of evidence 2.1 from the incarnation's genesis (validator portable.go VerifyPortable, evidence.go
 * Verify21FromGenesis / verifyFromGenesis / verifyFrom). The shared front half - the incarnation, the spine, the receipt into a certified
 * root, the validator set - is the verifier of evidence 2.0 (proof-v2/verify.ts); what differs for 2.1 is exactly what the Go code
 * differs in: the anchor of either kind with its partition derived from the committed body, no page loop before the 2.1 verifier, and the
 * 2.1 verifier itself. The order of the checks is Go's, so a document that is wrong in two ways is refused for the same one.
 */
import { createHash } from 'node:crypto';
import { equal, fail, hexBytes, receiptPrefixTo, receiptValid, toHex, VerifyError } from '../proof-v2/bytes.js';
import { genesisGlobals, Spine } from '../proof-v2/spine.js';
import { computeIncarnation, PORTABLE_FORMAT } from '../proof-v2/verify.js';
import { optList, type Rec } from '../proof-v2/shapes.js';
import { sameUrl } from '../proof-v2/accumulate.js';
import { decodeAnchor21, partitionOfAnchor } from './directory.js';
import { importEvidence, type Evidence } from './evidence.js';
import { verifySetCheck } from './setcheck.js';
import { majorFromJson } from './minorroot.js';
import { parsePartitionUrl } from './acc.js';
import { VERSION_21 } from './states.js';
import type { Report21, XIn } from './xtypes.js';
import { verify21 } from './verify21.js';
import { struct } from './gojson.js';
import { exactKey } from './occ.js';
import { nodeFromJson, recordBytes } from './jsonwire.js';
import { nodeToJson } from './nodejson.js';

/**
 * The spine after each starting point, walked from the genesis through the first `need` major blocks. It is a pure function of the genesis
 * and those records, so the states are kept by the hash of both: a verifier asked about many documents of one incarnation (a corpus of
 * mutations, a store of proofs) walks the spine once. Each caller gets clones; the kept states are never advanced.
 */
const SPINE_CACHE = new Map<string, Map<number, Spine>>();
function spineStates(genesis: ReturnType<typeof genesisGlobals>, majors: unknown[], need: number, starts: number[], key: string): Map<number, Spine> {
  const k = `${key}|${starts.join(',')}`;
  const hit = SPINE_CACHE.get(k);
  if (hit) return new Map([...hit].map(([n, s]) => [n, s.clone()]));
  // Go's Import reads every major record of the archive; the walk reads them in the spelling it expects.
  const records = majors.map((m, i) => majorFromJson(m, `major ${i + 1}`));
  const sp = new Spine(genesis, 1);
  const at = new Map<number, Spine>();
  for (let i = 0; i < need; i++) {
    sp.advance(records[i], `spine: major ${i + 1}`);
    if (starts.includes(i + 1)) at.set(i + 1, sp.clone());
  }
  if (SPINE_CACHE.size >= 16) SPINE_CACHE.delete(SPINE_CACHE.keys().next().value!);
  SPINE_CACHE.set(k, new Map([...at].map(([n, s]) => [n, s.clone()])));
  return at;
}

/** An empty report in the shape verifyFrom fills. */
function newReport(): Report21 {
  return {
    incarnation: '',
    majors: 0,
    certifiedBlock: 0,
    certifiedRoot: '',
    checkBlock: 0,
    partition: '',
    anchorBlock: 0,
    pages: [],
    pageChains: [],
    proven: [],
    setVerdict: 'validator_set_asserted',
    validators: 0,
    threshold: 0,
    version: '',
    tag: '',
    unproven: [],
    routingHeight: 0,
    authorizationMode: '',
    disclosures: [],
    arrivals: [],
    txHash: '',
    anchorTxHash: '',
    anchorStateRoot: '',
    anchorRootChainAnchor: '',
    accumulateSetRoot: '',
  };
}

/**
 * VerifyPortable for a document of evidence 2.1: Import, then Verify21FromGenesis. Any failure throws: a NamedState for a fact the
 * verifier could not establish (with the partition and block it was judged at), a plain VerifyError for a malformed or inconsistent
 * document.
 */
export function verifyPortable21(document: unknown): Report21 {
  const doc = document && typeof document === 'object' && !Array.isArray(document) ? (document as Rec) : undefined;
  if (!doc || doc.format !== PORTABLE_FORMAT) fail(`portable format ${JSON.stringify(doc?.format)} is not ${PORTABLE_FORMAT}`);

  // Import (portable.go): the pin, the genesis, the archive, the evidence. Every failure here is a plain refusal.
  const pin = hexBytes(doc.pin, 'pin', 32);
  const g = struct(doc.genesis, ['minorBlockIndex', 'rootChainAnchor', 'stateTreeAnchor', 'timeUnix', 'networkRecord', 'globalsRecord', 'network', 'globals'], 'PortableGenesis');
  const networkRecord = hexBytes(g.networkRecord ?? '', 'genesis.networkRecord');
  const globalsRecord = hexBytes(g.globalsRecord ?? '', 'genesis.globalsRecord');
  // sameEncoding (portable.go): the genesis JSON is decoded by the generated unmarshalers and must write exactly the record the incarnation commits to.
  const spelled: Record<string, unknown> = {};
  for (const [what, cls, json, record] of [['network', 'NetworkDefinition', g.network, networkRecord], ['globals', 'NetworkGlobals', g.globals, globalsRecord]] as const) {
    let enc: Uint8Array;
    try {
      enc = recordBytes(cls, json, `genesis ${what}`);
      // the SDK reads the JSON below with exact keys: it is handed the document the generated unmarshaler made, as MarshalJSON writes it
      spelled[what] = nodeToJson(nodeFromJson(cls, json, `genesis ${what}`));
    } catch (e) {
      throw new VerifyError(`genesis ${what}: ${(e as Error).message}`);
    }
    if (!equal(enc, record)) fail(`genesis ${what}: the JSON does not re-encode to the record`);
  }
  const genesis = genesisGlobals(spelled.network, networkRecord, spelled.globals, globalsRecord);
  const majors = optList(doc.majors, 'majors');
  const ev = importEvidence(doc);

  // Verify21FromGenesis
  if (ev.version !== VERSION_21) fail('not a v2.1 Accumulate proof');
  const id = computeIncarnation(g, networkRecord, globalsRecord);
  if (!equal(id, pin)) fail(`incarnation evidence is for ${toHex(id)}, not the pinned ${toHex(pin)}`);
  const rep = newReport();
  rep.incarnation = toHex(id);

  // The spine to the larger of the two starting points, keeping the state at each.
  const need = Math.max(ev.majors, ev.check.majors);
  if (need === 0 || need > majors.length) fail(`evidence builds on ${need} major blocks; the archive has ${majors.length}`);
  const at = spineStates(genesis, majors, need, [ev.majors, ev.check.majors], createHash('sha256').update(exactKey([g, majors])).digest('hex'));
  rep.majors = need;
  return verifyFrom(ev, rep, at, pin);
}

/** verifyFrom checks everything after the spine's starting points: at holds the spine after ev.majors and after ev.check.majors major blocks. */
function verifyFrom(ev: Evidence, rep: Report21, at: Map<number, Spine>, pin: Uint8Array): Report21 {
  // S1-S2: the receipt from the transaction to a certified root.
  const certified = at.get(ev.majors);
  if (!certified) fail(`certify: evidence.majors ${ev.majors} is not a major block of the archive`);
  const cert = certified.clone();
  if (ev.certify.length === 0) fail('certify: no minor-root run');
  ev.certify.forEach((run, i) => cert.advanceEpoch(run, `certify run ${i}`));
  const r = ev.receipt;
  const tx = ev.txHash.length === 64 && /^[0-9a-fA-F]{64}$/.test(ev.txHash) ? hexBytes(ev.txHash, 'txHash', 32) : fail('txHash is not 32 bytes of hex');
  if (!equal(r.start, tx)) fail(`receipt starts at ${toHex(r.start)}, not the transaction ${toHex(tx)}`);
  if (!equal(r.anchor, cert.rootChainAnchor)) fail(`receipt ends at ${toHex(r.anchor)}, not the root ${toHex(cert.rootChainAnchor)} certified at DN ${cert.lastMinorBlock}`);
  if (!receiptValid(r)) fail('receipt does not validate');
  rep.certifiedBlock = cert.lastMinorBlock;
  rep.certifiedRoot = toHex(cert.rootChainAnchor);
  rep.txHash = toHex(tx);

  // The partition anchor: executed by the Directory, proven into the same certified root, naming the block whose root chain the
  // transaction's receipt passes through and whose state root the pages are proven into.
  const anchor = decodeAnchor21(ev.anchor.message);
  partitionOfAnchor(anchor);
  const ar = ev.anchor.receipt;
  if (!equal(ar.start, anchor.tx) || !equal(ar.anchor, cert.rootChainAnchor) || !receiptValid(ar)) {
    fail('partition anchor: its receipt does not prove the anchor transaction into the certified root');
  }
  if (!receiptPrefixTo(r, anchor.body.rootChainAnchor)) fail(`the transaction's receipt does not pass through the anchor's root chain anchor ${toHex(anchor.body.rootChainAnchor)}`);
  if (anchor.tx.length !== 32) fail(`partition anchor: its transaction hash is ${anchor.tx.length} bytes, not 32`);
  const srcURL = anchor.body.source!.toString(); // the committed value; partitionOfAnchor has required the wrapper to agree
  rep.partition = srcURL;
  rep.anchorBlock = anchor.body.minorBlockIndex;
  rep.anchorTxHash = toHex(anchor.tx);
  rep.anchorStateRoot = toHex(anchor.body.stateTreeAnchor);
  rep.anchorRootChainAnchor = toHex(anchor.body.rootChainAnchor);
  const partId = parsePartitionUrl(anchor.body.source!)!;

  // The validator set: walked to a certified block at or after the certified one, proven there, equal to the set the walk derived. Every
  // write the walk applied must be accounted for by the network account's main chain.
  let chk: Spine;
  if (ev.check.hops.length === 0) {
    if (ev.check.majors !== ev.majors) {
      fail(`set check has no minor-root run of its own but builds on ${ev.check.majors} major blocks, not the certification's ${ev.majors}`);
    }
    chk = cert.clone();
  } else {
    const start = at.get(ev.check.majors);
    if (!start) fail(`set check: check.majors ${ev.check.majors} is not a major block of the archive`);
    chk = start.clone();
  }
  ev.check.hops.forEach((h, i) => chk.advanceEpoch(h, `set check hop ${i}`));
  if (chk.lastMinorBlock < cert.lastMinorBlock) {
    fail(`the set is checked at DN ${chk.lastMinorBlock}, before the certified DN ${cert.lastMinorBlock}: updates between are unaccounted`);
  }
  rep.checkBlock = chk.lastMinorBlock;

  const sc = verifySetCheck(ev.check.network, ev.check.globals, ev.check.incarnation, chk.stateTreeAnchor, pin, {
    networkRecord: chk.g.networkRecord,
    globalsRecord: chk.g.globalsRecord,
    networkUpdates: chk.applied.filter((x) => sameUrl(x.principal, 'acc://dn.acme/network')).length,
  });
  rep.setVerdict = sc.verdict;
  rep.accumulateSetRoot = sc.accumulateSetRoot;
  rep.validators = chk.validators().length;
  rep.threshold = chk.directoryThreshold();

  const x = { source: srcURL, id: partId, block: anchor.body.minorBlockIndex, stateRoot: new Uint8Array(anchor.body.stateTreeAnchor) };
  const inn: XIn = {
    certRoot: new Uint8Array(cert.rootChainAnchor),
    x,
    setRoot: new Uint8Array(chk.stateTreeAnchor),
    network: chk.g.network.networkName ?? '',
  };
  verify21(ev, rep, inn);
  return rep;
}

