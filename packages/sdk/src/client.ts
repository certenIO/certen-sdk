import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import { randomBytes } from 'crypto';
import { CertenError } from './errors.js';
import { IdentityResource } from './resources/identity.js';
import { TransactionResource } from './resources/transaction.js';
import { GovernanceResource } from './resources/governance.js';
import { PendingResource } from './resources/pending.js';
import { SignResource } from './resources/sign.js';
import { PortfolioResource } from './resources/portfolio.js';
import { BillingResource } from './resources/billing.js';
import { AdminResource } from './resources/admin.js';
import { ExecuteResource } from './resources/execute.js';
import { ChainsResource } from './resources/chains.js';
import { ProofResource } from './resources/proof.js';
import type { CertenClientOptions } from './types.js';

/**
 * The gateway this SDK talks to when the caller does not say.
 *
 * It must be a host that actually serves the API. This default was `https://api.certen.io`, which resolves
 * — to the Certen marketing site. So a client constructed without `baseUrl` returned HTML for every call,
 * and the failure read as a broken SDK rather than a wrong address. Point it only at a host whose
 * `/v1/health` answers.
 *
 * Precedence: `options.baseUrl` → `CERTEN_API_URL` → this. The env var exists so a deployment can be
 * retargeted (staging, a self-hosted gateway, a future `api.certen.io` once it fronts the gateway) without
 * a code change or an SDK release.
 */
export const DEFAULT_BASE_URL = 'https://gateway.kompendium.co';

/** Read an env var without assuming `process` exists — this SDK also runs in browsers, where touching a
 *  bare `process` is a ReferenceError rather than `undefined`. */
function envBaseUrl(): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env?.CERTEN_API_URL || undefined : undefined;
  } catch {
    return undefined;
  }
}
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The code to report when the gateway returns an error with no machine-readable `code`.
 *
 * Not hypothetical: an edge-level 502 from Cloudflare has a `text/plain` body, so `data.code` is
 * undefined and every such failure surfaced as `UNKNOWN_ERROR` — a code that appears nowhere in the
 * documented catalog. Callers branching on `BAD_GATEWAY`, exactly as `docs/errors.md` tells them to,
 * silently never matched. Mapping by status keeps the SDK's codes inside the documented set no
 * matter which layer produced the error.
 *
 * A `code` sent by the gateway always wins over this table.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMIT_EXCEEDED',
  500: 'INTERNAL_ERROR',
  // 503/504 are also "a downstream service did not answer", which is what BAD_GATEWAY documents.
  502: 'BAD_GATEWAY',
  503: 'BAD_GATEWAY',
  504: 'BAD_GATEWAY',
};

interface RetryConfig extends AxiosRequestConfig {
  __retryCount?: number;
}

interface RateLimitState {
  // Last-seen rate-limit reset, in ms-since-epoch. When the SDK gets a 429
  // it remembers this so subsequent requests can pre-emptively wait.
  resetAt: number | null;
}

export class CertenClient {
  private http: AxiosInstance;
  private rateLimit: RateLimitState = { resetAt: null };
  private maxRetries: number;
  private baseBackoffMs: number;
  private maxBackoffMs: number;

  public identity: IdentityResource;
  public transaction: TransactionResource;
  public governance: GovernanceResource;
  public pending: PendingResource;
  public sign: SignResource;
  public portfolio: PortfolioResource;
  public admin: AdminResource;
  /** Balance, commitments, and adding funds. See resources/billing.ts. */
  public billing: BillingResource;
  /** The proof-gated execution flow as one call: open, sign, submit, poll, prove. See resources/execute.ts. */
  public execute: ExecuteResource;
  /** The public contract registry — which chains CERTEN is on, and where. Needs no API key. */
  public chains: ChainsResource;
  /** Reading and sharing proofs. See resources/proof.ts. */
  public proof: ProofResource;

  constructor(options: CertenClientOptions & {
    maxRetries?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    /** When true (default), the SDK auto-generates an Idempotency-Key for
     *  every POST so a retried network error is safe to replay. Set false
     *  to opt out and supply your own key in request options. */
    autoIdempotencyKey?: boolean;
    /**
     * Round-2 #42: opt out of auto-idempotency for specific routes (e.g.
     * `'/v1/oauth/token'`, where the operation is naturally idempotent on
     * the server side and the SDK-generated key would just waste DB rows).
     *
     * Each entry can be:
     *  - a literal path string (exact match against `req.url`),
     *  - a path prefix ending with `*` (`'/v1/admin/usage*'`),
     *  - or a RegExp.
     */
    skipIdempotencyFor?: Array<string | RegExp>;
  }) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

