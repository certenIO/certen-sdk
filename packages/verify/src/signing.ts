/**
 * Sign what you see: rebuild the transaction a gateway asks for a signature on, and check it before anything is signed.
 *
 * A gateway returns `hash_to_sign`. Signing that is signing a number: it says nothing about what the signature will
 * authorise, and a gateway (or anything between you and it) that returned the hash of a different transaction would get a
 * valid signature on it. So the gateway also returns the unsigned transaction (Accumulate v3 JSON: header and body, with the
 * exact data blobs) and the signature metadata (signer, version, timestamp), and this module:
 *
 *   1. rebuilds the transaction with accumulate-sdk-opendlt and recomputes its hash,
 *   2. recomputes the signature metadata hash and the signing hash, sha256(sigMdHash || txHash),
 *   3. requires every hash the gateway sent to equal what was recomputed,
 *   4. decodes what the transaction authorises (the legs of an intent, the operations of a governance change), and
 *   5. requires that to match what the caller asked for: principal, chain, every leg's target, value and calldata, expected
 *      events, expiry, additional authorities, and the signing key.
 *
 * Any disagreement is a SigningDataMismatch (SIGNING_DATA_MISMATCH) naming the field, and nothing is signed. Data the
 * gateway did not send is SigningDataAbsent (SIGNING_DATA_ABSENT): there is no blind-signing mode.
 *
 * The recipe is checked against real transactions: test/signing.test.ts rebuilds seven transactions CERTEN put on the
 * Kermit testnet and requires the signature each carries on chain to verify over the recomputed signing hash.
 */
import { createHash } from 'node:crypto';
import { core } from 'accumulate-sdk-opendlt';
import { encodeObject, keccak256, sameUrl, transaction, transactionHash } from './proof-v2/accumulate.js';
import { VerifyError, hexBytes, toHex } from './proof-v2/bytes.js';
import { list, optList, rec, str, uint, type Rec } from './proof-v2/shapes.js';

export const SIGNING_DATA_MISMATCH = 'SIGNING_DATA_MISMATCH';
export const SIGNING_DATA_ABSENT = 'SIGNING_DATA_ABSENT';

/** What the gateway asked to be signed is not what was asked for, or does not hash to what it says it does. Nothing was signed. */
export class SigningDataMismatch extends VerifyError {
  readonly code = SIGNING_DATA_MISMATCH;
  constructor(readonly field: string, readonly expected: unknown, readonly actual: unknown, detail?: string) {
    super(`${SIGNING_DATA_MISMATCH}: ${field}: ${detail ?? 'differs'} (asked for ${show(expected)}, the gateway returned ${show(actual)}). Nothing was signed.`);
  }
}

/** The gateway sent no unsigned transaction or signature metadata to check. There is no mode that signs without them. */
export class SigningDataAbsent extends VerifyError {
  readonly code = SIGNING_DATA_ABSENT;
  constructor(readonly missing: string) {
    super(`${SIGNING_DATA_ABSENT}: the gateway returned no \`${missing}\`, so what would be signed cannot be checked. Nothing was signed, and there is no option to sign without it.`);
  }
}

function show(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'nothing' : s.length > 90 ? `${s.slice(0, 87)}...` : s;
}

// ── inputs ──────────────────────────────────────────────────────────────────────────────────────────

/** `signing_data` as the gateway returns it (single intent, multi-leg, sign request and governance share this shape). */
export interface SigningData {
  transaction_hash?: string;
  /** `POST /v1/transaction` and governance. */
  hash_to_sign?: string;
  /** `POST /v1/sign`: the same bytes under another name. */
  data_for_signature?: string;
  /** The unsigned transaction, Accumulate v3 JSON: `{ header, body }`, with the exact data blobs. */
  transaction?: unknown;
  signature_metadata?: unknown;
}

export interface ExpectedEvent { contract?: string; topic0?: string; topic1?: string }

export interface ExpectedLeg {
  /** The chain's EIP-155 id, when the caller named it. */
  chainId?: number;
  chain?: string;
  /** The contract (or recipient) the leg calls. */
  target?: string;
  /** Wei, as a decimal string or bigint. */
  value?: string | bigint;
  /** 0x-prefixed calldata; `0x` or undefined with `target` set means a plain transfer. */
  callData?: string;
  expectedEvents?: ExpectedEvent[];
}

