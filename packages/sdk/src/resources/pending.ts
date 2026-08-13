import { AxiosInstance } from 'axios';
import { paginate } from '../client.js';
import type { PendingActionsResponse, ListPendingParams, PendingAction } from '../types.js';

export class PendingResource {
  constructor(private http: AxiosInstance) {}

  async list(params?: ListPendingParams): Promise<PendingActionsResponse> {
    const { data } = await this.http.get('/v1/pending', {
      params: {
        identity: params?.identity,
        status: params?.status,
        category: params?.category,
        limit: params?.limit,
        offset: params?.offset,
      },
    });
    return data;
  }

  /**
   * Every pending action, fetched a page at a time.
   *
   * ```ts
   * for await (const action of certen.pending.listAll({ identity })) { … }
   * ```
   *
   * Filters are passed through, so this narrows the same way `list()` does. `stats` is not carried:
   * it describes a page's context, and an iterator that spans pages has no single one to report —
   * call `list()` when you want the counts.
   */
  listAll(params?: Omit<ListPendingParams, 'limit' | 'offset'>, pageSize = 100): AsyncIterableIterator<PendingAction> {
    return paginate<PendingAction>(
      async (limit, offset) => ({ items: (await this.list({ ...params, limit, offset })).actions ?? [] }),
      pageSize,
    );
  }
}
