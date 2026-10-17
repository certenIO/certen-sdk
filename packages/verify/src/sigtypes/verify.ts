/**
 * Verification of every key-signature type Accumulate's executor accepts on a key page, from the signature's bytes.
 *
 * This is the TypeScript half of the validator's `govsig` package (liteclient/proof/govsig, branch pv2/rb8-b-every-key-signature-
 * type), and it reaches the same verdict, key hash and digest form on every shared vector (test/fixtures/sigtypes, 154 vectors).
 * The rule is Accumulate's, derived from its code at the commit Kermit runs (e1d1db9ebb7c; research R8):
 *
 *     A signature is a countable key signature iff, after unwrapping at most 20 DelegatedSignature layers, the innermost value
 *     is one of ed25519, legacyED25519, rcd1, btc, btclegacy, eth, rsaSha256, ecdsaSha256, typedData; the OUTERMOST signature
 *     verifies over the transaction by that type's own rule; (typedData) its chain id is the network's; the executor version
 *     the evidence proves at the signature's block registers the type; and the innermost key's hash is an entry of the signer
 *     page as of that block (the page is the caller's: this module reports the hash).
 *
 * Nothing is trusted from a label: a signature is decoded from Accumulate's binary encoding, the type is the one its own first
 * field names, and the digest is recomputed from the decoded fields. A type label cannot be swapped because the type is inside
 * the signed metadata hash.
 *
 * Verdicts are the shared vectors' vocabulary: "accepted"; "refused:<reason>" for a genuine rejection of the signature or of
 * the evidence's consistency; "named:<state>" for the verifier saying it cannot judge - never a weaker answer shaped like the
 * strong one.
 */
import { core } from 'accumulate-sdk-opendlt';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { keccak_256 } from '@noble/hashes/sha3';
import { merkleHashList, sha256, uvarint } from '../proof-v2/bytes.js';
import { btcVerify, ecdsaAsn1Verify, ed25519Verify, ethVerify, rsaPkcs1v15Sha256Verify, secp256k1Point, secp256k1Verify } from './curves.js';
import { laxSecp256k1Signature, parsePkcs1Rsa, parseSpkiEcdsa } from './der.js';
import { eip712Hash } from './eip712.js';
import { checkExecutorGate, EthRule, ethChainId, type EthRuleName, type Where } from './gate.js';
import { transactionHash } from './txhash.js';
import { binaryBytes, goText } from './gourl.js';
import { decodeObject, decodeUnion, encodeNode, WireError, type Value, type WireNode } from './wire.js';

/** protocol.DelegationDepthLimit. */
export const DELEGATION_DEPTH_LIMIT = 20;

/** The digest forms (govsig FormMetadata / FormMerkle / FormEIP712 / FormV1Rule). */
export const Form = { Metadata: 'metadata', Merkle: 'initiator-merkle', EIP712: 'eip712', V1Rule: 'v1-rule' } as const;
export type FormName = (typeof Form)[keyof typeof Form];

const ST = core.SignatureType as unknown as Record<string, number> & { getName(v: number): string };

/** The nine accepted key-signature types, by SDK class, with the SDK's own enum value (whose name is Accumulate's JSON name). */
const KEY_CLASSES: Readonly<Record<string, number>> = {
  LegacyED25519Signature: ST.LegacyED25519!,
  ED25519Signature: ST.ED25519!,
  RCD1Signature: ST.RCD1!,
  BTCSignature: ST.BTC!,
  BTCLegacySignature: ST.BTCLegacy!,
  ETHSignature: ST.ETH!,
  RsaSha256Signature: ST.RsaSha256!,
  EcdsaSha256Signature: ST.EcdsaSha256!,
  TypedDataSignature: ST.TypedData!,
};
/** Signature classes that exist but are not a user's key signature over a transaction. */
const NON_KEY_CLASSES: Readonly<Record<string, number>> = {
  AuthoritySignature: ST.Authority!,
  PartitionSignature: ST.Partition!,
  ReceiptSignature: ST.Receipt!,
  RemoteSignature: ST.Remote!,
  SignatureSet: ST.Set!,
  InternalSignature: ST.Internal!,
};
const DELEGATED_CLASS = 'DelegatedSignature';

/** Accumulate's name for the accepted types, in the order the validator lists them. */
export const ACCEPTED_KEY_TYPES: readonly string[] = Object.values(KEY_CLASSES).map((v) => ST.getName(v));

