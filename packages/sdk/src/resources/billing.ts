import { AxiosInstance } from 'axios';
import { paginate } from '../client.js';
import type {
  BalanceResponse,
  QuoteResponse,
  ObligationsResponse,
  DepositTarget,
  DepositIntentStatus,
  PaymentRecord,
  PricingCatalog,
  PayerAddress,
  LedgerEntry,
  ReceiptSummary,
  Receipt,
  ReceiptProof,
  VerificationKeys,
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
 * Funding has two attribution mechanisms and both are here.
 * `openPayment` declares an exact amount to send, matched inside a TTL — it needs
 * no registered wallet and suits a first deposit. `registerPayerAddress` records a
 * wallet once so every future send from it credits automatically.
 *
 * The second used to be omitted, on the stated grounds that asserting an address
 * belongs to your organization required a signed-in portal owner rather than a
 * machine key. That was simply wrong — the endpoint authenticates with an API key
 * carrying `billing:write` — and the omission mattered, because the gateway's own
 * 402 names registering a sender as the recommended fix.
 */
export class BillingResource {
  constructor(private http: AxiosInstance) {}

  /**
   * Every priced operation and what it costs — one call, no guessing.
   *
   * `quote()` prices ONE sku on ONE chain and needs the sku name up front, which is the problem:
   * the names are not guessable (`identity.provision`, not `identity.create`), and nothing listed
   * them. Discovering the price of onboarding meant guessing a name, being refused, and guessing
   * again.
   *
   * Use this to find the sku, then `quote()` to get a binding price for a specific piece of work.
   * Requires `billing:read`.
   */
  async pricing(): Promise<PricingCatalog> {
    const { data } = await this.http.get('/v1/pricing');
    return data;
  }

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

  // ── Evidence ────────────────────────────────────────────────────────────────────────────────
  //
  // What was I charged, and can I prove it? These four endpoints existed on the gateway from the
  // start and had no client surface at all — so the one question an enterprise finance or audit
  // function actually asks could only be answered by hand-rolling HTTP. The evidence was there and
  // unreachable, which for an auditor is the same as absent.

  /**
   * Every balance change, newest first. Requires `billing:read`.
   *
   * The append-only, double-entry record behind the balance: what moved, when, and why. Corrections
   * appear as new REVERSING entries rather than edits, so the history is what happened.
   *
   * Use `ledgerAll()` to walk the whole thing.
   */
  async ledger(params: { limit?: number; offset?: number } = {}): Promise<{ entries: LedgerEntry[] }> {
    const { data } = await this.http.get('/v1/billing/ledger', {
      params: { limit: params.limit ?? 50, offset: params.offset ?? 0 },
    });
    return data;
  }

  /**
   * Every ledger entry, paging automatically.
   *
   * ```ts
   * for await (const entry of certen.billing.ledgerAll()) { ... }
   * ```
   *
   * The endpoint returns no total and no `has_more`, so termination is inferred from a short page —
   * which is why this belongs here once rather than in every caller that gets the condition subtly
   * wrong and silently reports a partial ledger as complete.
   */
  ledgerAll(pageSize = 100): AsyncIterableIterator<LedgerEntry> {
    return paginate<LedgerEntry>(
      async (limit, offset) => ({ items: (await this.ledger({ limit, offset })).entries ?? [] }),
      pageSize,
    );
  }

  /** Signed receipts for every payment, charge, refund and adjustment. Requires `billing:read`. */
  async receipts(
    params: { limit?: number; offset?: number } = {},
  ): Promise<{ receipts: ReceiptSummary[] }> {
    const { data } = await this.http.get('/v1/billing/receipts', {
      params: { limit: params.limit ?? 50, offset: params.offset ?? 0 },
    });
    return data;
  }

  /** Every receipt, paging automatically. */
  receiptsAll(pageSize = 100): AsyncIterableIterator<ReceiptSummary> {
    return paginate<ReceiptSummary>(
      async (limit, offset) => ({ items: (await this.receipts({ limit, offset })).receipts ?? [] }),
      pageSize,
    );
  }

  /**
   * One receipt, with its signature, its computation inputs, and the gateway's own verification.
   *
   * `verification` is CERTEN checking CERTEN, which settles nothing by itself. What makes the
   * receipt evidence is that every check in it is reproducible by you: verify `signature` against
   * `verificationKeys()`, reproduce `digest` from `body`, and fetch `receiptProof()` to show the
   * receipt is in a log that was anchored on Accumulate.
   */
  async receipt(id: string): Promise<Receipt> {
    const { data } = await this.http.get(`/v1/billing/receipts/${encodeURIComponent(id)}`);
    return data;
  }

  /**
   * The transparency-log inclusion proof for a receipt.
   *
   * **Store it alongside the receipt.** It remains valid forever against the tree head it names,
   * and that head is pinned on Accumulate — so the proof outlives any cooperation from CERTEN,
   * which is the entire point of it existing.
   *
   * Defaults to the newest ANCHORED head; a proof against an unanchored head is only as good as our
   * word. Only receipts with `logged: true` have one — expect a 404 otherwise.
   */
  async receiptProof(id: string, params: { treeSize?: number } = {}): Promise<ReceiptProof> {
    const { data } = await this.http.get(
      `/v1/billing/receipts/${encodeURIComponent(id)}/proof`,
      params.treeSize ? { params: { tree_size: params.treeSize } } : undefined,
    );
    return data;
  }

  /**
   * The public keys receipts and tree heads are signed with.
   *
   * Deliberately unauthenticated on the gateway, and it should stay that way in your integration
   * too: a verification key you can only obtain by asking us nicely could not settle a dispute
   * with us.
   */
  async verificationKeys(): Promise<VerificationKeys> {
    const { data } = await this.http.get('/v1/billing/receipts/verification-key');
    return data;
  }

  /**
   * Register a wallet you pay from, so every future deposit from it credits automatically.
   *
   * This is the difference between funding once and funding repeatedly. `openPayment` opens a
   * single-use intent matched on the EXACT amount within a TTL — right for a first deposit, and a
   * step before every send thereafter. A registered address needs none of that: money arriving from
   * it is attributed to this organization on sight.
   *
   * **The gateway's own 402 recommends doing this, and until now no client could.** Its `how_to_pay`
   * block names `POST /v1/billing/deposit-addresses` as the recommended fix, while this SDK omitted
   * it on the stated grounds that it needed a portal session rather than a machine key. That was
   * wrong: the endpoint takes an API key with `billing:write`, which is exactly what an autonomous
   * caller settling its own 402 is holding.
   *
   * An address belongs to ONE organization per chain. A duplicate is rejected rather than merged,
   * because ambiguous attribution means crediting the wrong customer — expect a 409.
   */
  async registerPayerAddress(params: {
    chain: string;
    address: string;
    label?: string;
  }): Promise<PayerAddress> {
    const { data } = await this.http.post('/v1/billing/deposit-addresses', {
      chain: params.chain,
      address: params.address,
      ...(params.label ? { label: params.label } : {}),
    });
    return data;
  }

  /** Wallets registered for automatic attribution. Requires `billing:read`. */
  async payerAddresses(): Promise<{ addresses: PayerAddress[] }> {
    const { data } = await this.http.get('/v1/billing/deposit-addresses');
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
    // The response IS the intent. It used to arrive under an `intent` key with nothing beside it,
    // so the wrapper carried no information — the clearest case of the inconsistency the gateway's
    // 2026-08 break removed.
    return data as DepositIntentStatus;
  }

  /**
   * Resolve once the payment is credited, or when it expires.
   *
   * Returns the terminal status rather than throwing on expiry — an expired
   * payment is an ordinary outcome the caller should report, not an error. Only a
   * genuine transport or auth failure throws.
   *
   * **It watches the payment feed as well as the intent, and that is not belt-and-braces.**
   *
   * It began as a workaround for a gateway bug: the gateway closed a deposit intent only when the
   * payment had been attributed BY that intent, and since attribution tries a registered payer
   * address first — and the funding flow registers the sender — a paid intent was never closed.
   * Observed live: 1 USDC credited in seconds with `attribution: registered_address` while the
   * intent sat `open` with `matched_at: null`, until it expired an hour later. Watching only the
   * intent reported "not credited" on money that had already arrived. The gateway now closes the
   * intent on credit regardless of how the org was identified.
   *
   * The feed watch stays, for two reasons that outlive that bug. The SDK is versioned separately
   * and is regularly pointed at an older gateway, where the old behaviour is still live. And the
   * intent can only ever report money that matched it: a deposit for the wrong amount, or one sent
   * before the intent was opened, still credits the balance and still answers the caller's actual
   * question — did my money arrive.
   *
   * On that path the returned status is synthesised with `status: 'matched'` and the credited
   * payment's id, because from the caller's point of view the money arrived.
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
