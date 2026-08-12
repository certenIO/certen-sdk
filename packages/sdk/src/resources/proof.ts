import { AxiosInstance } from 'axios';
import type {
  ProofArtifact, ProofCustody, ChainReceipt, ProofShare, ProofSharesResponse,
} from '../types.js';

/**
 * Reading and sharing proofs.
 *
 * A transaction hash is a claim; a proof is evidence. These are the reads a counterparty performs
 * instead of trusting you — and the reads you perform to hand them something to check.
 *
 * **Two independent sources sit behind these methods, and they fail independently.**
 *
 * `proof/{id}`, `/bundle` and `/custody` are served by the proof-service. `proof/tx/{hash}/receipt`
 * is read live from Accumulate. When the proof-service is unavailable the first three return 5xx
 * — with a plain-text body, not JSON — while the receipt keeps working, because it never touched
 * the proof-service at all. Code that treats "the proof endpoint failed" as "there is no proof"
 * gets this exactly backwards, and the receipt is usually still there to be had.
 *
 * The receipt is also the only route that works for governance and key-page authorizations, which
 * the proof-service does not index and which therefore carry no `proof_id`.
 */
export class ProofResource {
  constructor(private http: AxiosInstance) {}

  /** The proof artifact for a proof id. Shape is defined by the proof-service, not by this SDK. */
  async get(proofId: string): Promise<ProofArtifact> {
    const { data } = await this.http.get(`/v1/proof/${proofId}`);
    return data;
  }

  /** The proof artifact for a transaction hash, where the proof-service indexed one. */
  async byTxHash(txHash: string): Promise<ProofArtifact> {
    const { data } = await this.http.get(`/v1/proof/tx/${txHash}`);
    return data;
  }

  /**
   * The Accumulate merkle inclusion receipt for a transaction, read from the network.
   *
   * This is the read that works everywhere: any delivered transaction has one, including the
   * governance and key-page authorizations the proof-service does not index. When a `proof_id`
   * lookup comes back empty for something you know executed, this is what you want.
   */
  async receipt(txHash: string): Promise<ChainReceipt> {
    const { data } = await this.http.get(`/v1/proof/tx/${txHash}/receipt`);
    return data;
  }

  /**
   * The full bundle.
   *
   * Returned as a Buffer because the gateway streams `application/octet-stream` when the
   * downstream produces binary and JSON otherwise. Deciding between them here would mean
   * guessing; the caller writes it to a file, and `contentType` says which it got.
   */
  async bundle(proofId: string): Promise<{ data: Buffer; contentType: string }> {
    const response = await this.http.get(`/v1/proof/${proofId}/bundle`, {
      responseType: 'arraybuffer',
    });
    return {
      data: Buffer.from(response.data as ArrayBuffer),
      contentType: String(response.headers['content-type'] ?? 'application/octet-stream'),
    };
  }

  /** The custody chain for a proof. */
  async custody(proofId: string): Promise<ProofCustody> {
    const { data } = await this.http.get(`/v1/proof/${proofId}/custody`);
    return data;
  }

  /**
   * Mint a shareable link, so a counterparty can fetch the bundle without an API key of yours.
   *
   * The token is returned once. `expiresIn` is seconds.
   */
  async share(proofId: string, params: { label?: string; expiresIn?: number } = {}): Promise<ProofShare> {
    const { data } = await this.http.post(`/v1/proof/${proofId}/share`, {
      label: params.label,
      expires_in: params.expiresIn,
    });
    return data;
  }

  /** Every share link this organization has created, including revoked and expired ones. */
  async shares(): Promise<ProofSharesResponse> {
    const { data } = await this.http.get('/v1/proof/shares');
    return data;
  }

  /** Revoke a share link. The token stops resolving; the proof itself is untouched. */
  async revokeShare(shareId: string): Promise<{ revoked?: boolean; [key: string]: unknown }> {
    const { data } = await this.http.delete(`/v1/proof/shares/${shareId}`);
    return data;
  }
}
