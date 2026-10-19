/**
 * The Directory's validator-set spine (Go: certen-validator pkg/proof/v2/spine.go, vendored from accumulate
 * internal/fastsync/spine.go). Each anchor is verified against the set tracked by induction from the genesis values;
 * the network updates each record carries are proven into its root.
 *
 * A proven write to acc://dn.acme/network or acc://dn.acme/globals changes the tracked set, and is applied here as Go's
 * GlobalValues.ParseNetwork / ParseGlobals applies it (netrecord.ts decodes the written record and proves the decode by
 * re-encoding it). A write that cannot be decoded is refused by name (network_update_undecodable).
 */
import {
  encodeObject,
  messageHash,
  networkDefinition,
  networkGlobals,
  sameUrl,
  transaction,
  transactionHashOfJson,
  verifySignature,
} from './accumulate.js';
import { equal, fail, hexBytes, receiptFromJSON, receiptListParts, receiptListValid, receiptValid, toHex, UNDECODABLE } from './bytes.js';
import { decodeNetworkDefinition, decodeNetworkGlobals } from './netrecord.js';
import { CertifyCode, certifyState, UpdateWindow } from '../s3/certify.js';
import { sequencedHashOf } from '../s3/seqmsg.js';
import type { Rcpt } from '../s3/rcpt.js';
import {
  anchorBody,
  anchorMessage,
  majorRecord,
  minorRootRecord,
  networkUpdates,
  optUint,
  rec,
  signatures,
  str,
  type AnchorBody,
  type AnchorMessage,
  type GlobalsJSON,
  type MinorRootRecord,
  type NetworkJSON,
  type NetworkUpdateJSON,
  type Rec,
  type SignatureJSON,
} from './shapes.js';

export interface Validator {
  publicKey: string; // hex, lowercase
  publicKeyHash: string; // hex, lowercase
  partitions: { id: string; active: boolean }[];
}

export interface Globals {
  /** The genesis NetworkDefinition, as JSON, and its encoding. */
  network: NetworkJSON;
  networkRecord: Uint8Array;
  /** The genesis NetworkGlobals, as JSON, and its encoding. */
  globals: GlobalsJSON;
  globalsRecord: Uint8Array;
}

export interface Applied {
  principal: string;
  txHash: Uint8Array;
  anchorMinorBlock: number;
}

export class Spine {
  nextMajor: number;
  lastMinorBlock = 0;
  /** The same block as a uint64, exactly: what the walk compares (lastMinorBlock is its double, for the report). */
  lastBlock = 0n;
  rootChainAnchor: Uint8Array = new Uint8Array(32);
  stateTreeAnchor: Uint8Array = new Uint8Array(32);
  applied: Applied[] = [];
  /**
   * Set by the evidence 2.1 verifier on the spines it walks (Go: refuseReplay): a record that applies an update the walk already applied is
   * certify_update_replayed, and every update must lie in its window (certify_update_unproven). A 2.0 spine never sets it, so 2.0 verdicts do not move.
   */
  refuseReplay = false;
  /** The root chain index of the last verified anchor (a spine from genesis knows it: 0). Only the evidence 2.1 walk reads it. */
  rootChainIndex = 0;
  /** The root chain index as a uint64, exactly. */
  rootChain = 0n;
  rciKnown = true;

  constructor(public g: Globals, next: number) {
    if (next === 0) fail('major blocks are 1-based');
    this.nextMajor = next;
  }

  clone(): Spine {
    const c = new Spine(this.g, this.nextMajor);
    c.lastMinorBlock = this.lastMinorBlock;
    c.lastBlock = this.lastBlock;
    c.rootChainAnchor = this.rootChainAnchor;
    c.stateTreeAnchor = this.stateTreeAnchor;
    c.applied = [...this.applied];
    c.refuseReplay = this.refuseReplay;
    c.rootChainIndex = this.rootChainIndex;
    c.rootChain = this.rootChain;
    c.rciKnown = this.rciKnown;
    return c;
  }