/** One governance change as the caller asked for it (the gateway's own operation names). */
export type ExpectedOperation =
  | { type: 'add_key' | 'remove_key'; public_key_hash: string }
  | { type: 'set_threshold'; threshold: number | string }
  | { type: 'add_delegate' | 'remove_delegate'; delegate_url: string }
  | { type: 'add_authority' | 'remove_authority'; authority_url: string }
  | { type: 'create_key_page'; public_key_hash: string };

export interface Expectation {
  /** The intent the transaction must be for (blob `intent_id`). */
  intentId?: string;
  /** The identity's ADI URL: a CERTEN intent is written to `<adi>/data`; a governance change must stay inside the ADI. */
  adiUrl?: string;
  /** The exact principal, when the caller knows it. */
  principal?: string;
  legs?: ExpectedLeg[];
  governance?: ExpectedOperation[];
  /** When the caller asked for a deadline, the header must carry exactly it. */
  expiresAt?: Date | string;
  /** The additional authorities the caller asked for. The header must carry exactly these (none, when none were asked for). */
  additionalAuthorities?: string[];
  /** The key that will sign: the signature metadata must name it. */
  signerPublicKey?: string;
  /** The key page that will sign, when the caller named it. */
  signerKeyPage?: string;
}

// ── output ──────────────────────────────────────────────────────────────────────────────────────────

export interface SummaryLeg {
  legId: string;
  role: string;
  chain: string;
  chainId: number;
  from?: string;
  target: string;
  valueWei: string;
  callData: string;
  callDataBytes: number;
  dataHash: string;
  expectedEvents: ExpectedEvent[];
  expectedStateSlots: number;
}

export interface SigningSummary {
  kind: string;
  principal: string;
  memo?: string;
  intentId?: string;
  expiresAt?: string;
  additionalAuthorities: string[];
  signer: { publicKey: string; keyPage: string; keyPageVersion: number; timestampMicros: string; vote?: string };
  legs: SummaryLeg[];
  /** For a governance change: the operations the transaction carries, as Accumulate renders them. */
  operations: unknown[];
  hashes: { transaction: string; signatureMetadata: string; toSign: string };
  /** What a person should read before a signature is made. */
  text: string[];
}

// ── the rebuild ─────────────────────────────────────────────────────────────────────────────────────

const sha256 = (...p: Uint8Array[]): Uint8Array => {
  const h = createHash('sha256');
  for (const x of p) h.update(x);
  return new Uint8Array(h.digest());
};
const norm = (h: unknown): string => String(h ?? '').toLowerCase().replace(/^0x/, '');
const lc = (s: unknown): string => String(s ?? '').toLowerCase();

interface SdkSignature { fromObject(j: unknown): object }

function signatureMetadata(raw: unknown): { json: Rec; publicKey: string; signer: string; signerVersion: number; timestamp: string; vote?: string } {
  const m = rec(raw, 'signature_metadata');
  if (m.type !== 'ed25519') throw new SigningDataMismatch('signature_metadata.type', 'ed25519', m.type, 'only ed25519 signatures are made');
  const publicKey = norm(m.public_key);
  hexBytes(publicKey, 'signature_metadata.public_key', 32);
  const signer = str(m.signer, 'signature_metadata.signer');
  const signerVersion = uint(m.signer_version, 'signature_metadata.signer_version');
  if (signerVersion === 0) throw new SigningDataMismatch('signature_metadata.signer_version', '>= 1', 0);
  const ts = m.timestamp_us;
  const timestamp = typeof ts === 'string' ? ts : String(uint(ts, 'signature_metadata.timestamp_us'));
  if (!/^\d+$/.test(timestamp) || BigInt(timestamp) === 0n) throw new SigningDataMismatch('signature_metadata.timestamp_us', 'a positive integer', ts);
  const vote = m.vote === undefined || m.vote === null || m.vote === '' ? undefined : str(m.vote, 'signature_metadata.vote');
  if (vote !== undefined && !['approve', 'reject', 'abstain'].includes(vote)) throw new SigningDataMismatch('signature_metadata.vote', 'approve | reject | abstain', vote);
  // The signature as Accumulate hashes it: everything but the signature bytes and the transaction hash.
  const json: Rec = { type: 'ed25519', publicKey, signer, signerVersion, timestamp: Number(timestamp), ...(vote ? { vote } : {}) };
  if (!Number.isSafeInteger(json.timestamp)) throw new SigningDataMismatch('signature_metadata.timestamp_us', 'a timestamp below 2^53', ts, 'not representable');
  return { json, publicKey, signer, signerVersion, timestamp, vote };
}

