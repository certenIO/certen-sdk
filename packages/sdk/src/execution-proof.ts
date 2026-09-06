/**
 * Independent verification of a proof bundle's component 5, the execution proof: that the receipt
 * with these logs sits in the block the bundle names, under that block's receipts root.
 *
 * The validator's RB-2 gate built a Merkle-Patricia proof from the raw block and verified it against
 * the header; the bundle now carries that proof (the raw trie nodes and the leaf value) so anyone
 * can repeat the check with nothing but this file: re-hash every node with keccak-256, walk the
 * trie from the root along RLP(transaction index), and compare the value found to the receipt.
 *
 * What this proves and what it does not, plainly:
 *   - proved here: the receipt (status, logs) is in a receipts trie whose root is `receipts_root`;
 *   - NOT proved here: that `receipts_root` is the header of block N on chain C. That root is the
 *     validator's statement. Fetch the block header from any RPC of your own and compare
 *     `receiptsRoot` (and `hash` to `block_hash`) to close the gap — `checkAgainstHeader` does it
 *     when handed a header.
 *
 * No dependencies: keccak-256 and RLP are implemented below, small and readable, because Node's
 * `crypto` has SHA-3 but not the keccak padding Ethereum uses.
 */

// ---- keccak-256 ----------------------------------------------------------------------------------

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT: number[] = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const PI: number[] = [0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4];
const M64 = (1n << 64n) - 1n;
const rotl = (x: bigint, n: number): bigint => n === 0 ? x : (((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);

function keccakF(s: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[y + x] ^= d;
    }
    const b = new Array<bigint>(25);
    for (let i = 0; i < 25; i++) b[PI[i]] = rotl(s[i], ROT[i]);
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) s[y + x] = b[y + x] ^ ((~b[y + (x + 1) % 5]) & M64 & b[y + (x + 2) % 5]);
    }
    s[0] ^= RC[round];
  }
}

