import { AxiosInstance } from 'axios';
import type { RegistrationToken, MintedRegistrationToken } from '../types.js';

/**
 * Registration tokens — letting an organization be created without a browser.
 *
 * Minting is the half that needs a credential and the `org:invite` scope. Redeeming is deliberately
 * NOT here: the redeemer holds nothing yet, so it is the standalone `redeemRegistrationToken`.
 *
 * What the new organization will be is fixed at mint time by the minter — its plan, and what its
 * first key may do. A redeemer able to choose those would be choosing what someone else is billed
 * for, and how much reach an unattended credential has.
 */
export class RegistrationTokensResource {
  constructor(private http: AxiosInstance) {}

  /**
   * Mint a token. **The token is returned once and never again.**
   *
   * `permissions` are the scopes the redeemed organization's first key receives. Operator and
   * wildcard scopes are refused, as is `org:invite` itself — one human decision must not become an
   * unbounded tree of organizations.
   *
   * NOT retry-safe: each call mints a DIFFERENT token, so a retry leaves a second live token that
   * can create a second organization. Revoke anything you did not mean to issue.
   */
  async mint(params: {
    /** Name for the organization this creates. The redeemer may override it. */
    orgName?: string;
    plan?: 'starter' | 'pro' | 'enterprise';
    /** Scopes for the redeemed org's first key. Defaults to a working read/write set. */
    permissions?: string[];
    /** Seconds until it expires. Default 86400, clamped to the gateway's ceiling. */
    expiresIn?: number;
    /** For your own records — who this was issued to. */
    note?: string;
  } = {}): Promise<MintedRegistrationToken> {
    const { data } = await this.http.post('/v1/registration-tokens', {
      ...(params.orgName ? { org_name: params.orgName } : {}),
      ...(params.plan ? { plan: params.plan } : {}),
      ...(params.permissions ? { permissions: params.permissions } : {}),
      ...(params.expiresIn !== undefined ? { expires_in: params.expiresIn } : {}),
      ...(params.note ? { note: params.note } : {}),
    });
    return data;
  }

  /** Tokens this organization minted, newest first. Never includes a token. Requires `org:invite`. */
  async list(): Promise<{ tokens: RegistrationToken[] }> {
    const { data } = await this.http.get('/v1/registration-tokens');
    return data;
  }

  /**
   * Stop a token being redeemed.
   *
   * Idempotent — revoking twice succeeds, because the intent is already satisfied. A token that has
   * ALREADY been redeemed cannot be revoked: the organization exists and cannot be un-created, so
   * this throws a 409 rather than implying you have contained something you have not. Revoke that
   * organization's API keys instead.
   */
  async revoke(id: string): Promise<RegistrationToken> {
    const { data } = await this.http.delete(`/v1/registration-tokens/${encodeURIComponent(id)}`);
    return data;
  }
}
