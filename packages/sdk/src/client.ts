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
import { TransparencyResource } from './resources/transparency.js';
import { HealthResource } from './resources/health.js';
import { ProofResource } from './resources/proof.js';
import { DeviceResource } from './resources/device.js';
import { runDoctor, type DoctorReport } from './doctor.js';
import type { CertenClientOptions,
  MeResponse,
} from './types.js';

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
  /**
   * The public transparency log — signed tree heads, consistency proofs, published price books.
   * What makes a receipt checkable rather than merely signed. Needs no API key.
   */
  public transparency: TransparencyResource;
  /**
   * Whether CERTEN can serve right now, and what is wrong when it cannot. Needs no API key —
   * a caller whose credential is rejected can still learn whether the platform is the problem.
   */
  public health: HealthResource;
  /** Reading and sharing proofs. See resources/proof.ts. */
  public proof: ProofResource;
  /** Device authorization, so a terminal can obtain its own key. Needs no API key. */
  public device: DeviceResource;

  /**
   * Diagnose this setup and say what is blocking it.
   *
   * Never throws for a failed check — a diagnosis that cannot report a broken setup is useless.
   * `report.ok` is false when something failed; warnings do not clear it and do not set it.
   * See doctor.ts for what each check exists to catch.
   */
  /**
   * Who this credential is, and what it may do.
   *
   * One call, and the only way to learn your own organization and scopes. It accepted a portal
   * session only until the gateway's 2026-08 change, so a machine holding an API key could not ask
   * — clients resorted to probing endpoints and reading the 403s to guess what they were allowed
   * to do.
   *
   * Check `scopes` before a flow rather than after: a missing scope surfaces otherwise as a 403
   * partway through, when some of the work may already have happened.
   */
  me(): Promise<MeResponse> {
    return this.http.get('/v1/me').then((r) => r.data as MeResponse);
  }

  doctor(): Promise<DoctorReport> {
    return runDoctor(this);
  }

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
      // Respect a rate-limit window the gateway already told us about — but BOUNDED.
      //
      // This slept for the entire remaining window with no ceiling, so a 429 carrying
      // `Retry-After: 3600` parked the next request for an hour inside the HTTP client, ignoring
      // both `maxBackoffMs` and the per-request timeout, with no way for the caller to escape it.
      // Capping at `maxBackoffMs` keeps the wait to something the caller agreed to; if the window
      // has genuinely not reopened the next attempt returns 429 and the retry path handles it.
      if (this.rateLimit.resetAt && Date.now() < this.rateLimit.resetAt) {
        const wait = Math.min(this.rateLimit.resetAt - Date.now(), this.maxBackoffMs);
        await sleep(wait);
        this.rateLimit.resetAt = null;
      }
      return req;
    });

    // Wrap errors into the typed taxonomy + retry transient failures.
    this.http.interceptors.response.use(
      (response) => {
        // Self-throttle ONLY once the window is actually exhausted.
        //
        // Two things were wrong here. `x-ratelimit-reset` is SECONDS REMAINING, not a Unix
        // timestamp — the gateway sends `56` with a 60-second window — so `Number(reset) * 1000`
        // produced 56000, an instant in 1970, and the guard above never fired. The throttle has
        // never run.
        //
        // Simply correcting the arithmetic would have been far worse than the bug: `reset` comes
        // back on EVERY response, so setting the window from it unconditionally would sleep the
        // full remaining window before every single request. It is only meaningful when
        // `x-ratelimit-remaining` has reached zero.
        const reset = response.headers['x-ratelimit-reset'];
        const remaining = response.headers['x-ratelimit-remaining'];
        if (remaining === '0' && typeof reset === 'string' && /^\d+$/.test(reset)) {
          this.rateLimit.resetAt = Date.now() + Number(reset) * 1000;
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

        // `details` carries whatever is STRUCTURED about this failure, from either side.
        //
        // It used to hold only `retryAfter`, so the gateway's own `details` — the per-field
        // validation entries naming exactly what was wrong — reached callers only via `body`,
        // which is not where anyone looks. A tool rendering `error.details` therefore showed
        // nothing for the one error class where structure is most useful.
        //
        // `retryAfter` keeps its place: `CertenError.retryAfterSeconds` reads it from here.
        const serverDetails = (body as { details?: unknown } | undefined)?.details;
        const details = retryAfter || serverDetails !== undefined
          ? {
            ...(retryAfter ? { retryAfter: Number(retryAfter) } : {}),
            ...(serverDetails !== undefined ? { validation: serverDetails } : {}),
          }
          : undefined;

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
            // The server's own `Retry-After` wins over the local curve.
            //
            // Exponential backoff is a guess made without information; `Retry-After` is the
            // gateway stating when the window actually reopens. Ignoring it — as this did — meant
            // retrying early, which cannot succeed, and each failed attempt still counts against
            // the limit. Capped at `maxBackoffMs` so a large server value cannot park a caller
            // for longer than they agreed to wait, and jittered like the fallback so a fleet
            // released at the same instant does not stampede.
            const serverHint = retryAfter ? Number(retryAfter) * 1000 : NaN;
            const base = Number.isFinite(serverHint) && serverHint > 0
              ? Math.min(this.maxBackoffMs, serverHint)
              : Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, cfg.__retryCount - 1));
            const jitter = Math.floor(Math.random() * Math.min(base, 1_000));
            await sleep(base + jitter);
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
    this.billing = new BillingResource(this.http, this);
    this.execute = new ExecuteResource(this.http, generateIdempotencyKey);
    this.chains = new ChainsResource(this.http);
    this.transparency = new TransparencyResource(this.http);
    this.health = new HealthResource(this.http);
    this.proof = new ProofResource(this.http);
    this.device = new DeviceResource(this.http);
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
 * Async iterator helper for paginated list endpoints.
 *
 * **Prefer the `listAll()` method on the resource** — `certen.transaction.listAll()`,
 * `certen.pending.listAll()`. They call this internally and need no adapter.
 *
 * This takes a callback returning `{ items }`, and no SDK method returns that shape: `list()`
 * returns `{ transactions }`, `shares()` returns `{ shares }`. So using it directly meant writing
 * the adapter that should have shipped with it. Since 0.7.0 that adapter lives on the resources,
 * and this stays exported for list endpoints the SDK does not model yet, and for callers paginating
 * their own API.
 *
 * `paginateWithTotal` exposes `{ item, index, total }` for progress UIs that need to render
 * "27 of 412". When the server does not return `total`, the yielded object's `total` is undefined.
 */
export async function* paginate<T>(
  fetchPage: (limit: number, offset: number) => Promise<{ items: T[]; total?: number; hasMore?: boolean }>,
  pageSize = 100,
): AsyncIterableIterator<T> {
  let offset = 0;
  for (;;) {
    const { items, hasMore } = await fetchPage(pageSize, offset);
    for (const it of items) yield it;

    // `hasMore` when the endpoint reports it; a short page otherwise.
    //
    // The fallback is not equivalent, and the difference is the reason the gateway now sends the
    // field. A final page that lands EXACTLY on the page size is indistinguishable from a full one,
    // so short-page inference either stops a page early — reporting a partial ledger as complete,
    // which for a reconciliation is worse than an error — or spends an extra request discovering an
    // empty page. It stays only because the SDK is regularly pointed at an older gateway.
    if (hasMore !== undefined) {
      if (!hasMore) return;
    } else if (items.length < pageSize) {
      return;
    }

    // Guard against a server that reports more while returning nothing: without this the loop
    // never advances and never ends.
    if (items.length === 0) return;
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