export interface Reconstruction {
  transactionHash: string;
  signatureMetadataHash: string;
  hashToSign: string;
}

/** Recompute the three hashes from the unsigned transaction and the signature metadata. Throws on malformed input only. */
export function reconstructSigning(transactionJson: unknown, metadataJson: unknown): Reconstruction & { initiator: string } {
  const md = signatureMetadata(metadataJson);
  const sig = (core as unknown as { Signature: SdkSignature }).Signature.fromObject(md.json);
  const sigMdHash = sha256(encodeObject(sig));
  const tx = rec(transactionJson, 'transaction');
  const header = { ...rec(tx.header, 'transaction.header') };
  const presented = header.initiator;
  if (presented !== undefined && presented !== null && norm(presented) !== toHex(sigMdHash)) {
    throw new SigningDataMismatch('transaction.header.initiator', toHex(sigMdHash), norm(presented), 'the header does not name the signature metadata that was returned');
  }
  header.initiator = toHex(sigMdHash);
  const t = transaction({ header, body: tx.body }, 'transaction');
  const txHash = transactionHash(t);
  return { transactionHash: toHex(txHash), signatureMetadataHash: toHex(sigMdHash), hashToSign: toHex(sha256(sigMdHash, txHash)), initiator: toHex(sigMdHash) };
}

// ── the check ───────────────────────────────────────────────────────────────────────────────────────

function mustEqual(field: string, expected: unknown, actual: unknown): void {
  if (String(expected) !== String(actual)) throw new SigningDataMismatch(field, expected, actual);
}

/**
 * Rebuild, recompute, compare, decode, and match against what was asked for. Returns the summary of what the signature will
 * authorise; throws SigningDataAbsent or SigningDataMismatch (nothing may be signed) otherwise.
 */
export function verifySigningData(signingData: unknown, expect: Expectation = {}): SigningSummary {
  const sd = rec(signingData, 'signing_data') as SigningData & Rec;
  if (sd.transaction === undefined || sd.transaction === null) throw new SigningDataAbsent('signing_data.transaction');
  if (sd.signature_metadata === undefined || sd.signature_metadata === null) throw new SigningDataAbsent('signing_data.signature_metadata');
  const claimed = sd.hash_to_sign ?? sd.data_for_signature;
  if (!claimed) throw new SigningDataAbsent('signing_data.hash_to_sign');

  const md = signatureMetadata(sd.signature_metadata);
  let rebuilt: ReturnType<typeof reconstructSigning>;
  try {
    rebuilt = reconstructSigning(sd.transaction, sd.signature_metadata);
  } catch (e) {
    if (e instanceof SigningDataMismatch) throw e;
    throw new SigningDataMismatch('transaction', 'a transaction the SDK can rebuild', 'unusable', e instanceof Error ? e.message : String(e));
  }
  if (sd.transaction_hash !== undefined && sd.transaction_hash !== null && norm(sd.transaction_hash) !== rebuilt.transactionHash) {
    throw new SigningDataMismatch('transaction_hash', rebuilt.transactionHash, norm(sd.transaction_hash), 'the transaction returned does not hash to the transaction hash returned');
  }
  if (norm(claimed) !== rebuilt.hashToSign) {
    throw new SigningDataMismatch('hash_to_sign', rebuilt.hashToSign, norm(claimed), 'the hash to sign is not the signing hash of the transaction returned');
  }

  const tx = rec(sd.transaction, 'transaction');
  const header = rec(tx.header, 'transaction.header');
  const body = rec(tx.body, 'transaction.body');
  const principal = str(header.principal, 'transaction.header.principal');

  // The signer: the key that will sign, and the page it signs for.
  if (expect.signerPublicKey !== undefined) mustEqual('signature_metadata.public_key', norm(expect.signerPublicKey), md.publicKey);
  if (expect.signerKeyPage !== undefined && !sameUrl(md.signer, expect.signerKeyPage)) throw new SigningDataMismatch('signature_metadata.signer', expect.signerKeyPage, md.signer);

  // The header.
  if (expect.principal !== undefined && !sameUrl(principal, expect.principal)) throw new SigningDataMismatch('transaction.header.principal', expect.principal, principal);
  const authorities = optList(header.authorities, 'transaction.header.authorities').map((a) => lc(String(a).replace(/\/+$/, '')));
  if (expect.additionalAuthorities !== undefined) {
    const want = expect.additionalAuthorities.map((a) => lc(a.replace(/\/+$/, ''))).sort();
    if (JSON.stringify([...authorities].sort()) !== JSON.stringify(want)) throw new SigningDataMismatch('transaction.header.authorities', want, authorities, 'the transaction would add authorities that were not asked for');
  }
  const expire = header.expire && typeof header.expire === 'object' ? (header.expire as Rec).atTime : undefined;
  const expiresAt = typeof expire === 'string' ? expire : undefined;
  if (expect.expiresAt !== undefined) {
    const want = Math.floor(new Date(expect.expiresAt).getTime() / 1000);
    const got = expiresAt === undefined ? NaN : Math.floor(new Date(expiresAt).getTime() / 1000);
    if (want !== got) throw new SigningDataMismatch('transaction.header.expire.atTime', new Date(expect.expiresAt).toISOString(), expiresAt, 'the deadline differs');
  }

  const base = {
    principal,
    memo: typeof header.memo === 'string' ? header.memo : undefined,
    expiresAt,
    additionalAuthorities: authorities,
    signer: { publicKey: md.publicKey, keyPage: md.signer, keyPageVersion: md.signerVersion, timestampMicros: md.timestamp, ...(md.vote ? { vote: md.vote } : {}) },
    hashes: { transaction: rebuilt.transactionHash, signatureMetadata: rebuilt.signatureMetadataHash, toSign: rebuilt.hashToSign },
  };

  let summary: Omit<SigningSummary, 'text'>;
  if (body.type === 'writeData') {
    summary = { kind: 'cross-chain intent', ...base, ...checkIntent(base.principal, base.memo, body, expect), operations: [] };
  } else {
    summary = { kind: String(body.type), ...base, intentId: undefined, legs: [], ...checkGovernance(principal, body, expect) };
  }
  return { ...summary, text: describe(summary) };
}

