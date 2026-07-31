import { AxiosInstance } from 'axios';
import type { PendingActionsResponse, ListPendingParams } from '../types.js';

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
}
