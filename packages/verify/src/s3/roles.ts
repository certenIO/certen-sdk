/**
 * Roles that depend on the governed transaction, derived from the transaction the evidence carries (validator xroles.go; design D1(c),
 * D1(f), D4).
 *
 *   - header-authority: every authority Header.Authorities and the body (Transaction.GetAdditionalAuthorities) name. The book and every
 *     page of it carry the role. Proven when the transaction is carried; recorded and Declared when it is not.
 *   - initiator-signer: the page the initiating signature paid from (CreditPayment.Payer: the innermost key page, a lite token address
 *     paying as its lite identity) and every delegator page in that signature's path. The initiating signature is the one whose metadata
 *     hash (or merkle initiator hash) is Header.Initiator. It is found among the carried cause-chain signatures, or it is the document's member
 *     initiatingSignature (DAX-1G: a separate, non-voting initiator, proven completely by carriedInitiatorPages or the document is refused by name);
 *     when it is carried the role is proven exactly. When it is not the role stays a recorded fact, listed as Declared, and the report says so by name.
 *
 * certified-key-page stays Declared in every case: it depends on the key book and page the INTENT declares.
 */
import { equal, VerifyError } from '../proof-v2/bytes.js';
import { AccUrl, goEqualFold, payerOf } from './acc.js';
import type { Evidence, Hop, Vote } from './evidence.js';
import type { XAnchor } from './executor.js';
import { keyHeldDuring, normalizeAccURL } from './govvote.js';
import { additionalAuthorities, bodyType, delegatorPages, headerAuthorities, initiatorOf, principalOf, signatureDidInitiate, signerOf, signerVersionOf, transactionTypeName, txnHash, type WireNode } from './model.js';
import { decodeSigHex, decodeTxnHex, requireSig, verifyKeySignature } from './sig.js';
import { refusal21, State } from './states.js';
import { deriveArrival, normURL, type TimelineStates } from './timeline.js';
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
 * initiatorPages finds the signature that initiated the transaction and returns the pages it makes initiator-signers: its payer and every delegator in its
 * path. found is false when no carried signature initiated the transaction. The signature is the document's member initiatingSignature when it carries one (a
 * separate, non-voting initiator: carriedInitiatorPages proves it completely or refuses the document), else it is searched among the cause-chain signatures of
 * the votes. A signature used here is bound first, exactly as the vote re-evaluation binds it: it is the message its chain entry holds, and a key signature must
 * sign the transaction.
 */
