// The manifest extension (twin of manifest.go WithExtension, checkChains and findDuplicateKey): an extension may only APPEND rows. A row that
// shadows a row of the pinned manifest is manifest_shadow{table,key}; a row of a chain the merged manifest does not know, or a new chain without
// its mandatory rows, is manifest_unknown{chain}. A later owner or set-root row retires the earlier row of its key at its own validFromBlock - 1.
import { sha256 } from '@noble/hashes/sha2';
import { toHex } from './canon.js';
import { Manifest, manifestCorrupt, manifestUnknown, validateDoc, ManifestSchema } from './manifest.js';
import * as N from './names.js';
import { must, type StateError } from './states.js';

const shadow = (table: string, key: string): StateError => must(N.CodeManifestShadow, '', { table, key });
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const sorted = (o: Obj): string[] => Object.keys(o).sort();

/** The first object that repeats a key: its path ("" root, ".k" member, "[]" element) and the key; the text must already be valid JSON. */
export function findDuplicateKey(text: string): { path: string; key: string } | undefined {
  let i = 0;
  const ws = (): void => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++; };
  const str = (): string => {
    const start = i;
    i++;
    while (text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const walk = (path: string): { path: string; key: string } | undefined => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') { i++; return undefined; }
      for (;;) {
        ws();
        const k = str();
        if (seen.has(k)) return { path, key: k };
        seen.add(k);
        ws();
        i++;
        const r = walk(path + '.' + k);
        if (r) return r;
        ws();
        if (text[i] === ',') { i++; continue; }
        i++;
        return undefined;
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') { i++; return undefined; }
      for (;;) {
        const r = walk(path + '[]');
        if (r) return r;
        ws();
        if (text[i] === ',') { i++; continue; }
        i++;
        return undefined;
      }
    }
    if (c === '"') { str(); return undefined; }
    while (i < text.length && !',]} \t\n\r'.includes(text[i]!)) i++;
    return undefined;
  };
  return walk('');
}

const rowKey = (r: unknown, a: string, b: string): string => {
  const o = isObj(r) ? r : {};
  const f = (k: string): string => (typeof o[k] === 'number' ? String(o[k]) : typeof o[k] === 'string' ? (o[k] as string) : '');
  return f(a) + ',' + f(b);
};
function mergeMapRows(base: unknown, add: unknown, table: string): Obj {
  if (!isObj(add)) throw manifestCorrupt();
  const b: Obj = isObj(base) ? { ...base } : {};
  for (const k of sorted(add)) {
    if (k in b) throw shadow(table, k);
    b[k] = add[k];
  }
  return b;
}
function mergeArrayRows(base: unknown, add: unknown, table: string, key: (r: unknown) => string): unknown[] {
  if (!Array.isArray(add)) throw manifestCorrupt();
  const b: unknown[] = Array.isArray(base) ? [...base] : [];
  const seen = new Set(b.map(key));
  for (const r of add) {
    const k = key(r);
    if (seen.has(k)) throw shadow(table, k);
    seen.add(k);
    b.push(r);
  }
  return b;
}

const extensionMeta = new Set(['schema', 'description']);
const extensionRowTables = new Set(['builds', 'deployments', 'accounts', 'eip2935', 'policy', 'chains', 'generations']);
const newChainRoles = [N.RoleAnchor, N.RoleBlsZkVerifier, N.RoleGroth16Verifier, N.RoleAccountFactory, N.RoleOutcomeRegistry];
const newChainOwnerRoles = ['anchor', 'verifier'];

function checkChains(m: Manifest, base: Manifest): void {
  const known = new Set(m.chains().map((c) => BigInt(c.chainId)));
  const foreign: bigint[] = [];
  const note = (c: bigint): void => { if (!known.has(c)) foreign.push(c); };
  for (const d of (m.doc['deployments'] as { chainId: number }[])) note(BigInt(d.chainId));
  for (const a of (m.doc['accounts'] as { chainId: number }[])) note(BigInt(a.chainId));
  for (const k of Object.keys(m.doc['eip2935'] as Obj)) note(BigInt(k));
  const policy = m.doc['policy'] as { txScan?: Obj; owner?: Obj; setRootHistory?: { chainId: number }[] };
  for (const k of Object.keys(policy.txScan ?? {})) note(BigInt(k));
  for (const k of Object.keys(policy.owner ?? {})) note(BigInt(k));
  for (const r of policy.setRootHistory ?? []) note(BigInt(r.chainId));
  if (foreign.length > 0) throw manifestUnknown(foreign.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]!);
  const baseKnown = new Set(base.chains().map((c) => BigInt(c.chainId)));
  const added = m.chains().map((c) => BigInt(c.chainId)).filter((c) => !baseKnown.has(c)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const c of added) {
    let complete = m.eip2935(c) !== undefined && m.txScan(c) !== undefined;
    for (const role of newChainOwnerRoles) if (m.ownerRows(c, role).length === 0) complete = false;
    for (const role of newChainRoles) {
      const d = m.deployment(c, role);
      if (!d || !m.build(d.build)) complete = false;
    }
    if (!complete) throw manifestUnknown(c);
  }
}

