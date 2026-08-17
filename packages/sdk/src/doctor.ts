import type { CertenClient } from './client.js';
import { CertenError } from './errors.js';
import { VENDORED_ERROR_CODES } from './error-codes.js';

/**
 * Diagnose a setup and say what is blocking it.
 *
 * The CLI grew this first, and it turned out not to be a CLI concern: every integration hits the
 * same handful of conditions, and each one is invisible until it produces a failure somewhere far
 * away from its cause. A key with no `billing:read` scope, an organization with no active identity,
 * an abstract account with no gas, a balance entirely committed to pending intents — none of these
 * announce themselves, and three of them surface as a transaction that is accepted and then never
 * completes.
 *
 * Checks are ordered by dependency and stop being evaluated once a prerequisite fails: nothing
 * below an unusable credential is meaningful, so nothing below it is run. A skipped check is
 * reported as skipped rather than omitted — a list whose length depends on how far the run got is
 * one a caller cannot index into.
 *
 * This deliberately does NOT check anything machine-local (a signing key on disk, where the API key
 * is stored). Those are real checks and the CLI makes them, but an SDK embedded in a server has no
 * such state and inventing an opinion about it would be wrong.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What resolves it. Absent when the check passed. */
  fix?: string;
}

export interface DoctorReport {
  /** True when nothing FAILED. Warnings do not clear this flag but do not set it either. */
  ok: boolean;
  /** True when the gateway could not be reached at all — nothing below it was evaluated. */
  unreachable: boolean;
  checks: DoctorCheck[];
}

/**
 * Checks that cannot run without a working credential, in the order they are reported.
 *
 * Exported because the CLI needs the same list: it knows things the SDK cannot (whether a key is
 * configured on this machine at all) and has to mark the same checks skipped. It kept its own copy
 * once, the two drifted, and a machine with no API key showed a verdict for the check that had been
 * added to only one of them. One list, imported, makes that impossible rather than merely
 * discouraged.
 */
export const CREDENTIALLED_CHECKS = [
  'identity can sign',
  'abstract accounts funded',
  'billing balance',
  'credit / trial',
  'intents executing',
] as const;

/**
 * States in which an intent is waiting on the PLATFORM to do something.
 *
 * `signing_required` is deliberately absent. That state means the intent is waiting on a human
 * co-signer, and on a multi-signature panel that legitimately takes hours or weeks — flagging it as
 * stalled would cry wolf on the one state that is supposed to sit still.
 */
const AWAITING_EXECUTION = ['anchoring', 'submitted', 'executing', 'proving'];

/**
 * How long before "still working" becomes "not working".
 *
 * A proof cycle is 60–110 seconds of real validator work and `execute.wait()` budgets 360s. Fifteen
 * minutes is far enough past both that a queue backlog is not mistaken for a stall.
 */
const STALL_AFTER_MS = 15 * 60_000;

/**
 * Numeric EVM chain id → registry slug, for chains where the portfolio may report either.
 *
 * `GET /v1/portfolio` used to return `chain_id` as a slug on some chain accounts and as a numeric
 * EVM id on others, in the same response. Anything that compares or de-duplicates on that field
 * had to normalize first, or it reported one chain twice and found no faucet for the numeric copy.
 *
 * The gateway now canonicalizes on write and has backfilled the old rows. This is kept because the
 * SDK is versioned independently of the gateway and may be pointed at an older one — and `doctor`
 * of all things must not be the command that misreports when talking to an older peer.
 */
const NUMERIC_CHAIN_IDS: Record<string, string> = {
  11155111: 'ethereum-sepolia',
  84532: 'base-sepolia',
  421614: 'arbitrum-sepolia',
  11155420: 'optimism-sepolia',
  80002: 'polygon-amoy',
};

function normalizeChain(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  return NUMERIC_CHAIN_IDS[raw] ?? raw;
}

function summarize(items: string[], max = 3): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

/**
 * Is anything actually EXECUTING?
 *
 * The check that exists because everything above it can pass while the platform still does no work.
 * A proof-gated intent has two halves: the authorization, which the gateway writes to Accumulate and
 * anchors, and the execution on the destination chain. The first can succeed perfectly while the
 * second never runs — observed on a deployment where the gateway was healthy, the account was
 * funded, the authorization anchored correctly, and no cross-chain executor was deployed at all.
 *
 * Every other check reported a clean bill of health, because every other check was true.
 */