  validators(): Validator[] {
    return validatorsOf(this.g);
  }

  /** NetworkUpdates: the writes to acc://dn.acme/network the spine has applied since genesis (what the network account's main chain must account for beside its genesis entry). */
  networkUpdates(): number {
    return this.applied.filter((a) => a.principal === 'acc://dn.acme/network').length; // Go compares the applied principal's string exactly (Spine.NetworkUpdates)
  }

  /** GlobalsUpdates: the writes to acc://dn.acme/globals the spine has counted (V-E A2(b)); only the evidence 2.1 verifier compares it. */
  globalsUpdates(): number {
    return this.applied.filter((a) => a.principal === 'acc://dn.acme/globals').length; // exactly, as Go (Spine.GlobalsUpdates)
  }

  /** GlobalValues.ValidatorThreshold(Directory): ceil(active on the Directory x numerator / denominator). */
  directoryThreshold(): number {
    return directoryThresholdOf(this.g);
  }

  /** Spine.Advance. */
  advance(record: unknown, label: string): void {
    const r = majorRecord(record, label);
    if (r.index !== this.nextMajor) fail(`${label}: expected major block ${this.nextMajor}, got ${r.index}`);
    if (r.entryBlockIndex !== r.index) fail(`${label}: index entry is for major block ${r.entryBlockIndex}, not ${r.index}`);
    const { hash, body } = directorySelfAnchor(r.anchor, label);
    if (body.minorBlock <= this.lastBlock) {
      fail(`${label}: anchor for minor block ${body.minorBlock} does not advance past ${this.lastBlock}`);
    }
    this.verifyAndCommit(body, hash, r.signatures, r.updates, label, this.refuseReplay);
    this.nextMajor++;
  }

  /** Spine.AdvanceEpoch. */
  advanceEpoch(record: unknown, label: string): void {
    // decodeMinorRoot: a record whose binary form the reader cannot decode is refused at its turn
    if (record && typeof record === 'object' && (record as { [UNDECODABLE]?: boolean })[UNDECODABLE]) fail(`${label}: fields are out of order`);
    const r = minorRootRecord(record, label);
    const { hash, body } = directorySelfAnchor(r.anchor, label);
    if (body.minorBlock <= this.lastBlock) {
      fail(`${label}: anchor for minor block ${body.minorBlock} does not advance past ${this.lastBlock}`);
    }
    if (this.refuseReplay) {
      // Evidence 2.1 judges a root proof in Go's order and wording (AdvanceEpoch): present, where it starts, where it ends, then whether it validates.
      const p = receiptListParts(r.rootProof, label);
      if (!equal(p.start, this.rootChainAnchor)) fail(`${label}: root proof does not start at the verified root`);
      if (!equal(p.anchor, body.rootChainAnchor)) fail(`${label}: root proof does not end at the anchor's root`);
      p.validate();
      this.verifyAndCommit(body, hash, r.signatures, r.updates, label, true);
      return;
    }
    const rl = receiptListValid(r.rootProof, `${label}.rootProof`);
    if (!equal(rl.start, this.rootChainAnchor)) fail(`${label}: root proof does not start at the verified root`);
    if (!equal(rl.anchor, body.rootChainAnchor)) fail(`${label}: root proof does not end at the anchor's root`);
    this.verifyAndCommit(body, hash, r.signatures, r.updates, label, this.refuseReplay);
  }

