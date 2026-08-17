import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain ESM analysis script, deliberately not TypeScript. See scripts/coverage.mjs.
import { analyse, reachableOperations } from '../../../scripts/coverage.mjs';

/**
 * Every gateway operation is either reachable from a client or listed here with a reason.
 *
 * This exists because the measurement was wrong and nobody noticed. The original coverage tool
 * matched paths as substrings anywhere in client source, so a path in a code COMMENT counted as
 * implemented — `POST /v1/oauth/token` was reported covered while the SDK had no OAuth surface at
 * all. Its replacement then missed every path behind a local helper, because it required a leading
 * dot on the call. Both errors ran the same direction: toward "the work is done".
 *
 * Then `GET /v1/errors` was published on the gateway and left with no client method for a whole
 * phase — by me, one phase after I built the endpoint. A tool that is run by hand catches that only
 * if someone remembers to run it.
 *
 * So the list below is the contract. An operation that becomes unreachable fails this test, and
 * adding an entry is a deliberate act that costs a sentence explaining why a customer never needs
 * to call it. **The reason is the point.** A bare list of 43 paths would drift into a place where
 * inconvenient findings get parked.
 */

/** Unreachable ON PURPOSE. Key -> why a customer client should never call it. */
const DELIBERATELY_UNREACHABLE: Record<string, string> = {
  // ── The operator fee console ────────────────────────────────────────────────────────────────
  // A web UI for CERTEN staff: margin, drift, reconciliation, price-book publishing. Cross-org by
  // nature, and a customer SDK has no use for any of it.
  'GET /v1/admin/billing/accounts': 'Operator console — every org\'s billing account.',
  'GET /v1/admin/billing/balance-drift': 'Operator console — ledger-vs-balance reconciliation.',
  'GET /v1/admin/billing/chain-coverage': 'Operator console — which chains are priced.',
  'GET /v1/admin/billing/chains': 'Operator console — chain-level fee configuration.',
  'GET /v1/admin/billing/enforcement-readiness': 'Operator console — is the paywall safe to enable.',
  'GET /v1/admin/billing/health': 'Operator console — fee subsystem health.',
  'GET /v1/admin/billing/intents': 'Operator console — intents across all orgs.',
  'GET /v1/admin/billing/margin': 'Operator console — platform margin.',
  'GET /v1/admin/billing/payments/unattributed': 'Operator console — payments needing manual attribution.',
  'GET /v1/admin/billing/summary': 'Operator console — platform-wide revenue summary.',
  'GET /v1/admin/billing/timeseries': 'Operator console — revenue over time.',
  'POST /v1/admin/billing/payments/{}/attribute': 'Operator action — assign a payment to an org.',
  'POST /v1/admin/billing/price-books': 'Operator action — publish a price book.',
  'POST /v1/admin/billing/price-books/{}/assign': 'Operator action — put an org on a price book.',
  'POST /v1/admin/billing/reconcile': 'Operator action — run reconciliation.',
  'POST /v1/admin/billing/run-balance-check': 'Operator action — force a balance check.',
  'POST /v1/admin/billing/signing-keys': 'Operator action — mint a receipt-signing key.',
  'POST /v1/admin/billing/signing-keys/{}/revoke': 'Operator action — revoke a receipt-signing key.',
  'GET /v1/admin/orgs': 'Operator console — every organization on the platform.',
  'POST /v1/admin/orgs/{}/approve': 'Operator action — approve a signup.',
  'POST /v1/admin/orgs/{}/suspend': 'Operator action — suspend an org.',
  'GET /v1/admin/signing-providers': 'Operator console — configured signing providers.',
  'DELETE /v1/admin/signing-providers/{}': 'Operator action — remove a signing provider.',

  // Superseded rather than missing: the endpoints API replaced the single per-org webhook_url.
  // A candidate for removal, not for wiring.
  'POST /v1/admin/org/{}/webhook': 'Legacy single-webhook config, superseded by /v1/webhooks/endpoints.',

  // ── The portal ──────────────────────────────────────────────────────────────────────────────
  // Firebase-session flows. A browser holds the session; an SDK holds an API key and never a
  // session, so these are unreachable by construction rather than by omission.
  'GET /v1/portal/keys': 'Portal session — browser key management.',
  'POST /v1/portal/keys': 'Portal session — self-service key mint.',
  'POST /v1/portal/keys/{}/rotate': 'Portal session — rotate a portal-minted key.',
  'DELETE /v1/portal/keys/{}': 'Portal session — revoke a portal-minted key.',
  'GET /v1/portal/members': 'Portal session — team membership.',
  'POST /v1/portal/invites': 'Portal session — invite a teammate.',
  'GET /v1/portal/funding': 'Portal session — funding overview.',
  'POST /v1/portal/funding/intents': 'Portal session — the CLI uses /v1/billing/deposits instead.',
  'GET /v1/portal/funding/intents/{}': 'Portal session — the CLI uses /v1/billing/deposits instead.',
  'POST /v1/portal/funding/addresses': 'Portal session — the CLI uses /v1/billing/deposit-addresses.',
  'DELETE /v1/portal/funding/addresses/{}': 'Portal session — the CLI uses /v1/billing/deposit-addresses.',
  'POST /v1/portal/device/approve': 'Portal session — the human APPROVES here; the CLI polls the token endpoint.',
  'POST /v1/portal/device/deny': 'Portal session — the human DENIES here.',

  // ── Not API calls ───────────────────────────────────────────────────────────────────────────
  'GET /metrics': 'Prometheus scrape format, not JSON. Consumed by monitoring.',
  'GET /reference': 'An HTML documentation page.',

  // ── Self-authenticating, and not for customers ──────────────────────────────────────────────
  'GET /v1/entitlement/current': 'Validator-facing signed entitlement. Consumed by validators.',
  'GET /v1/entitlement/health': 'Validator-facing entitlement health.',

  // ── Health: covered by a narrower method ────────────────────────────────────────────────────
  // `health.ready()` answers "can CERTEN serve", which is the question a client has. These two are
  // the liveness probe and an operator-scoped component breakdown.
  'GET /v1/health': 'Liveness probe. `health.ready()` answers the question a client actually has.',
  'GET /v1/health/detail': 'Component-level detail behind the operator-only health:read scope.',
};

