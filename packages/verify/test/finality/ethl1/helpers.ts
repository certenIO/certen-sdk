/**
 * Shared harness of the ethl1 conformance tests: loads the validator's finality_ethl1_v2 vector set (a byte-identical copy in
 * test/fixtures/finality/ethl1_v2), judges every case with the TypeScript verifier and renders the verdict in the canonical form the
 * Go-written `expect` is rendered in, so the two compare as strings byte for byte.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { FinalityStateError, hexLower } from '../../../src/proof-v2/finality/state.js';
import {
  KeyCache,
  blockAt,
  covers,
  decodeLC,
  encodeLC,
  verifyFinalizedHead,
  type Anchor,
  type Fork,
  type L1Block,
  type LC,
  type Pins,
} from '../../../src/proof-v2/finality/ethl1/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export const SET = join(here, '..', '..', 'fixtures', 'finality', 'ethl1_v2');
export const OFFICIAL = join(here, '..', '..', 'fixtures', 'finality', 'ethl1_official');

/** The sha256 of manifest.json of the validator's finality_ethl1_v2 at certen-validator pv2/rb11-int@21e7a94. */
export const V2_MANIFEST_SHA256 = '8b01c7cf3577dd36028362f1b4e1be2c1a823b30a142caad5827453f01ecde7d';
export const GO_COMMIT = '21e7a94e3e887e372fa725489a206c9ab121cd0a';

export const readSet = (rel: string): Buffer => readFileSync(join(SET, ...rel.split('/')));
export const setJSON = <T = any>(rel: string): T => JSON.parse(readSet(rel).toString('utf8')) as T;
export const sha256Hex = (b: Uint8Array): string => hexLower(sha256(b));

export const hex = (s: string): Uint8Array => {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error(`bad hex ${s}`);
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};
const h32 = (s: string): Uint8Array => {
  const b = hex(s);
  if (b.length !== 32) throw new Error(`want 32 bytes, got ${b.length}`);
  return b;
};

/** A pins file of the vector set (the validator's vPins). */
export function loadPins(name: string): Pins {
  const vp = setJSON(name);
  const forks: Fork[] = vp.forks.map((f: any) => ({ name: f.name, epoch: BigInt(f.epoch), version: hex(f.version), layout: f.layout }));
  const anchors: Anchor[] = vp.anchors.map((a: any) => ({
    period: BigInt(a.period),
    committeeRoot: h32(a.committee_root),
    blockRoot: a.block_root === null ? null : h32(a.block_root),
    wspEpochs: BigInt(a.wsp_epochs),
  }));
  return {
    network: { chainId: BigInt(vp.chain_id), genesisValidatorsRoot: h32(vp.genesis_validators_root), forks },
    anchors,
    minParticipants: vp.min_participants,
    maxLinks: vp.max_links,
    maxSpineHeaders: vp.max_spine_headers,
  };
}

export interface VCase {
  id: string;
  kind: 'head' | 'covers';
  pins?: string;
  lc?: string;
  exec_hash?: string;
  spine?: string[];
  spine_file?: string;
  max?: number;
  block_number?: string;
  expect: any;
}

export const caseIds = (): string[] => setJSON('manifest.json').cases as string[];
export const loadCase = (id: string): VCase => setJSON(`cases/${id}.json`) as VCase;

/** The framed spine of a set: u32be count, then per header u32be length and the raw RLP. */
export function readSpineFile(rel: string): Uint8Array[] {
  const b = readSet(rel);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint32(0, false);
  let pos = 4;
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const l = dv.getUint32(pos, false);
    pos += 4;
    out.push(new Uint8Array(b.buffer, b.byteOffset + pos, l));
    pos += l;
  }
  if (pos !== b.length) throw new Error(`${rel}: ${b.length - pos} trailing bytes`);
  return out;
}

const HTML_ESCAPES = new RegExp('[<>&\u2028\u2029]', 'g');

/** Go's json.Marshal of a string: HTML characters and U+2028/U+2029 escaped. */
export function goString(s: string): string {
  return JSON.stringify(s).replace(HTML_ESCAPES, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Canonical JSON: keys sorted at every level, no whitespace (what Go's json.Marshal of the expect maps renders). */
export function canon(v: any): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return goString(v);
  if (typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${goString(k)}:${canon(v[k])}`)
    .join(',')}}`;
}

/** The bytes the Go test compares: a fault is {"code","fields"}; an ok is the finalized_head / blocks / {block,headers_walked}. */
export function expectedOf(c: VCase): string {
  const e = c.expect;
  if (e.result === 'fault') return canon({ code: e.code, fields: e.fields });
  if (e.result !== 'ok') throw new Error(`bad expect in ${c.id}`);
  if (e.block !== undefined) return canon({ block: e.block, headers_walked: e.headers_walked });
  if (e.finalized_head !== undefined) return canon(e.finalized_head);
  return canon(e.blocks);
}

const blockJSON = (b: L1Block) => ({ hash: `0x${hexLower(b.hash)}`, number: b.number.toString(), state_root: `0x${hexLower(b.stateRoot)}`, timestamp: b.timestamp.toString() });

export const lcOf = (c: VCase): LC => {
  const raw = readSet(c.lc!);
  const lc = decodeLC(raw, 1 << 16);
  const back = encodeLC(lc);
  if (Buffer.compare(Buffer.from(back), raw) !== 0) throw new Error(`${c.id}: encode(decode(lc)) differs from the file`);
  return lc;
};

/** The TypeScript verdict of one case, rendered canonically. A non-named failure is a test failure, never a verdict. */
export function judge(c: VCase, keyCache?: KeyCache): string {
  try {
    if (c.kind === 'head') {
      const h = verifyFinalizedHead(loadPins(c.pins!), lcOf(c), { keyCache });
      return canon({
        beacon_root: `0x${hexLower(h.beaconRoot)}`,
        epoch: h.epoch.toString(),
        exec_hash: `0x${hexLower(h.execHash)}`,
        participants: String(h.participants),
        periods_crossed: h.periodsCrossed.toString(),
        slot: h.slot.toString(),
      });
    }
    const spine = c.spine_file !== undefined ? readSpineFile(c.spine_file) : (c.spine ?? []).map(hex);
    const bl = covers({ slot: 0n, epoch: 0n, beaconRoot: new Uint8Array(32), execHash: h32(c.exec_hash!), participants: 0, periodsCrossed: 0n }, spine, c.max!);
    const found = c.block_number !== undefined ? blockAt(bl, BigInt(c.block_number)) : undefined;
    if (c.spine_file !== undefined) return canon({ block: blockJSON(found!), headers_walked: String(bl.length) });
    return canon(bl.map(blockJSON));
  } catch (e) {
    if (e instanceof FinalityStateError) return e.canonical();
    throw e;
  }
}

/** The ids of the cases of shard k of n (round-robin over the sorted manifest, which spreads the chain cases). */
export const shardOf = (k: number, n: number): string[] => caseIds().filter((_, i) => i % n === k);