// ── a CERTEN intent: writeData with four JSON blobs ─────────────────────────────────────────────────

function parseBlob(hex: unknown, i: number): Rec {
  let j: unknown;
  try {
    j = JSON.parse(Buffer.from(hexBytes(hex, `transaction.body.entry.data[${i}]`)).toString('utf8'));
  } catch (e) {
    throw new SigningDataMismatch(`transaction.body.entry.data[${i}]`, 'a JSON document', 'unreadable', e instanceof Error ? e.message : String(e));
  }
  return rec(j, `transaction.body.entry.data[${i}]`);
}

function checkIntent(principal: string, memo: string | undefined, body: Rec, expect: Expectation): { intentId?: string; legs: SummaryLeg[] } {
  if (memo !== 'CERTEN_INTENT') throw new SigningDataMismatch('transaction.header.memo', 'CERTEN_INTENT', memo, 'a data write that is not a CERTEN intent');
  const entry = rec(body.entry, 'transaction.body.entry');
  if (entry.type !== 'doubleHash') throw new SigningDataMismatch('transaction.body.entry.type', 'doubleHash', entry.type);
  const data = list(entry.data, 'transaction.body.entry.data');
  if (data.length !== 4) throw new SigningDataMismatch('transaction.body.entry.data', '4 blobs (intent, cross-chain, governance, replay)', `${data.length} blobs`);
  const [intent, crossChain] = [parseBlob(data[0], 0), parseBlob(data[1], 1)];
  parseBlob(data[2], 2);
  parseBlob(data[3], 3);
  if (intent.kind !== 'CERTEN_INTENT') throw new SigningDataMismatch('transaction.body.entry.data[0].kind', 'CERTEN_INTENT', intent.kind);

  if (expect.adiUrl !== undefined && !sameUrl(principal, `${expect.adiUrl.replace(/\/+$/, '')}/data`)) {
    throw new SigningDataMismatch('transaction.header.principal', `${expect.adiUrl.replace(/\/+$/, '')}/data`, principal, 'an intent is written to the identity\'s own data account');
  }
  const intentId = typeof intent.intent_id === 'string' ? intent.intent_id : undefined;
  if (expect.intentId !== undefined) {
    mustEqual('transaction.body.entry.data[0].intent_id', expect.intentId, intentId);
    mustEqual('transaction.body.entry.data[1].operationGroupId', expect.intentId, crossChain.operationGroupId);
  }

  const rawLegs = list(crossChain.legs, 'transaction.body.entry.data[1].legs');
  if (intent.leg_count !== undefined) mustEqual('transaction.body.entry.data[0].leg_count', rawLegs.length, intent.leg_count);
  const legs: SummaryLeg[] = rawLegs.map((raw, i) => {
    const leg = rec(raw, `legs[${i}]`);
    const p = rec(leg.executionPayload, `legs[${i}].executionPayload`);
    const callData = lc(str(p.callData, `legs[${i}].executionPayload.callData`));
    if (!/^0x([0-9a-f]{2})*$/.test(callData)) throw new SigningDataMismatch(`legs[${i}].executionPayload.callData`, 'hex', callData);
    const dataHash = lc(str(p.dataHash, `legs[${i}].executionPayload.dataHash`));
    const wantHash = `0x${toHex(keccak256(hexBytes(callData, 'callData')))}`;
    if (dataHash !== wantHash) throw new SigningDataMismatch(`legs[${i}].executionPayload.dataHash`, wantHash, dataHash, 'the calldata shown is not the calldata the leg commits to');
    const chainId = uint(p.chainId, `legs[${i}].executionPayload.chainId`);
    if (leg.chainId !== undefined && uint(leg.chainId, `legs[${i}].chainId`) !== chainId) throw new SigningDataMismatch(`legs[${i}].chainId`, chainId, leg.chainId, 'the leg names one chain and executes on another');
    const value = str(p.value, `legs[${i}].executionPayload.value`);
    if (!/^\d+$/.test(value)) throw new SigningDataMismatch(`legs[${i}].executionPayload.value`, 'a whole number of wei', value);
    return {
      legId: String(leg.legId ?? `leg-${i + 1}`),
      role: String(leg.role ?? ''),
      chain: String(leg.chain ?? ''),
      chainId,
      ...(typeof leg.from === 'string' ? { from: leg.from } : {}),
      target: str(p.target, `legs[${i}].executionPayload.target`),
      valueWei: value,
      callData,
      callDataBytes: (callData.length - 2) / 2,
      dataHash,
      expectedEvents: optList(p.expectedEvents, `legs[${i}].executionPayload.expectedEvents`).map((e) => {
        const r = rec(e, 'expectedEvent');
        return { contract: String(r.contract ?? ''), topic0: String(r.topic0 ?? ''), ...(r.topic1 ? { topic1: String(r.topic1) } : {}) };
      }),
      expectedStateSlots: optList(p.expectedState, `legs[${i}].executionPayload.expectedState`).length,
    };
  });

  if (expect.legs !== undefined) {
    mustEqual('legs', expect.legs.length, legs.length);
    expect.legs.forEach((want, i) => {
      const got = legs[i];
      if (want.chainId !== undefined) mustEqual(`legs[${i}].chainId`, want.chainId, got.chainId);
      if (want.chain !== undefined) mustEqual(`legs[${i}].chain`, lc(want.chain), lc(got.chain));
      if (want.target !== undefined) mustEqual(`legs[${i}].target`, lc(want.target), lc(got.target));
      if (want.value !== undefined) mustEqual(`legs[${i}].value`, BigInt(want.value).toString(), got.valueWei);
      if (want.callData !== undefined || want.target !== undefined) mustEqual(`legs[${i}].callData`, lc(want.callData ?? '0x'), got.callData);
      if (want.expectedEvents !== undefined) {
        const key = (e: ExpectedEvent) => `${lc(e.contract)}|${lc(e.topic0)}|${lc(e.topic1)}`;
        const a = want.expectedEvents.map(key).sort();
        const b = got.expectedEvents.map(key).sort();
        if (JSON.stringify(a) !== JSON.stringify(b)) throw new SigningDataMismatch(`legs[${i}].expectedEvents`, want.expectedEvents, got.expectedEvents);
      }
    });
  }
  return { intentId, legs };
}

