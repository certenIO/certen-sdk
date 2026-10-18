/**
 * The binding of an account's chain roots to the receipt that proves the account into a state root, and the proof of an account into a BPT
 * root (validator pkg/proof: validator_set_proof.go AccountStateProof.verify / verifyChainBinding / ChainRoot.derive, validator_set_at.go
 * VerifyChainBinding / MainChainHeight, page.go verifyPage).
 *
 * The state hasher is [main, secondaryState, chains, pending], so a receipt from the account's state to the root has the secondary
 * component as its first sibling and H(merkle(chain roots) || pending) as its second: the chain roots a document states are bound to the
 * block exactly when they recompute that second sibling. Every hex string is read with Go's helpers: a hash must be 64 hex characters, a
 * pending hash may carry a 0x prefix and spaces (hexBytes), and nothing else is tolerated.
 */
import { VerifyError, equal, merkleHashList, sha256, toHex } from '../proof-v2/bytes.js';
import type { ChainRoot } from './evidence.js';
import { goHex } from './gojson.js';

const fail = (m: string): never => {
  throw new VerifyError(m);
};

/** chained_proof.MustHex32Lower: exactly 64 hex characters (case-insensitive); returns the bytes. */
export function mustHex32(s: string, label: string): Uint8Array {
  if (s === '') return fail(`${label}: empty`);
  if (s.length !== 64) return fail(`${label}: expected 64 hex chars (32 bytes), got len=${s.length} (${JSON.stringify(s)})`);
  const b = goHex(s);
  if (!b) return fail(`${label}: invalid hex: encoding/hex: invalid byte`);
  return b;
}

