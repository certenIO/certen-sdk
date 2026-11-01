/**
 * The events the gateway pushes to a webhook endpoint, and the body each one carries.
 *
 * **Provenance.** Webhook events are pushed, not served, so they are not in `spec/openapi.json` and `agentgen` cannot check this file.
 * It is transcribed from the gateway's event registry (`src/webhooks/event-types.ts`), which is the gateway's own single source of
 * truth: dispatching an event whose name is not in that registry throws. If the gateway adds an event or a field, this file is behind
 * until someone copies it, so treat it as a convenience for the common case and not a closed list:
 *
 *   - `isWebhookEvent` narrows a received webhook to one of these, and is false for an event this SDK does not know.
 *   - A payload only ever grows (a field is added, never renamed; an incompatible change is a NEW event name), so a field missing
 *     from a type here is present at runtime, not absent.
 *
 * The body on the wire is the payload alone. There is no `{ event, data }` envelope — the event name travels in the
 * `X-Certen-Event` header, which the signature does NOT cover. See `ReceivedWebhook`.
 */

export const WEBHOOK_EVENTS = {
  TransactionCompleted: 'transaction.completed',
  TransactionFailed: 'transaction.failed',
  /** The action executed on its chain and its proof is still being produced. Not a failure and not the end. */
  TransactionExecuted: 'transaction.executed',
  /** The action executed and its proof can never be produced (an operator declared it, with the evidence). Terminal. */
  TransactionProofUnavailable: 'transaction.proof_unavailable',
  GovernanceCompleted: 'governance.completed',
  /** A transaction is NEWLY awaiting this organization's signature — the push signal that replaces polling `GET /v1/pending`. */
  InboxActionPending: 'inbox.action_pending',
  InboxActionSigned: 'inbox.action_signed',
  /** The ping sent on registration and by `webhooks.verify(id)`. Answer 2xx; there is nothing to act on. */
  WebhookVerify: 'webhook.verify',
  BillingPaymentReceived: 'billing.payment_received',
  BillingCharged: 'billing.charged',
  /** Spendable balance fell to the configured floor. Fired on the way DOWN, not at zero. */
  BillingBalanceLow: 'billing.balance_low',
  BillingDepositUnattributed: 'billing.deposit_unattributed',
  BillingCreditWarning: 'billing.credit_warning',
  BillingAccountSuspended: 'billing.account_suspended',
  BillingAccountReinstated: 'billing.account_reinstated',
  BillingTrialExpiring: 'billing.trial_expiring',
} as const;

export type WebhookEventName = typeof WEBHOOK_EVENTS[keyof typeof WEBHOOK_EVENTS];

const KNOWN: ReadonlySet<string> = new Set<string>(Object.values(WEBHOOK_EVENTS));

/** True when `name` is an event this SDK has a payload type for. A `false` is not an error: the gateway may be newer than the SDK. */
export function isKnownWebhookEvent(name: string | null | undefined): name is WebhookEventName {
  return typeof name === 'string' && KNOWN.has(name);
}

/** The header conditions an intent was created with. `null` when none were requested. */
export interface WebhookIntentHeader {
  additional_authorities?: string[] | null;
  expires_at?: string | null;
}

export interface WebhookEventPayloads {
  'transaction.completed': {
    intent_id: string;
    identity_id: string | null;
    tx_hash: string;
    proof_id: string | null;
    proof_bundle_url: string | null;
    /** Present for an intent on several chains: every chain's proof, in the order the intent declares them. */
    proofs?: Array<{ chain_id: number; legs: number[]; proof_id: string | null; proof_bundle_url: string | null }>;
    /**
     * How completion was established. `proof_artifact`: the proof service holds a bundled proof (`proof_id` is set).
     * `execution_observed`: a measured cost event proves a target-chain leg landed (`proof_id` may be null — verify the receipt
     * yourself). `chain_receipt` is legacy and no longer emitted.
     */
    completion_basis: 'proof_artifact' | 'execution_observed' | 'chain_receipt' | null;
    status: 'completed';
  } & WebhookIntentHeader;
  'transaction.failed': {
    intent_id: string;
    identity_id: string | null;
    tx_hash: string | null;
    status: 'failed';
    reason: string;
    /**
     * A stable value (see `describeReasonCode`). A deadline-derived `expired` can be followed, within the gateway's recheck window,
     * by `transaction.completed` for the same intent: treat the later event as authoritative.
     */
    reason_code?: string | null;
    error_message?: string | null;
  } & WebhookIntentHeader;
  'transaction.executed': {
    intent_id: string;
    identity_id: string | null;
    tx_hash: string;
    status: 'executed';
    reason: string;
  } & WebhookIntentHeader;
  'transaction.proof_unavailable': {
    intent_id: string;
    identity_id: string | null;
    tx_hash: string;
    status: 'completed_unproven';
    reason_code: 'execution_proof_unavailable';
    reason: string;
  } & WebhookIntentHeader;
  'governance.completed': {
    governance_op_id: string;
    operation_type: 'keypage_update' | 'account_auth_update';
    tx_hash: string;
  };
  'inbox.action_pending': {
    pending_action_id: string;
    identity_id: string;
    identity_url: string;
    tx_hash: string;
    /** `governance` | `transactions` | `unknown` */
    category: string;
    /** The Accumulate transaction type, e.g. `writeData`. */
    transaction_type: string | null;
    expires_at: string | null;
  };
  'inbox.action_signed': {
    pending_action_id: string | null;
    sign_request_id?: string;
    tx_hash: string;
    vote: string;
    signature_count: number;
    signing_mode?: 'provider' | 'external';
  };
  'webhook.verify': {
    challenge: string;
    endpoint_id: string;
  };
  // Money crosses the wire as fixed-6dp decimal STRINGS, never JSON numbers: a float round-trip can move a cent.
  'billing.payment_received': {
    payment_id: string | null;
    receipt_id: string;
    rail: string;
    amount_usd: string;
    balance_usd: string;
  };
  'billing.charged': {
    receipt_id: string;
    ref_type: string | null;
    ref_id: string | null;
    amount_usd: string;
    platform_fee_usd: string;
    gas_usd: string;
    balance_usd: string;
  };
  'billing.balance_low': {
    balance_usd: string;
    spendable_usd: string;
    threshold_usd: string;
  };
  'billing.deposit_unattributed': {
    payment_id: string;
    chain: string;
    tx_hash: string;
    from_address: string;
    amount_usd: string;
  };
  'billing.credit_warning': {
    drawn_usd: string;
    credit_limit_usd: string;
    remaining_usd: string;
    percent_used: number;
    suspends_at_usd: string;
    how_to_pay: { cli: string; portal: string };
  };
  'billing.account_suspended': {
    reason: string;
    drawn_usd: string;
    credit_limit_usd: string;
    restores_when: string;
    how_to_pay: { cli: string; portal: string };
  };
  'billing.account_reinstated': {
    available_usd: string;
    reason: string;
  };
  'billing.trial_expiring': {
    expires_at: string;
    days_remaining: number;
    credit_label: string | null;
    remaining_usd: string;
    how_to_continue: string;
  };
}
