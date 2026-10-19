/**
 * The protocol objects the evidence 2.1 verifier reads, as typed views over the decoded wire objects of the signature-type verifier
 * (sigtypes/wire.ts): accounts, key pages with the operations that change them, transactions, signatures.
 *
 * Accumulate's Go types are mirrored by the behaviour the verifier depends on, each function naming the Go function it ports
 * (protocol/keys.go, protocol/authority.go, protocol/transaction.go, protocol/access_control.go, protocol/signature.go).
 */
import { core } from 'accumulate-sdk-opendlt';
import { equal } from '../proof-v2/bytes.js';
import { AccUrl } from './acc.js';
import { decodeObject, decodeUnion, encodeNode, WireError, type Value, type WireNode } from '../sigtypes/wire.js';
import { initiatorHash, metadataHash, unwrap } from '../sigtypes/verify.js';
import { transactionHash } from '../sigtypes/txhash.js';
import { sha256 } from '../proof-v2/bytes.js';

export type { WireNode, Value };

export const isNode = (v: Value | undefined): v is WireNode => typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && 'cls' in v && 'fields' in v;

export function nodeOf(n: WireNode, name: string): WireNode | undefined {
  const v = n.fields.get(name);
  return isNode(v) ? v : undefined;
}
export function nodesOf(n: WireNode, name: string): WireNode[] {
  const v = n.fields.get(name);
  return Array.isArray(v) ? v.filter(isNode) : [];
}
export function bigOf(n: WireNode, name: string): bigint {
  const v = n.fields.get(name);
  return typeof v === 'bigint' ? v : 0n;
}
export function bytesOf(n: WireNode, name: string): Uint8Array {
  const v = n.fields.get(name);
  return v instanceof Uint8Array ? v : new Uint8Array(0);
}
export function boolOf(n: WireNode, name: string): boolean {
  return n.fields.get(name) === true;
}
/** A URL field of a decoded object (a binary string that Accumulate's reader parsed): undefined when the field is absent or empty. */
export function urlOf(n: WireNode, name: string): AccUrl | undefined {
  const v = n.fields.get(name);
  if (typeof v !== 'string' || v === '') return undefined;
  return AccUrl.fromBinary(v);
}
export function urlsOf(n: WireNode, name: string): AccUrl[] {
  const v = n.fields.get(name);
  if (!Array.isArray(v)) return [];
  const out: AccUrl[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const u = x === '' ? undefined : AccUrl.fromBinary(x);
    if (u) out.push(u);
  }
  return out;
}

// --------------------------------------------------------------------------------------------------------------------------------
// enums

const TT = core.TransactionType as unknown as Record<string, number> & { getName(v: number): string };

/** protocol.TransactionType values the verifier decides on. */
export const TransactionType = {
  UpdateKeyPage: TT.UpdateKeyPage!,
  UpdateAccountAuth: TT.UpdateAccountAuth!,
  UpdateKey: TT.UpdateKey!,
  CreateIdentity: TT.CreateIdentity!,
  CreateLiteTokenAccount: TT.CreateLiteTokenAccount!,
  CreateKeyBook: TT.CreateKeyBook!,
  CreateTokenAccount: TT.CreateTokenAccount!,
  CreateDataAccount: TT.CreateDataAccount!,
  CreateToken: TT.CreateToken!,
  ReleaseLockedOperation: TT.ReleaseLockedOperation ?? -1,
  NetworkMaintenance: TT.NetworkMaintenance ?? -1,
} as const;

/** protocol.TransactionType.String(), the spelling of the Go error messages. */
export function transactionTypeName(t: number): string {
  try {
    return TT.getName(t);
  } catch {
    return `TransactionType:${t}`;
  }
}

/** protocol.VoteType values (accept 0, reject 1, abstain 2, suggest 3) and VoteType.String(). */
export const VoteType = { Accept: 0, Reject: 1, Abstain: 2, Suggest: 3 } as const;
export function voteName(v: number): string {
  switch (v) {
    case 0:
      return 'accept';
    case 1:
      return 'reject';
    case 2:
      return 'abstain';
    case 3:
      return 'suggest';
  }
  return `VoteType:${v}`;
}

/** protocol.TransactionType.RequireAuthorization. */
export function requireAuthorization(t: number): boolean {
  return t === TransactionType.UpdateAccountAuth;
}

/** protocol.TransactionType.AllowedTransactionBit. */
export function allowedTransactionBit(t: number): number | undefined {
  if (t === TransactionType.UpdateKeyPage) return 1;
  if (t === TransactionType.UpdateAccountAuth) return 2;
  return undefined;
}

// --------------------------------------------------------------------------------------------------------------------------------
// accounts

