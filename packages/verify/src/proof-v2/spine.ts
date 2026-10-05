/**
 * The Directory's validator-set spine (Go: certen-validator pkg/proof/v2/spine.go, vendored from accumulate
 * internal/fastsync/spine.go). Each anchor is verified against the set tracked by induction from the genesis values;
 * the network updates each record carries are proven into its root.
 *
 * One deliberate difference from Go, which only ever refuses more: a proven write to acc://dn.acme/network or
 * acc://dn.acme/globals would change the tracked set, and this verifier has no way to decode the written record
 * without a binary decoder, so it refuses such a spine by name (network_update_unsupported) where Go would apply the
 * write. No Kermit major block carries one (measured 2026-10-04: the only updates are two systemGenesis transactions).
 */
import {
  encodeObject,
  messageHash,
  networkDefinition,
  networkGlobals,
  normalize,
  sameUrl,
  sequencedMessage,
  transaction,
  transactionHash,
  verifySignature,
} from './accumulate.js';
import { equal, fail, hexBytes, receiptFromJSON, receiptListValid, receiptValid } from './bytes.js';

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

  constructor(readonly g: Globals, next: number) {
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
    const vs = this.g.network.validators;
    if (!Array.isArray(vs)) return [];
    return vs.map((v: any) => ({
      publicKey: String(v.publicKey ?? '').toLowerCase(),
      publicKeyHash: String(v.publicKeyHash ?? '').toLowerCase(),
      partitions: Array.isArray(v.partitions) ? v.partitions.map((p: any) => ({ id: String(p.id ?? ''), active: p.active === true })) : [],
    }));
  }

  /** GlobalValues.ValidatorThreshold(Directory): ceil(active on the Directory x numerator / denominator). */
  directoryThreshold(): number {
    const active = this.validators().filter((v) => v.partitions.some((p) => p.active && p.id.toLowerCase() === 'directory')).length;
    const t = this.g.globals.validatorAcceptThreshold ?? {};
    const num = Number(t.numerator ?? 0);
    const den = Number(t.denominator ?? 0);
    if (active === 0) return Number.MAX_SAFE_INTEGER;
    return Math.ceil((active * num) / den);
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
    const applied: Applied[] = [];
    for (const [i, u] of (Array.isArray(updates) ? updates : []).entries()) {
      const a = applyProvenUpdate(u, root, `${label}.updates[${i}]`);
      if (a) applied.push({ ...a, anchorMinorBlock: Number(body.minorBlockIndex) });
    }
    // With no write to the tracked accounts applied, the candidate set is the current one, so Go's fallback to the
    // pre-update set for an anchor in the update's own block can never be taken here.
    verifyQuorum(this, msg, sigs, label);
    this.lastMinorBlock = Number(body.minorBlockIndex);
    this.rootChainAnchor = root;
    this.stateTreeAnchor = hexBytes(body.stateTreeAnchor, `${label}.stateTreeAnchor`, 32);
    this.applied.push(...applied);
  }
}

/** checkDirectorySelfAnchor. */
function directorySelfAnchor(j: unknown, label: string): { msg: any; body: any } {
  const msg = sequencedMessage(j, `${label}.anchor`);
  const n = normalize(j) as any;
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
function verifyQuorum(s: Spine, msg: any, sigs: unknown, label: string): void {
  const hash = messageHash(msg);
  const seen = new Set<string>();
  const vs = s.validators();
  for (const [i, sig] of (Array.isArray(sigs) ? sigs : []).entries()) {
    if (!verifySignature(sig, hash, `${label}.signatures[${i}]`)) fail(`${label}: invalid signature`);
    const key = String((sig as any).publicKey ?? '').toLowerCase();
    const v = vs.find((x) => x.publicKey === key && x.partitions.some((p) => p.active && p.id.toLowerCase() === 'directory'));
    if (!v) fail(`${label}: signer is not an active directory validator`);
    seen.add(v.publicKeyHash);
  }
  const threshold = s.directoryThreshold();
  if (seen.size < threshold) fail(`${label}: quorum not met: ${seen.size} of ${threshold} validator signatures`);
}

/** applyProvenUpdate. */
function applyProvenUpdate(u: any, root: Uint8Array, label: string): Omit<Applied, 'anchorMinorBlock'> | undefined {
  if (!u || !u.transaction || !u.receipt) fail(`${label}: incomplete network update proof`);
  const tx = transaction(u.transaction, `${label}.transaction`);
  const h = transactionHash(tx);
  const r = receiptFromJSON(u.receipt, `${label}.receipt`);
  if (!equal(r.start, h)) fail(`${label}: network update receipt does not start at the transaction`);
  if (!equal(r.anchor, root)) fail(`${label}: network update receipt does not end at the anchor's root`);
  if (!receiptValid(r)) fail(`${label}: invalid network update receipt`);
  const body = normalize(u.transaction).body ?? {};
  if (body.type !== 'writeData') return undefined; // other types do not affect the consensus validator set
  const principal = String(normalize(u.transaction).header?.principal ?? '');
  if (sameUrl(principal, 'acc://dn.acme/network') || sameUrl(principal, 'acc://dn.acme/globals')) {
    fail(`network_update_unsupported: ${label} writes ${principal}; this verifier cannot decode the written record`);
  }
  return undefined;
}

/** For the genesis values: the JSON must re-encode to exactly the record the incarnation commits to. */
export function genesisGlobals(networkJson: unknown, networkRecord: Uint8Array, globalsJson: unknown, globalsRecord: Uint8Array): Globals {
  const def = networkDefinition(networkJson);
  if (!equal(encodeObject(def), networkRecord)) fail('genesis network: the JSON does not re-encode to the record');
  const glob = networkGlobals(globalsJson);
  if (!equal(encodeObject(glob), globalsRecord)) fail('genesis globals: the JSON does not re-encode to the record');
  return { network: normalize(networkJson), networkRecord, globals: normalize(globalsJson), globalsRecord };
}
