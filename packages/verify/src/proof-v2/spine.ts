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
  sequencedMessage,
  transaction,
  transactionHash,
  verifySignature,
} from './accumulate.js';
import { equal, fail, hexBytes, receiptFromJSON, receiptListValid, receiptValid } from './bytes.js';
import { decodeNetworkDefinition, decodeNetworkGlobals } from './netrecord.js';

export interface Validator {
  publicKey: string; // hex, lowercase
  publicKeyHash: string; // hex, lowercase
  partitions: { id: string; active: boolean }[];
}

export interface Globals {
  /** The genesis NetworkDefinition, as JSON, and its encoding. */
  network: any;
  networkRecord: Uint8Array;
  /** The genesis NetworkGlobals, as JSON, and its encoding. */
  globals: any;
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
  rootChainAnchor: Uint8Array = new Uint8Array(32);
  stateTreeAnchor: Uint8Array = new Uint8Array(32);
  applied: Applied[] = [];

  constructor(public g: Globals, next: number) {
    if (next === 0) fail('major blocks are 1-based');
    this.nextMajor = next;
  }

  clone(): Spine {
    const c = new Spine(this.g, this.nextMajor);
    c.lastMinorBlock = this.lastMinorBlock;
    c.rootChainAnchor = this.rootChainAnchor;
    c.stateTreeAnchor = this.stateTreeAnchor;
    c.applied = [...this.applied];
    return c;
  }

  validators(): Validator[] {
    return validatorsOf(this.g);
  }

  /** GlobalValues.ValidatorThreshold(Directory): ceil(active on the Directory x numerator / denominator). */
  directoryThreshold(): number {
    return directoryThresholdOf(this.g);
  }

  /** Spine.Advance. */
  advance(r: any, label: string): void {
    if (!r || !r.entry || !r.anchor) fail(`${label}: incomplete major header record`);
    if (Number(r.index) !== this.nextMajor) fail(`${label}: expected major block ${this.nextMajor}, got ${r.index}`);
    if (Number(r.entry.blockIndex) !== Number(r.index)) fail(`${label}: index entry is for major block ${r.entry.blockIndex}, not ${r.index}`);
    const { msg, body } = directorySelfAnchor(r.anchor, label);
    if (Number(body.minorBlockIndex) <= this.lastMinorBlock) {
      fail(`${label}: anchor for minor block ${body.minorBlockIndex} does not advance past ${this.lastMinorBlock}`);
    }
    this.verifyAndCommit(body, msg, r.signatures, r.updates, label);
    this.nextMajor++;
  }

  /** Spine.AdvanceEpoch. */
  advanceEpoch(r: any, label: string): void {
    if (!r || !r.anchor || !r.rootProof) fail(`${label}: incomplete minor root record`);
    const { msg, body } = directorySelfAnchor(r.anchor, label);
    if (Number(body.minorBlockIndex) <= this.lastMinorBlock) {
      fail(`${label}: anchor for minor block ${body.minorBlockIndex} does not advance past ${this.lastMinorBlock}`);
    }
    const rl = receiptListValid(r.rootProof, `${label}.rootProof`);
    if (!equal(rl.start, this.rootChainAnchor)) fail(`${label}: root proof does not start at the verified root`);
    if (!equal(rl.anchor, hexBytes(body.rootChainAnchor, 'rootChainAnchor', 32))) fail(`${label}: root proof does not end at the anchor's root`);
    this.verifyAndCommit(body, msg, r.signatures, r.updates, label);
  }

  private verifyAndCommit(body: any, msg: any, sigs: unknown, updates: unknown, label: string): void {
    const root = hexBytes(body.rootChainAnchor, `${label}.rootChainAnchor`, 32);
    // Spine.verifyAndCommit: the updates are applied to a candidate copy; the anchor must be signed by the candidate set,
    // or, when it carries updates, by the set in force before them (an update takes effect when it executes, so an
    // anchor in the update's own block is signed by the pre-update set).
    let candidate = this.g;
    const applied: Applied[] = [];
    for (const [i, u] of (Array.isArray(updates) ? updates : []).entries()) {
      const r = applyProvenUpdate(candidate, u, root, `${label}.updates[${i}]`);
      candidate = r.g;
      if (r.applied) applied.push({ ...r.applied, anchorMinorBlock: Number(body.minorBlockIndex) });
    }
    try {
      verifyQuorum(candidate, msg, sigs, label);
    } catch (e) {
      if (!(Array.isArray(updates) && updates.length > 0)) throw e;
      verifyQuorum(this.g, msg, sigs, label);
    }
    this.g = candidate;
    this.lastMinorBlock = Number(body.minorBlockIndex);
    this.rootChainAnchor = root;
    this.stateTreeAnchor = hexBytes(body.stateTreeAnchor, `${label}.stateTreeAnchor`, 32);
    this.applied.push(...applied);
  }
}