/** The account classes that carry an AccountAuth (protocol.FullAccount). */
const FULL_ACCOUNTS = new Set(['ADI', 'DataAccount', 'KeyBook', 'TokenAccount', 'TokenIssuer']);

export function isFullAccount(a: WireNode): boolean {
  return FULL_ACCOUNTS.has(a.cls);
}

/** GetAuth().Authorities of a full account. */
export function authoritiesOf(a: WireNode): { url: AccUrl; disabled: boolean }[] {
  const out: { url: AccUrl; disabled: boolean }[] = [];
  for (const e of nodesOf(a, 'authorities')) {
    const u = urlOf(e, 'url');
    if (u) out.push({ url: u, disabled: boolOf(e, 'disabled') });
  }
  return out;
}

/** protocol.UnmarshalAccount. */
export function decodeAccount(state: Uint8Array): WireNode {
  const n = decodeUnion('Account', state);
  if (!n) throw new WireError('the account is the empty object');
  return n;
}

export function accountUrl(a: WireNode): AccUrl {
  const u = urlOf(a, 'url');
  if (!u) throw new WireError(`a ${a.cls} account has no URL`);
  return u;
}

// --------------------------------------------------------------------------------------------------------------------------------
// key pages

export interface KeySpec {
  publicKeyHash: Uint8Array;
  lastUsedOn: bigint;
  delegate: AccUrl | null;
}

/** A key page as the replay changes it (protocol.KeyPage). */
export class KeyPage {
  constructor(
    public url: AccUrl,
    public version: bigint = 0n,
    public acceptThreshold: bigint = 0n,
    public rejectThreshold: bigint = 0n,
    public responseThreshold: bigint = 0n,
    public blockThreshold: bigint = 0n,
    public keys: KeySpec[] = [],
    /** TransactionBlacklist: null is Accumulate's nil pointer. */
    public blacklist: bigint | null = null,
  ) {}

  static from(n: WireNode): KeyPage {
    const keys: KeySpec[] = nodesOf(n, 'keys').map((k) => ({ publicKeyHash: bytesOf(k, 'publicKeyHash'), lastUsedOn: bigOf(k, 'lastUsedOn'), delegate: urlOf(k, 'delegate') ?? null }));
    const bl = n.fields.get('transactionBlacklist');
    return new KeyPage(
      accountUrl(n),
      bigOf(n, 'version'),
      bigOf(n, 'acceptThreshold'),
      bigOf(n, 'rejectThreshold'),
      bigOf(n, 'responseThreshold'),
      bigOf(n, 'blockThreshold'),
      keys,
      typeof bl === 'bigint' ? bl : null,
    );
  }

  copy(): KeyPage {
    return new KeyPage(
      this.url,
      this.version,
      this.acceptThreshold,
      this.rejectThreshold,
      this.responseThreshold,
      this.blockThreshold,
      this.keys.map((k) => ({ ...k })),
      this.blacklist,
    );
  }

  /** GetSignatureThreshold: an unset accept threshold means one. */
  get signatureThreshold(): bigint {
    return this.acceptThreshold === 0n ? 1n : this.acceptThreshold;
  }

  /** KeyPage.EntryByKeyHash: binary search over the keys, which are sorted by key hash. */
  entryByKeyHash(keyHash: Uint8Array): { index: number; spec: KeySpec } | undefined {
    const [i, found] = search(this.keys, (k) => compareBytes(k.publicKeyHash, keyHash));
    return found ? { index: i, spec: this.keys[i]! } : undefined;
  }

  /** KeyPage.EntryByDelegate: a key page URL names its book. */
  entryByDelegate(owner: AccUrl): { index: number; spec: KeySpec } | undefined {
    const parsed = parseKeyPageOwner(owner);
    const target = parsed ?? owner;
    for (let i = 0; i < this.keys.length; i++) {
      const d = this.keys[i]!.delegate;
      if (d && target.equal(d)) return { index: i, spec: this.keys[i]! };
    }
    return undefined;
  }

  /** KeyPage.AddKeySpec: sorted insert by (key hash, delegate). */
  addKeySpec(k: KeySpec): void {
    const [i, found] = search(this.keys, (l) => {
      const v = compareBytes(l.publicKeyHash, k.publicKeyHash);
      if (v !== 0) return v;
      if (l.delegate === null) return -1;
      if (k.delegate === null) return 1;
      return compareUrls(l.delegate, k.delegate);
    });
    // sortutil.BinaryInsert: an equal entry is replaced, otherwise the new one is inserted at its position.
    if (found) this.keys[i] = k;
    else this.keys.splice(i, 0, k);
  }

  removeKeySpecAt(i: number): void {
    this.keys.splice(i, 1);
  }