function typeNameOf(cls: string): string {
  const v = KEY_CLASSES[cls] ?? NON_KEY_CLASSES[cls] ?? (cls === DELEGATED_CLASS ? ST.Delegated : undefined);
  return v === undefined ? cls : ST.getName(v);
}

/** The sentence that states the real rule, for every refusal that names a type. */
export function typeRule(): string {
  return `CERTEN verifies exactly the key-signature types Accumulate's executor accepts on a key page (${ACCEPTED_KEY_TYPES.join(', ')}), directly or as the innermost signature of a delegation chain of at most ${DELEGATION_DEPTH_LIMIT} layers`;
}

// ------------------------------------------------------------------ typed refusals

export class SigtypeError extends Error {
  constructor(
    readonly verdict: string,
    message: string,
  ) {
    super(message);
  }
}
export class NotKeySignature extends SigtypeError {
  constructor(readonly type: string) {
    super('refused:not_a_key_signature', `not a key signature (type: ${type}): only a user's key signature over a transaction is a vote; ${typeRule()}`);
  }
}
export class DelegationDepthExceeded extends SigtypeError {
  constructor(readonly depth: number) {
    super('refused:delegation_depth_exceeded', `delegation chain is ${depth} deep, exceeding DelegationDepthLimit of ${DELEGATION_DEPTH_LIMIT}`);
  }
}
export class SignatureInvalid extends SigtypeError {
  constructor(
    readonly type: string,
    readonly forms: readonly string[],
  ) {
    super('refused:signature_invalid', `signature verification failed against all ${forms.length} accepted digest form(s) (${forms.join(', ')}) for a ${type} signature`);
  }
}
export class TransactionUnavailableForTypedData extends SigtypeError {
  constructor(readonly txHash: string) {
    super(
      'named:transaction_unavailable_for_typed_data',
      `a typedData signature signs the EIP-712 encoding of the whole transaction, not its hash; the transaction ${txHash} was not supplied, so the signature cannot be verified. This is NOT a governance rejection`,
    );
  }
}
export class NetworkNameUnproven extends SigtypeError {
  constructor() {
    super(
      'named:network_name_unproven',
      "a typedData signature carries the network's EIP-155 chain id, derived from the network's name; the name was not supplied, so the chain id cannot be checked. This is NOT a governance rejection",
    );
  }
}
export class TypedDataChainIdMismatch extends SigtypeError {
  constructor(
    readonly want: string,
    readonly got: string,
    readonly networkName: string,
  ) {
    super('refused:typed_data_chain_id_mismatch', `invalid chain ID: want ${want} (network "${networkName}"), got ${got}`);
  }
}
/** Any other refusal the evidence's own consistency forces (a supplied transaction that does not hash to the governed one, a key with no hash). */
export class EvidenceInconsistent extends SigtypeError {
  constructor(message: string) {
    super('refused:other', message);
  }
}

// Re-exported so a caller needs one import for every named state.
export { ExecutorGateNotMet, ExecutorVersionUnproven } from './gate.js';

/** The shared vectors' verdict string for a thrown error (or "accepted" for none). */
export function verdictOf(err: unknown): string {
  if (err === undefined || err === null) return 'accepted';
  if (err instanceof SigtypeError) return err.verdict;
  if (err instanceof WireError) return 'refused:undecodable';
  const v = (err as { verdict?: unknown }).verdict;
  return typeof v === 'string' ? v : 'refused:other';
}

// ------------------------------------------------------------------ decoding

/**
 * protocol.UnmarshalSignature: the first field names the type, which names the class. The empty object decodes to no signature
 * at all (null), exactly as Accumulate returns a nil Signature with no error; that is not a key signature.
 */
export function decodeSignature(bytes: Uint8Array): WireNode | null {
  return decodeUnion('Signature', bytes);
}

/** protocol.Transaction.UnmarshalBinary. */
export function decodeTransaction(bytes: Uint8Array): WireNode {
  return decodeObject('Transaction', bytes);
}

const isNode = (v: Value | undefined): v is WireNode => typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && 'cls' in v && 'fields' in v;
const bytesOf = (n: WireNode, name: string): Uint8Array => {
  const v = n.fields.get(name);
  return v instanceof Uint8Array ? v : new Uint8Array(0);
};
const stringOf = (n: WireNode, name: string): string => {
  const v = n.fields.get(name);
  return typeof v === 'string' ? v : '';
};
const bigOf = (n: WireNode, name: string): bigint => {
  const v = n.fields.get(name);
  return typeof v === 'bigint' ? v : 0n;
};

// ------------------------------------------------------------------ unwrapping (sig_user.go unwrapDelegated)