  /**
   * Spine.AdvanceAnchored (evidence 2.1): a minor-root record without a root proof, whose continuity with the previously verified root chain anchor is
   * the O(log n) link instead of the walk of every root chain entry in between. The record's anchor must be a Directory self-anchor of a later minor
   * block; the link must be present, start at the verified root chain anchor, end at the anchor's own and validate; the updates are applied and the
   * quorum checked exactly as advanceEpoch does, and an update the walk already applied is refused. The refusals are CertifyStates with index 0: the
   * caller, who knows the link's ordinal, renames the index.
   */
  advanceAnchored(record: unknown, link: Rcpt | undefined, label: string): void {
    const r = anchoredRecord(record, label);
    const { hash, body } = directorySelfAnchor(r.anchor, label);
    if (body.minorBlock <= this.lastBlock) {
      fail(`${label}: anchor for minor block ${body.minorBlock} does not advance past ${this.lastBlock}`);
    }
    if (link === undefined) throw certifyState(CertifyCode.CertifyLinkMissing, '0');
    if (!equal(link.start, this.rootChainAnchor)) throw certifyState(CertifyCode.CertifyLinkStart, '0');
    if (!equal(link.anchor, body.rootChainAnchor)) throw certifyState(CertifyCode.CertifyLinkEnd, '0');
    if (!receiptValid(link)) throw certifyState(CertifyCode.CertifyLinkInvalid, '0');
    this.verifyAndCommit(body, hash, r.signatures, r.updates, label, true);
  }

  private verifyAndCommit(body: AnchorBody, hash: Uint8Array, sigs: SignatureJSON[], updates: NetworkUpdateJSON[], label0: string, refuseReplay: boolean): void {
    // Go wraps the refusals of a record in "block N: " (AdvanceEpoch, AdvanceAnchored); the 2.0 spine keeps the wording it has.
    const label = refuseReplay ? `${label0}: block ${body.minorBlock}` : label0;
    const root = body.rootChainAnchor;
    // Evidence 2.1 only: each update's root chain position must lie in (the previous anchor's RootChainIndex, this one's] (V-E A2(c)).
    const win = refuseReplay ? new UpdateWindow(this.rootChain, this.rciKnown, body.rootChain, body.minorBlock) : undefined;
    // Spine.verifyAndCommit: the updates are applied to a candidate copy; the anchor must be signed by the candidate set,
    // or, when it carries updates, by the set in force before them (an update takes effect when it executes, so an
    // anchor in the update's own block is signed by the pre-update set).
    let candidate = this.g;
    const applied: Applied[] = [];
    for (const [i, u] of updates.entries()) {
      const r = applyProvenUpdate(candidate, u, root, `${label}.updates[${i}]`, win !== undefined);
      candidate = r.g;
      if (r.applied) {
        if (refuseReplay && (hasUpdate(this.applied, r.applied.txHash) || hasUpdate(applied, r.applied.txHash))) {
          throw certifyState(CertifyCode.CertifyUpdateReplayed, toHex(r.applied.txHash));
        }
        applied.push({ ...r.applied, anchorMinorBlock: body.minorBlockIndex });
      }
      if (win) win.check(r.principal, r.txHash, receiptFromJSON(u.receipt!, `${label}.updates[${i}].receipt`).entries);
    }
    try {
      verifyQuorum(candidate, hash, sigs, label);
    } catch (e) {
      if (updates.length === 0) throw e;
      verifyQuorum(this.g, hash, sigs, label);
    }
    this.g = candidate;
    // The quorum has signed this anchor: a height above 2^53 cannot be one a network has reached, and the report states heights as doubles.
    if (body.minorBlock > BigInt(Number.MAX_SAFE_INTEGER) || body.rootChain > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail(`${label}: the signed anchor names a height above 2^53 - 1, which a report cannot state`);
    }
    this.lastMinorBlock = body.minorBlockIndex;
    this.lastBlock = body.minorBlock;
    this.rootChainAnchor = root;
    this.stateTreeAnchor = body.stateTreeAnchor;
    this.rootChainIndex = body.rootChainIndex;
    this.rootChain = body.rootChain;
    this.rciKnown = true;
    this.applied.push(...applied);
  }
}

export function validatorsOf(g: Globals): Validator[] {
  const vs = g.network.validators;
  if (!Array.isArray(vs)) return [];
  return vs.map((v) => ({
    publicKey: String(v.publicKey ?? '').toLowerCase(),
    publicKeyHash: String(v.publicKeyHash ?? '').toLowerCase(),
    partitions: Array.isArray(v.partitions) ? v.partitions.map((p) => ({ id: String(p.id ?? ''), active: p.active === true })) : [],
  }));
}

