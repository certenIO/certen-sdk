import { AxiosInstance } from 'axios';
import type {
  BalanceResponse,
  QuoteResponse,
  ObligationsResponse,
  DepositTarget,
  DepositIntentStatus,
  PaymentRecord,
} from '../types.js';

/**
 * Balance, commitments, and adding funds.
 *
 * The two numbers here are easy to confuse and only one of them is safe to act
 * on. `spendable_usd` is available balance plus any credit line. `remaining_usd`
 * (from `obligations`) subtracts what pending intents will consume when they
 * execute — and multi-signature intents can wait hours or weeks for quorum, so an
 * account can hold a balance that is entirely committed and still be refused on
 * its next call. Show or gate on `remaining_usd`.
 *
 * Funding has two attribution mechanisms and this resource exposes one of them.
 * `openPayment` declares an exact amount to send, matched inside a TTL — it needs
 * no registered wallet and suits a first deposit. Registering a payer address, so
 * every future send credits automatically, is deliberately NOT here: that asserts
 * deposits from an address belong to your organization, so it requires a signed-in
 * owner or admin in the portal rather than a machine key.
 */
export class BillingResource {
  constructor(private http: AxiosInstance) {}

  /** Available, held, credit line, and spendable. Requires `billing:read`. */
  async balance(): Promise<BalanceResponse> {
    const { data } = await this.http.get('/v1/billing/balance');
    return data;
  }

  /**
   * Price a piece of work before committing to it.
   *
   * Free, and the answer binds: pass the returned `id` as `quote_id` on the
   * transaction and that is the price, regardless of what gas does in between.
   * A quote is single-use and expires, so ask when you are ready to act.
   *
   * Worth checking `computation.gas_estimate_basis` on a cost-plus chain. A
   * `class_thin` basis means the proof class has its own cost history but too
   * little of it for the median to be stable — the number is indicative, and
   * can move materially as more of that class executes.
   */
  async quote(params: {
    chain: string;
    proofClass?: 'on_demand' | 'on_cadence';
    legCount?: number;
    sku?: string;
    additionalChains?: string[];
  }): Promise<QuoteResponse> {
    const { data } = await this.http.post('/v1/quote', {
      chain: params.chain,
      proof_class: params.proofClass,
      leg_count: params.legCount ?? 1,
      sku: params.sku,
      additional_chains: params.additionalChains,
    });
    return data;
  }

  /**
   * Pending intents and what they will cost — including `remaining_usd`, the
   * amount that may actually be committed to new work.
   */
  async obligations(): Promise<ObligationsResponse> {
    const { data } = await this.http.get('/v1/billing/obligations');
    return data;
  }

  /**
   * Where to send stablecoin, optionally opening a single-use payment matched on
   * the exact amount.
   *
   * Omit `amountUsd` to read the deposit address without opening anything — an
   * intent for an unspecified amount could never be matched. Requires
   * `billing:fund` (or `billing:write`).
   */
  async openPayment(params: { chain: string; amountUsd?: string }): Promise<DepositTarget> {
    const { data } = await this.http.post('/v1/billing/deposits', {
      chain: params.chain,
      ...(params.amountUsd ? { amount_usd: params.amountUsd } : {}),
    });
    return data;
  }

  /**
   * Status of a payment you opened. Requires `billing:read`.
   *
   * Use this rather than watching the balance: a second deposit or a charge in the
   * same window moves the balance too, so inferring from it reports the wrong
   * payment as matched.
   */
  /**
   * Payments the gateway has seen, most recent first.
   *
   * Distinct from a deposit INTENT. A payment can be credited without ever matching an intent —
   * see `waitForPayment` — so this is the record that says whether money actually arrived.
   */
  async payments(params: { limit?: number } = {}): Promise<{ payments: PaymentRecord[] }> {
    const { data } = await this.http.get('/v1/billing/payments', {
      params: { limit: params.limit ?? 10 },
    });
    return data;
  }

  async payment(reference: string): Promise<DepositIntentStatus> {
    const { data } = await this.http.get(
      `/v1/billing/deposits/${encodeURIComponent(reference)}`,
    );
    return data.intent as DepositIntentStatus;
  }

  /**
   * Resolve once the payment is credited, or when it expires.
   *
   * Returns the terminal status rather than throwing on expiry — an expired
   * payment is an ordinary outcome the caller should report, not an error. Only a
   * genuine transport or auth failure throws.
   *
   * **It watches the payment feed as well as the intent, and that is not belt-and-braces.** The
   * gateway has two attribution paths: matching a deposit intent by exact amount, and recognising
   * a REGISTERED payer address. When the sending wallet is registered, the payment is credited
   * within seconds by address and the intent it was opened against is never touched — it stays
   * `open` until it expires.
   *
   * Watching only the intent therefore reported "not credited" on money that had already arrived,
   * after making the caller wait the full hour for it. Observed live: 1 USDC credited in seconds
   * with `attribution: registered_address`, while the intent sat `open` with `matched_at: null`.
   *
   * On that path the returned status is synthesised with `status: 'matched'` and the credited
   * payment's id, because from the caller's point of view the money arrived — which is the
   * question they asked.
   */
  async waitForPayment(
    reference: string,
    opts: {
      intervalMs?: number;
      timeoutMs?: number;
      onPoll?: (status: DepositIntentStatus) => void;
    } = {},
  ): Promise<DepositIntentStatus> {
    const intervalMs = opts.intervalMs ?? 5_000;
    const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1_000;
    const deadline = Date.now() + timeoutMs;

    // Payments already credited before this wait started are not evidence for it. Anything at or
    // after this instant is.
    const since = Date.now();

    for (;;) {
      const status = await this.payment(reference);
      opts.onPoll?.(status);
      if (status.status !== 'open') return status;

      const credited = await this.creditedSince(since, status.amount_usd);
      if (credited) {
        const matched: DepositIntentStatus = {
          ...status,
          status: 'matched',
          matched_at: credited.created_at ?? new Date().toISOString(),
          payment_id: credited.id ?? null,
        };
        opts.onPoll?.(matched);
        return matched;
      }

      if (new Date(status.expires_at).getTime() <= Date.now()) return status;
      if (Date.now() >= deadline) return status;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * A credited payment of this amount that arrived after `since`, if there is one.
   *
   * Returns null on any failure: an unavailable payments feed must never turn a wait that would
   * otherwise have succeeded into an error, and the intent poll above remains the primary signal.
   */
  private async creditedSince(since: number, amountUsd: string): Promise<PaymentRecord | null> {
    try {
      const { payments } = await this.payments({ limit: 10 });
      return (payments ?? []).find((p) => {
        if (p.status !== 'credited') return false;
        if (String(p.amount_usd) !== String(amountUsd)) return false;
        const at = Date.parse(String(p.created_at ?? ''));
        // A missing timestamp cannot be placed in time, so it is not treated as evidence.
        return Number.isFinite(at) && at >= since - 60_000;
      }) ?? null;
    } catch {
      return null;
    }
  }
}