export interface Unwrapped {
  inner: WireNode;
  /** The delegators' pages, OUTERMOST first. */
  delegators: string[];
}

function isUserSignature(cls: string): boolean {
  return cls in KEY_CLASSES || cls === DELEGATED_CLASS;
}

/** govsig.Unwrap: descend through DelegatedSignature layers to the innermost value, which must be an accepted key signature. */
export function unwrap(sig: WireNode): Unwrapped {
  const delegators: string[] = [];
  let cur: WireNode | undefined = sig;
  for (;;) {
    if (!cur) throw new NotKeySignature('nil');
    if (cur.cls === DELEGATED_CLASS) {
      delegators.push(stringOf(cur, 'delegator'));
      if (delegators.length > DELEGATION_DEPTH_LIMIT) throw new DelegationDepthExceeded(delegators.length);
      const next: Value | undefined = cur.fields.get('signature');
      cur = isNode(next) ? next : undefined;
      continue;
    }
    if (cur.cls in KEY_CLASSES) return { inner: cur, delegators };
    throw new NotKeySignature(typeNameOf(cur.cls));
  }
}

// ------------------------------------------------------------------ digests (signature_utils.go, signature.go)

/** Signature.Metadata(): the signature with its signature bytes and transaction hash cleared, recursing through delegation. */
function metadataNode(n: WireNode): WireNode {
  if (n.cls === DELEGATED_CLASS) {
    const fields = new Map(n.fields);
    const inner = n.fields.get('signature');
    if (isNode(inner)) fields.set('signature', metadataNode(inner));
    return { ...n, fields };
  }
  const fields = new Map(n.fields);
  fields.delete('signature');
  fields.delete('transactionHash');
  return { ...n, fields };
}

/** Signature.Metadata().Hash(): sha256 of the metadata's binary encoding. */
export function metadataHash(sig: WireNode): Uint8Array {
  return sha256(encodeNode(metadataNode(sig)));
}

/**
 * Signature.Initiator().MerkleHash(): the merkle root of [H(publicKey), H(signer), H(signerVersion), H(timestamp)] and then
 * H(delegator) for each delegator, innermost first - or undefined when the signature cannot initiate (rsaSha256 and
 * ecdsaSha256 never can; the others need a key, a signer, a non-zero version and a non-zero timestamp).
 */
export function initiatorHash(sig: WireNode): Uint8Array | undefined {
  const leaves = initiatorLeaves(sig);
  return leaves ? merkleHashList(leaves) : undefined;
}

function initiatorLeaves(n: WireNode): Uint8Array[] | undefined {
  if (n.cls === DELEGATED_CLASS) {
    const delegator = stringOf(n, 'delegator');
    const inner = n.fields.get('signature');
    if (delegator === '' || !isNode(inner)) return undefined;
    const leaves = initiatorLeaves(inner);
    if (!leaves) return undefined;
    return [...leaves, sha256(binaryBytes(delegator))];
  }
  if (n.cls === 'RsaSha256Signature' || n.cls === 'EcdsaSha256Signature' || !(n.cls in KEY_CLASSES)) return undefined;
  const key = bytesOf(n, 'publicKey');
  const signer = stringOf(n, 'signer');
  const version = bigOf(n, 'signerVersion');
  const timestamp = bigOf(n, 'timestamp');
  if (key.length === 0 || signer === '' || version === 0n || timestamp === 0n) return undefined;
  return [sha256(key), sha256(binaryBytes(signer)), sha256(uvarint(version)), sha256(uvarint(timestamp))];
}

// ------------------------------------------------------------------ the per-type rules (Verify methods)

interface Message {
  hash: Uint8Array;
  transaction?: WireNode;
}

/**
 * verifySig / verifySigSplit: the digest sha256(H || messageHash) (legacyED25519: sha256(H || uvarint(timestamp) || messageHash))
 * is tried with H the OUTER signature's metadata hash and then, when the type may initiate by merkle hash, its initiator merkle
 * hash. Returns which one verified.
 */
function verifyDigests(
  outer: WireNode,
  merkle: boolean,
  hash: Uint8Array,
  verify: (digest: Uint8Array) => boolean,
  legacyTimestamp?: bigint,
): typeof Form.Metadata | typeof Form.Merkle | undefined {
  const digest = (first: Uint8Array): Uint8Array => (legacyTimestamp === undefined ? sha256(first, hash) : sha256(first, uvarint(legacyTimestamp), hash));
  if (verify(digest(metadataHash(outer)))) return Form.Metadata;
  if (!merkle) return undefined;
  const init = initiatorHash(outer);
  if (!init) return undefined;
  return verify(digest(init)) ? Form.Merkle : undefined;
}