/** GlobalValues.ValidatorThreshold(Directory): ceil(active on the Directory x numerator / denominator). */
export function directoryThresholdOf(g: Globals): number {
  const active = validatorsOf(g).filter((v) => v.partitions.some((p) => p.active && p.id.toLowerCase() === 'directory')).length;
  const t = g.globals.validatorAcceptThreshold ?? {};
  const num = optUint(t.numerator, 'validatorAcceptThreshold.numerator');
  const den = optUint(t.denominator, 'validatorAcceptThreshold.denominator');
  if (active === 0 || den === 0) return Number.MAX_SAFE_INTEGER;
  return Math.ceil((active * num) / den);
}

function hasUpdate(list: Applied[], h: Uint8Array): boolean {
  return list.some((a) => equal(a.txHash, h));
}

/** An anchored record (evidence 2.1): an anchor and no root proof. */
function anchoredRecord(v: unknown, label: string): MinorRootRecord {
  if (!v || typeof v !== 'object') fail(`${label}: incomplete minor root record`);
  const r = v as Rec;
  if (!r.anchor) fail(`${label}: incomplete minor root record`);
  if (r.rootProof) fail(`${label}: an anchored record carries no root proof`);
  return { anchor: anchorMessage(r.anchor, `${label}.anchor`), rootProof: undefined, signatures: signatures(r.signatures, `${label}.signatures`), updates: networkUpdates(r.updates, `${label}.updates`) };
}

/** The minor block of the Directory self-anchor a record's anchor message carries, or undefined when checkDirectorySelfAnchor would refuse it. */
export function selfAnchorBlock(m: unknown): bigint | undefined {
  try {
    if (!m || typeof m !== 'object') return undefined;
    return directorySelfAnchor(anchorMessage(m, 'anchor'), 'anchor').body.minorBlock;
  } catch {
    return undefined;
  }
}

/** checkDirectorySelfAnchor. */
function directorySelfAnchor(m: AnchorMessage, label: string): { hash: Uint8Array; body: AnchorBody } {
  if (m.bodyType !== 'directoryAnchor') fail(`${label}: anchor is ${m.bodyType}, not a directory anchor`);
  if (!sameUrl(m.source, 'acc://dn.acme') || !sameUrl(m.destination, 'acc://dn.acme') || !sameUrl(m.principal, 'acc://dn.acme/anchors')) {
    fail(`${label}: anchor is not a directory self-anchor`);
  }
  // The hash is the one Go's reader computes from the message's binary form, extra data included; an anchor whose message was not imported has none, and
  // is refused here rather than judged by the hash of a re-encoding.
  const hash = sequencedHashOf(m.json);
  if (hash === undefined) fail(`${label}: the anchor message was not read as Go reads it, so its hash is not established`);
  return { hash, body: anchorBody(m.body, `${label}.anchor`) };
}

/** verifyQuorum: every signature valid and by an active Directory validator; distinct signers >= threshold. */
function verifyQuorum(g: Globals, hash: Uint8Array, sigs: SignatureJSON[], label: string): void {
  const seen = new Set<string>();
  const vs = validatorsOf(g);
  for (const [i, sig] of sigs.entries()) {
    if (!verifySignature(sig, hash, `${label}.signatures[${i}]`)) fail(`${label}: invalid signature`);
    const key = String(sig.publicKey ?? '').toLowerCase();
    const v = vs.find((x) => x.publicKey === key && x.partitions.some((p) => p.active && p.id.toLowerCase() === 'directory'));
    if (!v) fail(`${label}: signer is not an active directory validator`);
    seen.add(v.publicKeyHash);
  }
  const threshold = directoryThresholdOf(g);
  if (seen.size < threshold) fail(`${label}: quorum not met: ${seen.size} of ${threshold} validator signatures`);
}