/** The characters strings.TrimSpace removes (Unicode White_Space); String.prototype.trim differs (it removes U+FEFF and keeps U+0085). */
function isGoSpace(c: number): boolean {
  return (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

/** strings.TrimSpace. */
export function goTrimSpace(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isGoSpace(s.charCodeAt(a))) a++;
  while (b > a && isGoSpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** pkg/proof hexBytes: trimmed (strings.TrimSpace), lower-cased, an optional 0x prefix removed, then hex.DecodeString. */
export function hexBytesLoose(s: string, label: string): Uint8Array {
  let t = goTrimSpace(s).toLowerCase();
  if (t.startsWith('0x')) t = t.slice(2);
  const b = goHex(t);
  if (!b) return fail(`${label}: invalid hex: encoding/hex: invalid byte`);
  return b;
}

/** validator_set_proof.go recomputeReceipt: lower-cased, an optional 0x prefix removed, then hex.DecodeString - space is not trimmed. */
function hexReceiptStep(s: string): Uint8Array | undefined {
  const t = s.toLowerCase();
  return goHex(t.startsWith('0x') ? t.slice(2) : t);
}

/** ChainRoot.compute: the height and the DAG root from the pending list alone. */
function compute(c: ChainRoot): { count: number; anchor: Uint8Array } {
  let count = 0;
  let anchor: Uint8Array | undefined;
  (c.pending ?? []).forEach((v, i) => {
    if (v === null) return;
    count += 2 ** i;
    let h: Uint8Array;
    try {
      h = hexBytesLoose(v, 'chain pending entry');
    } catch {
      return fail(`chain ${JSON.stringify(c.name)}: pending[${i}] must be 32 bytes of hex`);
    }
    if (h.length !== 32) return fail(`chain ${JSON.stringify(c.name)}: pending[${i}] must be 32 bytes of hex`);
    anchor = anchor === undefined ? h : sha256(h, anchor);
  });
  return { count, anchor: anchor ?? new Uint8Array(32) };
}

/** ChainRoot.derive: the restated count and anchor must agree with the pending list. */
export function deriveChain(c: ChainRoot): { count: number; anchor: Uint8Array } {
  const { count, anchor } = compute(c);
  if (count !== c.count) fail(`chain ${JSON.stringify(c.name)}: restated count ${c.count} but its merkle state says ${count} - the height is not what the proof claims`);
  // strings.ToLower(strings.TrimPrefix(c.Anchor, "0x")): the prefix is removed BEFORE the lower-casing, so a "0X" prefix stays and never matches
  const restated = (c.anchor.startsWith('0x') ? c.anchor.slice(2) : c.anchor).toLowerCase();
  if (restated !== '' && count > 0 && toHex(anchor) !== restated) {
    fail(`chain ${JSON.stringify(c.name)}: restated anchor does not match its merkle state: computed=${toHex(anchor).slice(0, 16)} restated=${restated.slice(0, 16)}`);
  }
  return { count, anchor };
}

/** MainChainHeight: the height of the first chain named main, when there is one and it derives. */
export function mainChainHeight(chains: ChainRoot[]): number | undefined {
  for (const c of chains) {
    if (c.name === 'main') {
      try {
        return deriveChain(c).count;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** A receipt in the chained form: hex strings, as the proofs of accounts carry them. */
export interface ChainedReceipt {
  start: string;
  anchor: string;
  entries: { hash: string; right: boolean }[];
}

/** AccountStateProof.verifyChainBinding, with the secondary hash and the chains it is given. */
export function verifyChainBinding(r: ChainedReceipt, chains: ChainRoot[], secondaryHash: string, pendingHash: string): void {
  if (r.entries.length < 2) fail(`state receipt has ${r.entries.length} steps; the four-element state hasher needs at least 2 before the BPT path`);
  if (secondaryHash === '' || pendingHash === '') {
    fail("secondaryHash and pendingHash are required: the receipt's second step is H(chains || pending), so the chain roots alone cannot be checked");
  }
  const sec = mustHex32(secondaryHash, 'secondaryHash');
  const first = r.entries[0]!.hash.toLowerCase();
  if (first !== toHex(sec)) fail(`secondaryHash is not the receipt's first sibling: got=${toHex(sec).slice(0, 16)} want=${first.slice(0, 16)}`);
  const leaves: Uint8Array[] = chains.map((c, i) => {
    try {
      const { count, anchor } = deriveChain(c);
      return count === 0 ? new Uint8Array(32) : anchor;
    } catch (e) {
      return fail(`chains[${i}]: ${(e as Error).message}`);
    }
  });
  const pend = hexBytesLoose(pendingHash, 'pendingHash');
  if (pend.length !== 32) fail('pendingHash must be 32 bytes');
  const combined = sha256(merkleHashList(leaves), pend);
  const second = r.entries[1]!.hash.toLowerCase();
  if (toHex(combined) !== second) fail(`H(chains||pending) is not the receipt's second sibling: computed=${toHex(combined).slice(0, 16)} receipt=${second.slice(0, 16)} - the chain heights are NOT bound`);
}

/** recomputeReceipt: the root a chained receipt's path reaches from its start. */
function recomputeReceipt(r: ChainedReceipt): Uint8Array {
  const start = hexReceiptStep(r.start);
  if (start === undefined || start.length !== 32) return fail('receipt.start must be 32 bytes of hex');
  let cur: Uint8Array = start;
  r.entries.forEach((e, i) => {
    const h = hexReceiptStep(e.hash);
    if (h === undefined || h.length !== 32) return fail(`receipt.entries[${i}].hash must be 32 bytes of hex`);
    cur = e.right ? sha256(cur, h) : sha256(h, cur);
  });
  return cur;
}

/**
 * AccountStateProof.verify (steps 11-13): the account's state hashes to the leaf being proven, the merkle path recomputes, and the chain
 * history is bound to the receipt. Returns the BPT root the account is proven into and the main chain's height.
 */
export function verifyAccountState(state: Uint8Array, r: ChainedReceipt, chains: ChainRoot[], secondaryHash: string, pendingHash: string): { root: Uint8Array; mainHeight: number | undefined } {
  const leaf = sha256(state);
  const start = mustHex32(r.start, 'stateReceipt.start');
  if (!equal(leaf, start)) fail(`accountState does not hash to the proven leaf: sha256(state)=${toHex(leaf.subarray(0, 8))} start=${toHex(start).slice(0, 16)}`);
  const got = recomputeReceipt(r);
  const claimed = mustHex32(r.anchor, 'stateReceipt.anchor');
  if (!equal(got, claimed)) fail(`state receipt does not recompute: got=${toHex(got).slice(0, 16)} want=${toHex(claimed).slice(0, 16)}`);
  verifyChainBinding(r, chains, secondaryHash, pendingHash);
  return { root: claimed, mainHeight: mainChainHeight(chains) };
}

/** A merkle.Receipt (bytes) as the chained form: the hex strings VerifyChainBinding reads. */
export function toChained(r: { start: Uint8Array; anchor: Uint8Array; entries: { hash: Uint8Array; right: boolean }[] }): ChainedReceipt {
  return { start: toHex(r.start), anchor: toHex(r.anchor), entries: r.entries.map((e) => ({ hash: toHex(e.hash), right: e.right })) };
}

export interface PageChainX {
  url: string;
  bound: boolean;
  mainHeight: number;
  note?: string;
}

/**
 * verifyPage, the chains: a page captured with its chain roots must bind them to its receipt, which proves them the roots at the anchor's
 * block; a page captured without them is named unbound, with the capture's reason.
 */
export function pageChains(url: string, chains: ChainRoot[], pendingHash: string, chainError: string, r: { start: Uint8Array; anchor: Uint8Array; entries: { hash: Uint8Array; right: boolean }[] }): PageChainX {
  if (chains.length === 0) return { url, bound: false, mainHeight: 0, note: chainError !== '' ? chainError : 'g1_chain_uncaptured' };
  const cr = toChained(r);
  try {
    verifyChainBinding(cr, chains, r.entries.length > 0 ? toHex(r.entries[0]!.hash) : '', pendingHash);
  } catch (e) {
    throw new VerifyError(`${url}: chains: ${(e as Error).message}`);
  }
  const h = mainChainHeight(chains);
  if (h === undefined) fail(`${url}: no main chain among the bound chains`);
  return { url, bound: true, mainHeight: h! };
}