// ── a governance change: updateKeyPage / updateAccountAuth / createKeyPage ──────────────────────────

/** The Accumulate rendering of an operation the gateway names. */
function accumulateOperation(op: ExpectedOperation): { body: string; key: string; value: unknown } {
  switch (op.type) {
    case 'add_key': return { body: 'updateKeyPage', key: 'operation', value: { type: 'add', entry: { keyHash: norm(op.public_key_hash) } } };
    case 'remove_key': return { body: 'updateKeyPage', key: 'operation', value: { type: 'remove', entry: { keyHash: norm(op.public_key_hash) } } };
    case 'set_threshold': return { body: 'updateKeyPage', key: 'operation', value: { type: 'setThreshold', threshold: Number(op.threshold) } };
    case 'add_delegate': return { body: 'updateKeyPage', key: 'operation', value: { type: 'add', entry: { delegate: op.delegate_url } } };
    case 'remove_delegate': return { body: 'updateKeyPage', key: 'operation', value: { type: 'remove', entry: { delegate: op.delegate_url } } };
    case 'add_authority': return { body: 'updateAccountAuth', key: 'operations', value: { type: 'addAuthority', authority: op.authority_url } };
    case 'remove_authority': return { body: 'updateAccountAuth', key: 'operations', value: { type: 'removeAuthority', authority: op.authority_url } };
    case 'create_key_page': return { body: 'createKeyPage', key: 'keys', value: { keyHash: norm(op.public_key_hash) } };
  }
}

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Rec).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, y]) => [k, typeof y === 'string' ? y.toLowerCase() : y])) : x));