/** Manifest.WithExtension: the pinned manifest plus the appended rows of `ext`, or the framework state that refuses it. */
export function withExtension(m: Manifest, ext: Uint8Array): Manifest {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(ext).replace(/\r\n/g, '\n');
  let edoc: unknown;
  try { edoc = JSON.parse(text); } catch { throw manifestCorrupt(); }
  const dup = findDuplicateKey(text);
  if (dup) throw shadow('extension' + dup.path, dup.key);
  if (!isObj(edoc)) throw manifestCorrupt();
  for (const name of sorted(edoc)) {
    if (extensionMeta.has(name) || extensionRowTables.has(name)) continue;
    const v = edoc[name];
    throw shadow(name, isObj(v) && Object.keys(v).length > 0 ? sorted(v)[0]! : '*');
  }
  if ('schema' in edoc && edoc['schema'] !== ManifestSchema) throw manifestCorrupt();
  const merged = structuredClone(m.doc) as Obj;
  if ('builds' in edoc) merged['builds'] = mergeMapRows(merged['builds'], edoc['builds'], 'builds');
  if ('eip2935' in edoc) merged['eip2935'] = mergeMapRows(merged['eip2935'], edoc['eip2935'], 'eip2935');
  if ('deployments' in edoc) merged['deployments'] = mergeArrayRows(merged['deployments'], edoc['deployments'], 'deployments', (r) => rowKey(r, 'chainId', 'role'));
  if ('accounts' in edoc) merged['accounts'] = mergeArrayRows(merged['accounts'], edoc['accounts'], 'accounts', (r) => rowKey(r, 'chainId', 'address').toLowerCase());
  if ('chains' in edoc) merged['chains'] = mergeArrayRows(merged['chains'], edoc['chains'], 'chains', (r) => rowKey(r, 'chainId', '_').replace(/,$/, ''));
  if ('generations' in edoc) {
    const added = edoc['generations'];
    if (!Array.isArray(added)) throw manifestCorrupt();
    for (const g of added as { maskedKeccak?: unknown }[]) if (typeof g?.maskedKeccak !== 'string' || !/^0x[0-9a-f]{64}$/.test(g.maskedKeccak)) throw manifestCorrupt();
    merged['generations'] = mergeArrayRows(merged['generations'], added, 'generations', (r) => { const g = isObj(r) ? r : {}; return String(g['role'] ?? '') + ',' + String(g['maskedKeccak'] ?? ''); });
  }
  if ('policy' in edoc) {
    const add = edoc['policy'];
    if (!isObj(add)) throw manifestCorrupt();
    const base: Obj = isObj(merged['policy']) ? (merged['policy'] as Obj) : {};
    for (const k of sorted(add)) {
      if (['owner', 'setRootHistory', 'txScan', 'description'].includes(k)) continue;
      if (k === 'rules') {
        const rules = add[k];
        throw shadow('policy.rules', Array.isArray(rules) && rules.length > 0 && isObj(rules[0]) ? String((rules[0] as Obj)['id'] ?? '') : '*');
      }
      throw shadow('policy', k);
    }
    if ('txScan' in add) base['txScan'] = mergeMapRows(base['txScan'], add['txScan'], 'policy.txScan');
    if ('owner' in add) {
      const addO = add['owner'];
      if (!isObj(addO)) throw manifestCorrupt();
      const baseO: Record<string, unknown[]> = isObj(base['owner']) ? (base['owner'] as Record<string, unknown[]>) : {};
      for (const chainKey of Object.keys(addO).sort()) {
        const rows = addO[chainKey];
        if (!Array.isArray(rows)) throw manifestCorrupt();
        for (const row of rows as { role?: unknown; validFromBlock?: unknown }[]) {
          if (!isObj(row) || typeof row.role !== 'string' || typeof row.validFromBlock !== 'number') throw manifestCorrupt();
          let last: number | undefined;
          for (const e of (baseO[chainKey] ?? []) as { role?: string; validFromBlock?: number }[]) if (e.role === row.role && (last === undefined || e.validFromBlock! > last)) last = e.validFromBlock!;
          if (last !== undefined && row.validFromBlock <= last) throw shadow('policy.owner', chainKey + ',' + row.role);
          (baseO[chainKey] ??= []).push(row);
        }
      }
      base['owner'] = baseO;
    }
    if ('setRootHistory' in add) {
      const addS = add['setRootHistory'];
      if (!Array.isArray(addS)) throw manifestCorrupt();
      const baseS: unknown[] = Array.isArray(base['setRootHistory']) ? (base['setRootHistory'] as unknown[]) : [];
      for (const row of addS as { chainId?: unknown; validFromBlock?: unknown }[]) {
        if (!isObj(row) || typeof row.chainId !== 'number' || typeof row.validFromBlock !== 'number') throw manifestCorrupt();
        let last: number | undefined;
        for (const e of baseS as { chainId?: number; validFromBlock?: number }[]) if (e.chainId === row.chainId && (last === undefined || e.validFromBlock! > last)) last = e.validFromBlock!;
        if (last !== undefined && row.validFromBlock <= last) throw shadow('policy.setRootHistory', String(row.chainId));
        baseS.push(row);
      }
      base['setRootHistory'] = baseS;
    }
    merged['policy'] = base;
  }
  validateDoc(merged);
  const out = new Manifest(merged, m.sha256, 'extension:' + toHex(sha256(ext)), toHex(sha256(ext)));
  checkChains(out, m);
  return out;
}
