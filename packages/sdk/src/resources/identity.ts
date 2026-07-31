import { AxiosInstance } from 'axios';
import { omitUndefined } from '../internal.js';
import type {
  CreateIdentityParams,
  IdentityResponse,
  UpdateIdentityParams,
} from '../types.js';

export class IdentityResource {
  constructor(private http: AxiosInstance) {}

  /**
   * Create an identity.
   *
   * ASYNCHRONOUS: this returns 202 and provisioning continues in the background. Poll `get()` until the
   * status is terminal, and check `can_sign` before building anything on it.
   *
   * `webhookUrl` used to be sent here. POST /v1/identity does not accept one — Fastify strips unknown
   * properties, so the option silently did nothing. Set it with `update()`, which does accept it.
   */
  async create(params: CreateIdentityParams): Promise<IdentityResponse> {
    const headers: Record<string, string> = {};
    if (params.idempotencyKey) headers['Idempotency-Key'] = params.idempotencyKey;
    const { data } = await this.http.post('/v1/identity', omitUndefined({
      name: params.name,
      public_key: params.publicKey,
      public_key_hash: params.publicKeyHash,
      chains: params.chains,
      credits: params.credits,
      signing_mode: params.signingMode,
      signing_provider: params.signingProvider,
    }), { headers });
    return data;
  }

  /**
   * Fetch one identity.
   *
   * The route takes no query parameters. An `include` list was previously accepted by this method and sent
   * as a query string, where it was silently ignored — so the signature promised a capability the API does
   * not have.
   */
  async get(id: string): Promise<IdentityResponse> {
    const { data } = await this.http.get(`/v1/identity/${id}`);
    return data;
  }

  /** Link or unlink chains, set a webhook, or supply a `publicKey` to repair an identity created without one. */
  async update(id: string, params: UpdateIdentityParams): Promise<IdentityResponse> {
    const { data } = await this.http.patch(`/v1/identity/${id}`, omitUndefined({
      link_chains: params.linkChains,
      unlink_chains: params.unlinkChains,
      webhook_url: params.webhookUrl,
      public_key: params.publicKey,
    }));
    return data;
  }

  /** Retire an identity, freeing the slot it occupies against the org quota. Soft delete inside Certen only:
   *  the on-chain ADI, key book, and key page are untouched and keep existing on Accumulate. */
  async retire(id: string): Promise<{ success: boolean }> {
    const { data } = await this.http.delete(`/v1/identity/${id}`);
    return data;
  }

  /**
   * There is deliberately no `list()`.
   *
   * It used to call `GET /v1/identities`, which does not exist — the gateway serves `/v1/identity` (POST)
   * and `/v1/identity/{id}` (GET/PATCH/DELETE) and has no plural collection route, so every call 404'd.
   * Track the ids you create, or read them from your own records.
   */
}
