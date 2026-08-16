import { AxiosInstance } from 'axios';
import { paginate } from '../client.js';
import type { WebhookEndpoint, WebhookDelivery, Pagination } from '../types.js';

/**
 * Webhook endpoints, and what happened to each delivery.
 *
 * The gateway has had a delivery queue, a retry policy, an event registry and a customer-facing
 * signature-verification guide since early on. None of it had a client surface — so the only push
 * mechanism CERTEN offers could be configured nowhere, and a failed delivery could be neither seen
 * nor retried. A webhook a customer cannot inspect is worse than no webhook: it fails silently and
 * looks like the event never happened.
 *
 * These lived under `/v1/admin/webhooks/*` and required `admin:write` — a scope that also grants
 * revoking every API key in the organization, attributing payments and publishing price books.
 * The data was always org-scoped, so the path and the scope both overstated what this is. Moved to
 * `/v1/webhooks/*` with `webhook:read` and `webhook:write`, which cover exactly this and nothing
 * else.
 */
export class WebhooksResource {
  constructor(private http: AxiosInstance) {}

  /** Endpoints registered for this organization. Requires `webhook:read`. */
  async list(): Promise<{ endpoints: WebhookEndpoint[] }> {
    const { data } = await this.http.get('/v1/webhooks/endpoints');
    return data;
  }

  /**
   * Register an endpoint.
   *
   * **The signing secret is returned once and never again.** Store it before doing anything else —
   * without it you cannot verify that a delivery came from CERTEN, and the only recovery is
   * `rotateSecret`, which invalidates whatever the previous secret was signing.
   *
   * Supply your own `secret` to keep the value out of a response body entirely. Omit `eventTypes`
   * to receive everything.
   */
  async register(params: {
    url: string;
    secret?: string;
    eventTypes?: string[];
    description?: string;
    /** Skip the verification ping. The endpoint is registered unverified. */
    skipVerification?: boolean;
  }): Promise<WebhookEndpoint & { secret?: string; warning?: string }> {
    const { data } = await this.http.post('/v1/webhooks/endpoints', {
      url: params.url,
      ...(params.secret ? { secret: params.secret } : {}),
      ...(params.eventTypes ? { event_types: params.eventTypes } : {}),
      ...(params.description ? { description: params.description } : {}),
      ...(params.skipVerification ? { skip_verification: true } : {}),
    });
    return data;
  }

  /** Change an endpoint's URL, events, description, or active state. Requires `webhook:write`. */
  async update(id: string, params: {
    url?: string;
    eventTypes?: string[];
    description?: string;
    isActive?: boolean;
  }): Promise<WebhookEndpoint> {
    const { data } = await this.http.patch(`/v1/webhooks/endpoints/${encodeURIComponent(id)}`, {
      ...(params.url ? { url: params.url } : {}),
      ...(params.eventTypes ? { event_types: params.eventTypes } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.isActive !== undefined ? { is_active: params.isActive } : {}),
    });
    return data;
  }

  /** Stop delivering to an endpoint. Requires `webhook:write`. */
  async remove(id: string): Promise<{ deleted?: boolean; [k: string]: unknown }> {
    const { data } = await this.http.delete(`/v1/webhooks/endpoints/${encodeURIComponent(id)}`);
    return data;
  }

  /**
   * Issue a new signing secret.
   *
   * NOT retry-safe: each call invalidates the secret the previous one issued, so a retry can strand
   * a receiver that was verifying correctly seconds earlier. Returns the new secret once.
   */
  async rotateSecret(id: string): Promise<{ secret: string; [k: string]: unknown }> {
    const { data } = await this.http.post(
      `/v1/webhooks/endpoints/${encodeURIComponent(id)}/rotate-secret`,
    );
    return data;
  }

  /** Re-run the verification ping against an endpoint. Requires `webhook:write`. */
  async verify(id: string): Promise<WebhookEndpoint> {
    const { data } = await this.http.post(
      `/v1/webhooks/endpoints/${encodeURIComponent(id)}/verify`,
    );
    return data;
  }

  /**
   * Delivery attempts, newest first. Requires `webhook:read`.
   *
   * This is the half that makes webhooks debuggable: a delivery that failed is otherwise invisible
   * to the person waiting for the event.
   */
  async deliveries(
    params: { limit?: number; offset?: number } = {},
  ): Promise<{ deliveries: WebhookDelivery[]; pagination?: Pagination }> {
    const { data } = await this.http.get('/v1/webhooks/deliveries', {
      params: { limit: params.limit ?? 50, offset: params.offset ?? 0 },
    });
    return data;
  }

  /** Every delivery, paging automatically on `has_more`. */
  deliveriesAll(pageSize = 100): AsyncIterableIterator<WebhookDelivery> {
    return paginate<WebhookDelivery>(
      async (limit, offset) => {
        const page = await this.deliveries({ limit, offset });
        return { items: page.deliveries ?? [], hasMore: page.pagination?.has_more };
      },
      pageSize,
    );
  }

  /** One delivery, including the response body the endpoint returned. Requires `webhook:read`. */
  async delivery(id: string): Promise<WebhookDelivery> {
    const { data } = await this.http.get(`/v1/webhooks/deliveries/${encodeURIComponent(id)}`);
    return data;
  }

  /**
   * Send a delivery again.
   *
   * Deliberately NOT retry-safe: delivering again is the entire point, so calling this twice
   * delivers twice. Make sure the receiver is idempotent before leaning on it.
   */
  async redeliver(id: string): Promise<{ [k: string]: unknown }> {
    const { data } = await this.http.post(
      `/v1/webhooks/deliveries/${encodeURIComponent(id)}/redeliver`,
    );
    return data;
  }
}
