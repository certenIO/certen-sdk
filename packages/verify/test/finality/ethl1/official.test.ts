/**
 * The OFFICIAL light-client single_merkle_proof vectors of ethereum/consensus-specs v1.7.0-beta.4 (aa16bb4c), the same committed subset
 * the validator's pkg/finality/ethl1/official_test.go runs: for the electra, fulu, gloas and heze forks of both presets, the generalized
 * index and the branch length of every proof are those this verifier uses for the layout, the three BeaconState proofs of one state
 * fold to the SAME state root, the verifier's normalized-branch check accepts every vector's own branch, and the verifier's
 * hash_tree_root of an ExecutionPayloadHeader reproduces the official execution_merkle_proof leaf from the vector's own payload.
 *
 * The committed copy holds the single_merkle_proof entries of the validator's MANIFEST.sha256 only (the sync pyspec_tests paths exceed
 * the Windows path limit of git); every copied file is checked against that manifest, which is itself pinned here.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2';
import { describe, expect, it } from 'vitest';
import {
  Layout,
  executionHeaderRoot,
  floorLog2,
  gindexExecHashGloas,
  gindexExecPayloadInBody,
  gindicesOf,
  isValidNormalizedMerkleBranch,
  sha2,
} from '../../../src/proof-v2/finality/ethl1/index.js';
import { hexLower } from '../../../src/proof-v2/finality/state.js';
import { OFFICIAL, hex } from './helpers.js';
import { snappyDecode } from './snappy.js';

const ROOT = join(OFFICIAL, 'v1.7.0-beta.4');
/** sha256 of the validator's testdata/official/v1.7.0-beta.4/MANIFEST.sha256 at pv2/rb11-int@21e7a94 (374 lines). */
const GO_MANIFEST_SHA256 = 'a7c33176a08b40d7059b785a29d87dcd5fa32a20c5d9df2d648f8923854a647d';

describe('the committed official subset', () => {
  it('is the single_merkle_proof entries of the validator manifest, byte for byte', () => {
    const mf = readFileSync(join(ROOT, 'MANIFEST.sha256'));
    expect(hexLower(sha256(mf))).toBe(GO_MANIFEST_SHA256);
    const lines = mf.toString('utf8').trim().split('\n');
    expect(lines.length).toBe(374);
    const listed = new Set<string>();
    let checked = 0;
    for (const line of lines) {
      const [h, path] = [line.slice(0, 64), line.slice(66)];
      expect(line.slice(64, 66)).toBe('  ');
      if (!path.includes('/single_merkle_proof/')) continue;
      listed.add(path);
      expect(hexLower(sha256(readFileSync(join(ROOT, ...path.split('/'))))), path).toBe(h);
      checked++;
    }
    expect(checked).toBe(65);
    const onDisk: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else onDisk.push(p.slice(ROOT.length + 1).split('\\').join('/'));
      }
    };
    walk(ROOT);
    expect(onDisk.filter((f) => f !== 'MANIFEST.sha256').sort()).toEqual([...listed].sort());
  });
});

describe('snappy block decoder', () => {
  it('decodes literals, overlapping copies of every width and the long-literal form', () => {
    expect(new TextDecoder().decode(snappyDecode(Uint8Array.of(5, 4 << 2, ...new TextEncoder().encode('hello'))))).toBe('hello');
    expect(new TextDecoder().decode(snappyDecode(Uint8Array.of(10, 3 << 2, 97, 98, 99, 100, 0x01 | ((6 - 4) << 2), 4)))).toBe('abcdabcdab');
    expect(new TextDecoder().decode(snappyDecode(Uint8Array.of(6, 2 << 2, 120, 121, 122, 0x02 | ((3 - 1) << 2), 3, 0)))).toBe('xyzxyz');
    const long = new Uint8Array(70).fill(7);
    expect(Buffer.from(snappyDecode(Uint8Array.of(70, 60 << 2, 69, ...long)))).toEqual(Buffer.from(long));
    // copy with a 4-byte offset
    expect(new TextDecoder().decode(snappyDecode(Uint8Array.of(6, 2 << 2, 120, 121, 122, 0x03 | ((3 - 1) << 2), 3, 0, 0, 0)))).toBe('xyzxyz');
  });
  it('refuses a bad offset, a short or long preamble, a truncated literal and the empty input', () => {
    expect(() => snappyDecode(Uint8Array.of(4, 0x01, 9))).toThrow();
    expect(() => snappyDecode(Uint8Array.of(9, 2 << 2, 120, 121, 122))).toThrow();
    expect(() => snappyDecode(Uint8Array.of(2, 2 << 2, 120, 121, 122))).toThrow();
    expect(() => snappyDecode(Uint8Array.of(5, 4 << 2, 104, 101))).toThrow();
    expect(() => snappyDecode(new Uint8Array(0))).toThrow();
    expect(() => snappyDecode(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0x7f))).toThrow();
  });
});