/** A key signature's own Verify(outer, message), under the version-1 DER rule for eth when `v1`. Returns the digest form that verified. */
function verifyInner(inner: WireNode, outer: WireNode, msg: Message, v1: boolean): FormName | undefined {
  const pub = bytesOf(inner, 'publicKey');
  const sig = bytesOf(inner, 'signature');
  switch (inner.cls) {
    case 'ED25519Signature':
    case 'RCD1Signature':
      if (pub.length !== 32 || sig.length !== 64) return undefined;
      return verifyDigests(outer, true, msg.hash, (d) => ed25519Verify(pub, d, sig));
    case 'LegacyED25519Signature':
      if (pub.length !== 32 || sig.length !== 64) return undefined;
      return verifyDigests(outer, true, msg.hash, (d) => ed25519Verify(pub, d, sig), bigOf(inner, 'timestamp'));
    case 'BTCSignature':
    case 'BTCLegacySignature':
      return verifyBtc(outer, msg.hash, pub, sig);
    case 'ETHSignature': {
      if (v1) return verifyBtc(outer, msg.hash, pub, sig);
      const rs = sig.length === 65 ? sig.subarray(0, 64) : sig;
      return verifyDigests(outer, true, msg.hash, (d) => ethVerify(pub, d, rs));
    }
    case 'RsaSha256Signature': {
      const key = parsePkcs1Rsa(pub);
      if (!key || Math.ceil(key.n.toString(2).length / 8) !== sig.length) return undefined;
      return verifyDigests(outer, false, msg.hash, (d) => rsaPkcs1v15Sha256Verify(pub, d, sig));
    }
    case 'EcdsaSha256Signature':
      if (!parseSpkiEcdsa(pub)) return undefined;
      return verifyDigests(outer, false, msg.hash, (d) => ecdsaAsn1Verify(pub, d, sig));
    case 'TypedDataSignature': {
      // EIP-712 cannot sign anything but a transaction.
      if (!msg.transaction) return undefined;
      let digest: Uint8Array;
      try {
        digest = eip712Hash(msg.transaction, outer);
      } catch {
        return undefined;
      }
      const rs = sig.length === 65 ? sig.subarray(0, 64) : sig;
      return ethVerify(pub, digest, rs) ? Form.EIP712 : undefined;
    }
  }
  return undefined;
}

/** BTCSignature.Verify (and the version-1 eth rule): the signature and key are parsed first, a failure of either is a failure. */
function verifyBtc(outer: WireNode, hash: Uint8Array, pub: Uint8Array, sig: Uint8Array): FormName | undefined {
  const rs = laxSecp256k1Signature(sig);
  if (!rs) return undefined;
  const pt = secp256k1Point(pub);
  if (!pt) return undefined;
  return verifyDigests(outer, true, hash, (d) => secp256k1Verify(pt, d, rs.r, rs.s));
}

function formsTried(innerCls: string): string[] {
  switch (innerCls) {
    case 'TypedDataSignature':
      return [Form.EIP712];
    case 'RsaSha256Signature':
    case 'EcdsaSha256Signature':
      return [Form.Metadata];
    default:
      return [Form.Metadata, Form.Merkle];
  }
}

// ------------------------------------------------------------------ key hash (PublicKeyHash)

/** protocol.ETHhash: the last 20 bytes of keccak256 of the uncompressed point without its 0x04; undefined when the key does not parse. */
export function ethHash(key: Uint8Array): Uint8Array | undefined {
  const pt = secp256k1Point(key);
  return pt ? keccak_256(pt.subarray(1)).slice(12) : undefined;
}

/**
 * protocol.PublicKeyHash(key, type): sha256(key) for ed25519, legacyED25519, rsaSha256 and ecdsaSha256; sha256(sha256(0x01||key))
 * for rcd1; ripemd160(sha256(key)) for btc and btclegacy; the keccak address for eth and typedData. Undefined when no hash exists
 * (a key that does not parse as the type's key).
 */
export function publicKeyHash(cls: string, key: Uint8Array): Uint8Array | undefined {
  switch (cls) {
    case 'ED25519Signature':
    case 'LegacyED25519Signature':
    case 'RsaSha256Signature':
    case 'EcdsaSha256Signature':
      return sha256(key);
    case 'RCD1Signature': {
      const k = new Uint8Array(32);
      k.set(key.subarray(0, 32));
      return sha256(sha256(Uint8Array.of(1), k));
    }
    case 'BTCSignature':
    case 'BTCLegacySignature':
      return ripemd160(sha256(key));
    case 'ETHSignature':
    case 'TypedDataSignature':
      return ethHash(key);
  }
  return undefined;
}