function executionCheck(list: Awaited<ReturnType<CertenClient['transaction']['list']>> | null): DoctorCheck {
  // Takes the already-fetched list rather than fetching its own. It is the last check reported, but
  // its data depends on nothing above it, so making it wait cost a round trip of pure latency on the
  // command whose whole job is to answer a stuck user quickly.
  if (!list) {
    return { name: 'intents executing', status: 'skipped', detail: 'could not list transactions' };
  }

  const rows = ((list as unknown as { transactions?: Array<Record<string, unknown>> }).transactions
    ?? (list as unknown as { intents?: Array<Record<string, unknown>> }).intents
    ?? []);
  if (rows.length === 0) {
    return { name: 'intents executing', status: 'ok', detail: 'no intents yet' };
  }

  const now = Date.now();
  const stalled = rows.filter((r) => {
    if (!AWAITING_EXECUTION.includes(String(r.status ?? ''))) return false;
    const since = Date.parse(String(r.updated_at ?? r.created_at ?? ''));
    return Number.isFinite(since) && now - since > STALL_AFTER_MS;
  });

  if (stalled.length === 0) {
    return {
      name: 'intents executing',
      status: 'ok',
      detail: `${rows.length} recent intent(s), none stalled`,
    };
  }

  const oldest = stalled
    .map((r) => now - Date.parse(String(r.updated_at ?? r.created_at)))
    .sort((a, b) => b - a)[0];
  const hours = Math.round(oldest / 3_600_000);
  const age = hours >= 1 ? `${hours}h` : `${Math.round(oldest / 60_000)}m`;
  const example = String(stalled[0].intent_id ?? stalled[0].id ?? '<id>');

  return {
    name: 'intents executing',
    // A warning, not a failure: the caller's own setup is fine, and saying "you have a problem"
    // about someone else's infrastructure would be wrong. But it must be visible, because until it
    // resolves no proof-gated call this account makes will complete.
    status: 'warn',
    detail: `${stalled.length} intent(s) awaiting execution for over ${age}. The authorization `
      + 'anchored; the execution leg has not completed. This is usually the cross-chain executor, '
      + 'not your integration.',
    fix: `certen proof get ${example} — if anchored:true and the destination chain shows no change, `
      + 'the authorization succeeded and execution never ran.',
  };
}

/**
 * Run the diagnostic.
 *
 * Never throws for a failed check — a diagnosis that cannot report a broken setup is useless. It
 * throws only if something outside the checks goes wrong.
 */
