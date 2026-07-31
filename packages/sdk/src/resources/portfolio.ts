import { AxiosInstance } from 'axios';
import type { PortfolioResponse } from '../types.js';

export class PortfolioResource {
  constructor(private http: AxiosInstance) {}

  async get(identity?: string): Promise<PortfolioResponse> {
    const { data } = await this.http.get('/v1/portfolio', {
      params: identity ? { identity } : undefined,
    });
    return data;
  }
}
