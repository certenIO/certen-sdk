import { AxiosInstance } from 'axios';
import { omitUndefined } from '../internal.js';
import type {
  CreateIdentityParams,
  Identity,
  IdentityResponse,
  UpdateIdentityParams,
} from '../types.js';
import { CertenError } from '../errors.js';

/** Statuses provisioning is still in flight in. Anything else is treated as terminal. */
const IN_FLIGHT = ['provisioning', 'pending', 'creating'];

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * Accept what the gateway actually handed the caller.
 *
 * `mnemonic_retrieval.url` is a path, not an id and a token — so a method taking `(id, token)` only
 * would make every caller split a string, and splitting it wrongly costs them the seed. Both forms
 * are accepted, and an absolute URL works too in case the gateway ever returns one.
 */
export function parseMnemonicTarget(
  idOrUrl: string,
  token?: string,
): { id: string; token: string } {
  if (token) return { id: idOrUrl, token };

  const path = idOrUrl.includes('://') ? new URL(idOrUrl).pathname : idOrUrl;
  const m = /\/v1\/identity\/([^/]+)\/mnemonic\/([^/?#]+)/.exec(path);
  if (!m) {
    throw new CertenError(
      `certen: "${idOrUrl}" is not a mnemonic retrieval URL. Pass the create response's `
      + 'mnemonic_retrieval.url, or the identity id and token as two arguments.',
      0, 'INVALID_MNEMONIC_TARGET',
    );
  }
  return { id: decodeURIComponent(m[1]), token: decodeURIComponent(m[2]) };
}

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
  async get(
    id: string,
    opts: {
      /**
       * Which enrichments to fetch. Defaults to ALL THREE, and each costs a live query —
       * `governance` and `balances` hit the network, `balances` once PER LINKED CHAIN.
       *
       * Pass `[]` to skip them entirely. `status` and `can_sign` are computed before any
       * enrichment runs and are always returned, so anything polling for readiness wants `[]`.
       */
      include?: Array<'governance' | 'balances' | 'pending'>;
    } = {},
  ): Promise<IdentityResponse> {
    const { data } = await this.http.get(`/v1/identity/${id}`, {
      // Only sent when asked for: omitting the param keeps the gateway's default, while sending
      // `include=` is the explicit "none" that a poll loop wants. The two are different requests
      // and conflating them would silently strip enrichments from every ordinary read.
      ...(opts.include ? { params: { include: opts.include.join(',') } } : {}),
    });
    return data;
  }

  /**
   * Create an identity and wait until it is genuinely usable.
   *
   * `create()` returns `202` and provisioning continues, so the response it gives back says nothing
   * about whether the identity works. Every integration then writes the same poll loop, and the
   * ones that do not write it hand around an identity that fails at the last step of every flow.
   *
   * "Usable" is `status` terminal AND `can_sign === true`, and those fail for different reasons:
   *
   * - `can_sign === false` — provisioning finished, but the on-chain key page is not held by your
   *   key. The identity exists, consumes org quota, and can never sign.
   * - `can_sign === null` — the key page could not be READ. That is UNKNOWN, not a soft yes, and an
   *   Accumulate outage is exactly when the distinction matters most. This keeps polling, and says
   *   plainly that it could not determine the answer if the budget runs out.
   *
   * A timeout is neither success nor failure — provisioning may still complete — so it throws
   * rather than returning something a caller could mistake for a ready identity.
   *
   * **Not the right call for `signing_mode: "provider"`.** The one-shot mnemonic URL expires in
   * about ten minutes and this method is allowed to wait five, so waiting first burns most of the
   * window on the one flow where losing the token loses the seed. Use `create()`, call
   * `retrieveMnemonic()` immediately, then poll `get()`. If you do use this, the URL is carried
   * through on `mnemonic_retrieval` rather than dropped — but it may already have expired.
   */
  async createAndWait(
    params: CreateIdentityParams,
    { timeoutMs = 300_000, intervalMs, onPoll }: {
      timeoutMs?: number;
      /** Overrides the cadence the gateway publishes. Leave unset to use it. */
      intervalMs?: number;
      onPoll?: (identity: Identity) => void;
    } = {},
  ): Promise<Identity & Pick<IdentityResponse, 'mnemonic_retrieval'>> {
    const created = await this.create(params);
    const id = created.id;
    if (!id) {
      throw new CertenError('certen: the gateway accepted the identity but returned no id', 0, 'NO_IDENTITY_ID');
    }

    // The gateway now publishes how to wait, so this stops guessing. It used to poll every 3s
    // starting IMMEDIATELY, against an operation that is a chain of anchored Accumulate
    // transactions and cannot finish in under a minute — roughly twenty requests spent before
    // anything could possibly have changed. An explicit `intervalMs` still wins, and a gateway that
    // sends no `polling` block falls back to the old numbers rather than to nothing.
    const polling = created.polling;
    const pollInterval = intervalMs ?? (polling ? polling.interval_seconds * 1_000 : 3_000);
    const firstPollDelay = intervalMs === undefined && polling
      ? polling.first_poll_after_seconds * 1_000
      : 0;

    const deadline = Date.now() + timeoutMs;
    let last: Identity | undefined;

    // Bounded by the deadline, so a large published delay can never overshoot the caller's budget.
    if (firstPollDelay > 0) await sleep(Math.min(firstPollDelay, Math.max(0, deadline - Date.now())));

    while (Date.now() < deadline) {
      // The response IS the identity (plus its joined sub-resources) since the gateway flattened
      // these endpoints; it no longer arrives under an `identity` key.
      // No enrichments while polling. This loop reads `status` and `can_sign`, both computed
      // before any enrichment runs — so fetching governance, balances and pending on every
      // iteration bought nothing. At the default 3s interval a 90s provisioning wait is ~30
      // polls, each of which was making a governance network call, a balance network call PER
      // LINKED CHAIN, and a pending lookup, then discarding all of it.
      const identity = await this.get(id, { include: [] });
      last = identity;
      onPoll?.(identity);

      if (!IN_FLIGHT.includes(identity.status)) {
        if (identity.can_sign === true) {
          // One enriched read at the end, so what comes back is exactly what it always was.
          // Returning the lean poll result would silently drop `balances`, `governance` and
          // `pending` for anyone reading them off this — a saving not worth a surprise.
          const ready = await this.get(id).catch(() => identity);
          // `mnemonic_retrieval` only ever appears on the create response, and this method used to
          // throw that response away — so provider mode through `createAndWait` lost the seed with
          // no way to notice. Carried through instead.
          //
          // It may already be too late: the token lives ~10 minutes and this call is allowed to
          // wait five. A caller who needs the mnemonic should use `create()` and collect it first,
          // then wait. This is a safety net, not the recommended path.
          return created.mnemonic_retrieval
            ? { ...ready, mnemonic_retrieval: created.mnemonic_retrieval }
            : ready;
        }

        if (identity.can_sign === false) {
          throw new CertenError(
            `certen: identity ${id} finished provisioning as "${identity.status}" but cannot sign — `
            + 'its key page is not held by your key'
            + (identity.error_message ? `: ${identity.error_message}` : ''),
            0, 'IDENTITY_CANNOT_SIGN',
          );
        }
        if (identity.status === 'error') {
          throw new CertenError(
            `certen: identity ${id} failed to provision`
            + (identity.error_message ? `: ${identity.error_message}` : ''),
            0, 'IDENTITY_PROVISIONING_FAILED',
          );
        }
        // Terminal status with can_sign null: the key page was unreadable. Keep asking — this is
        // usually transient — and fall through to the unknown-answer error if it never resolves.
      }

      await sleep(pollInterval);
    }

    if (last && !IN_FLIGHT.includes(last.status) && last.can_sign == null) {
      throw new CertenError(
        `certen: identity ${id} is "${last.status}" but whether it can sign could not be determined `
        + '— the on-chain key page was unreadable for the whole wait',
        0, 'IDENTITY_CAN_SIGN_UNKNOWN',
      );
    }
    throw new CertenError(
      `certen: identity ${id} is still "${last?.status ?? 'unknown'}" after ${timeoutMs}ms — it may yet finish`,
      0, 'IDENTITY_WAIT_TIMEOUT',
    );
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
   * Collect the mnemonic generated for a `signing_mode: "provider"` identity. **Once.**
   *
   * This had no client surface at all, which made it the most dangerous gap in the SDK. Creating a
   * provider-mode identity never returns the mnemonic inline — it returns a `mnemonic_retrieval.url`
   * — and the token behind that URL is consumed atomically on first read. So a caller who did not
   * hand-roll the HTTP request lost the seed permanently, on the one flow where the key material
   * exists and CERTEN is holding it for them.
   *
   * **Two clocks are running.** The token expires (10 minutes by default, published as
   * `mnemonic_retrieval.expires_in`) and it dies on first read. Call this immediately after
   * `create()` and persist the result before doing anything else — including before waiting for
   * provisioning to finish, which takes longer than the token lives.
   *
   * Pass either the URL the create response gave you, or the id and token separately:
   *
   * ```ts
   * const created = await certen.identity.create({ name: 'ops', signingMode: 'provider' });
   * if (created.mnemonic_retrieval) {
   *   const { mnemonic } = await certen.identity.retrieveMnemonic(created.mnemonic_retrieval.url);
   *   await saveToVault(mnemonic);   // there is no second chance
   * }
   * ```
   *
   * Requires `identity:write`. A second call fails with 404 — indistinguishable, by design, from a
   * token that never existed.
   */
  async retrieveMnemonic(
    idOrUrl: string,
    token?: string,
  ): Promise<{ mnemonic: string; warning?: string }> {
    const { id, token: tok } = parseMnemonicTarget(idOrUrl, token);
    const { data } = await this.http.get(
      `/v1/identity/${encodeURIComponent(id)}/mnemonic/${encodeURIComponent(tok)}`,
    );
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
