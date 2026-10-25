// The leg context (twin of types.go LegContext + inputs.go ContextFromFile + ValidateContext, step 1b): everything the verifier reads that is
// not in the container. Parsing is strict (canonical hex and decimal spellings); a context the document cannot express is an Error, an
// incomplete one is the named state context_incomplete{missing}.
import { RlpError, listItems, split } from '../../s6/rlp.js';
import { isZero, undec, unhex, unhexN } from './bytes.js';
import type { BlockRef } from './codec.js';
import * as N from './names.js';
import { must, defaultVocabulary, type StateError } from './states.js';

export interface Settlement { header: Uint8Array; blockHash: Uint8Array; hasTx: boolean; hasReceipt: boolean }
export interface Tx { to?: Uint8Array; data: Uint8Array }
export interface Log { address: Uint8Array; topics: Uint8Array[]; data: Uint8Array }
export interface ReceiptLeaf { type: number; postStateOrStatus: Uint8Array; cumulativeGasUsed: bigint; bloom: Uint8Array; logs: Log[] }
/** A status receipt succeeded iff its status byte is 0x01. */
export const succeeded = (r: ReceiptLeaf): boolean => r.postStateOrStatus.length === 1 && r.postStateOrStatus[0] === 1;
export interface S6Link { contract: Uint8Array; leafKey: Uint8Array; settlementBlock: BlockRef; provenAt: BlockRef; codeHash: Uint8Array }
export interface BatchFacts { batchRoot: Uint8Array; operationId: Uint8Array; accSetRoot: Uint8Array; incarnation: Uint8Array }
export interface RegistryMember { address: Uint8Array; power: bigint; blsKey: string }
export interface Registry9 { members: RegistryMember[]; num: bigint; den: bigint; certenSetRoot: Uint8Array; signerCommitment: Uint8Array }
export interface S7Level { status: string; code: string }
export interface S7Report {
  block: { chain: bigint; number: bigint; hash: Uint8Array }; headline: string; levels: Record<string, S7Level>; unsupported: string;
  finalizedBlock?: { number: bigint; hash: Uint8Array; stateRoot: Uint8Array };
}
export type S6Status = 's6_proven' | 's6_silent' | 's6_not_proven';
export interface LegContext {
  chain: bigint; settlement?: Settlement; tx?: Tx; receipt?: ReceiptLeaf; adiUrl: string; s6Status: S6Status | string; s6Reason: string; s6State: string;
  s6?: S6Link; batch: BatchFacts; registry9?: Registry9; s7?: S7Report;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown, what: string): string => { if (typeof v !== 'string') throw new Error(`${what}: not a string`); return v; };
const hexLoose = (s: string): Uint8Array => unhex(s.startsWith('0x') ? s : '0x' + s);
const ref = (v: unknown, what: string): BlockRef => { const o = obj(v); if (!o) throw new Error(`${what}: not an object`); return { number: undec(str(o['number'], what)), hash: unhexN(str(o['hash'], what), 32) }; };

/** The transaction members the verifier reads (to, input) of a typed (EIP-2718) or legacy wire encoding. */
export function parseTx(b: Uint8Array): Tx {
  let body = b;
  let layout: [number, number, number] = [3, 5, 9]; // [to, input, field count] of a legacy transaction
  const t = b[0]!;
  if (t < 0x80) {
    const typed: Record<number, [number, number, number]> = { 1: [4, 6, 11], 2: [5, 7, 12], 3: [5, 7, 14], 4: [5, 7, 13] };
    if (!typed[t]) throw new Error(`unsupported transaction type ${t}`);
    layout = typed[t]!;
    body = b.slice(1);
  }
  const [toIdx, dataIdx, want] = layout;
  try {
    const it = split(body);
    if (it.kind !== 'list' || it.rest.length !== 0) throw new RlpError('transaction is not one list');
    const items = listItems(it.content);
    if (items.length !== want) throw new RlpError(`transaction has ${items.length} fields, want ${want}`);
    const to = items[toIdx]!.content;
    if (to.length !== 0 && to.length !== 20) throw new RlpError('transaction recipient is not an address');
    return { ...(to.length === 20 ? { to: Uint8Array.from(to) } : {}), data: Uint8Array.from(items[dataIdx]!.content) };
  } catch (e) {
    if (e instanceof RlpError) throw new Error(`context.tx: ${e.message}`);
    throw e;
  }
}