// ------------------------------------------------------------------ the verdict

export interface VerifyEnv {
  /** The governed transaction's hash: the message every type but typedData signs. */
  txHash: Uint8Array;
  /** The full governed transaction, decoded. typedData signs an EIP-712 encoding of the whole transaction, so it cannot be verified without it. */
  transaction?: WireNode;
  /** The network's name ("DevNet" on Kermit); typedData's chain id is derived from it. */
  networkName?: string;
  /** Where the signature was recorded, for the executor-version gate. Absent: a gated type is then a named state, never accepted. */
  where?: Where;
}

export interface Verified {
  /** The innermost key signature. */
  inner: WireNode;
  /** Accumulate's name for the innermost type ("ecdsaSha256"). */
  innerType: string;
  /** The delegators' pages, outermost first. */
  delegators: string[];
  /** The page-entry hash of the innermost key. */
  keyHash: Uint8Array;
  form: FormName;
  ethRule: EthRuleName;
}

/**
 * govsig.Verify: verify `sig` (decoded) exactly as Accumulate's executor does, or throw the typed refusal / named state.
 * The result says what was established; whether the key hash is on the signer's page at the signature's block is the caller's
 * (it holds the page).
 */
export function verifyKeySignature(sig: WireNode | null, env: VerifyEnv): Verified {
  if (!sig) throw new NotKeySignature('nil');
  if (!isUserSignature(sig.cls)) throw new NotKeySignature(typeNameOf(sig.cls));
  const { inner, delegators } = unwrap(sig);
  const typed = inner.cls === 'TypedDataSignature';
  const innerType = typeNameOf(inner.cls);

  const msg: Message = { hash: env.txHash };
  if (typed) {
    if (!env.transaction) throw new TransactionUnavailableForTypedData(Buffer.from(env.txHash).toString('hex'));
    let h: Uint8Array;
    try {
      h = transactionHash(env.transaction);
    } catch (e) {
      throw new EvidenceInconsistent(`the supplied transaction cannot be hashed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (Buffer.compare(h, env.txHash) !== 0) {
      throw new EvidenceInconsistent(`the supplied transaction hashes to ${Buffer.from(h).toString('hex')}, not to ${Buffer.from(env.txHash).toString('hex')}`);
    }
    msg.transaction = env.transaction;
  }

  // The verdict: Accumulate's own Verify on the OUTERMOST signature.
  let rule: EthRuleName = EthRule.None;
  let form = verifyInner(inner, sig, msg, false);
  if (form && inner.cls === 'ETHSignature') rule = EthRule.V2RSV;
  // protocol.VerifyUserSignatureV1 re-casts only a signature that is an eth signature itself, not one inside a delegation.
  if (!form && sig.cls === 'ETHSignature') {
    form = verifyInner(inner, sig, msg, true);
    if (form) {
      rule = EthRule.V1DER;
      form = Form.V1Rule;
    }
  }
  if (!form) throw new SignatureInvalid(innerType, formsTried(inner.cls));

  if (typed) {
    if (!env.networkName || env.networkName.trim() === '') throw new NetworkNameUnproven();
    const want = ethChainId(env.networkName);
    const got = inner.fields.get('chainID');
    if (typeof got !== 'bigint' || got !== want) {
      throw new TypedDataChainIdMismatch(want.toString(10), typeof got === 'bigint' ? got.toString(10) : '<none>', env.networkName);
    }
  }

  checkExecutorGate(innerType, rule, env.where);

  const keyHash = publicKeyHash(inner.cls, bytesOf(inner, 'publicKey'));
  if (!keyHash || keyHash.length === 0) {
    throw new EvidenceInconsistent(`the ${innerType} key ${Buffer.from(bytesOf(inner, 'publicKey')).toString('hex')} has no key hash (it does not parse as a ${innerType} key)`);
  }
  return { inner, innerType, delegators: delegators.map(goText), keyHash, form, ethRule: rule };
}

/** Decode `signatureBytes` then verify it: the one-call form for evidence that carries Accumulate's binary signature. */
export function verifySignatureBytes(signatureBytes: Uint8Array, env: VerifyEnv): Verified {
  return verifyKeySignature(decodeSignature(signatureBytes), env);
}