  /** KeyPage.SetThreshold. */
  setThreshold(m: bigint): void {
    if (m <= BigInt(this.keys.length) && m > 0n) this.acceptThreshold = m;
    else if (m === 0n) throw new Error('cannot require 0 signatures on a key page');
    else throw new Error(`cannot require ${m} signatures on a key page with ${this.keys.length} keys`);
  }

  isBlacklisted(bit: number): boolean {
    return this.blacklist !== null && (this.blacklist & (1n << BigInt(bit))) !== 0n;
  }
}

/** protocol.ParseKeyPageUrl applied to an owner: a key page URL stands for its book. */
function parseKeyPageOwner(owner: AccUrl): AccUrl | undefined {
  const i = owner.path.lastIndexOf('/');
  if (i < 0) return undefined;
  const tail = owner.path.slice(i + 1);
  if (!/^[0-9]+$/.test(tail) || BigInt(tail) > 0xffffn) return undefined;
  return owner.identity();
}

/** sortutil.Search: the first index whose compare is >= 0, and whether that entry compares equal. */
function search<T>(l: T[], cmp: (e: T) => number): [number, boolean] {
  let lo = 0;
  let hi = l.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (cmp(l[m]!) >= 0) hi = m;
    else lo = m + 1;
  }
  if (lo >= l.length) return [lo, false];
  return [lo, cmp(l[lo]!) === 0];
}

/** bytes.Compare. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** URL.Compare: the lower-cased strings. */
export function compareUrls(a: AccUrl, b: AccUrl): number {
  const x = a.key;
  const y = b.key;
  return x < y ? -1 : x > y ? 1 : 0;
}

// --------------------------------------------------------------------------------------------------------------------------------
// transactions

export interface HoldUntil {
  minorBlock: bigint;
}

/** protocol.Transaction.UnmarshalBinary, with the checks the verifier makes of a carried transaction (decodeTxn). */
export function decodeTxn(raw: Uint8Array): WireNode {
  return decodeObject('Transaction', raw);
}

export function headerOf(txn: WireNode): WireNode | undefined {
  return nodeOf(txn, 'header');
}
export function bodyOf(txn: WireNode): WireNode | undefined {
  return nodeOf(txn, 'body');
}
export function principalOf(txn: WireNode): AccUrl | undefined {
  const h = headerOf(txn);
  return h ? urlOf(h, 'principal') : undefined;
}
export function bodyType(txn: WireNode): number {
  const b = bodyOf(txn);
  return b ? Number(bigOf(b, 'type')) : 0;
}
export function initiatorOf(txn: WireNode): Uint8Array {
  const h = headerOf(txn);
  return h ? bytesOf(h, 'initiator') : new Uint8Array(32);
}
export function holdUntilOf(txn: WireNode): bigint {
  const h = headerOf(txn);
  const hu = h ? nodeOf(h, 'holdUntil') : undefined;
  return hu ? bigOf(hu, 'minorBlock') : 0n;
}

/** Transaction.GetHash. */
export function txnHash(txn: WireNode): Uint8Array {
  return transactionHash(txn);
}

/** Transaction.GetAdditionalAuthorities (protocol/transaction.go): the authorities a body adds. */
export function additionalAuthorities(txn: WireNode): AccUrl[] {
  const body = bodyOf(txn);
  if (!body) return [];
  switch (body.cls) {
    case 'CreateIdentity':
    case 'CreateTokenAccount':
    case 'CreateDataAccount':
    case 'CreateToken':
    case 'CreateKeyBook':
      return urlsOf(body, 'authorities');
    case 'UpdateKeyPage': {
      const out: AccUrl[] = [];
      for (const op of nodesOf(body, 'operation')) {
        if (op.cls === 'AddKeyOperation') {
          const d = delegateOf(nodeOf(op, 'entry'));
          if (d) out.push(d);
        } else if (op.cls === 'UpdateKeyOperation') {
          const d = delegateOf(nodeOf(op, 'newEntry'));
          if (d) out.push(d);
        }
      }
      return out;
    }
    case 'UpdateAccountAuth': {
      const out: AccUrl[] = [];
      for (const op of nodesOf(body, 'operations')) {
        if (op.cls === 'AddAccountAuthorityOperation') {
          const a = urlOf(op, 'authority');
          if (a) out.push(a);
        }
      }
      return out;
    }
  }
  return [];
}

function delegateOf(entry: WireNode | undefined): AccUrl | undefined {
  return entry ? urlOf(entry, 'delegate') : undefined;
}

/** Header.Authorities. */
export function headerAuthorities(txn: WireNode): AccUrl[] {
  const h = headerOf(txn);
  return h ? urlsOf(h, 'authorities') : [];
}

// --------------------------------------------------------------------------------------------------------------------------------
// signatures

