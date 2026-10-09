/**
 * Where an intent can be, and what each place means.
 *
 * ONE table, used by `execute.wait()`, the CLI and the MCP server, so they cannot disagree about which statuses end a wait. Before
 * this there were three copies of `['completed', 'delivered', 'proven']`, and none of them knew the two states the execution
 * outcome model added:
 *
 * - `executed`: the action EXECUTED on its chain and its proof bundle is pending. Not a failure, and not terminal: CERTEN produces
 *   the bundle automatically and the intent then reads `completed`. The fee is held meanwhile.
 * - `completed_unproven`: the action executed and its proof can NEVER be produced (declared by an operator with the evidence).
 *   Terminal. Billed gas only, fee waived. It is never "completed": nothing can be verified for it.
 *
 * `expired` is terminal too, and a failure: the intent will never execute. `wait()` used to poll through it to its timeout.
 *
 * The statuses are the gateway's own (`chk_intent_status`, api-gateway migration 053) and the spec's description of the field.
 * `delivered` and `error` are older spellings this client has always treated as terminal; they stay in the table so a gateway that
 * still sends them is not misread. A status that is not in the table is `unknown` and is never treated as terminal.
 */

/** What a status means for a caller waiting on the intent. */
export type IntentStatusClass =
  /** Opened or in progress; nothing has executed. Keep waiting. */
  | 'in_flight'
  /** Executed on its chain; the proof bundle is pending. Not terminal, not a failure. Keep waiting for `completed`. */
  | 'executed'
  /** Executed and proven. Terminal. */
  | 'terminal_success'
  /** Executed and its proof can never be produced. Terminal; gas-only billing. */
  | 'terminal_gas_only'
  /** Will never execute. Terminal. */
  | 'terminal_failure'
  /** A status this client does not know. Not terminal: more waiting cannot make it worse, and calling it done could. */
  | 'unknown';

export const INTENT_STATUS_CLASS = {
  created: 'in_flight',
  signing_required: 'in_flight',
  submitted: 'in_flight',
  processing: 'in_flight',
  anchoring: 'in_flight',
  executed: 'executed',
  completed: 'terminal_success',
  proven: 'terminal_success',
  delivered: 'terminal_success',
  completed_unproven: 'terminal_gas_only',
  failed: 'terminal_failure',
  expired: 'terminal_failure',
  error: 'terminal_failure',
} as const satisfies Record<string, Exclude<IntentStatusClass, 'unknown'>>;

export type KnownIntentStatus = keyof typeof INTENT_STATUS_CLASS;

/** The reason the gateway gives a `completed_unproven` intent: the proof can never be produced. */
export const EXECUTION_PROOF_UNAVAILABLE = 'execution_proof_unavailable';

export function classifyIntentStatus(status: unknown): IntentStatusClass {
  return typeof status === 'string' && Object.prototype.hasOwnProperty.call(INTENT_STATUS_CLASS, status)
    ? INTENT_STATUS_CLASS[status as KnownIntentStatus]
    : 'unknown';
}

/** Does this status end a wait (success, gas-only, or failure)? `executed` and `unknown` do not. */
export function isTerminalIntentStatus(status: unknown): boolean {
  const c = classifyIntentStatus(status);
  return c === 'terminal_success' || c === 'terminal_gas_only' || c === 'terminal_failure';
}

/** What happened to the action itself, which is what a caller usually wants to branch on. */
export type IntentOutcomeName =
  | 'completed'
  | 'completed_unproven'
  | 'executed'
  | 'failed'
  /** Nothing has executed yet. */
  | 'pending'
  | 'unknown';

export interface IntentOutcome {
  /** The gateway's status, verbatim. */
  status: string;
  class: IntentStatusClass;
  terminal: boolean;
  outcome: IntentOutcomeName;
  /**
   * Why, as a stable value. For `completed_unproven` this is always `execution_proof_unavailable`; for a failure it is the gateway's
   * `reason_code`; otherwise null.
   */
  reason: string | null;
}

/** Read the named outcome off a transaction response. Never invents a state: an unrecognised status is `unknown`. */
export function intentOutcome(tx: { status?: unknown; reason_code?: unknown } | null | undefined): IntentOutcome {
  const status = typeof tx?.status === 'string' ? tx.status : '';
  const cls = classifyIntentStatus(status);
  const reasonCode = typeof tx?.reason_code === 'string' && tx.reason_code ? tx.reason_code : null;
  switch (cls) {
    case 'terminal_success':
      return { status, class: cls, terminal: true, outcome: 'completed', reason: null };
    case 'terminal_gas_only':
      return { status, class: cls, terminal: true, outcome: 'completed_unproven', reason: reasonCode ?? EXECUTION_PROOF_UNAVAILABLE };
    case 'executed':
      return { status, class: cls, terminal: false, outcome: 'executed', reason: null };
    case 'terminal_failure':
      return { status, class: cls, terminal: true, outcome: 'failed', reason: reasonCode };
    case 'in_flight':
      return { status, class: cls, terminal: false, outcome: 'pending', reason: null };
    default:
      return { status, class: cls, terminal: false, outcome: 'unknown', reason: null };
  }
}
