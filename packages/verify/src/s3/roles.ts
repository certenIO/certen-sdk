/**
 * Roles that depend on the governed transaction, derived from the transaction the evidence carries (validator xroles.go; design D1(c),
 * D1(f), D4).
 *
 *   - header-authority: every authority Header.Authorities and the body (Transaction.GetAdditionalAuthorities) name. The book and every
 *     page of it carry the role. Proven when the transaction is carried; recorded and Declared when it is not.
 *   - initiator-signer: the page the initiating signature paid from (CreditPayment.Payer: the innermost key page, a lite token address
 *     paying as its lite identity) and every delegator page in that signature's path. The initiating signature is the one whose metadata
 *     hash (or merkle initiator hash) is Header.Initiator. It is found among the carried cause-chain signatures; when it is among them the
 *     role is proven exactly. When it is not the role stays a recorded fact, listed as Declared, and the report says so by name.
 *
 * certified-key-page stays Declared in every case: it depends on the key book and page the INTENT declares.
 */
import { equal } from '../proof-v2/bytes.js';
import { AccUrl, goEqualFold, payerOf } from './acc.js';
import type { Evidence, Hop, Vote } from './evidence.js';
import type { XAnchor } from './executor.js';
import { additionalAuthorities, delegatorPages, headerAuthorities, initiatorOf, principalOf, signatureDidInitiate, signerOf, txnHash, type WireNode } from './model.js';
import { decodeSigHex, decodeTxnHex, requireSig, verifyKeySignature } from './sig.js';
import { refusal21, State } from './states.js';
import type { ProvenAcct } from './xtypes.js';
import { signatureHash } from './model.js';

/** allHops: the signatures a vote's pages counted - the cause chain, then the other counted signatures. */
export function allHops(v: Vote): Hop[] {
  return [...(v.hops ?? []), ...(v.counted ?? [])];
}

/**
 * carriedTransaction decodes the transaction the evidence carries and requires it to be the one the evidence names: its hash TxHash and its
 * principal the evidence's account (g1_transaction_mismatch otherwise). undefined when none is carried.
 */
export function carriedTransaction(ev: Evidence, x: XAnchor): WireNode | undefined {
  if (ev.transaction === '') return undefined;
  let txn: WireNode;
  try {
    txn = decodeTxnHex(ev.transaction);
  } catch (e) {
    throw refusal21(State.TransactionMismatch, x.id, x.block, e instanceof Error ? e.message : String(e));
  }
  const h = txnHash(txn);
  const want = Buffer.from(ev.txHash, 'hex'); // hex.DecodeString errors are ignored: the receipt check has refused an invalid txHash
  if (!equal(h, new Uint8Array(want)) || want.length !== h.length) {
    throw refusal21(State.TransactionMismatch, x.id, x.block, `the carried transaction hashes to ${Buffer.from(h.subarray(0, 8)).toString('hex')}, not the transaction ${ev.txHash.slice(0, 16)}`);
  }
  const principal = principalOf(txn);
  if (!principal || !goEqualFold(principal.toString(), ev.account)) {
    throw refusal21(State.TransactionMismatch, x.id, x.block, `the carried transaction acts on ${principal}, not ${ev.account}`);
  }
  return txn;
}

/** headerAuthorityURLs: the authorities the transaction requires beyond the principal's, without repeats, in order. */
export function headerAuthorityURLs(txn: WireNode): AccUrl[] {
  const out: AccUrl[] = [];
  const seen = new Set<string>();
  for (const a of [...headerAuthorities(txn), ...additionalAuthorities(txn)]) {
    if (!seen.has(a.key)) {
      seen.add(a.key);
      out.push(a);
    }
  }
  return out;
}

/**
 * initiatorPages finds, among the cause-chain signatures the evidence carries, the signature that initiated the transaction and returns
 * the pages it makes initiator-signers: its payer and every delegator in its path. A signature used here is bound first, exactly as the
 * vote re-evaluation binds it: it is the message its chain entry holds, and a key signature must sign the transaction.
 */
export function initiatorPages(ev: Evidence, txn: WireNode, byURL: Map<string, ProvenAcct>, network: string): { pages: AccUrl[]; found: boolean } {
  const init = initiatorOf(txn);
  if (init.every((b) => b === 0)) return { pages: [], found: false };
  const seen = new Set<string>();
  for (const v of ev.votes) {
    for (const h of allHops(v)) {
      if (seen.has(h.message)) continue;
      seen.add(h.message);
      let sig: WireNode | null;
      try {
        sig = decodeSigHex(h.signature);
      } catch {
        continue; // a signature that does not decode initiates nothing; the re-evaluation refuses it by name
      }
      const s = requireSig(sig);
      if (s.cls === 'AuthoritySignature') continue;
      if (!signatureDidInitiate(s, init)) continue;
      let pa = byURL.get(h.page.toLowerCase());
      const hp = AccUrl.parse(h.page);
      if (hp) {
        const p2 = byURL.get(hp.key);
        if (p2) pa = p2;
      }
      const id = pa ? pa.anchor.id : '';
      const blk = pa ? pa.anchor.block : 0;
      if (Buffer.from(signatureHash(s)).toString('hex') !== h.message.toLowerCase()) {
        throw refusal21(State.SignatureInvalid, id, blk, `the initiating signature on ${h.page} is not the message its chain entry holds`);
      }
      let signer: AccUrl | undefined;
      if (pa) {
        const vs = verifyKeySignature(s, txn, network, pa, h.page, h.block);
        signer = signerOf(vs.inner);
      } else {
        // A page that is not among the proven pages: the signature must still be a user signature that verifies over the transaction.
        throw refusal21(State.SignatureInvalid, id, blk, `the initiating signature on ${h.page} does not sign the transaction`);
      }
      const pages: AccUrl[] = [];
      if (signer) pages.push(payerOf(signer));
      pages.push(...delegatorPages(s));
      return { pages, found: true };
    }
  }
  return { pages: [], found: false };
}
