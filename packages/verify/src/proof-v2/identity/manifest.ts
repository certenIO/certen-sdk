// Step 0 of the S8 verifier: the identity manifest document loaded against its pin (twin of manifest.go LoadManifest / LoadOverride / Chain).
// This file carries the loading, the pin, the schema and the chain row; the accessors the steps need are added with the steps that read them.
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { CREATION_ARTIFACTS, MANIFEST_JSON, MANIFEST_SHA256 } from './embedded.js';
import * as N from './names.js';
import { must, type StateError } from './states.js';
import { toHex } from './canon.js';

export const ManifestSchema = 'certen:identity-manifest:v1.1';
const te = new TextEncoder();

export const manifestHash = (raw: Uint8Array): string => toHex(sha256(raw));
export const embeddedManifestBytes = (): Uint8Array => te.encode(MANIFEST_JSON);
export const embeddedPin = (): string => MANIFEST_SHA256;

export const manifestCorrupt = (): StateError => must(N.CodeManifestCorrupt, '', {});
export const manifestUnknown = (chain: bigint): StateError => must(N.CodeManifestUnknown, '', { chain });

export interface ChainEntry { chainId: number; name: string; [k: string]: unknown }
export interface Ref { start: number; length: number }
export interface ImmutableRule { kind: string; value?: string }
export interface Immutable { name: string; references: Ref[]; rule: ImmutableRule }
export interface Build { contract: string; variant: string; runtime: { bytes: number; maskedKeccak: string }; immutables: Immutable[] }
export interface Deployment { chainId: number; role: string; address: string; build: string }
export interface Generation { role: string; generation: string; kind: string; pinned: boolean; maskedKeccak: string; runtimeBytes: number; references: Ref[] }
export interface Selector { role: string; contract: string; selector: string }
export interface Topic { topic0: string }
export interface OwnerRow { role: string; address: string; validFromBlock: bigint; validToBlock: bigint | null }
export interface SetRootRow { root: string; validFromBlock: bigint; validToBlock: bigint | null; thresholdNumerator: bigint; thresholdDenominator: bigint; keysDigest: string | null; pkcCount: bigint | null; pkcList: string[] | null }
export interface Threshold { numerator: bigint; denominator: bigint }
export interface Policy { blsThreshold: Threshold; verifierThreshold: Threshold; pubkeyBindingEnforced: boolean; blsZkVerificationEnabled: boolean; minimumGovernanceLevel: number }

const need = <T,>(v: unknown, what: string): T => { if (v === undefined || v === null) throw manifestCorrupt(); void what; return v as T; };
const thr = (v: unknown): Threshold => { const o = need<{ numerator: number; denominator: number }>(v, 'threshold'); return { numerator: BigInt(o.numerator), denominator: BigInt(o.denominator) }; };