export function validatorsOf(g: Globals): Validator[] {
  const vs = g.network.validators;
  if (!Array.isArray(vs)) return [];
  return vs.map((v: any) => ({
    publicKey: String(v.publicKey ?? '').toLowerCase(),
    publicKeyHash: String(v.publicKeyHash ?? '').toLowerCase(),
    partitions: Array.isArray(v.partitions) ? v.partitions.map((p: any) => ({ id: String(p.id ?? ''), active: p.active === true })) : [],
  }));
}

/** GlobalValues.ValidatorThreshold(Directory): ceil(active on the Directory x numerator / denominator). */
export function directoryThresholdOf(g: Globals): number {
  const active = validatorsOf(g).filter((v) => v.partitions.some((p) => p.active && p.id.toLowerCase() === 'directory')).length;
  const t = g.globals.validatorAcceptThreshold ?? {};
  const num = Number(t.numerator ?? 0);
  const den = Number(t.denominator ?? 0);
  if (active === 0) return Number.MAX_SAFE_INTEGER;
  return Math.ceil((active * num) / den);
}

/** checkDirectorySelfAnchor. */
function directorySelfAnchor(j: unknown, label: string): { msg: any; body: any } {
  const msg = sequencedMessage(j, `${label}.anchor`);
  const n = j as any;
  const txm = n.message;
  if (!txm || txm.type !== 'transaction' || !txm.transaction) fail(`${label}: anchor is not a transaction`);
  const body = txm.transaction.body;
  if (!body || body.type !== 'directoryAnchor') fail(`${label}: anchor is ${body?.type}, not a directory anchor`);
  if (!sameUrl(n.source, 'acc://dn.acme') || !sameUrl(n.destination, 'acc://dn.acme') || !sameUrl(txm.transaction.header?.principal, 'acc://dn.acme/anchors')) {
    fail(`${label}: anchor is not a directory self-anchor`);
  }
  return { msg, body };
}

/** verifyQuorum: every signature valid and by an active Directory validator; distinct signers >= threshold. */
function verifyQuorum(g: Globals, msg: any, sigs: unknown, label: string): void {
  const hash = messageHash(msg);
  const seen = new Set<string>();
  const vs = validatorsOf(g);
  for (const [i, sig] of (Array.isArray(sigs) ? sigs : []).entries()) {
    if (!verifySignature(sig, hash, `${label}.signatures[${i}]`)) fail(`${label}: invalid signature`);
    const key = String((sig as any).publicKey ?? '').toLowerCase();
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
function applyProvenUpdate(g: Globals, u: any, root: Uint8Array, label: string): { g: Globals; applied?: Omit<Applied, 'anchorMinorBlock'> } {
  if (!u || !u.transaction || !u.receipt) fail(`${label}: incomplete network update proof`);
  const tx = transaction(u.transaction, `${label}.transaction`);
  const h = transactionHash(tx);
  const r = receiptFromJSON(u.receipt, `${label}.receipt`);
  if (!equal(r.start, h)) fail(`${label}: network update receipt does not start at the transaction`);
  if (!equal(r.anchor, root)) fail(`${label}: network update receipt does not end at the anchor's root`);
  if (!receiptValid(r)) fail(`${label}: invalid network update receipt`);
  const body = u.transaction.body ?? {};
  if (body.type !== 'writeData') return { g }; // other types do not affect the consensus validator set
  const principal = String(u.transaction.header?.principal ?? '');
  const isNetwork = sameUrl(principal, 'acc://dn.acme/network');
  const isGlobals = sameUrl(principal, 'acc://dn.acme/globals');
  if (!isNetwork && !isGlobals) return { g };

  // parseEntryAs: the entry must hold exactly one record.
  const data = body.entry?.data;
  const kind = isNetwork ? 'network' : 'globals';
  if (!Array.isArray(data) || data.length !== 1) fail(`${label}: unmarshal ${kind}: want 1 record, got ${Array.isArray(data) ? data.length : 0}`);
  const record = hexBytes(data[0], `${label}.entry`);
  const applied = { principal, txHash: h };

  if (isGlobals) {
    const obj = decodeNetworkGlobals(record);
    return { g: { ...g, globals: obj.asObject(), globalsRecord: record }, applied };
  }
  const def = decodeNetworkDefinition(record);
  const next = Number(def.version ?? 0);
  const current = Number(g.network.version ?? 0);
  if (next <= current) return { g, applied }; // stale or genesis definition
  return { g: { ...g, network: def.asObject(), networkRecord: record }, applied };
}

/** For the genesis values: the JSON must re-encode to exactly the record the incarnation commits to. */
export function genesisGlobals(networkJson: unknown, networkRecord: Uint8Array, globalsJson: unknown, globalsRecord: Uint8Array): Globals {
  const def = networkDefinition(networkJson);
  if (!equal(encodeObject(def), networkRecord)) fail('genesis network: the JSON does not re-encode to the record');
  const glob = networkGlobals(globalsJson);
  if (!equal(encodeObject(glob), globalsRecord)) fail('genesis globals: the JSON does not re-encode to the record');
  return { network: networkJson, networkRecord, globals: globalsJson, globalsRecord };
}
