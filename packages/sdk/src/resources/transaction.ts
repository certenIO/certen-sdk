import { AxiosInstance } from 'axios';
import { omitUndefined } from '../internal.js';
import { paginate } from '../client.js';
import type {
  CreateTransactionParams,
  CreateTransactionResponse,
  TransactionResponse,
  ListTransactionsResponse,
  SubmitSignatureParams,
  SubmitSignatureResponse,
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
  async create(params: CreateTransactionParams): Promise<CreateTransactionResponse> {
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

  async submitSignature(id: string, params: SubmitSignatureParams): Promise<SubmitSignatureResponse> {
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

  // Declared `{ transactions, pagination }`; the endpoint returns `{ transactions, limit, offset }`
  // with no pagination object at all.
  async list(params?: ListTransactionsParams): Promise<ListTransactionsResponse> {
    const { data } = await this.http.get('/v1/transactions', {
      params: {
        limit: params?.limit,
        offset: params?.offset,
      },
    });
    return data;
  }

  /**
   * Every transaction, fetched a page at a time.
   *
   * ```ts
   * for await (const tx of certen.transaction.listAll()) { … }
   * ```
   *
   * The `paginate` helper has been exported since 0.2.0, but it takes a callback returning
   * `{ items }` and NO method on this SDK returns that shape — `list()` returns `{ transactions }`.
   * So the helper could not be used without first hand-writing the adapter it should have contained:
   *
   * ```ts
   * paginate((limit, offset) =>
   *   certen.transaction.list({ limit, offset }).then((r) => ({ items: r.transactions })))
   * ```
   *
   * Exporting a helper that composes with nothing it ships beside is worse than not exporting one:
   * it reads as a solved problem. The adapter lives here now, once, instead of in every caller.
   */
  listAll(pageSize = 100): AsyncIterableIterator<TransactionResponse> {
    return paginate<TransactionResponse>(
      async (limit, offset) => ({ items: (await this.list({ limit, offset })).transactions ?? [] }),
      pageSize,
    );
  }
}
