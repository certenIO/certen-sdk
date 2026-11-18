/**
 * The principal's own CERTEN entries (AGT-2 WP1, finding AGT-F20): the subject registration (GR-62 registry, subject type agent), the
 * Grant (certen.grant/v1) and the mandate (certen.mandate/v1), each written to the principal's own data account
 * (`<principal>/certen-subjects`, `certen-grants`, `certen-mandates`) through the gateway's two-phase governance route
 * (`create_data_account`, `write_data`). Every Accumulate transaction is signed by the principal's own key page, and every entry carries an
 * envelope the principal's key signed: nothing is signed by the gateway or the bridge.
 *
 * The bytes are the core's (transaction-controls packages/core and packages/agent): element 0 is the RFC 8785 canonical text of the
 * document, element 1 the canonical text of its envelope {payloadTag, payloadHash, signatures}; payloadHash = SHA-256(lp(tag) ||
 * lp(canonical text)) and a key signs SHA-256(lp("certen:envelope-sig:v1") || lp(tag) || lp(hash bytes) || lp(page)), lp = 4-byte
 * big-endian length then the bytes. The cross-repo vector test (test/principal-entries.vectors.test.ts) holds these to the tcl vectors.
 *
 * Before anything is signed or sent, every document is judged by the CORE's own profile functions (AGT-F25): validateGrant,
 * validateRegistration and the mandate shape (mandateShape), byte-pinned copies of transaction-controls in src/core and src/agent
 * (scripts/sync-core.mjs, src/core/PIN.json; src/agent/core.ts is this package's own unpinned shim). A refusal is
 * PRINCIPAL_ENTRY_REFUSED_BY_CORE with the core's reason; nothing of the profile is re-implemented here.
 */
import { CertenError } from './errors.js';
import { bytesToHex, concatBytes, hexToBytes, utf8 } from './bytes.js';
import { sha256 } from './sha256.js';
import { checkGovernanceSigning } from './signing-check.js';
import type { CertenClient } from './client.js';
import { parseGrantTextUnhashed, validateGrant } from './core/grant-profile.js';
import { parseRegistrationTextUnhashed, validateRegistration } from './core/registry-profile.js';
import { canonicalize } from './core/jcs.js';
import { mandateShape } from './agent/mandate.js';

export const ENTRY_TAGS = {
  grant: 'certen:grant:v1',
  subject: 'certen:subject:v1',
  subject2: 'certen:subject:v2',
  mandate: 'certen:mandate:v1',
  envelopeSig: 'certen:envelope-sig:v1',
} as const;

export const PRINCIPAL_ACCOUNTS = { registration: 'certen-subjects', grant: 'certen-grants', mandate: 'certen-mandates' } as const;
export type PrincipalEntryKind = keyof typeof PRINCIPAL_ACCOUNTS;

const SCHEMAS: Record<PrincipalEntryKind, string[]> = {
  registration: ['certen.subject/v2'],
  grant: ['certen.grant/v1'],
  mandate: ['certen.mandate/v1'],
};

/** A refusal before anything is sent or signed. */
export const PRINCIPAL_ENTRY_MALFORMED = 'PRINCIPAL_ENTRY_MALFORMED';
export const PRINCIPAL_ENTRY_NOT_PRINCIPALS = 'PRINCIPAL_ENTRY_NOT_PRINCIPALS';
export const PRINCIPAL_PAGE_INVALID = 'PRINCIPAL_PAGE_INVALID';
export const PRINCIPAL_WRITE_UNSIGNED = 'PRINCIPAL_WRITE_UNSIGNED';
/** The core's profile function refused the document; `details` carries the core's {reason, detail}. */
export const PRINCIPAL_ENTRY_REFUSED_BY_CORE = 'PRINCIPAL_ENTRY_REFUSED_BY_CORE';
const refuse = (code: string, message: string): never => { throw new CertenError(message, 0, code); };

// ── RFC 8785 canonical JSON (the subset the core's documents use) ─────────────────────────────────────────

/**
 * RFC 8785 canonical text of a JSON value: object members sorted by UTF-16 code units, no whitespace, strings and integers in their
 * ECMAScript serialization. Refused (PRINCIPAL_ENTRY_MALFORMED): a number that is not a safe integer, a lone surrogate, undefined, a
 * function, a Date / Map / typed array or any other non-plain object, and nesting deeper than 64.
 */
export function canonicalJson(value: unknown): string {
  return canon(value, 0);
}