/** protocol.UnmarshalSignature of a binary signature. */
export { decodeSignature } from '../sigtypes/verify.js';

/** Signature.Hash: sha256 of the signature's binary encoding (signatureHash). */
export function signatureHash(sig: WireNode): Uint8Array {
  return sha256(encodeNode(sig));
}

export const isDelegated = (s: WireNode): boolean => s.cls === 'DelegatedSignature';
export const isAuthoritySignature = (s: WireNode): boolean => s.cls === 'AuthoritySignature';

/** Signature.GetSigner. */
export function signerOf(sig: WireNode): AccUrl | undefined {
  switch (sig.cls) {
    case 'DelegatedSignature': {
      const inner = nodeOf(sig, 'signature');
      return inner ? signerOf(inner) : undefined;
    }
    case 'AuthoritySignature': {
      // AuthoritySignature.RoutingLocation: the first delegator when there is one, else the account of the transaction id.
      const d = urlsOf(sig, 'delegator');
      if (d.length > 0) return d[0];
      const id = sig.fields.get('txID');
      if (typeof id !== 'string' || id === '') return undefined;
      const u = AccUrl.fromBinary(id);
      return u ? new AccUrl(u.authority, u.path) : undefined;
    }
    default:
      return urlOf(sig, 'signer');
  }
}

/** KeySignature.GetSignerVersion. */
export function signerVersionOf(sig: WireNode): bigint {
  return bigOf(sig, 'signerVersion');
}

/** Signature.GetVote. */
export function voteOf(sig: WireNode): bigint {
  if (sig.cls === 'DelegatedSignature') {
    const inner = nodeOf(sig, 'signature');
    return inner ? voteOf(inner) : 0n;
  }
  return bigOf(sig, 'vote');
}

/** The delegators a signature is wrapped in, outermost first (delegatorPages in xverify.go). */
export function delegatorPages(sig: WireNode): AccUrl[] {
  const out: AccUrl[] = [];
  let cur: WireNode | undefined = sig;
  while (cur && cur.cls === 'DelegatedSignature') {
    const d = urlOf(cur, 'delegator');
    if (d) out.push(d);
    cur = nodeOf(cur, 'signature');
  }
  return out;
}

/** The delegator spelling unwrapSignature records: the normalised URL string of every wrapper, outermost first, and the innermost signature. */
export function unwrapSignature(sig: WireNode, norm: (u: AccUrl) => string): { inner: WireNode; path: string[] } {
  const path: string[] = [];
  let cur = sig;
  while (cur.cls === 'DelegatedSignature') {
    const d = urlOf(cur, 'delegator');
    path.push(d ? norm(d) : '');
    const next = nodeOf(cur, 'signature');
    if (!next) break;
    cur = next;
  }
  return { inner: cur, path };
}

/**
 * protocol.SignatureDidInitiate(sig, txnInitHash, nil): whether the signature (a user signature, unpacked through signature sets,
 * remote and delegated wrappers) is the one the transaction header names as its initiator, by its metadata hash or its merkle
 * initiator hash.
 */
export function signatureDidInitiate(sig: WireNode, initiator: Uint8Array): boolean {
  for (const s of unpackSignature(sig)) {
    if (equal(initiator, metadataHash(s))) return true;
    if (!isUserSignatureNode(s)) continue;
    const h = initiatorHash(s);
    if (!h) return false;
    if (equal(initiator, h)) return true;
  }
  return false;
}

const USER_SIGNATURES = new Set([
  'LegacyED25519Signature', 'ED25519Signature', 'RCD1Signature', 'BTCSignature', 'BTCLegacySignature', 'ETHSignature', 'RsaSha256Signature',
  'EcdsaSha256Signature', 'TypedDataSignature', 'DelegatedSignature', 'SignatureSet', 'RemoteSignature',
]);
const isUserSignatureNode = (s: WireNode): boolean => USER_SIGNATURES.has(s.cls);

function unpackSignature(sig: WireNode): WireNode[] {
  switch (sig.cls) {
    case 'SignatureSet': {
      const out: WireNode[] = [];
      for (const s of nodesOf(sig, 'signatures')) out.push(...unpackSignature(s));
      return out;
    }
    case 'RemoteSignature': {
      const inner = nodeOf(sig, 'signature');
      return inner ? unpackSignature(inner) : [];
    }
    case 'DelegatedSignature': {
      const inner = nodeOf(sig, 'signature');
      if (!inner) return [];
      return unpackSignature(inner).map((s) => ({ ...sig, fields: new Map(sig.fields).set('signature', s) }));
    }
    default:
      return [sig];
  }
}

/** Re-exports the key-signature unwrapping the verifier shares with the signature-type verifier. */
export { unwrap };
