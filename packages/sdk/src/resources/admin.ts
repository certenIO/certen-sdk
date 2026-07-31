import { AxiosInstance } from 'axios';
import type {
  CreateOrgParams,
  OrgResponse,
  CreateApiKeyParams,
  ApiKeyResponse,
  ApiKeyListItem,
  AuditLogResponse,
  UsageSummaryResponse,
} from '../types.js';

export class AdminResource {
  constructor(private http: AxiosInstance) {}

  async createOrg(params: CreateOrgParams): Promise<OrgResponse> {
    const { data } = await this.http.post('/v1/admin/org', {
      name: params.name,
      plan: params.plan,
      webhook_url: params.webhookUrl,
    });
    return data;
  }

  async createApiKey(params: CreateApiKeyParams): Promise<ApiKeyResponse> {
    const { data } = await this.http.post('/v1/admin/api-keys', {
      name: params.name,
      org_id: params.orgId,
      permissions: params.permissions,
      rate_limit_rpm: params.rateLimitRpm,
      expires_at: params.expiresAt,
    });
    return data;
  }

  async listApiKeys(): Promise<{ apiKeys: ApiKeyListItem[] }> {
    const { data } = await this.http.get('/v1/admin/api-keys');
    return data;
  }

  async revokeApiKey(id: string): Promise<{ success: boolean; message: string }> {
    const { data } = await this.http.delete(`/v1/admin/api-keys/${id}`);
    return data;
  }

  /**
   * Rotate an api key: the gateway provisions a fresh key with the same
   * permissions and revokes the old one. The new plaintext key is returned
   * ONCE — clients must persist it now.
   */
  async rotateApiKey(id: string): Promise<ApiKeyResponse> {
    const { data } = await this.http.post(`/v1/admin/api-keys/${id}/rotate`);
    return data;
  }

  async getAuditLog(params?: {
    resourceType?: string;
    action?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<AuditLogResponse> {
    const { data } = await this.http.get('/v1/admin/audit-log', {
      params: {
        resource_type: params?.resourceType,
        action: params?.action,
        from: params?.from,
        to: params?.to,
        limit: params?.limit,
        offset: params?.offset,
      },
    });
    return data;
  }

  async getUsage(params?: { from?: string; to?: string }): Promise<UsageSummaryResponse> {
    const { data } = await this.http.get('/v1/admin/usage', {
      params: {
        from: params?.from,
        to: params?.to,
      },
    });
    return data;
  }
}