export class Manifest {
  constructor(readonly doc: Record<string, unknown>, readonly sha256: string, readonly source: string, readonly extensionSha256: string = '') {}
  chains(): ChainEntry[] { return (this.doc['chains'] as ChainEntry[]) ?? []; }
  /** The chain row, or THROWS manifest_unknown{chain}. */
  chain(chain: bigint): ChainEntry {
    const c = this.chains().find((x) => BigInt(x.chainId) === chain);
    if (!c) throw manifestUnknown(chain);
    return c;
  }
  build(key: string): Build | undefined { return (this.doc['builds'] as Record<string, Build> | undefined)?.[key]; }
  private deployments(): Deployment[] { return (this.doc['deployments'] as Deployment[]) ?? []; }
  deployment(chain: bigint, role: string): Deployment | undefined { return this.deployments().find((d) => BigInt(d.chainId) === chain && d.role === role); }
  deploymentAt(chain: bigint, addr: string): Deployment | undefined { return this.deployments().find((d) => BigInt(d.chainId) === chain && d.address.toLowerCase() === addr.toLowerCase()); }
  accountSelectors(generation: string): Selector[] {
    return Object.values((this.doc['selectors'] as Record<string, Selector>) ?? {}).filter((s) => s.role === 'account' && s.contract === 'CertenAccount' + generation);
  }
  topic(name: string): Topic | undefined { return (this.doc['topics'] as Record<string, Topic> | undefined)?.[name]; }
  accountEventTopics(): Record<string, Topic> { return ((this.doc['topics'] as { accountEvents?: { events?: Record<string, Topic> } } | undefined)?.accountEvents?.events) ?? {}; }
  generations(): Generation[] { return (this.doc['generations'] as Generation[]) ?? []; }
  policy(): Policy {
    const p = need<Record<string, unknown>>(this.doc['policy'], 'policy');
    return {
      blsThreshold: thr(p['blsThreshold']), verifierThreshold: thr(p['verifierThreshold']), pubkeyBindingEnforced: need<boolean>(p['pubkeyBindingEnforced'], 'pubkeyBindingEnforced'),
      blsZkVerificationEnabled: need<boolean>(p['blsZKVerificationEnabled'], 'blsZKVerificationEnabled'), minimumGovernanceLevel: need<{ min: number }>(p['minimumGovernanceLevel'], 'minimumGovernanceLevel').min,
    };
  }
  ownerRows(chain: bigint, role: string): OwnerRow[] {
    const rows = (((this.doc['policy'] as { owner?: Record<string, { role: string; address: string; validFromBlock: number; validToBlock: number | null }[]> })?.owner) ?? {})[chain.toString()] ?? [];
    return rows.filter((r) => r.role === role).map((r) => ({ role: r.role, address: r.address, validFromBlock: BigInt(r.validFromBlock), validToBlock: r.validToBlock === null ? null : BigInt(r.validToBlock) }))
      .sort((x, y) => (x.validFromBlock < y.validFromBlock ? -1 : x.validFromBlock > y.validFromBlock ? 1 : 0));
  }
  /** The owner rows whose validity covers `block` (an appended row retires the earlier one at its own validFromBlock - 1). */
  ownerCovering(chain: bigint, role: string, block: bigint): OwnerRow[] {
    const rows = this.ownerRows(chain, role);
    const out: OwnerRow[] = [];
    rows.forEach((r, i) => {
      if (block < r.validFromBlock) return;
      const next = rows.slice(i + 1).find((x) => x.validFromBlock > r.validFromBlock)?.validFromBlock ?? null;
      const ends = [r.validToBlock, next === null ? null : next - 1n].filter((x): x is bigint => x !== null);
      if (ends.length === 0 || block <= ends.reduce((m, x) => (x < m ? x : m))) out.push(r);
    });
    return out;
  }
  selector(key: string): Selector | undefined { return (this.doc['selectors'] as Record<string, Selector> | undefined)?.[key]; }
  eip2935(chain: bigint): { address: string; codeHash: string; window: bigint } | undefined {
    const r = (this.doc['eip2935'] as Record<string, { address: string; codeHash: string; window: number }> | undefined)?.[chain.toString()];
    return r ? { address: r.address, codeHash: r.codeHash, window: BigInt(r.window) } : undefined;
  }
  txScan(chain: bigint): { coveredTypes: number[]; systemTypes: number[] } | undefined {
    return (this.doc['policy'] as { txScan?: Record<string, { coveredTypes: number[]; systemTypes: number[] }> } | undefined)?.txScan?.[chain.toString()];
  }
  setRootRows(chain: bigint): SetRootRow[] {
    const rows = ((this.doc['policy'] as { setRootHistory?: { chainId: number; root: string; validFromBlock: number; validToBlock: number | null; thresholdNumerator?: number; thresholdDenominator?: number; keysDigest?: string | null; pkcCount?: number | null; pkcList?: string[] | null }[] })?.setRootHistory) ?? [];
    return rows.filter((r) => BigInt(r.chainId) === chain).map((r) => ({
      root: r.root, validFromBlock: BigInt(r.validFromBlock), validToBlock: r.validToBlock === null || r.validToBlock === undefined ? null : BigInt(r.validToBlock),
      thresholdNumerator: BigInt(r.thresholdNumerator ?? 0), thresholdDenominator: BigInt(r.thresholdDenominator ?? 0), keysDigest: r.keysDigest ?? null,
      pkcCount: r.pkcCount === null || r.pkcCount === undefined ? null : BigInt(r.pkcCount), pkcList: r.pkcList ?? null,
    })).sort((x, y) => (x.validFromBlock < y.validFromBlock ? -1 : x.validFromBlock > y.validFromBlock ? 1 : 0));
  }
  setRootRowFor(chain: bigint, block: bigint, root: string): SetRootRow | undefined {
    const rows = this.setRootRows(chain);
    for (const [i, r] of rows.entries()) {
      if (block < r.validFromBlock || r.root.toLowerCase() !== root.toLowerCase()) continue;
      const next = rows.slice(i + 1).find((x) => x.validFromBlock > r.validFromBlock)?.validFromBlock ?? null;
      const ends = [r.validToBlock, next === null ? null : next - 1n].filter((x): x is bigint => x !== null);
      if (ends.length === 0 || block <= ends.reduce((m, x) => (x < m ? x : m))) return r;
    }
    return undefined;
  }
  authWriters(buildKey: string): { status: string; conditions: Record<string, string> } | undefined { return (this.doc['builds'] as Record<string, { authWriters?: { status: string; conditions: Record<string, string> } }> | undefined)?.[buildKey]?.authWriters ?? undefined; }
  authAllowList(buildKey: string): { rows: { function: string; allowedWrites: string | string[]; deploymentOnly: boolean }[] } | undefined {
    return (this.doc['builds'] as Record<string, { authWriterAllowList?: { rows: { function: string; allowedWrites: string | string[]; deploymentOnly: boolean }[] } }> | undefined)?.[buildKey]?.authWriterAllowList ?? undefined;
  }
  /** The checked creation bytecode of a build (CreationArtifactBytes): its length, keccak256 and sha256 must be the row's. */
  creationArtifactBytes(buildKey: string): Uint8Array {
    const row = (this.doc['creationArtifacts'] as Record<string, { file: string; bytes: number; keccak256: string; sha256: string }> | undefined)?.[buildKey];
    if (!row) throw new Error(`contractidentity: creation artifact absent: ${buildKey} has no creationArtifacts row`);
    const b64 = CREATION_ARTIFACTS[row.file];
    if (b64 === undefined) throw new Error(`contractidentity: creation artifact absent: ${buildKey} (${row.file})`);
    const b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (b.length !== row.bytes || '0x' + toHex(keccak_256(b)) !== row.keccak256.toLowerCase() || toHex(sha256(b)) !== row.sha256.toLowerCase()) throw new Error(`contractidentity: creation artifact mismatch: ${buildKey} (${row.file})`);
    return b;
  }
}