interface Proof {
  leaf: string;
  leafIndex: number;
  branch: string[];
}

/** proof.yaml has exactly the shape `leaf: '0x..'`, `leaf_index: N`, `branch:` and one `- '0x..'` per node. */
function parseProof(text: string): Proof {
  const lines = text.trim().split('\n');
  const m1 = /^leaf: '(0x[0-9a-f]{64})'$/.exec(lines[0]!);
  const m2 = /^leaf_index: (\d+)$/.exec(lines[1]!);
  if (!m1 || !m2 || lines[2] !== 'branch:') throw new Error('unexpected proof.yaml shape');
  const branch = lines.slice(3).map((l) => {
    const m = /^- '(0x[0-9a-f]{64})'$/.exec(l);
    if (!m) throw new Error(`unexpected branch line ${l}`);
    return m[1]!;
  });
  return { leaf: m1[1]!, leafIndex: Number(m2[1]), branch };
}

/** The plain Phase 0 fold of a leaf up its branch at gindex. */
function foldBranch(leaf: Uint8Array, branch: Uint8Array[], gindex: number): Uint8Array {
  let v = leaf;
  for (let i = 0; i < branch.length; i++) v = Math.floor(gindex / 2 ** i) % 2 === 1 ? sha2(branch[i]!, v) : sha2(v, branch[i]!);
  return v;
}

describe('official single_merkle_proof vectors', () => {
  const layouts: Record<string, number> = { electra: Layout.Electra, fulu: Layout.Electra, gloas: Layout.Gloas, heze: Layout.Gloas };
  it('use the generalized indices and branch lengths of the verifier; the three state proofs of a fork meet at one root', () => {
    let run = 0;
    let states = 0;
    let bodies = 0;
    for (const preset of ['mainnet', 'minimal']) {
      for (const fork of ['electra', 'fulu', 'gloas', 'heze']) {
        const base = join(ROOT, 'tests', preset, fork, 'light_client', 'single_merkle_proof');
        if (!existsSync(base)) continue;
        const layout = layouts[fork]!;
        const roots = new Map<string, string>();
        for (const suite of ['BeaconState', 'BeaconBlockBody']) {
          for (const name of (existsSync(join(base, suite)) ? readdirSync(join(base, suite)) : []).sort()) {
            const p = parseProof(readFileSync(join(base, suite, name, 'proof.yaml'), 'utf8'));
            let want: bigint;
            if (suite === 'BeaconState' && name === 'current_sync_committee_merkle_proof') want = gindicesOf(layout).current;
            else if (suite === 'BeaconState' && name === 'next_sync_committee_merkle_proof') want = gindicesOf(layout).next;
            else if (suite === 'BeaconState' && name === 'finality_root_merkle_proof') want = gindicesOf(layout).finalized;
            else if (suite === 'BeaconBlockBody' && name === 'execution_merkle_proof' && layout === Layout.Electra) want = gindexExecPayloadInBody;
            else if (suite === 'BeaconBlockBody' && name === 'execution_block_hash_merkle_proof' && layout === Layout.Gloas) want = gindexExecHashGloas;
            else throw new Error(`${preset}/${fork}/${suite}/${name}: unknown proof`);
            const id = `${preset}/${fork}/${suite}/${name}`;
            expect(BigInt(p.leafIndex), id).toBe(want);
            expect(p.branch.length, id).toBe(floorLog2(BigInt(p.leafIndex)));
            const br = p.branch.map(hex);
            const r = foldBranch(hex(p.leaf), br, p.leafIndex);
            if (suite === 'BeaconState') {
              roots.set(name, hexLower(r));
              states++;
            } else bodies++;
            // the normalized-branch verifier agrees with the plain fold at the vector's own gindex
            expect(isValidNormalizedMerkleBranch(hex(p.leaf), br, BigInt(p.leafIndex), r), id).toBe(true);
            run++;
          }
        }
        if (roots.size === 3) {
          const [a, b, c] = [roots.get('current_sync_committee_merkle_proof'), roots.get('next_sync_committee_merkle_proof'), roots.get('finality_root_merkle_proof')];
          expect(a, `${preset}/${fork}`).toBe(b);
          expect(b, `${preset}/${fork}`).toBe(c);
        }
      }
    }
    expect(run).toBe(26);
    expect(states).toBe(18);
    expect(bodies).toBe(8);
  });
});

// ---- the execution payload leaf of the official BeaconBlockBody proofs

const zeroHashes: Uint8Array[] = (() => {
  const z: Uint8Array[] = [new Uint8Array(32)];
  for (let i = 1; i < 40; i++) z.push(sha2(z[i - 1]!, z[i - 1]!));
  return z;
})();