export function initiatorPages(ev: Evidence, txn: WireNode, byURL: Map<string, ProvenAcct>, tl: TimelineStates, x: XAnchor, network: string): { pages: AccUrl[]; found: boolean } {
  if (ev.initiatingSignature) return carriedInitiatorPages(ev, txn, byURL, tl, x, network);
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

/**
 * carriedInitiatorPages proves the initiating signature the document carries (Evidence.initiatingSignature, DAX-1G; validator xroles.go) and returns the pages it
 * makes initiator-signers: the payer and every delegator of its path. It proves the member COMPLETELY or refuses the document by name; there is no state in which a
 * carried signature is only partly proven. Each refusal names the signer page's partition and block (the transaction's when the page is not proven at all). In order:
 *
 *   1. the page the signature is recorded on is a proven page                                    g1_initiator_page_unproven
 *   2. the transaction names an initiator                                                         g1_role_mismatch
 *   3. the signature decodes and is not an authority signature                                   g1_signature_invalid
 *   4. the signature's message hash (the signature's own hash) is the member's message             g1_signature_invalid
 *   5. the signature is the one the header names as the initiator (SignatureDidInitiate)           g1_role_mismatch
 *   6. the message is a member of the page's signature chain as bound at the page's block, and the
 *      claimed block is the one its signature-index chain gives (deriveArrival)                    g1_block_before_signature, g1_arrival_unproven
 *   7. the signature signs this transaction, is of a type the executor version in force there
 *      admits, and its delegation is within the depth limit (govsig.Verify)                        g1_signature_invalid, g1_executor_version_unproven, g1_delegation_depth_exceeded
 *   8. the key signature's payer is the page it is recorded on                                     g1_signature_invalid
 *   9. the page's certified history is carried (folded and replayed by foldTimelines), and a state
 *      of the page at the signature's signer version during the arrival block held the key        g1_history_unavailable, g1_initiator_key_not_held
 *
 * Every delegator of the signature is then required to be a proven page by deriveRoles (g1_initiator_page_unproven). What this does NOT prove: that each delegation of a
 * delegated initiating signature was admitted by the executor at arrival (the delegator pages' entries naming the delegate book); the initiator authorizes nothing, the
 * executor's acceptance of the message is evidenced by its membership in the key page's signature chain (step 6), and the vote model re-evaluates delegation for votes
 * only (docs/proof/G1_CROSS_PARTITION.md, initiator-signer).
 */
export function carriedInitiatorPages(ev: Evidence, txn: WireNode, byURL: Map<string, ProvenAcct>, tl: TimelineStates, x: XAnchor, network: string): { pages: AccUrl[]; found: boolean } {
  const h = ev.initiatingSignature!;
  const page = AccUrl.parse(h.page);
  const pa = page ? byURL.get(page.key) : undefined;
  if (!page || !pa) {
    throw refusal21(State.InitiatorPageUnproven, x.id, x.block, `the initiating signature is carried for ${h.page}, which is not among the proven pages`);
  }
  const id = pa.anchor.id;
  const blk = pa.anchor.block;
  if (initiatorOf(txn).every((b) => b === 0)) {
    throw refusal21(State.RoleMismatch, id, blk, `the transaction names no initiator, so the initiating signature carried for ${h.page} claims a role the transaction does not justify`);
  }
  let decoded: WireNode | null;
  try {
    decoded = decodeSigHex(h.signature);
  } catch (e) {
    if (!(e instanceof VerifyError)) throw e;
    throw refusal21(State.SignatureInvalid, id, blk, `the initiating signature on ${h.page}: ${e.message}`);
  }
  // Accumulate's union decoder answers neither a signature nor an error for bytes that hold no type (a run of zeros): there is no signature to read.
  if (!decoded) throw refusal21(State.SignatureInvalid, id, blk, `the initiating signature on ${h.page}: a signature does not decode: it holds no signature`);
  const sig = decoded;
  if (sig.cls === 'AuthoritySignature') {
    throw refusal21(State.SignatureInvalid, id, blk, `the initiating signature on ${h.page} is an authority signature, which cannot initiate a transaction`);
  }
  if (Buffer.from(signatureHash(sig)).toString('hex') !== h.message.toLowerCase()) {
    throw refusal21(State.SignatureInvalid, id, blk, `the initiating signature on ${h.page} is not the message its chain entry holds`);
  }
  if (!signatureDidInitiate(sig, initiatorOf(txn))) {
    throw refusal21(State.RoleMismatch, id, blk, `the signature carried for ${h.page} is not the one the transaction header names as its initiator: initiator-signer is claimed for it and the transaction does not justify it`);
  }
  if (!h.arrival) throw refusal21(State.ArrivalUnproven, id, blk, `the initiating signature on ${h.page} carries no arrival proof`);
  const block = deriveArrival(pa, ev.pages[pa.i]!, 'signature', h.message, h.receipt, h.arrival);
  if (block !== h.block) {
    throw refusal21(State.ArrivalUnproven, id, blk, `the initiating signature on ${h.page} was claimed to arrive in block ${h.block}, its signature-index chain says ${block}`);
  }
  const vs = verifyKeySignature(sig, txn, network, pa, h.page, block);
  const signer = signerOf(vs.inner);
  if (!signer || normURL(payerOf(signer)) !== normURL(page)) {
    throw refusal21(State.SignatureInvalid, id, blk, `the initiating signature recorded on ${h.page} is by ${signer ? signer.toString() : '<nil>'}`);
  }
  const st = tl.get(normalizeAccURL(h.page));
  if (!st) {
    throw refusal21(
      State.HistoryUnavailable,
      id,
      blk,
      `the initiating signature on ${h.page} is carried without the page's certified history, so the key it was made with cannot be judged against the page as it stood when the signature arrived`,
    );
  }
  const version = signerVersionOf(vs.inner);
  if (keyHeldDuring(st, bodyType(txn), version, block, vs.keyHash).holding === 0) {
    throw refusal21(
      State.InitiatorKeyNotHeld,
      id,
      blk,
      `no state of ${h.page} at version ${version} during block ${block} both held the key of the initiating signature and allowed a ${transactionTypeName(bodyType(txn))}`,
    );
  }
  const pages: AccUrl[] = [payerOf(signer)];
  pages.push(...delegatorPages(sig));
  return { pages, found: true };
}
