import { AxiosInstance } from 'axios';
import type {
  TransparencyLogInfo,
  TransparencyHead,
  ConsistencyProof,
  PublishedPriceBook,
  FxObservation,
} from '../types.js';

/**
 * The public transparency log.
 *
 * This is what turns a receipt from an assertion into evidence. A receipt's signature says CERTEN
 * issued it; the log says CERTEN did not later hide or edit it, because every receipt is a leaf of
 * an append-only Merkle tree whose roots are signed and written to Accumulate.
 *
 * The receipt's own verification instructions name these endpoints — "check root_hash against the
 * signed head at this tree size" — and none of them had a client surface, so the instruction could
 * not be followed without hand-rolling HTTP. A verification procedure nobody can run is not a
 * verification procedure.
 *
 * **These reads need no API key.** That is deliberate on the gateway's side and worth preserving in
 * your integration: evidence obtainable only by asking CERTEN nicely could not settle a dispute
 * with CERTEN. The client sends its key anyway because it sends one to everything; the endpoints do
 * not require it.
 */
export class TransparencyResource {
  constructor(private http: AxiosInstance) {}

  /** What the log is, how big it is, and where its roots are anchored. */
  async log(): Promise<TransparencyLogInfo> {
    const { data } = await this.http.get('/v1/transparency');
    return data;
  }

  /** Signed tree heads, newest first. */
  async heads(params: { limit?: number; offset?: number } = {}): Promise<{ heads: TransparencyHead[] }> {
    const { data } = await this.http.get('/v1/transparency/heads', {
      params: { limit: params.limit ?? 50, offset: params.offset ?? 0 },
    });
    return data;
  }

  /**
   * The signed head at one tree size.
   *
   * Step three of verifying a receipt: fold its audit path to a root, then check that root against
   * the head fetched HERE rather than against the `root_hash` the proof itself carried. Comparing a
   * proof to a root supplied in the same response proves nothing — it is the independent fetch, and
   * the signature on it, that makes the check mean something.
   */
  async head(treeSize: number): Promise<TransparencyHead> {
    const { data } = await this.http.get(`/v1/transparency/heads/${treeSize}`);
    return data;
  }

  /**
   * Proof that the log at `second` extends the log at `first` without rewriting it.
   *
   * Needed whenever a receipt's own head is not the one that got anchored. The anchored head is
   * later and larger, and this is what shows the anchored root still commits to everything the
   * earlier root did — that the log was appended to, not rebuilt.
   */
  async consistency(first: number, second: number): Promise<ConsistencyProof> {
    const { data } = await this.http.get('/v1/transparency/consistency', {
      params: { first, second },
    });
    return data;
  }

  /**
   * Every published price book, with its hash and the window it was in force.
   *
   * A receipt carries `price_book_hash`. This is where that hash resolves to actual prices — which
   * is what lets someone check that a charge matched the prices published at the time, rather than
   * prices chosen afterwards.
   */
  async priceBooks(): Promise<{ price_books: PublishedPriceBook[] }> {
    const { data } = await this.http.get('/v1/transparency/price-books');
    return data;
  }

  /**
   * A signed FX observation.
   *
   * A gas-priced charge converts native currency to USD at a rate observed at a moment. The receipt
   * names the observation; this returns it, signed, so the conversion can be rechecked rather than
   * taken on trust.
   */
  async fx(id: string): Promise<FxObservation> {
    const { data } = await this.http.get(`/v1/transparency/fx/${encodeURIComponent(id)}`);
    return data;
  }
}
