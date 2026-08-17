import { AxiosInstance } from 'axios';
import type { OAuthClient, OAuthClientCredentials } from '../types.js';

/**
 * The OAuth2 clients your organization owns.
 *
 * `fetchOAuthToken` and `revokeOAuthToken` let a service obtain and give back tokens — but the
 * client those tokens come from could only be created by a human opening the portal. So an
 * integration could authenticate itself and could not provision itself, and every automated
 * deployment stopped to wait on someone clicking through a browser.
 *
 * These sat at `/v1/admin/oauth-clients` behind `admin:write`, which was the same misfiling
 * webhooks had: the rows are org-scoped and the create route explicitly refuses to cross orgs
 * without admin scope, so this was always a customer capability wearing an operator's path. Moved
 * to `/v1/oauth-clients` with `oauth:read` and `oauth:write`.
 *
 * **A secret appears exactly twice in its life** — once from `create()`, once from
 * `rotateSecret()` — and never again from any read. Store it before doing anything else.
 */
export class OAuthClientsResource {
  constructor(private http: AxiosInstance) {}

  /** Clients this organization owns. Never includes secrets. Requires `oauth:read`. */
  async list(): Promise<{ clients: OAuthClient[] }> {
    const { data } = await this.http.get('/v1/oauth-clients');
    return data;
  }

  /**
   * Create a client and receive its credentials once.
   *
   * `scopes` is what tokens issued to this client may do — grant it the narrowest set that works,
   * because a token is only as constrained as the client that minted it. Omitting it creates a
   * client whose tokens can do nothing, which is rarely what anyone wants.
   *
   * `orgId` is for operators placing a client in another organization and requires `admin:write`;
   * leave it unset and the client lands in your own org.
   *
   * NOT retry-safe — a repeat creates a second client. Requires `oauth:write`.
   */
  async create(params: {
    scopes: string[];
    orgId?: string;
  }): Promise<OAuthClientCredentials> {
    const { data } = await this.http.post('/v1/oauth-clients', {
      scopes: params.scopes,
      ...(params.orgId ? { org_id: params.orgId } : {}),
    });
    return data;
  }

  /**
   * Deactivate a client and revoke every token it ever issued.
   *
   * Immediate and cascading: anything currently authenticating as this client stops working on the
   * next request, including tokens that had hours left. That is the correct behaviour for a leaked
   * client secret and a severe one for a live integration — reach for `rotateSecret` with a grace
   * window when the goal is to change the credential rather than to stop the client.
   *
   * Idempotent: deactivation is a state, so a retry is safe. Requires `oauth:write`.
   */
  async remove(id: string): Promise<void> {
    await this.http.delete(`/v1/oauth-clients/${encodeURIComponent(id)}`);
  }

  /**
   * Issue a new client secret, optionally keeping the old one alive while you deploy.
   *
   * `graceSeconds` is the whole point of this method over delete-and-recreate: the previous secret
   * keeps working for that long, so a fleet can pick up the new one at its own pace instead of
   * failing all at once. Defaults to 300 seconds, and the gateway caps it at seven days. Pass `0`
   * for an immediate cutover — correct when the old secret has leaked, and a small outage otherwise.
   *
   * NOT retry-safe. Each call invalidates the secret the previous one issued, so calling twice
   * strands whatever was mid-deployment with the first new secret. Requires `oauth:write`.
   */
  async rotateSecret(id: string, params: { graceSeconds?: number } = {}): Promise<
    OAuthClientCredentials & { grace_seconds?: number; previous_secret_expires_at?: string | null }
  > {
    const { data } = await this.http.post(
      `/v1/oauth-clients/${encodeURIComponent(id)}/rotate-secret`,
      params.graceSeconds === undefined ? {} : { grace_seconds: params.graceSeconds },
    );
    return data;
  }
}