/** keccak-256 of `data` (Ethereum's keccak, not NIST SHA3-256). */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136;
  const s = new Array<bigint>(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = s[i];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

// ---- bytes -----------------------------------------------------------------------------------------

export const toHex = (b: Uint8Array): string => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h: string): Uint8Array {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  if (s.length % 2) throw new Error('odd-length hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The bundle writes bytes three ways: hex, base64 (Go's []byte), or a JSON array of numbers (Go's [32]byte). */
export function bytesFrom(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v.map(Number));
  if (typeof v === 'string') {
    if (/^0x[0-9a-fA-F]*$/.test(v)) return fromHex(v);
    if (/^[0-9a-fA-F]{64}$/.test(v)) return fromHex(v);
    return Uint8Array.from(Buffer.from(v, 'base64'));
  }
  if (v && typeof v === 'object' && 'data' in (v as Record<string, unknown>)) return bytesFrom((v as { data: unknown }).data);
  throw new Error('unrecognised byte encoding');
}

// ---- RLP -------------------------------------------------------------------------------------------

export type Rlp = Uint8Array | Rlp[];

function rlpDecodeAt(b: Uint8Array, at: number): { value: Rlp; end: number } {
  const p = b[at];
  if (p === undefined) throw new Error('rlp: truncated');
  if (p < 0x80) return { value: b.slice(at, at + 1), end: at + 1 };
  const lenOfLen = (base: number): { len: number; start: number } => {
    const n = p - base;
    let len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[at + 1 + i];
    return { len, start: at + 1 + n };
  };
  if (p < 0xb8) return { value: b.slice(at + 1, at + 1 + (p - 0x80)), end: at + 1 + (p - 0x80) };
  if (p < 0xc0) { const { len, start } = lenOfLen(0xb7); return { value: b.slice(start, start + len), end: start + len }; }
  let start: number, len: number;
  if (p < 0xf8) { start = at + 1; len = p - 0xc0; } else { ({ len, start } = lenOfLen(0xf7)); }
  const items: Rlp[] = [];
  let i = start;
  while (i < start + len) { const r = rlpDecodeAt(b, i); items.push(r.value); i = r.end; }
  return { value: items, end: start + len };
}
export function rlpDecode(b: Uint8Array): Rlp { return rlpDecodeAt(b, 0).value; }

/** RLP of a non-negative integer, as Ethereum keys transaction indices in the trie. */
export function rlpEncodeUint(n: number): Uint8Array {
  if (n === 0) return Uint8Array.from([0x80]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) bytes.unshift(x % 256);
  if (bytes.length === 1 && bytes[0] < 0x80) return Uint8Array.from(bytes);
  return Uint8Array.from([0x80 + bytes.length, ...bytes]);
}

// ---- Merkle-Patricia trie proof ------------------------------------------------------------------

const nibbles = (b: Uint8Array): number[] => Array.from(b).flatMap((x) => [x >> 4, x & 15]);

/**
 * Walk a Patricia-trie proof from `root` along `key` using only `nodes`, each keyed by its own
 * keccak-256 (the key the prover supplied is never trusted). Returns the value at the key, or
 * throws with the reason the walk failed.
 */
export function verifyTrieProof(root: Uint8Array, key: Uint8Array, nodes: Uint8Array[]): Uint8Array {
  const byHash = new Map<string, Uint8Array>();
  for (const n of nodes) byHash.set(toHex(keccak256(n)), n);
  const path = nibbles(key);
  let want: Uint8Array = root;
  let pos = 0;
  let embedded: Rlp | null = null;
  for (let hop = 0; hop < 64; hop++) {
    let node: Rlp;
    if (embedded) { node = embedded; embedded = null; }
    else {
      const raw = byHash.get(toHex(want));
      if (!raw) throw new Error(`proof is missing the node ${toHex(want).slice(0, 18)}… (hop ${hop})`);
      node = rlpDecode(raw);
    }
    if (!Array.isArray(node)) throw new Error('trie node is not a list');
    if (node.length === 17) {
      if (pos === path.length) { const v = node[16]; if (!(v instanceof Uint8Array)) throw new Error('branch value is not bytes'); return v; }
      const next: Rlp = node[path[pos++]];
      if (Array.isArray(next)) { embedded = next; continue; }
      if (next.length === 0) throw new Error('key is not in the trie (empty branch slot)');
      want = next; continue;
    }
    if (node.length === 2) {
      const enc = node[0] as Uint8Array;
      const flag = enc[0] >> 4;
      const odd = (flag & 1) === 1, leaf = flag >= 2;
      const segment = nibbles(enc).slice(odd ? 1 : 2);
      for (const nb of segment) { if (path[pos++] !== nb) throw new Error('key diverges from the trie path'); }
      const next: Rlp = node[1];
      if (leaf) { if (pos !== path.length) throw new Error('leaf reached before the key was consumed'); if (!(next instanceof Uint8Array)) throw new Error('leaf value is not bytes'); return next; }
      if (Array.isArray(next)) { embedded = next; continue; }
      want = next as Uint8Array; continue;
    }
    throw new Error(`trie node with ${node.length} items`);
  }
  throw new Error('trie walk did not terminate');
}

// ---- receipts --------------------------------------------------------------------------------------

export interface DecodedLog { address: string; topics: string[]; data: string }
export interface DecodedReceipt { type: number; status: number; cumulativeGasUsed: bigint; logs: DecodedLog[] }

/** Decode a consensus-encoded receipt: legacy RLP, or a typed receipt (EIP-2718: one type byte, then RLP). */
export function decodeReceipt(raw: Uint8Array): DecodedReceipt {
  let type = 0, body = raw;
  if (raw[0] < 0x80) { type = raw[0]; body = raw.slice(1); }
  const items = rlpDecode(body);
  if (!Array.isArray(items) || items.length < 4) throw new Error('receipt is not a 4-item list');
  const [statusB, gasB, , logsL] = items as [Uint8Array, Uint8Array, Uint8Array, Rlp[]];
  const toBig = (b: Uint8Array): bigint => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
  const logs = (logsL as Rlp[]).map((l) => {
    const [addr, topics, data] = l as [Uint8Array, Uint8Array[], Uint8Array];
    return { address: toHex(addr), topics: topics.map((t) => toHex(t)), data: toHex(data) };
  });
  return { type, status: Number(toBig(statusB)), cumulativeGasUsed: toBig(gasB), logs };
}

// ---- the component -------------------------------------------------------------------------------

/** Component 5 of a proof bundle, as the validator writes it. */
export interface ExecutionProofComponent {
  chain_id: string;
  tx_hash: string;
  block_number: number;
  block_hash?: string;
  status?: number;
  receipts_root?: string;
  transactions_root?: string;
  raw_receipt?: string;
  logs?: Array<{ address: string; topics: string[]; data: string; log_index?: number }>;
  receipt_inclusion_proof?: { leaf_index: number; expected_root: unknown; proof_nodes?: unknown[]; leaf_value?: unknown };
  tx_inclusion_proof?: unknown;
  verified_by?: string;
  verified_at?: string;
}

export interface ExecutionVerification {
  /** The receipt is in a trie with this root, and it is the receipt the bundle shows. */
  ok: boolean;
  chainId: string;
  txHash: string;
  blockNumber: number;
  blockHash?: string;
  receiptsRoot: string;
  transactionIndex: number;
  receipt?: DecodedReceipt;
  /** A log matching `expect` was found (only set when `expect` was given). */
  expectedLogFound?: boolean;
  /** What was NOT checked here, in words. */
  caveats: string[];
  error?: string;
}

/**
 * Verify component 5 with nothing but its own bytes. Pass `expect` to also look for a specific
 * event (contract address and topic0, optionally topic1) among the receipt's logs.
 */
export function verifyExecutionProof(
  c: ExecutionProofComponent,
  expect?: { address?: string; topic0?: string; topic1?: string },
): ExecutionVerification {
  const base: ExecutionVerification = {
    ok: false, chainId: String(c.chain_id ?? ''), txHash: String(c.tx_hash ?? ''), blockNumber: Number(c.block_number ?? 0),
    blockHash: c.block_hash, receiptsRoot: '', transactionIndex: -1,
    caveats: [
      'the receipts root is the validator\'s statement of the block header; compare it (and block_hash) to the header from an RPC you trust to make this independent of Certen',
      'this proves the receipt executed as shown; whether that was the RIGHT call is your record to compare against',
    ],
  };
  try {
    const p = c.receipt_inclusion_proof;
    if (!p || !Array.isArray(p.proof_nodes) || p.proof_nodes.length === 0) return { ...base, error: 'no receipt inclusion proof in the bundle — outcome cannot be verified from it' };
    const root = bytesFrom(p.expected_root);
    base.receiptsRoot = toHex(root);
    if (c.receipts_root && toHex(bytesFrom(c.receipts_root)) !== base.receiptsRoot) return { ...base, error: 'the proof\'s expected root differs from the component\'s receipts_root' };
    const idx = Number(p.leaf_index);
    base.transactionIndex = idx;
    const nodes = p.proof_nodes.map(bytesFrom);
    const value = verifyTrieProof(root, rlpEncodeUint(idx), nodes);
    if (p.leaf_value != null && !eq(value, bytesFrom(p.leaf_value))) return { ...base, error: 'the trie resolves to a different value than the proof\'s leaf_value' };
    if (c.raw_receipt && !eq(value, bytesFrom(c.raw_receipt))) return { ...base, error: 'the trie resolves to a different receipt than the bundle shows' };
    const receipt = decodeReceipt(value);
    base.receipt = receipt;
    if (c.status != null && Number(c.status) !== receipt.status) return { ...base, error: `the receipt's status is ${receipt.status}, the component says ${c.status}` };
    if (expect) {
      const a = expect.address?.toLowerCase(), t0 = expect.topic0?.toLowerCase(), t1 = expect.topic1?.toLowerCase();
      base.expectedLogFound = receipt.logs.some((l) =>
        (!a || l.address.toLowerCase() === a) && (!t0 || l.topics[0]?.toLowerCase() === t0) && (!t1 || l.topics[1]?.toLowerCase() === t1));
    }
    return { ...base, ok: true };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Close the caveat: compare the component's root and block hash to a header from your own RPC. */
export function checkAgainstHeader(
  v: ExecutionVerification,
  header: { hash?: string; receiptsRoot?: string; number?: string | number },
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (header.receiptsRoot && header.receiptsRoot.toLowerCase() !== v.receiptsRoot.toLowerCase()) reasons.push(`receipts root differs: header ${header.receiptsRoot}, bundle ${v.receiptsRoot}`);
  if (header.hash && v.blockHash && header.hash.toLowerCase() !== v.blockHash.toLowerCase()) reasons.push(`block hash differs: header ${header.hash}, bundle ${v.blockHash}`);
  if (header.number != null && Number(header.number) !== v.blockNumber) reasons.push(`block number differs: header ${Number(header.number)}, bundle ${v.blockNumber}`);
  return { ok: reasons.length === 0, reasons };
}

/** Find component 5 in a bundle JSON, whatever wrapping the share endpoint gave it. */
export function executionComponentOf(bundle: unknown): ExecutionProofComponent | null {
  const b = bundle as Record<string, unknown> | null;
  const pc = (b?.proof_components ?? (b?.bundle as Record<string, unknown> | undefined)?.proof_components) as Record<string, unknown> | undefined;
  const c = pc?.['5_execution_proof'];
  return c && typeof c === 'object' ? (c as ExecutionProofComponent) : null;
}
