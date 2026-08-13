import type { CertenClient } from './client.js';
import { CertenError } from './errors.js';

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

/** Checks that cannot run without a working credential, in the order they are reported. */
const CREDENTIALLED = [
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
 * `GET /v1/portfolio` returns `chain_id` as a slug on some chain accounts and as a numeric EVM id
 * on others, in the same response. Anything that compares or de-duplicates on that field must
 * normalize first, or it reports one chain twice and finds no faucet for the numeric copy.
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
async function executionCheck(client: CertenClient): Promise<DoctorCheck> {
  const list = await client.transaction.list({ limit: 25 }).catch(() => null);
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

  // ── 2. Does the gateway accept this credential? ─────────────────────────────────────────────
  let credentialOk = false;
  if (unreachable) {
    checks.push({ name: 'api key', status: 'skipped', detail: 'gateway unreachable' });
  } else {
    try {
      await client.billing.balance();
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
    for (const name of CREDENTIALLED) {
      checks.push({ name, status: 'skipped', detail: 'needs a working API key' });
    }
    return { ok: checks.every((c) => c.status !== 'fail'), unreachable, checks };
  }

  // ── 3-4. Identities, and whether their abstract accounts can execute ────────────────────────
  const portfolio = await client.portfolio.get().catch(() => null);

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
  const [balance, obligations] = await Promise.all([
    client.billing.balance().catch(() => null),
    client.billing.obligations().catch(() => null),
  ]);

  if (!balance) {
    checks.push({ name: 'billing balance', status: 'skipped', detail: 'balance unavailable' });
    checks.push({ name: 'credit / trial', status: 'skipped', detail: 'balance unavailable' });
    checks.push(await executionCheck(client));
    return { ok: checks.every((c) => c.status !== 'fail'), unreachable, checks };
  }

  if (balance.status !== 'active') {
    checks.push({
      name: 'billing balance',
      status: 'fail',
      detail: `Account is ${balance.status}${balance.suspended_reason ? `: ${balance.suspended_reason}` : ''}.`,
      fix: 'Add funds.',
    });
  } else if (obligations && Number(obligations.remaining_usd) <= 0) {
    // A balance can read healthy while every cent is committed to intents awaiting quorum, and
    // multi-signature intents can wait weeks. `remaining_usd` is the number that decides whether
    // new work is accepted.
    checks.push({
      name: 'billing balance',
      status: 'fail',
      detail: `Nothing left to commit — ${obligations.pending_intents} pending intent(s) have claimed it.`,
      fix: 'Add funds.',
    });
  } else {
    checks.push({
      name: 'billing balance',
      status: 'ok',
      detail: `${balance.spendable_usd} spendable`
        + (obligations ? `, ${obligations.remaining_usd} left to commit` : ''),
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

  checks.push(await executionCheck(client));

  return { ok: checks.every((c) => c.status !== 'fail'), unreachable, checks };
}