function checkGovernance(principal: string, body: Rec, expect: Expectation): { operations: unknown[] } {
  const type = String(body.type);
  const field = type === 'updateKeyPage' ? 'operation' : type === 'updateAccountAuth' ? 'operations' : type === 'createKeyPage' ? 'keys' : undefined;
  if (field === undefined) {
    // Not a transaction this verifier knows how to describe. It does not sign what it cannot read.
    throw new SigningDataMismatch('transaction.body.type', 'writeData, updateKeyPage, updateAccountAuth or createKeyPage', type, 'a transaction this SDK cannot describe');
  }
  const operations = optList(body[field], `transaction.body.${field}`);
  if (expect.adiUrl !== undefined) {
    const adi = expect.adiUrl.replace(/\/+$/, '').toLowerCase();
    if (lc(principal) !== adi && !lc(principal).startsWith(`${adi}/`)) throw new SigningDataMismatch('transaction.header.principal', `${expect.adiUrl}/...`, principal, 'a governance change must stay inside the identity');
  }
  if (expect.governance !== undefined) {
    const mapped = expect.governance.map(accumulateOperation);
    const bodies = new Set(mapped.map((m) => m.body));
    if (bodies.size !== 1 || !bodies.has(type)) throw new SigningDataMismatch('transaction.body.type', [...bodies].join('|'), type);
    const want = mapped.map((m) => canon(m.value));
    const got = operations.map(canon);
    if (JSON.stringify(want) !== JSON.stringify(got)) throw new SigningDataMismatch(`transaction.body.${field}`, mapped.map((m) => m.value), operations, 'the change is not the one asked for');
  }
  return { operations };
}

// ── what a person reads ─────────────────────────────────────────────────────────────────────────────

function describe(s: Omit<SigningSummary, 'text'>): string[] {
  const t: string[] = [];
  t.push(`You are about to sign: ${s.kind}${s.intentId ? ` (intent ${s.intentId})` : ''}`);
  t.push(`  written to        ${s.principal}`);
  t.push(`  signed as         key ${s.signer.publicKey.slice(0, 16)}... on ${s.signer.keyPage} (page version ${s.signer.keyPageVersion})`);
  if (s.expiresAt) t.push(`  expires           ${s.expiresAt}`);
  if (s.additionalAuthorities.length) t.push(`  also requires     ${s.additionalAuthorities.join(', ')}`);
  for (const l of s.legs) {
    const call = l.callDataBytes === 0 ? 'plain transfer' : `call with ${l.callDataBytes} bytes of calldata (${l.callData.slice(0, 10)}${l.callDataBytes > 4 ? '...' : ''})`;
    t.push(`  ${l.legId.padEnd(8)}          ${l.chain} (chain ${l.chainId}): ${call} to ${l.target}, value ${l.valueWei} wei`);
    for (const e of l.expectedEvents) t.push(`                    must emit ${(e.topic0 ?? "").slice(0, 18)}... from ${e.contract}${e.topic1 ? ` (first argument ${e.topic1.slice(0, 18)}...)` : ''}`);
  }
  for (const op of s.operations) t.push(`  change            ${JSON.stringify(op)}`);
  t.push(`  signing hash      ${s.hashes.toSign}`);
  return t;
}

