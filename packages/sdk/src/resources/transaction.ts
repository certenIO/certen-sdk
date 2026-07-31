import { AxiosInstance } from 'axios';
import { omitUndefined } from '../internal.js';
import type {
  CreateTransactionParams,
  TransactionResponse,
  SubmitSignatureParams,
  ListTransactionsParams,
} from '../types.js';

export class TransactionResource {
  constructor(private http: AxiosInstance) {}

  /**
   * Open a transaction intent.
   *
   * This previously sent a flat `{ type, to, amount, token, chain, memo }` body and never sent `intent`,
   * which the API REQUIRES — so every call 400'd. The mistake was invisible because the SDK's own tests
   * only exercised retry and error plumbing against a mock that accepted anything;
   * `test/contract.test.ts` now validates request shapes against a snapshot of the live OpenAPI spec.
   */
  async create(params: CreateTransactionParams): Promise<TransactionResponse> {
    const headers: Record<string, string> = {};
    if (params.idempotencyKey) {
      headers['Idempotency-Key'] = params.idempotencyKey;
    }
    const { data } = await this.http.post(
      '/v1/transaction',
      omitUndefined({
        identity_id: params.identityId,
        intent: params.intent,
        contract_addresses: params.contractAddresses,
        proof_class: params.proofClass,
        signer_key_page: params.signerKeyPage,
        signer_public_key: params.signerPublicKey,
      }),
      { headers },
    );
    return data;
  }

  async submitSignature(id: string, params: SubmitSignatureParams): Promise<TransactionResponse> {
    const { data } = await this.http.post(`/v1/transaction/${id}/signature`, {
      signature: params.signature,
      public_key: params.publicKey,
    });
    return data;
  }

  async get(id: string): Promise<TransactionResponse> {
    const { data } = await this.http.get(`/v1/transaction/${id}`);
    return data;
  }

  async list(params?: ListTransactionsParams): Promise<{ transactions: TransactionResponse[]; pagination: unknown }> {
    const { data } = await this.http.get('/v1/transactions', {
      params: {
        limit: params?.limit,
        offset: params?.offset,
      },
    });
    return data;
  }
}
