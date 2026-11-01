import { AxiosInstance } from 'axios';
import { paginate } from '../client.js';
import type { WebhookEndpoint, WebhookDelivery, Pagination } from '../types.js';
import { apiPath } from '../internal.js';
import { CertenError } from '../errors.js';
import { assertWebhookSecret, checkWebhookDelivery } from '../webhook-signature.js';
import type { WebhookDeliveryCheck } from '../webhook-signature.js';

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
   *
   * Verify each delivery with `verifyWebhookSignature` / `constructWebhookEvent` (exported from the package), and exercise a receiver
   * before the first real event with `signWebhookPayload`.
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
    const { data } = await this.http.patch(apiPath`/v1/webhooks/endpoints/${id}`, {
      ...(params.url ? { url: params.url } : {}),
      ...(params.eventTypes ? { event_types: params.eventTypes } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.isActive !== undefined ? { is_active: params.isActive } : {}),
    });
    return data;
  }

  /**
   * Stop delivering to an endpoint. Requires `webhook:write`. The gateway answers 204 with no body, so this resolves
   * `{ deleted: true }` (a failure throws); it used to return the empty body, an empty string, under a type that promised an object.
   */
  async remove(id: string): Promise<{ deleted: true }> {
    await this.http.delete(apiPath`/v1/webhooks/endpoints/${id}`);
    return { deleted: true };
  }

  /**
   * Issue a new signing secret. Requires `webhook:write`.
   *
   * The old secret stops working **immediately**: the very next delivery, and every retry of an earlier one (each attempt is signed
   * afresh with the current secret), is signed with the new one. A receiver still holding the old value rejects them until it is
   * switched, so rotate with a plan:
   *
   *   - With no `secret`, the gateway generates one and returns it once. The window between this call and your deploy is a window of
   *     failed verifications, and retried deliveries only recover if it is shorter than the retry schedule.
   *   - With your own `secret` (16–255 characters), you choose the value, so the receiver can be deployed accepting BOTH
   *     (`verifyWebhookSignature({ secret: [newSecret, oldSecret] })`) before you rotate, and there is no window at all. The gateway
   *     still returns the secret once.
   *
   * Without a `secret`, NOT retry-safe (the gateway classifies it so): each call invalidates the secret the previous one issued, so a
   * retry can strand a receiver that was verifying correctly seconds earlier. With one, repeating the call sets the same value.
   */
  async rotateSecret(id: string, params: { secret?: string } = {}): Promise<{ secret: string; [k: string]: unknown }> {
    if (params.secret !== undefined) {
      // Before the request: a value the gateway will refuse should not travel, and the message here does not echo it.
      assertWebhookSecret(params.secret);
      if (params.secret.length < 16 || params.secret.length > 255) {
        throw new CertenError(
          `A webhook secret you supply must be 16 to 255 characters; this one is ${params.secret.length}. Omit it to have the gateway generate one.`,
          0, 'WEBHOOK_SECRET_INVALID',
        );
      }
    }
    const { data } = await this.http.post(
      apiPath`/v1/webhooks/endpoints/${id}/rotate-secret`,
      params.secret !== undefined ? { secret: params.secret } : undefined,
    );
    return data;
  }

  /** Re-run the verification ping against an endpoint. Requires `webhook:write`. */
  async verify(id: string): Promise<WebhookEndpoint> {
    const { data } = await this.http.post(
      apiPath`/v1/webhooks/endpoints/${id}/verify`,
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
    const { data } = await this.http.get(apiPath`/v1/webhooks/deliveries/${id}`);
    return data;
  }

  /**
   * Is `secret` the one the gateway signed this delivery with? Fetches the delivery and reproduces the signature it recorded from the
   * signed bytes it also recorded. Requires `webhook:read`. The secret is used locally and never sent anywhere.
   *
   * The question to ask when a receiver rejects deliveries: `ok: true` means the secret is right and the fault is in how the receiver
   * gets the body (a framework parsing it first, a proxy changing it); `signature-mismatch` means the receiver holds the wrong
   * secret — rotated away, or another endpoint's. The signature is the LAST attempt's: each attempt re-signs.
   *
   * Resolves the verdict as data, with the delivery id attached. A delivery that does not exist or is not yours rejects as usual (404).
   */
  async checkDelivery(id: string, secret: string | readonly string[]): Promise<WebhookDeliveryCheck & { deliveryId: string }> {
    // Before the request: an unusable secret is the caller's mistake and should not cost a round trip.
    assertWebhookSecret(secret);
    const delivery = await this.delivery(id);
    return { deliveryId: id, ...checkWebhookDelivery(delivery, secret) };
  }

  /**
   * Send a delivery again.
   *
   * Deliberately NOT retry-safe: delivering again is the entire point, so calling this twice
   * delivers twice. Make sure the receiver is idempotent before leaning on it.
   */
  async redeliver(id: string): Promise<{ [k: string]: unknown }> {
    const { data } = await this.http.post(
      apiPath`/v1/webhooks/deliveries/${id}/redeliver`,
    );
    return data;
  }
}