const uintKey = (k: string): boolean => /^(0|[1-9][0-9]*)$/.test(k);
const canonHex32 = (v: unknown): boolean => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
/** The structural checks of Manifest.decode that every loaded or merged manifest passes (manifest_corrupt otherwise). */
export function validateDoc(doc: Record<string, unknown>): void {
  const bad = (): never => { throw manifestCorrupt(); };
  const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad());
  if (!Array.isArray(doc['chains']) || !Array.isArray(doc['deployments']) || !Array.isArray(doc['accounts'])) bad();
  const policy = obj(doc['policy']);
  const eip = obj(doc['eip2935']);
  obj(doc['builds']);
  for (const k of Object.keys(eip)) if (!uintKey(k)) bad();
  const txScan = policy['txScan'] === undefined ? {} : obj(policy['txScan']);
  for (const k of Object.keys(txScan)) if (!uintKey(k)) bad();
  const owners = policy['owner'] === undefined ? {} : obj(policy['owner']);
  for (const [k, rows] of Object.entries(owners)) {
    if (!uintKey(k) || !Array.isArray(rows)) bad();
    for (const r of rows as { validFromBlock?: unknown; validToBlock?: unknown }[]) {
      if (typeof r.validFromBlock !== 'number') bad();
      if (typeof r.validToBlock === 'number' && r.validToBlock < (r.validFromBlock as number)) bad();
    }
  }
  const setRoots = policy['setRootHistory'] === undefined ? [] : policy['setRootHistory'];
  if (!Array.isArray(setRoots)) bad();
  for (const r of setRoots as { validFromBlock?: unknown; validToBlock?: unknown }[]) {
    if (typeof r.validFromBlock !== 'number') bad();
    if (typeof r.validToBlock === 'number' && r.validToBlock < (r.validFromBlock as number)) bad();
  }
  const seen = new Set<string>();
  for (const g of (doc['generations'] ?? []) as { role: string; maskedKeccak: unknown }[]) {
    if (!canonHex32(g.maskedKeccak)) bad();
    const k = 'generations:' + g.role + ',' + String(g.maskedKeccak);
    if (seen.has(k)) bad();
    seen.add(k);
  }
  for (const d of doc['deployments'] as { chainId: number; role: string }[]) {
    const k = d.chainId + ',' + d.role;
    if (seen.has(k)) bad();
    seen.add(k);
  }
}

function parse(raw: Uint8Array): Record<string, unknown> {
  const norm = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/\r\n/g, '\n');
  let doc: unknown;
  try { doc = JSON.parse(norm); } catch { throw manifestCorrupt(); }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || (doc as Record<string, unknown>)['schema'] !== ManifestSchema) throw manifestCorrupt();
  validateDoc(doc as Record<string, unknown>);
  return doc as Record<string, unknown>;
}

/** The manifest bytes must hash to `pin` (64 lower-case hex digits): any other bytes are manifest_corrupt, whatever the schema says. */
export function loadManifest(raw: Uint8Array, pin: string): Manifest {
  const got = manifestHash(raw);
  if (got !== pin) throw manifestCorrupt();
  return new Manifest(parse(raw), got, N.ManifestSourceEmbedded);
}
/** A modified but self-consistent manifest: loaded by its own hash, reported as `override:<sha256>`. */
export function loadOverride(raw: Uint8Array): Manifest {
  const got = manifestHash(raw);
  return new Manifest(parse(raw), got, `override:${got}`);
}