/**
 * applyProvenUpdate: the update's receipt must bind its transaction to the anchor's root; a write to the Directory's
 * network or globals account is then applied. Returns the (possibly new) globals and, for a write to either account, the
 * applied update. A network definition whose version is not above the current one is a complete-state no-op that is still
 * accounted for: every write to the account is a write against its main chain.
 */
function applyProvenUpdate(
  g: Globals,
  u: NetworkUpdateJSON,
  root: Uint8Array,
  label: string,
  window: boolean,
): { g: Globals; applied?: Omit<Applied, 'anchorMinorBlock'>; principal: string; txHash: Uint8Array } {
  // An update without its transaction or its receipt is refused when it is reached, before anything else is judged of it (applyProvenUpdate).
  if (!u.transaction || !u.receipt) fail(`${label}: incomplete network update proof`);
  const ut = u.transaction;
  // The principal is read (and required) first when the update's window is to be judged: Go refuses an update without one before anything else.
  const principalOf = (): string => str(rec(ut.header ?? {}, `${label}.transaction.header`).principal, `${label}.transaction.header.principal`);
  const early = window ? principalOf() : '';
  transaction(ut, `${label}.transaction`); // the SDK must still accept the transaction's shape; its hash is that of the wire object below
  const h = transactionHashOfJson(ut, `${label}.transaction`);
  const r = receiptFromJSON(u.receipt, `${label}.receipt`);
  if (!equal(r.start, h)) fail(`${label}: network update receipt does not start at the transaction`);
  if (!equal(r.anchor, root)) fail(`${label}: network update receipt does not end at the anchor's root`);
  if (!receiptValid(r)) fail(`${label}: invalid network update receipt`);
  const body = rec(ut.body ?? {}, `${label}.transaction.body`);
  if (body.type !== 'writeData') return { g, principal: early, txHash: h }; // other types do not affect the consensus validator set
  const principal = window ? early : principalOf();
  const isNetwork = sameUrl(principal, 'acc://dn.acme/network');
  const isGlobals = sameUrl(principal, 'acc://dn.acme/globals');
  if (!isNetwork && !isGlobals) return { g, principal, txHash: h };

  // parseEntryAs: the entry must hold exactly one record.
  const data = body.entry && typeof body.entry === 'object' ? (body.entry as { data?: unknown }).data : undefined;
  const kind = isNetwork ? 'network' : 'globals';
  if (!Array.isArray(data) || data.length !== 1) fail(`${label}: unmarshal ${kind}: want 1 record, got ${Array.isArray(data) ? data.length : 0}`);
  const record = hexBytes(data[0], `${label}.entry`);
  const applied = { principal, txHash: h };

  if (isGlobals) {
    const obj = decodeNetworkGlobals(record);
    return { g: { ...g, globals: obj.asObject() as GlobalsJSON, globalsRecord: record }, applied, principal, txHash: h };
  }
  const def = decodeNetworkDefinition(record);
  const next = optUint(def.asObject().version, `${label}: network definition version`);
  const current = optUint(g.network.version, 'tracked network definition version');
  if (next <= current) return { g, applied, principal, txHash: h }; // stale or genesis definition
  return { g: { ...g, network: def.asObject() as NetworkJSON, networkRecord: record }, applied, principal, txHash: h };
}

/** For the genesis values: the JSON must re-encode to exactly the record the incarnation commits to. */
export function genesisGlobals(networkJson: unknown, networkRecord: Uint8Array, globalsJson: unknown, globalsRecord: Uint8Array): Globals {
  const def = networkDefinition(networkJson);
  if (!equal(encodeObject(def), networkRecord)) fail('genesis network: the JSON does not re-encode to the record');
  const glob = networkGlobals(globalsJson);
  if (!equal(encodeObject(glob), globalsRecord)) fail('genesis globals: the JSON does not re-encode to the record');
  // The tracked values are the SDK's own rendering of the records (the same form an applied update takes).
  return { network: def.asObject() as unknown as NetworkJSON, networkRecord, globals: glob.asObject() as unknown as GlobalsJSON, globalsRecord };
}
