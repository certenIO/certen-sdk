import { AxiosInstance } from 'axios';
import { paginateWithTotal } from '../client.js';
import type {
  CreateOrgParams,
  OrgResponse,
  CreateApiKeyParams,
  ApiKeyResponse,
  ApiKeyListItem,
  AuditLogResponse,
  AuditLogEntry,
  UsageSummaryResponse,
  ScopeInfo,
  ErrorCodeInfo,
} from '../types.js';

export class AdminResource {
  constructor(private http: AxiosInstance) {}

  /**
   * Every permission a key can be granted, and what each one covers.
   *
   * Read this before minting a key. The vocabulary was published nowhere, so the choice was made by
   * guessing — and guessing wrong is asymmetric: under-grant and you get 403s, which are visible;
   * over-grant, and the obvious answer to uncertainty is `*`, which hands a key that only needed to
   * read a balance the ability to retire identities and publish price books.
   *
   * Needs no API key: choosing permissions should not require already holding one.
   */
  async scopes(): Promise<{ scopes: ScopeInfo[] }> {
    const { data } = await this.http.get('/v1/scopes');
    return data;
  }

  /**
   * Every error code this API can return, and what to do about each.
   *
   * Reads the catalogue from the LIVE gateway, which is the point: the SDK ships a vendored copy in
   * `spec/errors.json`, but that copy is only as current as the release, and a gateway ahead of the
   * SDK raises codes the vendored file has never heard of. Asking the deployment you are actually
   * talking to is the only way to see those.
   *
   * `retryable` answers "will repeating this exact request eventually work?" — not "whose fault is
   * it". A 503 from an unavailable rate oracle is retryable; a 402 is not, because retrying without
   * paying changes nothing.
   *
   * Needs no API key: error handling should be buildable before you hold a credential.
   */
  async errors(): Promise<{ errors: ErrorCodeInfo[] }> {
    const { data } = await this.http.get('/v1/errors');
    return data;
  }


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

  /**
   * Every audit-log entry matching the filters, a page at a time.
   *
   * ```ts
   * for await (const { item, index, total } of certen.admin.auditLogAll({ from })) {
   *   process.stdout.write(`
${index + 1} of ${total}`);
   * }
   * ```
   *
   * Yields `{ item, index, total }` rather than bare entries — unlike the other `listAll`s, because
   * this endpoint DOES return a total and an audit export is the case where a caller genuinely
   * needs it: these run long enough to want a progress line, and long enough that a silent early
   * stop matters. Reading the full log by hand meant tracking the offset against
   * `pagination.total`, which is the arithmetic this exists to stop people writing.
   */
  auditLogAll(
    params?: Omit<Parameters<AdminResource['getAuditLog']>[0], 'limit' | 'offset'>,
    pageSize = 100,
  ): AsyncIterableIterator<{ item: AuditLogEntry; index: number; total: number | undefined }> {
    return paginateWithTotal<AuditLogEntry>(
      async (limit, offset) => {
        const page = await this.getAuditLog({ ...params, limit, offset });
        return { items: page.entries ?? [], total: page.pagination?.total };
      },
      pageSize,
    );
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