export async function runDoctor(client: CertenClient): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let unreachable = false;

  // ── 1. Is the gateway there at all? ─────────────────────────────────────────────────────────
  // `GET /v1/chains` is public, so this distinguishes "wrong address / network down" from "bad
  // credential" before any credential is involved.
  try {
    const registry = await client.chains.list();
    checks.push({
      name: 'gateway reachable',
      status: 'ok',
      detail: `registry v${registry.version}, ${registry.count} chains`,
    });
  } catch (err) {
    unreachable = true;
    checks.push({
      name: 'gateway reachable',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      fix: 'Check the base URL and network. Nothing else can be diagnosed until this passes.',
    });
  }

  // ── 1b. Can the platform actually serve? ────────────────────────────────────────────────────
  //
  // Check 1 proves the gateway is answering HTTP, and nothing more: `GET /v1/chains` is a static
  // registry read that keeps returning 200 while the database, the api-bridge, the proof service or
  // Accumulate are down. So a CERTEN-side outage was indistinguishable from a broken local setup,
  // and the report said "gateway reachable: ok" while sending the reader to look at their own
  // configuration for a fault that was never theirs.
  //
  // `sponsor_below_floor` is the reason this check earns its round trip. When the onboarding
  // sponsor runs dry, identity creation returns 202 and then never completes — every visible signal
  // says it worked. Nothing else in this report can see that.
  if (!unreachable) {
    try {
      const readiness = await client.health.ready();
      if (readiness.ready) {
        const warning = (readiness.reasons ?? []).includes('sponsor_low_warning');
        checks.push({
          name: 'platform ready',
          status: warning ? 'warn' : 'ok',
          detail: warning
            ? 'Serving normally. CERTEN reports its onboarding sponsor is running low'
              + (readiness.sponsor_identities_remaining != null
                ? ` (~${readiness.sponsor_identities_remaining} identities left)` : '')
              + ' — not an outage, but identity creation may be affected soon.'
            : 'All components serving.',
        });
      } else {
        const reasons = readiness.reasons ?? [];
        const sponsorDry = reasons.includes('sponsor_below_floor');
        // Named separately because the consequence differs: a dry sponsor stops identity CREATION
        // (silently, with a 202), while an entitlement gap stops EXECUTION of work already created.
        const gateShut = reasons.includes('entitlement_unpublished')
          || reasons.includes('entitlement_expired');
        checks.push({
          name: 'platform ready',
          status: 'fail',
          detail: sponsorDry
            ? 'CERTEN is not ready: the onboarding sponsor is below its floor. Identity creation '
              + 'will return 202 and then NEVER complete.'
              + (reasons.length > 1 ? ` Also down: ${reasons.filter((r) => r !== 'sponsor_below_floor').join(', ')}.` : '')
            : gateShut
              ? 'CERTEN is not ready: no valid entitlement epoch is published, so validators are '
                + 'refusing every intent. Work will not execute until this clears.'
                + (reasons.length > 1 ? ` Also affected: ${reasons.filter((r) => !r.startsWith('entitlement_')).join(', ')}.` : '')
              : `CERTEN is not ready. Affected: ${reasons.join(', ') || 'unspecified'}.`,
          // Deliberately not a configuration instruction. The whole value of this check is telling
          // someone to STOP looking at their own setup, so the fix must not send them back to it.
          fix: sponsorDry
            ? 'Nothing on your side to change. Do not create identities until this clears — they '
              + 'will appear to succeed and never finish. Retry later or contact CERTEN.'
            : 'Nothing on your side to change — this is a CERTEN-side outage. Retry later.',
        });
      }
    } catch (err) {
      // The probe is public and cheap; failing it while `/v1/chains` succeeded is odd enough to
      // report, but it is not evidence that anything is broken for this caller.
      checks.push({
        name: 'platform ready',
        status: 'warn',
        detail: `Could not read the readiness probe: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    checks.push({ name: 'platform ready', status: 'skipped', detail: 'gateway unreachable' });
  }

  // ── 2. Does the gateway accept this credential? ─────────────────────────────────────────────
  let credentialOk = false;
  // The credential probe's answer, kept rather than discarded.
  //
  // Check 2 asks the gateway whether it accepts this key, and the cheapest question that proves it
  // is a balance read. Check 5 then needs the balance — and used to fetch it AGAIN, so `doctor`
  // spent two of its six round trips asking one question twice. Measured against the live gateway:
  // 6 calls, 1785ms, with `/v1/billing/balance` at 190ms and 179ms.
  //
  // Reusing it is sound: these are moments apart, and this is a diagnosis, not a settlement.
  let probedBalance: Awaited<ReturnType<CertenClient['billing']['balance']>> | null = null;
  if (unreachable) {
    checks.push({ name: 'api key', status: 'skipped', detail: 'gateway unreachable' });
  } else {
    try {
      probedBalance = await client.billing.balance();
      credentialOk = true;
      checks.push({ name: 'api key', status: 'ok', detail: 'accepted' });
    } catch (err) {
      if (err instanceof CertenError && err.status === 403) {
        // The key is real; it simply cannot read billing. Not a blocker for signing work, so the
        // checks that depend on a working credential still run.
        credentialOk = true;
        checks.push({
          name: 'api key',
          status: 'warn',
          detail: 'accepted, but has no billing:read scope',
          fix: 'Balance and credit checks below will be skipped.',
        });
      } else if (err instanceof CertenError && err.status === 401) {
        checks.push({
          name: 'api key',
          status: 'fail',
          detail: 'The gateway rejected this key.',
          fix: 'Mint a new key, or check which one is configured.',
        });
      } else {
        // Inconclusive is not the same as broken. Say so, and carry on rather than blocking every
        // check below on one unexplained status.
        credentialOk = true;
        checks.push({
          name: 'api key',
          status: 'warn',
          detail: `Could not confirm the key (gateway answered ${err instanceof CertenError ? err.status : '?'}).`,
        });
      }
    }
  }

  if (!credentialOk) {
    for (const name of CREDENTIALLED_CHECKS) {
      checks.push({ name, status: 'skipped', detail: 'needs a working API key' });
    }
    return { ok: checks.every((c) => c.status !== 'fail'), unreachable, checks };
  }

  // Everything still needed, fetched CONCURRENTLY.
  //
  // These three answer unrelated questions and were awaited one after another, so `doctor` cost the
  // sum of them — on the command whose entire job is to answer a stuck user quickly. The checks are
  // still emitted in their original order below; only the I/O overlaps.
  //
  // `balance` reuses the credential probe when it succeeded, so the duplicate read is gone.
  const [portfolio, balance, recentIntents] = await Promise.all([
    client.portfolio.get().catch(() => null),
    probedBalance ? Promise.resolve(probedBalance) : client.billing.balance().catch(() => null),
    client.transaction.list({ limit: 25 }).catch(() => null),
  ]);

  // Commitments now ride along with the balance, so the dedicated `/v1/billing/obligations` read is
  // gone — doctor used its response for one field, `remaining_usd`, and paid a whole round trip for
  // it. Against a gateway that predates the change the field is absent and the old call is made,
  // because the alternative is reporting `spendable_usd` as if it were safe to commit.
  const commitments = balance?.remaining_usd !== undefined
    ? {
      remaining_usd: balance.remaining_usd,
      pending_intents: balance.pending_intents ?? 0,
    }
    : await client.billing.obligations().catch(() => null);

  // ── 3-4. Identities, and whether their abstract accounts can execute ────────────────────────

  if (!portfolio) {
    checks.push({ name: 'identity can sign', status: 'warn', detail: 'Could not read the portfolio.' });
    checks.push({ name: 'abstract accounts funded', status: 'skipped', detail: 'portfolio unavailable' });
  } else if ((portfolio.identities ?? []).length === 0) {
    checks.push({
      name: 'identity can sign',
      status: 'fail',
      detail: 'No identities in this organization.',
      fix: 'Create one with identity.create(), then poll until can_sign is true.',
    });
    checks.push({ name: 'abstract accounts funded', status: 'skipped', detail: 'no identities' });
  } else {
    const active = portfolio.identities.filter((i) => i.status === 'active');
    checks.push(active.length > 0
      ? {
        name: 'identity can sign',
        status: 'ok',
        detail: `${active.length} active: ${summarize(active.map((i) => i.adi_url))}`,
      }
      : {
        name: 'identity can sign',
        status: 'fail',
        detail: `${portfolio.identities.length} identity(ies), none active.`,
        fix: 'Check identity.get(id).error_message for why provisioning did not complete.',
      });

    // The silent failure this check exists for: an intent that moves value from an empty abstract
    // account is accepted, signed and submitted, and then parks at `anchoring` forever, because
    // the execution leg cannot run on chain. Nothing in any API response says so.
    const empty: string[] = [];
    let accounts = 0;
    for (const identity of portfolio.identities) {
      for (const chain of identity.chains ?? []) {
        const native = (chain.balances ?? [])
          .find((b) => !b.token || b.token === 'ETH' || b.token === 'native');
        if (!native) continue;
        accounts += 1;
        if (Number(native.balance) === 0) empty.push(normalizeChain(chain.chain_id));
      }
    }
    const emptyChains = [...new Set(empty)];
    checks.push(emptyChains.length === 0
      ? { name: 'abstract accounts funded', status: 'ok', detail: `all ${accounts} chain account(s) have gas` }
      : {
        name: 'abstract accounts funded',
        status: 'warn',
        detail: `${empty.length} of ${accounts} chain account(s) have no gas, on ${emptyChains.join(', ')}. `
          + 'A value transfer from an empty one parks at "anchoring" forever.',
        fix: 'Fund the abstract account on that chain before moving value from it.',
      });
  }

  // ── 5. Is there anything left to spend? ─────────────────────────────────────────────────────
  if (!balance) {
    checks.push({ name: 'billing balance', status: 'skipped', detail: 'balance unavailable' });
    checks.push({ name: 'credit / trial', status: 'skipped', detail: 'balance unavailable' });
    checks.push(executionCheck(recentIntents));
    return { ok: checks.every((c) => c.status !== 'fail'), unreachable, checks };
  }

  if (balance.status !== 'active') {
    checks.push({
      name: 'billing balance',
      status: 'fail',
      detail: `Account is ${balance.status}${balance.suspended_reason ? `: ${balance.suspended_reason}` : ''}.`,
      fix: 'Add funds.',
    });
  } else if (commitments && Number(commitments.remaining_usd) <= 0) {
    // A balance can read healthy while every cent is committed to intents awaiting quorum, and
    // multi-signature intents can wait weeks. `remaining_usd` is the number that decides whether
    // new work is accepted.
    checks.push({
      name: 'billing balance',
      status: 'fail',
      detail: `Nothing left to commit — ${commitments.pending_intents} pending intent(s) have claimed it.`,
      fix: 'Add funds.',
    });
  } else {
    checks.push({
      name: 'billing balance',
      status: 'ok',
      detail: `${balance.spendable_usd} spendable`
        + (commitments ? `, ${commitments.remaining_usd} left to commit` : ''),
    });
  }

  // ── 6. Is a trial about to end? ─────────────────────────────────────────────────────────────
  const credit = balance.credit;
  if (!credit || credit.kind === 'none') {
    checks.push({ name: 'credit / trial', status: 'ok', detail: 'no credit line in play' });
  } else if (credit.expired) {
    checks.push({
      name: 'credit / trial',
      status: 'fail',
      detail: `The ${credit.kind} credit has expired.`,
      fix: 'Add funds.',
    });
  } else {
    const days = credit.expires_at
      ? Math.max(0, Math.round((new Date(credit.expires_at).getTime() - Date.now()) / 86_400_000))
      : null;
    checks.push(days !== null && days <= 3
      ? {
        name: 'credit / trial',
        status: 'warn',
        detail: `${credit.label ?? credit.kind} ends in ${days} day(s).`,
        fix: 'Add funds before it lapses.',
      }
      : {
        name: 'credit / trial',
        status: 'ok',
        detail: `${credit.label ?? credit.kind}${days !== null ? `, ${days} day(s) left` : ''}`,
      });
  }

  checks.push(executionCheck(recentIntents));

  // ── Is this SDK older than the gateway it is talking to? ────────────────────────────────────
  //
  // Clients and the gateway deploy separately, so one is routinely ahead of the other — and the
  // symptoms of that are the most misleading failures on the surface. A method calling a path the
  // deployment does not serve 404s, which reads as "wrong URL" or "no such resource" until someone
  // thinks to compare versions. `ENDPOINT_NOT_ON_GATEWAY` names it once it happens; this says it
  // BEFORE, which is the point of a diagnostic.
  //
  // The error catalogue is the cheapest possible probe: public, one request, and its size is a
  // direct proxy for how far apart the two are. A gateway raising codes this SDK has never heard of
  // means its surface has moved.
  //
  // A warning, never a failure. Version skew is normal for hours at a time during a release, and an
  // SDK that refused to work would be worse than one that mentions it.
  const live = await client.admin.errors().catch(() => null);
  if (live?.errors?.length) {
    const known = new Set(VENDORED_ERROR_CODES);
    const unknown = live.errors.map((e) => e.code).filter((c) => !known.has(c));
    checks.push(unknown.length === 0
      ? {
        name: 'client matches gateway',
        status: 'ok',
        detail: `${live.errors.length} error codes, all known to this SDK`,
      }
      : {
        name: 'client matches gateway',
        status: 'warn',
        detail: `The gateway raises ${unknown.length} code(s) this SDK does not know: `
          + `${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`,
        fix: 'The gateway is ahead of this client. Upgrade @certen.io/sdk.',
      });
  }

  return { ok: checks.every((c) => c.status !== 'fail'), unreachable, checks };
}