/** SSZ merkleize(chunks, limit): the chunks zero-padded to the next power of two of limit (virtual zero subtrees). */
function merkleizeLimit(chunks: Uint8Array[], limit: number): Uint8Array {
  let depth = 0;
  while (2 ** depth < limit) depth++;
  let layer = chunks.slice();
  for (let d = 0; d < depth; d++) {
    if (layer.length % 2 === 1) layer.push(zeroHashes[d]!);
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length / 2; i++) next.push(sha2(layer[2 * i]!, layer[2 * i + 1]!));
    layer = next;
  }
  return layer.length === 0 ? zeroHashes[depth]! : layer[0]!;
}

function mixInLength(root: Uint8Array, n: number): Uint8Array {
  const l = new Uint8Array(32);
  new DataView(l.buffer).setBigUint64(0, BigInt(n), true);
  return sha2(root, l);
}

function chunksOf(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += 32) {
    const c = new Uint8Array(32);
    c.set(b.subarray(i, i + 32), 0);
    out.push(c);
  }
  return out;
}

const u32 = (b: Uint8Array, o: number): number => new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0, true);

describe('official execution_merkle_proof leaf', () => {
  it('is reproduced by executionHeaderRoot from the vector payload (electra and fulu, minimal preset objects)', () => {
    let checked = 0;
    for (const preset of ['mainnet', 'minimal']) {
      const [syncAgg, maxWithdrawals] = preset === 'minimal' ? [4 + 96, 4] : [160, 16];
      for (const fork of ['electra', 'fulu']) {
        const d = join(ROOT, 'tests', preset, fork, 'light_client', 'single_merkle_proof', 'BeaconBlockBody', 'execution_merkle_proof');
        if (!existsSync(join(d, 'object.ssz_snappy'))) continue; // the mainnet objects are fetched, not committed
        const body = snappyDecode(readFileSync(join(d, 'object.ssz_snappy')));
        const p = parseProof(readFileSync(join(d, 'proof.yaml'), 'utf8'));
        const at = 96 + 72 + 32 + 5 * 4 + syncAgg; // execution_payload offset in the fixed part of the electra/fulu BeaconBlockBody
        const start = u32(body, at);
        const end = u32(body, at + 4);
        const pl = body.subarray(start, end);
        expect(pl.length, `${preset}/${fork}`).toBeGreaterThanOrEqual(528);
        const offExtra = u32(pl, 436);
        const offTx = u32(pl, 504);
        const offWd = u32(pl, 508);
        expect(offExtra).toBe(528);
        expect(offTx).toBeGreaterThanOrEqual(offExtra);
        expect(offWd).toBeGreaterThanOrEqual(offTx);
        expect(offWd).toBeLessThanOrEqual(pl.length);
        const extra = pl.subarray(offExtra, offTx);
        const txs = pl.subarray(offTx, offWd);
        const wds = pl.subarray(offWd);
        // transactions: List[ByteList[2^30], 2^20]
        const txRoots: Uint8Array[] = [];
        if (txs.length > 0) {
          const n = u32(txs, 0) / 4;
          for (let i = 0; i < n; i++) {
            const a = u32(txs, 4 * i);
            const b = i + 1 < n ? u32(txs, 4 * (i + 1)) : txs.length;
            txRoots.push(mixInLength(merkleizeLimit(chunksOf(txs.subarray(a, b)), 2 ** 25), b - a));
          }
        }
        const txRoot = mixInLength(merkleizeLimit(txRoots, 2 ** 20), txRoots.length);
        // withdrawals: List[Withdrawal(index u64, validator_index u64, address 20, amount u64), MAX_WITHDRAWALS_PER_PAYLOAD]
        expect(wds.length % 44).toBe(0);
        const wdRoots: Uint8Array[] = [];
        for (let i = 0; i < wds.length / 44; i++) {
          const w = wds.subarray(44 * i, 44 * i + 44);
          const leaves = [new Uint8Array(32), new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)];
          leaves[0]!.set(w.subarray(0, 8));
          leaves[1]!.set(w.subarray(8, 16));
          leaves[2]!.set(w.subarray(16, 36));
          leaves[3]!.set(w.subarray(36, 44));
          wdRoots.push(merkleizeLimit(leaves, 4));
        }
        const wdRoot = mixInLength(merkleizeLimit(wdRoots, maxWithdrawals), wdRoots.length);
        const hdr = new Uint8Array(584 + extra.length);
        hdr.set(pl.subarray(0, 436), 0);
        new DataView(hdr.buffer).setUint32(436, 584, true);
        hdr.set(pl.subarray(440, 504), 440); // base_fee_per_gas, block_hash
        hdr.set(txRoot, 504);
        hdr.set(wdRoot, 536);
        hdr.set(pl.subarray(512, 528), 568); // blob_gas_used, excess_blob_gas
        hdr.set(extra, 584);
        expect(hexLower(executionHeaderRoot(hdr)), `${preset}/${fork}`).toBe(p.leaf.slice(2));
        checked++;
      }
    }
    expect(checked).toBe(2);
  });
});