describe('client coverage of the gateway surface', () => {
  it('leaves nothing unreachable without a stated reason', () => {
    const { unreachable } = analyse();

    const undocumented = unreachable.filter((op: string) => !(op in DELIBERATELY_UNREACHABLE));

    // Listed, not counted. A failure here should name the operation, because the decision it
    // demands — wire it, or write down why not — depends entirely on which one it is.
    expect(
      undocumented,
      'unreachable from every client, and not on the deliberate list — wire it, or add it with a reason',
    ).toEqual([]);
  });

  it('has no stale entries claiming something is unreachable when it is not', () => {
    const { unreachable } = analyse();
    const set = new Set(unreachable);

    // The other direction, and the one that rots silently: an operation gets wired and its excuse
    // stays behind, so the list slowly stops describing anything real.
    const stale = Object.keys(DELIBERATELY_UNREACHABLE).filter((op) => !set.has(op));

    expect(stale, 'listed as deliberately unreachable, but a client now calls it').toEqual([]);
  });

  it('finds call sites at all', () => {
    // The failure mode that produced the original bug: a tool matching nothing reports perfect
    // coverage. If the extraction regexes ever stop matching, this fails loudly instead of
    // quietly declaring victory.
    const reached = reachableOperations();
    expect(reached.size).toBeGreaterThan(50);
    // Spot-checks across all three shapes the extractor has to handle: a plain method call, a
    // template literal with interpolation, and a path reached only through a local helper.
    expect(reached.has('GET /v1/me')).toBe(true);
    expect(reached.has('GET /v1/identity/{}')).toBe(true);
    expect(reached.has('POST /v1/oauth/token')).toBe(true);
  });

  it('does not count a path that only appears in a comment', () => {
    // The original bug, pinned directly. `/v1/oauth/token` used to be "covered" because a comment
    // about idempotency mentioned it; the SDK had no OAuth surface whatsoever. It is genuinely
    // reachable now, so the property is asserted against a path that is NOT implemented anywhere:
    // every reachable key must correspond to a real call site, and nothing here reaches the
    // operator console — which is discussed in comments in several places.
    const reached = reachableOperations();
    expect(reached.has('GET /v1/admin/billing/margin')).toBe(false);
    expect(reached.has('POST /v1/admin/orgs/{}/suspend')).toBe(false);
  });
});