/** ContextFromFile: the `context` object of a materialised inputs file. */
export function contextFromFile(f: Record<string, unknown>): LegContext {
  const c: LegContext = {
    chain: undec(str(f['chain'], 'context.chain')), adiUrl: str(f['adi_url'] ?? '', 'context.adi_url'), s6Status: str(f['s6_status'] ?? '', 'context.s6_status'),
    s6Reason: str(f['s6_reason'] ?? '', 'context.s6_reason'), s6State: str(f['s6_state'] ?? '', 'context.s6_state'),
    batch: { batchRoot: new Uint8Array(32), operationId: new Uint8Array(32), accSetRoot: new Uint8Array(32), incarnation: new Uint8Array(32) },
  };
  const st = obj(f['settlement']);
  if (st) {
    c.settlement = {
      header: hexLoose(str(st['block_header_rlp'] ?? '0x', 'settlement.block_header_rlp')), blockHash: hexLoose(str(st['block_hash'] ?? '0x', 'settlement.block_hash')),
      hasTx: obj(st['tx_inclusion_proof']) !== undefined, hasReceipt: obj(st['receipt_inclusion_proof']) !== undefined,
    };
  }
  if (typeof f['tx'] === 'string') c.tx = parseTx(unhex(f['tx']));
  const r = obj(f['receipt']);
  if (r) {
    const bloom = unhex(str(r['bloom'], 'context.receipt.bloom'));
    if (bloom.length !== 256) throw new Error('context.receipt.bloom: not 256 bytes');
    c.receipt = {
      type: Number(undec(str(r['type'], 'context.receipt.type'))), postStateOrStatus: unhex(str(r['post_state_or_status'], 'context.receipt.post_state_or_status')),
      cumulativeGasUsed: undec(str(r['cumulative_gas_used'], 'context.receipt.cumulative_gas_used')), bloom,
      logs: ((r['logs'] as unknown[]) ?? []).map((l) => {
        const lo = obj(l)!;
        return { address: unhexN(str(lo['address'], 'log.address'), 20), topics: ((lo['topics'] as unknown[]) ?? []).map((t) => unhexN(str(t, 'log.topic'), 32)), data: unhex(str(lo['data'], 'log.data')) };
      }),
    };
  }
  const s6 = obj(f['s6']);
  if (s6) c.s6 = { contract: unhexN(str(s6['contract'], 's6'), 20), leafKey: unhexN(str(s6['leaf_key'], 's6'), 32), settlementBlock: ref(s6['settlement_block'], 's6'), provenAt: ref(s6['proven_at'], 's6'), codeHash: unhexN(str(s6['code_hash'], 's6'), 32) };
  const b = obj(f['batch']);
  if (b) c.batch = { batchRoot: unhexN(str(b['batch_root'], 'batch'), 32), operationId: unhexN(str(b['batch_operation_id'], 'batch'), 32), accSetRoot: unhexN(str(b['acc_set_root'], 'batch'), 32), incarnation: unhexN(str(b['incarnation'], 'batch'), 32) };
  const g = obj(f['registry9']);
  if (g) {
    c.registry9 = {
      num: undec(str(g['num'], 'registry9')), den: undec(str(g['den'], 'registry9')), certenSetRoot: unhexN(str(g['certen_set_root'], 'registry9'), 32), signerCommitment: unhexN(str(g['signer_commitment'], 'registry9'), 32),
      members: ((g['members'] as unknown[]) ?? []).map((m) => { const mo = obj(m)!; return { address: unhexN(str(mo['address'], 'member'), 20), power: undec(str(mo['power'], 'member')), blsKey: str(mo['bls_key'], 'member') }; }),
    };
  }
  const s7 = obj(f['s7']);
  if (s7) {
    const blk = obj(s7['block'])!;
    const fb = obj(s7['finalized_block']);
    c.s7 = {
      block: { chain: undec(str(blk['chain'], 's7')), number: undec(str(blk['number'], 's7')), hash: unhexN(str(blk['hash'], 's7'), 32) }, headline: str(s7['headline'] ?? '', 's7'),
      levels: Object.fromEntries(Object.entries(obj(s7['levels']) ?? {}).map(([k, v]) => [k, { status: str(obj(v)!['status'], 's7'), code: str(obj(v)!['code'] ?? '', 's7') }])),
      unsupported: str(s7['unsupported'] ?? '', 's7'),
      ...(fb ? { finalizedBlock: { number: undec(str(fb['number'], 's7')), hash: unhexN(str(fb['hash'], 's7'), 32), stateRoot: unhexN(str(fb['state_root'], 's7'), 32) } } : {}),
    };
  }
  return c;
}

export const ContextTokens: readonly string[] = ['settlement', 'tx', 'receipt', 'adi_url', 's6', 'batch.batchRoot', 'batch.batchOperationID', 'batch.accSetRoot', 'batch.incarnation', 'registry9', 's7'];
export const contextIncomplete = (missing: readonly string[]): StateError => must(N.CodeContextIncomplete, '', { missing: [...missing] });
const registry9Valid = (r: Registry9): boolean => r.members.length > 0 && r.members.every((m) => /^[0-9a-f]{192}$/.test(m.blsKey));
function s6Valid(c: LegContext): boolean {
  if (c.s6Status === N.S6S6Proven) {
    const l = c.s6;
    return !!l && !isZero(l.contract) && !isZero(l.leafKey) && l.settlementBlock.number !== 0n && !isZero(l.settlementBlock.hash) && l.provenAt.number !== 0n && !isZero(l.provenAt.hash) && !isZero(l.codeHash);
  }
  if (c.s6Status === N.S6S6Silent) return defaultVocabulary().check('s6_reason', c.s6Reason);
  if (c.s6Status === N.S6S6NotProven) return c.s6State !== '';
  return false;
}
/** Step 1b: the members the verifier cannot judge without. Returns the context_incomplete state, or undefined. */
export function validateContext(c: LegContext): StateError | undefined {
  const missing: string[] = [];
  const s = c.settlement;
  if (!s || s.header.length === 0 || isZero(s.blockHash) || c.chain === 0n || !s.hasTx || !s.hasReceipt) missing.push('settlement');
  if (!c.tx) missing.push('tx');
  if (!c.receipt) missing.push('receipt');
  if (c.adiUrl === '' || c.adiUrl.length > 1024) missing.push('adi_url');
  if (!s6Valid(c)) missing.push('s6');
  for (const [name, v] of [['batch.batchRoot', c.batch.batchRoot], ['batch.batchOperationID', c.batch.operationId], ['batch.accSetRoot', c.batch.accSetRoot], ['batch.incarnation', c.batch.incarnation]] as const) if (isZero(v)) missing.push(name);
  if (c.registry9 && !registry9Valid(c.registry9)) missing.push('registry9');
  if (!c.s7) missing.push('s7');
  return missing.length > 0 ? contextIncomplete(missing) : undefined;
}