function canon(v: unknown, depth: number): string {
  if (depth > 64) refuse(PRINCIPAL_ENTRY_MALFORMED, 'nested more than 64 levels');
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) refuse(PRINCIPAL_ENTRY_MALFORMED, `the number ${String(v)} is not a safe integer`);
    return Object.is(v, -0) ? '0' : String(v);
  }
  if (typeof v === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)) refuse(PRINCIPAL_ENTRY_MALFORMED, 'a string holds a lone surrogate');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => canon(x, depth + 1)).join(',')}]`;
  if (typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return `{${keys.map((k) => {
      if (o[k] === undefined) refuse(PRINCIPAL_ENTRY_MALFORMED, `member ${k} is undefined`);
      return `${canon(k, depth + 1)}:${canon(o[k], depth + 1)}`;
    }).join(',')}}`;
  }
  return refuse(PRINCIPAL_ENTRY_MALFORMED, `a ${typeof v} is not JSON`);
}

// ── the core's tagged hashes ──────────────────────────────────────────────────────────────────────────────

const lp = (b: Uint8Array): Uint8Array => {
  const n = new Uint8Array(4);
  new DataView(n.buffer).setUint32(0, b.length, false);
  return concatBytes(n, b);
};

/** lp(tag) || lp(field) || ... */
export function taggedPreimage(tag: string, fields: Uint8Array[]): Uint8Array {
  return concatBytes(lp(utf8(tag)), ...fields.map(lp));
}

const hex0x = (b: Uint8Array): string => '0x' + bytesToHex(b);

/** The tag a document is hashed and signed under: by its kind, and for a registration by its schema. */
export function entryTag(kind: PrincipalEntryKind, document: Record<string, unknown>): string {
  if (kind === 'grant') return ENTRY_TAGS.grant;
  if (kind === 'mandate') return ENTRY_TAGS.mandate;
  return document.schema === 'certen.subject/v2' ? ENTRY_TAGS.subject2 : ENTRY_TAGS.subject;
}

/** The payload hash of a document: SHA-256(lp(tag) || lp(canonical text)), 0x + lowercase hex. */
export function entryHash(kind: PrincipalEntryKind, document: Record<string, unknown>): string {
  return hex0x(sha256(taggedPreimage(entryTag(kind, document), [utf8(canonicalJson(document))])));
}

/** What a key signs for an envelope: SHA-256(lp("certen:envelope-sig:v1") || lp(tag) || lp(hash bytes) || lp(page)), as hex. */
export function envelopeDigestHex(payloadTag: string, payloadHash: string, page: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(payloadHash)) refuse(PRINCIPAL_ENTRY_MALFORMED, 'payloadHash must be 0x + 64 lowercase hex');
  return bytesToHex(sha256(taggedPreimage(ENTRY_TAGS.envelopeSig, [utf8(payloadTag), hexToBytes(payloadHash.slice(2)), utf8(page)])));
}

// ── the entry ─────────────────────────────────────────────────────────────────────────────────────────────

/** The principal's signing key: an ed25519 key on the principal's page. `sign` signs 32 bytes given as hex and returns 64 bytes as hex. */
export interface PrincipalSigner {
  publicKey: string;
  sign(hashHex: string): string;
}

export interface PrincipalEntry {
  kind: PrincipalEntryKind;
  account: string;
  tag: string;
  hash: string;
  /** element 0 (the document) and element 1 (the envelope), canonical text */
  texts: [string, string];
  /** the same two elements as lowercase hex of their UTF-8 bytes: what write_data carries and what is hashed on chain */
  elements: [string, string];
}

const ACC = /^acc:\/\/[a-z0-9][a-z0-9._-]*\.acme(\/[a-z0-9][a-z0-9._-]*)*$/;
const isObj = (o: unknown): o is Record<string, unknown> => o !== null && typeof o === 'object' && !Array.isArray(o);

/** The principal's book a document names: grant.grantor.keyBook, mandate.principal.keyBook, registration.principal.keyBook. */
function principalBookOf(kind: PrincipalEntryKind, d: Record<string, unknown>): unknown {
  const holder = kind === 'grant' ? d.grantor : d.principal;
  return isObj(holder) ? holder.keyBook : undefined;
}

/**
 * Build the entry the principal writes: the canonical document, and an envelope over it signed by the principal's key for the principal's
 * page. Refused before anything is signed: an unknown schema, a document that is not the principal's (its principal book is not the book
 * of the signing page), a page outside the principal's ADI, a key that is not hex.
 */
export function buildPrincipalEntry(a: { kind: PrincipalEntryKind; principal: string; page: string; document: unknown; signer: PrincipalSigner }): PrincipalEntry {
  const { kind } = a;
  if (!(kind in PRINCIPAL_ACCOUNTS)) refuse(PRINCIPAL_ENTRY_MALFORMED, `unknown entry kind ${String(kind)}`);
  const adi = typeof a.principal === 'string' ? a.principal.toLowerCase().replace(/\/+$/, '') : '';
  if (!ACC.test(adi) || adi.split('/').length !== 3) refuse(PRINCIPAL_PAGE_INVALID, 'the principal must be an ADI URL');
  const page = typeof a.page === 'string' ? a.page.toLowerCase() : '';
  const book = page.replace(/\/[0-9]+$/, '');
  if (!ACC.test(page) || !/\/[0-9]+$/.test(page) || !book.startsWith(adi + '/')) refuse(PRINCIPAL_PAGE_INVALID, 'the signing page must be a key page of the principal\'s own book');
  if (!isObj(a.document)) refuse(PRINCIPAL_ENTRY_MALFORMED, 'the document must be a JSON object');
  const d = a.document as Record<string, unknown>;
  if (!SCHEMAS[kind].includes(String(d.schema))) refuse(PRINCIPAL_ENTRY_MALFORMED, `a ${kind} entry must carry schema ${SCHEMAS[kind].join(' or ')}`);
  if (principalBookOf(kind, d) !== book) refuse(PRINCIPAL_ENTRY_NOT_PRINCIPALS, `the ${kind} names another principal book than ${book}, the book of the signing page`);
  if (kind === 'registration' && d.type !== 'agent') refuse(PRINCIPAL_ENTRY_MALFORMED, 'an agent registration carries subject type agent');
  // The core's own judgement of the document, before any key is used or anything is sent (AGT-F25).
  const core = coreVerdict(kind, d);
  if (core !== null) throw new CertenError(`the core refuses this ${kind}: ${core.reason}${core.detail ? ` (${core.detail})` : ''}`, 0, PRINCIPAL_ENTRY_REFUSED_BY_CORE, { details: core });
  if (!/^[0-9a-f]{64}$/.test(String(a.signer?.publicKey ?? ''))) refuse(PRINCIPAL_ENTRY_MALFORMED, 'the signer\'s public key must be 32 bytes of lowercase hex (ed25519)');
  const text = canonicalJson(d);
  const tag = entryTag(kind, d);
  const hash = entryHash(kind, d);
  const signature = String(a.signer.sign(envelopeDigestHex(tag, hash, page))).replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(signature)) refuse(PRINCIPAL_WRITE_UNSIGNED, 'the signer returned no 64-byte signature');
  const envelope = canonicalJson({ payloadTag: tag, payloadHash: hash, signatures: [{ alg: 'ed25519', page, publicKey: a.signer.publicKey, signature }] });
  return { kind, account: `${adi}/${PRINCIPAL_ACCOUNTS[kind]}`, tag, hash, texts: [text, envelope], elements: [bytesToHex(utf8(text)), bytesToHex(utf8(envelope))] };
}

/** The core profile verdict of a document: null when the core accepts it, else the core's reason and detail. Never throws. */
export function coreVerdict(kind: PrincipalEntryKind, document: unknown): { reason: string; detail?: string } | null {
  try {
    // A Grant or registration is judged as the core judges it AND as every reader will read the entry: the profile, then the canonical
    // text the entry carries through the core's own text parse (its size bound and number rules live there).
    if (kind === 'grant') {
      const v = validateGrant(document);
      if (!v.ok) return { reason: v.reason, ...(v.detail ? { detail: v.detail } : {}) };
      const t = parseGrantTextUnhashed(canonicalize(document));
      return t.ok ? null : { reason: t.reason, ...(t.detail ? { detail: t.detail } : {}) };
    }
    if (kind === 'registration') {
      const v = validateRegistration(document);
      if (!v.ok) return { reason: v.reason, ...(v.detail ? { detail: v.detail } : {}) };
      const t = parseRegistrationTextUnhashed(canonicalize(document));
      return t.ok ? null : { reason: t.reason, ...(t.detail ? { detail: t.detail } : {}) };
    }
    const shape = mandateShape(document);
    return shape === null ? null : { reason: 'mandate_malformed', detail: shape };
  } catch (e) {
    return { reason: 'core_check_failed', detail: e instanceof Error ? e.message.slice(0, 120) : 'non-error throw' };
  }
}

// ── writing it through the gateway ────────────────────────────────────────────────────────────────────────

export interface PrincipalWriteResult {
  entry: PrincipalEntry;
  /** true when this call created the account; false when it already existed (DATA_ACCOUNT_EXISTS) */
  accountCreated: boolean;
  createTx?: string;
  writeTx?: string;
  writeOperationId: string;
}

/** One governance operation, checked and signed by the principal's own key, or by the provider when the identity is provider-signed. */
async function signedOperation(client: CertenClient, a: { principal: string; page: string; signer: PrincipalSigner; operation: Record<string, unknown>; expected: Record<string, unknown> }): Promise<{ id: string; tx?: string }> {
  const created = await client.governance.create({ identity: a.principal, operations: [a.operation], signerKeyPage: a.page, signerPublicKey: a.signer.publicKey });
  if (created.signing_mode === 'provider' || !created.signing_data) return { id: created.governance_op_id, ...(created.tx_hash ? { tx: created.tx_hash } : {}) };
  // Rebuild the transaction the gateway returned and match it to exactly what was asked: nothing is signed on a mismatch.
  await checkGovernanceSigning(created.signing_data, { adiUrl: a.principal, operations: [a.expected as never], signerPublicKey: a.signer.publicKey, signerKeyPage: a.page });
  const hash = String((created.signing_data as { hash_to_sign?: unknown }).hash_to_sign ?? '');
  const submitted = await client.governance.submitSignature(created.governance_op_id, { signature: a.signer.sign(hash), publicKey: a.signer.publicKey });
  return { id: created.governance_op_id, ...((submitted as { tx_hash?: string }).tx_hash ? { tx: (submitted as { tx_hash?: string }).tx_hash } : {}) };
}

/**
 * Write one of the principal's entries: create its account when absent (authority set: the principal's own book alone), then write the
 * entry. Every signature is the principal's key on the principal's page. A gateway answer of DATA_ACCOUNT_EXISTS means the account is
 * there and is written to as it is (its authority set is judged by the readers of the entry, GRANT.md section 4a).
 */
export async function writePrincipalEntry(client: CertenClient, a: { kind: PrincipalEntryKind; principal: string; page: string; document: unknown; signer: PrincipalSigner }): Promise<PrincipalWriteResult> {
  const entry = buildPrincipalEntry(a);
  const principal = a.principal.toLowerCase().replace(/\/+$/, '');
  const page = a.page.toLowerCase();
  const book = page.replace(/\/[0-9]+$/, '');
  let accountCreated = false;
  let createTx: string | undefined;
  try {
    const c = await signedOperation(client, {
      principal, page, signer: a.signer,
      operation: { type: 'create_data_account', account_url: entry.account },
      expected: { type: 'create_data_account', account_url: entry.account, authorities: [book] },
    });
    accountCreated = true;
    createTx = c.tx;
  } catch (e) {
    if (!(e instanceof CertenError && e.code === 'DATA_ACCOUNT_EXISTS')) throw e;
  }
  const w = await signedOperation(client, {
    principal, page, signer: a.signer,
    operation: { type: 'write_data', account_url: entry.account, entries: entry.elements },
    expected: { type: 'write_data', account_url: entry.account, entries: entry.elements },
  });
  return { entry, accountCreated, ...(createTx ? { createTx } : {}), ...(w.tx ? { writeTx: w.tx } : {}), writeOperationId: w.id };
}

/** The agent's GR-62 registration in the principal's registry (subject type agent). */
export const registerAgent = (client: CertenClient, a: { principal: string; page: string; registration: unknown; signer: PrincipalSigner }) =>
  writePrincipalEntry(client, { kind: 'registration', principal: a.principal, page: a.page, document: a.registration, signer: a.signer });
/** The Grant the principal issues (certen:grant:v1). */
export const issueGrant = (client: CertenClient, a: { principal: string; page: string; grant: unknown; signer: PrincipalSigner }) =>
  writePrincipalEntry(client, { kind: 'grant', principal: a.principal, page: a.page, document: a.grant, signer: a.signer });
/** The mandate the principal signs (certen.mandate/v1, AGENT-GRANT.md section 3). */
export const issueMandate = (client: CertenClient, a: { principal: string; page: string; mandate: unknown; signer: PrincipalSigner }) =>
  writePrincipalEntry(client, { kind: 'mandate', principal: a.principal, page: a.page, document: a.mandate, signer: a.signer });