    this.http = axios.create({
      baseURL: options.baseUrl ?? envBaseUrl() ?? DEFAULT_BASE_URL,
      headers: {
        'X-API-Key': options.apiKey,
        'Content-Type': 'application/json',
        'User-Agent': `certen-sdk-node/${process.env.npm_package_version ?? 'dev'}`,
      },
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    const autoIdem = options.autoIdempotencyKey !== false;
    const skipPatterns = options.skipIdempotencyFor ?? [];
    const shouldSkip = (path: string): boolean => {
      for (const p of skipPatterns) {
        if (typeof p === 'string') {
          if (p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p) return true;
        } else if (p instanceof RegExp && p.test(path)) {
          return true;
        }
      }
      return false;
    };

    // Auto-stamp Idempotency-Key on every POST that didn't already supply one.
    this.http.interceptors.request.use(async (req) => {
      const reqPath = req.url ?? '';
      if (autoIdem && (req.method ?? 'GET').toUpperCase() === 'POST' && !shouldSkip(reqPath)) {
        const headers = req.headers ?? {};
        if (!('Idempotency-Key' in headers) && !('idempotency-key' in headers)) {
          (headers as Record<string, string>)['Idempotency-Key'] = generateIdempotencyKey();
          req.headers = headers;
        }
      }
      // Respect any rate-limit reset window the gateway already told us about.
      if (this.rateLimit.resetAt && Date.now() < this.rateLimit.resetAt) {
        const wait = this.rateLimit.resetAt - Date.now();
        await sleep(wait);
        this.rateLimit.resetAt = null;
      }
      return req;
    });

    // Wrap errors into the typed taxonomy + retry transient failures.
    this.http.interceptors.response.use(
      (response) => {
        // Update rate-limit state from headers if present.
        const reset = response.headers['x-ratelimit-reset'];
        if (typeof reset === 'string' && /^\d+$/.test(reset)) {
          this.rateLimit.resetAt = Number(reset) * 1000;
        }
        return response;
      },
      async (error: AxiosError<{ error?: string; code?: string }> & { config?: RetryConfig }) => {
        const cfg = error.config;
        const status = error.response?.status ?? 0;
        // A non-JSON error body (an edge 502, an HTML error page) leaves `data` as a string, so
        // `data?.code` is undefined — fall back to the status map rather than to UNKNOWN_ERROR.
        const body = error.response?.data;
        const sentCode = typeof body === 'object' && body !== null ? body.code : undefined;
        const code = sentCode
          ?? (status === 0 ? 'NETWORK_ERROR' : CODE_BY_STATUS[status] ?? 'UNKNOWN_ERROR');
        const sentMessage = typeof body === 'object' && body !== null ? body.error : undefined;
        const message = sentMessage ?? error.message;
        const requestId = (error.response?.headers?.['x-request-id'] as string | undefined) ?? undefined;
        const retryAfter = error.response?.headers?.['retry-after'];
        const details = retryAfter ? { retryAfter: Number(retryAfter) } : undefined;

        if (status === 429 && typeof retryAfter === 'string') {
          this.rateLimit.resetAt = Date.now() + Number(retryAfter) * 1000;
        }

        // The parsed body travels with the error. A 402 carries a payment target,
        // and dropping the body reduced it to a message string the caller could
        // only regex. Only objects are passed on: a string body (HTML error page)
        // would give typed accessors something meaningless to read.
        const parsedBody = typeof body === 'object' && body !== null ? body : undefined;
        const wrapped = CertenError.fromAxios(message, status, code, {
          requestId, details, body: parsedBody,
        });

        // Retry transient failures with exponential backoff + jitter.
        if (cfg && wrapped.isRetryable) {
          cfg.__retryCount = (cfg.__retryCount ?? 0) + 1;
          if (cfg.__retryCount <= this.maxRetries) {
            const backoff = Math.min(
              this.maxBackoffMs,
              this.baseBackoffMs * Math.pow(2, cfg.__retryCount - 1),
            );
            const jitter = Math.floor(Math.random() * backoff);
            await sleep(backoff + jitter);
            return this.http.request(cfg);
          }
        }

        throw wrapped;
      },
    );

    this.identity = new IdentityResource(this.http);
    this.transaction = new TransactionResource(this.http);
    this.governance = new GovernanceResource(this.http);
    this.pending = new PendingResource(this.http);
    this.sign = new SignResource(this.http);
    this.portfolio = new PortfolioResource(this.http);
    this.admin = new AdminResource(this.http);
    this.billing = new BillingResource(this.http);
    this.execute = new ExecuteResource(this.http, generateIdempotencyKey);
    this.chains = new ChainsResource(this.http);
    this.proof = new ProofResource(this.http);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function generateIdempotencyKey(): string {
  // Stable across retries within a process; unique across calls.
  return `sdk_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`;
}

/**
 * Async iterator helper for paginated list endpoints. Round-2 #40:
 * `paginateWithTotal` exposes `{ item, index, total }` for progress UIs that
 * need to render "27 of 412". When the server doesn't return `total`, the
 * yielded object's `total` is undefined.
 *
 * Use `paginate(...)` for the simple item-only form.
 */
export async function* paginate<T>(
  fetchPage: (limit: number, offset: number) => Promise<{ items: T[]; total?: number }>,
  pageSize = 100,
): AsyncIterableIterator<T> {
  let offset = 0;
  for (;;) {
    const { items } = await fetchPage(pageSize, offset);
    for (const it of items) yield it;
    if (items.length < pageSize) return;
    offset += items.length;
  }
}

export async function* paginateWithTotal<T>(
  fetchPage: (limit: number, offset: number) => Promise<{ items: T[]; total?: number }>,
  pageSize = 100,
): AsyncIterableIterator<{ item: T; index: number; total: number | undefined }> {
  let offset = 0;
  for (;;) {
    const { items, total } = await fetchPage(pageSize, offset);
    for (let i = 0; i < items.length; i++) {
      yield { item: items[i], index: offset + i, total };
    }
    if (items.length < pageSize) return;
    offset += items.length;
  }
}
