import type { CertenClient } from './client.js';
import { CertenError } from './errors.js';
import {
  chainAvailability, chainSlug, enablableChains, faucetForChain, readNativeBalance, describeUnverifiable, nativeSymbolFor,
  type ChainAvailability, type NativeBalanceReading,
} from './chains.js';
import { assessGas, nativeAmountOf, type GasAssessment } from './funding.js';
import { verifyKeyPageHolds, type KeyPageHold } from './key-page.js';
import type { BalanceResponse, ChainsListResponse, IdentityResponse } from './types.js';

/**
 * Is this identity, on this chain, able to act right now - and if not, what is the first thing in the way?
 *
 * Readiness used to be scattered. `doctor` answered org-wide questions ("some identity can sign", "every chain account has gas") and
 * nothing answered the one a person has when they are about to send: *the identity and chain I am about to use*. The checks that
 * decide whether an intent will execute were spread across three places that each saw a slice - the gateway's `can_sign` (one party's
 * word on the key page), the funding guard (refuses only on a zero it has observed), and a hand-written `curl` in the docs. This is
 * those, ordered by dependency, in one list a CLI card, an agent and the MCP server can all render.
 *
 * **Unknown is not OK.** A check that could not be answered is `unknown`, and the list is `ready` only when every check is `ok` or `warn`.
 * That is deliberately stricter than the submit-time funding guard, which does not block on a balance it cannot read: a guard that
 * blocked on a lagging view would refuse legitimate work, but a readiness card that said "ready" over a balance nobody read would be
 * a lie. The two are different questions and are allowed to give different answers.
 *
 * **Ordered by dependency, and a failed prerequisite skips what it gates.** Nothing below an unreachable gateway or a rejected
 * credential is meaningful, so it is reported as `skipped` rather than omitted: a list whose length depends on how far the run got is
 * one a caller cannot index into.
 *
 * **Never throws for a failed check.** Like `doctor()`, a diagnosis that cannot report a broken setup is useless. It throws only for a
 * malformed call (no identity, no chain).
 *
 * **Fixes are stated in plain words.** This module does not know it is being driven by a CLI and never names one; the CLI adds the command
 * for a check's `code`, as `doctor` does. A `fix.url` is only ever one the SDK itself knows (a chain's faucet).
 */

export type ReadinessStatus = 'ok' | 'warn' | 'fail' | 'unknown' | 'skipped';

export interface ReadinessFix {
  /** What resolves it, in words. */
  text: string;
  /** A command that performs it. Set by a CLI, never by the SDK. */
  command?: string;
  /** Somewhere to do it. */
  url?: string;
}

export interface ReadinessCheck {
  name: string;
  status: ReadinessStatus;
  detail: string;
  /** Machine-readable reason, on every check that is not `ok`. Stable: a caller may branch on it. */
  code?: string;
  /** Absent when the check passed. */
  fix?: ReadinessFix;
  /** The facts the verdict was drawn from, for a machine caller that would otherwise parse `detail`. Open: fields are only ever added. */
  data?: Record<string, unknown>;
}

export type ReadinessState = 'ready' | 'blocked' | 'unconfirmed';

export interface ReadinessContext {
  identity_id: string;
  adi_url: string | null;
  key_page_url: string | null;
  chain: string;
  /** The identity's abstract account on `chain`, once known. */
  abstract_account: string | null;
  /** The Accumulate node the independent key page read used, or null when none was made. */
  accumulate_rpc: string | null;
  key_hash: string | null;
}

export interface Readiness {
  /** True only when `state` is `ready`: every check is `ok` or `warn`. */
  ready: boolean;
  /**
   * `blocked`: something failed. `unconfirmed`: nothing failed, but something could not be answered (`unknown`) or was not evaluated
   * (`skipped`). Never `ready` over a gap.
   */
  state: ReadinessState;
  /** The first `fail`, else the first `unknown` / `skipped`; null when ready. */
  first_blocker: ReadinessCheck | null;
  /** Ordered by dependency; the same length however far the run got. */
  checks: ReadinessCheck[];
  context: ReadinessContext;
}

export interface ReadinessParams {
  /** The identity's UUID. Resolving an ADI URL or a name is the caller's job: the gateway's identity routes take a UUID. */
  identityId: string;
  /** The chain about to be used, as a slug or a numeric id. */
  chain: string;
  /**
   * SHA-256 of the signing key's raw public key, hex. Without it the key page can still be read but not compared with a key, and the check
   * says so (`warn`) instead of claiming the page holds one.
   */
  keyHash?: string;
  /** The native amount about to be moved, in whole units. Judged together with the gas reserve. */
  amount?: string;
  /** The token being moved. When it is not the chain's native token, the amount is not counted against the gas balance. */
  tokenSymbol?: string;
  /** Override the catalogue's gas reserve (whole native units); `null` for none. An estimate either way. */
  gasReserve?: string | null;
  /** The Accumulate API endpoint for the independent key page read. Default: the `accumulate.api` the gateway's chain registry advertises. */
  accumulateRpc?: string;
  /** The chains this client may use. Default: every catalogue chain that is not retired. */
  configuredChains?: readonly string[];
  /**
   * `full` (the default) also checks the gateway, the credential and the organization's balance. `context` runs only what depends on the
   * identity and chain, for a caller (such as `doctor`) that has already made the org-wide checks.
   */
  scope?: 'full' | 'context';
  /**
   * A chain registry the caller has already read (`doctor()` hands one back). The registry is a public document that changes rarely, and a caller
   * that holds it should not pay for it again. Omitted, it is read. Used only with `scope: 'context'`: a `full` run's `gateway` check is the
   * read of it, and a gateway reported reachable on the strength of an earlier read would be a claim nobody just checked.
   */
  registry?: ChainsListResponse;
  /** Injectable for tests; defaults to the platform `fetch`. Used only for the Accumulate read. */
  fetch?: typeof fetch;
  /** How long to wait for the Accumulate node (default 10s). */
  accumulateTimeoutMs?: number;
}

const NAMES = {
  gateway: 'gateway',
  credential: 'credential',
  identity: 'identity',
  chain: 'chain',
  keyPage: 'key page',
  credits: 'accumulate credits',
  balance: 'gateway balance',
  gas: 'gas',
} as const;

/** Every name `runReadiness` can emit, in the order it emits them. */
export const READINESS_CHECKS = [
  NAMES.gateway, NAMES.credential, NAMES.identity, NAMES.chain, NAMES.keyPage, NAMES.credits, NAMES.balance, NAMES.gas,
] as const;

/** The checks that depend on the identity and chain, as opposed to the organization. What `scope: 'context'` returns. */
export const CONTEXT_CHECKS = [NAMES.identity, NAMES.chain, NAMES.keyPage, NAMES.credits, NAMES.gas] as const;

const check = (
  name: string, status: ReadinessStatus, detail: string,
  extra: { code?: string; fix?: ReadinessFix; data?: Record<string, unknown> } = {},
): ReadinessCheck => ({ name, status, detail, ...extra });

const statusOf = (err: unknown): number | undefined => (err instanceof CertenError ? err.status : undefined);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message.replace(/^certen: /, '') : String(err));
const unreachable = (err: unknown): boolean => err instanceof CertenError && (err.status === 0 || err.code === 'NETWORK_ERROR');
const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return url; } };
const short = (hash: string): string => (hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash);

export async function runReadiness(client: CertenClient, params: ReadinessParams): Promise<Readiness> {
  if (!params.identityId) throw new CertenError('certen: readiness needs an identity id.', 0, 'MISSING_IDENTITY');
  if (!params.chain) throw new CertenError('certen: readiness needs a chain.', 0, 'MISSING_CHAIN');

  const scope = params.scope ?? 'full';
  const full = scope === 'full';
  const chain = chainSlug(params.chain);
  const keyHash = params.keyHash?.trim().replace(/^0x/i, '').toLowerCase() || undefined;
  const checks: ReadinessCheck[] = [];

  // Three unrelated reads, awaited together: they answer different questions and none needs another's answer. The checks are still
  // emitted in dependency order below; only the I/O overlaps.
  const [registryR, balanceR, identityR] = await Promise.allSettled([
    !full && params.registry ? Promise.resolve(params.registry) : client.chains.list(),
    full ? client.billing.balance() : Promise.resolve(null as BalanceResponse | null),
    client.identity.get(params.identityId, { include: ['balances'] }),
  ]);
  const registry: ChainsListResponse | undefined = registryR.status === 'fulfilled' ? registryR.value : undefined;

  const context: ReadinessContext = {
    identity_id: params.identityId,
    adi_url: null,
    key_page_url: null,
    chain,
    abstract_account: null,
    accumulate_rpc: null,
    key_hash: keyHash ?? null,
  };

  /** Mark every check that has not been emitted yet, from `from` on, as not evaluated. */
  const skipRest = (names: readonly string[], why: string): void => {
    for (const name of names) {
      if (!full && !(CONTEXT_CHECKS as readonly string[]).includes(name)) continue;
      checks.push(check(name, 'skipped', why));
    }
  };
  const after = (name: string): string[] => READINESS_CHECKS.slice(READINESS_CHECKS.indexOf(name as typeof READINESS_CHECKS[number]) + 1) as unknown as string[];

  // ── gateway ────────────────────────────────────────────────────────────────────────────────────────────
  if (full) {
    if (registryR.status === 'fulfilled') {
      checks.push(check(NAMES.gateway, 'ok', `registry v${registry!.version}, ${registry!.count} chains`));
    } else {
      const down = unreachable(registryR.reason);
      checks.push(check(NAMES.gateway, 'fail', messageOf(registryR.reason), {
        code: down ? 'GATEWAY_UNREACHABLE' : 'GATEWAY_ERROR',
        fix: { text: 'Check the gateway address and your network. Nothing else can be checked until this answers.' },
      }));
      skipRest(after(NAMES.gateway), 'gateway unreachable');
      return finish(checks, context);
    }

    // ── credential ─────────────────────────────────────────────────────────────────────────────────────
    // The balance read is the cheapest question that proves the gateway accepts the key. An identity read that was refused as
    // unauthenticated says the same thing, so either one counts.
    const rejected = (r: PromiseSettledResult<unknown>): boolean => r.status === 'rejected' && statusOf(r.reason) === 401;
    if (rejected(balanceR) || rejected(identityR)) {
      checks.push(check(NAMES.credential, 'fail', 'The gateway rejected this API key.', {
        code: 'CREDENTIAL_REJECTED',
        fix: { text: 'Sign in again or mint a new key; check which one is configured.' },
      }));
      skipRest(after(NAMES.credential), 'needs a working API key');
      return finish(checks, context);
    }
    if (balanceR.status === 'fulfilled') {
      checks.push(check(NAMES.credential, 'ok', 'accepted'));
    } else if (statusOf(balanceR.reason) === 403) {
      // Real, but unscoped: it can sign work and cannot read billing. The balance check says what it could not see.
      checks.push(check(NAMES.credential, 'ok', 'accepted, but this key has no billing:read scope'));
    } else {
      checks.push(check(NAMES.credential, 'unknown', `Could not confirm the key: ${messageOf(balanceR.reason)}`, {
        code: 'CREDENTIAL_UNCONFIRMED',
        fix: { text: 'Retry. If it persists, check the gateway status.' },
      }));
    }
  }

  // ── identity ───────────────────────────────────────────────────────────────────────────────────────────
  let identity: IdentityResponse | undefined;
  if (identityR.status === 'rejected') {
    const status = statusOf(identityR.reason);
    checks.push(
      status === 404
        ? check(NAMES.identity, 'fail', `The gateway has no identity ${params.identityId} in this organization.`, {
          code: 'IDENTITY_NOT_FOUND',
          fix: { text: 'Check the identity, or create one.' },
        })
        : status === 403
          ? check(NAMES.identity, 'fail', 'This API key may not read identities (it lacks identity:read).', {
            code: 'IDENTITY_FORBIDDEN',
            fix: { text: 'Use a key with the identity:read scope.' },
          })
          : status === 401
            ? check(NAMES.identity, 'fail', 'The gateway rejected this API key.', {
              code: 'CREDENTIAL_REJECTED',
              fix: { text: 'Sign in again or mint a new key.' },
            })
            : check(NAMES.identity, 'unknown', `Could not read the identity: ${messageOf(identityR.reason)}`, {
              code: 'IDENTITY_UNREADABLE',
              fix: { text: 'Retry. If it persists, check the gateway status.' },
            }),
    );
  } else {
    identity = identityR.value;
    context.adi_url = identity.adi_url ?? null;
    context.key_page_url = identity.key_page_url ?? null;
    const inFlight = ['provisioning', 'pending', 'creating'].includes(identity.status);
    if (identity.status === 'active') {
      checks.push(check(NAMES.identity, 'ok', `${identity.adi_url} is active`, { data: { status: identity.status } }));
    } else if (inFlight) {
      checks.push(check(NAMES.identity, 'fail', `${identity.adi_url} is still ${identity.status}.`, {
        code: 'IDENTITY_PROVISIONING',
        fix: { text: 'Provisioning takes about 45-90 seconds. Wait for it to finish, then check again.' },
        data: { status: identity.status },
      }));
    } else if (identity.status === 'error') {
      checks.push(check(NAMES.identity, 'fail', `${identity.adi_url} failed to provision${identity.error_message ? `: ${identity.error_message}` : '.'}`, {
        code: 'IDENTITY_PROVISIONING_FAILED',
        fix: { text: 'Retire this identity and create it again.' },
        data: { status: identity.status },
      }));
    } else {
      checks.push(check(NAMES.identity, 'fail', `${identity.adi_url} is ${identity.status}, not active.`, {
        code: 'IDENTITY_NOT_ACTIVE',
        fix: { text: 'Use an active identity, or create one.' },
        data: { status: identity.status },
      }));
    }
  }

  const identityOk = identity?.status === 'active';
  if (!identityOk) {
    skipRest(after(NAMES.identity), identity ? `identity is ${identity.status}` : 'identity not available');
    return finish(checks, context);
  }
  const ident = identity!;

  // ── chain ──────────────────────────────────────────────────────────────────────────────────────────────
  const account = (ident.chain_accounts ?? []).find((a) => chainSlug(a.chain_id) === chain);
  context.abstract_account = account?.address ?? null;
  checks.push(chainCheck(chain, registry, params.configuredChains, account));

  // ── key page (the gateway's word, and Accumulate's) ────────────────────────────────────────────────────
  const rpc = params.accumulateRpc ?? registry?.accumulate?.api;
  let hold: KeyPageHold | { state: 'not-checked'; why: string } = { state: 'not-checked', why: 'no key was given to compare' };
  if (ident.key_page_url) {
    if (keyHash && rpc) {
      context.accumulate_rpc = rpc;
      try {
        hold = await verifyKeyPageHolds(ident.key_page_url, keyHash, { rpc, fetch: params.fetch, timeoutMs: params.accumulateTimeoutMs });
      } catch (err) {
        hold = { state: 'unreadable', rpc, reason: messageOf(err), notFound: false };
      }
    } else if (keyHash) {
      hold = { state: 'unreadable', rpc: '', reason: 'the gateway advertises no Accumulate endpoint and none was given', notFound: false };
    }
  }
  checks.push(keyPageCheck(ident, keyHash, hold));

  // ── accumulate credits ─────────────────────────────────────────────────────────────────────────────────
  checks.push(creditsCheck(ident, hold));

  // ── gateway balance ────────────────────────────────────────────────────────────────────────────────────
  if (full) checks.push(balanceCheck(balanceR as PromiseSettledResult<BalanceResponse | null>));

  // ── gas ────────────────────────────────────────────────────────────────────────────────────────────────
  let rows = ident.balances;
  if (rows === undefined) {
    // A gateway that predates the balances enrichment. The portfolio carries the same numbers.
    try {
      const portfolio = await client.portfolio.get(params.identityId);
      for (const entry of portfolio.identities ?? []) {
        for (const c of entry.chains ?? []) {
          if (chainSlug(c.chain_id) === chain) rows = (c.balances ?? []).map((b) => ({ chain_id: chain, address: c.address, token: b.token, balance: b.balance }));
        }
      }
    } catch {
      rows = undefined;
    }
  }
  const onChain = (rows ?? []).filter((b) => chainSlug(b.chain_id) === chain);
  checks.push(gasCheck(chain, account?.address ?? onChain[0]?.address, readNativeBalance(chain, onChain), params));

  return finish(checks, context);
}

/**
 * The verdict a list of checks adds up to.
 *
 * Exported because a caller that adds a check of its own - the CLI adds "is there a signing key on this machine", which the SDK cannot see -
 * must get the verdict from the same rule rather than restate it.
 */
export function summarizeReadiness(checks: readonly ReadinessCheck[]): Pick<Readiness, 'ready' | 'state' | 'first_blocker'> {
  const failed = checks.filter((c) => c.status === 'fail');
  const unsettled = checks.filter((c) => c.status === 'unknown' || c.status === 'skipped');
  const state: ReadinessState = failed.length > 0 ? 'blocked' : unsettled.length > 0 ? 'unconfirmed' : 'ready';
  return { ready: state === 'ready', state, first_blocker: failed[0] ?? unsettled[0] ?? null };
}

function finish(checks: ReadinessCheck[], context: ReadinessContext): Readiness {
  return { ...summarizeReadiness(checks), checks, context };
}

function chainCheck(
  chain: string,
  registry: ChainsListResponse | undefined,
  configured: readonly string[] | undefined,
  account: { address: string; status: string } | undefined,
): ReadinessCheck {
  if (!registry) {
    return check(NAMES.chain, 'unknown', 'Could not read the gateway\'s chain registry, so whether it serves this chain is not known.', {
      code: 'CHAIN_REGISTRY_UNREADABLE', fix: { text: 'Retry. If it persists, check the gateway status.' },
    });
  }
  const availability: ChainAvailability = chainAvailability(chain, configured ?? enablableChains(), registry.chains);
  switch (availability.state) {
    case 'enabled':
      break;
    case 'unknown': {
      // Not in this client's catalogue: it can still be a chain the gateway serves (a newer one). Judge it by the registry alone, and the
      // gas check will say it cannot tell which balance pays for it.
      const entry = registry.chains.find((c) => chainSlug(c.id) === chain);
      if (entry && entry.enabled !== false) break;
      return check(NAMES.chain, 'fail', `${chain} is not a chain the gateway serves.`, {
        code: 'CHAIN_NOT_SERVED', fix: { text: 'Pick a chain the gateway serves (the chain registry lists them).' },
      });
    }
    case 'retired':
      return check(NAMES.chain, 'fail', `${chain} is retired and can no longer be used.`, { code: 'CHAIN_RETIRED', fix: { text: 'Use another chain.' } });
    case 'not-configured':
      return check(NAMES.chain, 'fail', `${chain} is not enabled in this client's configuration.`, {
        code: 'CHAIN_NOT_ENABLED', fix: { text: 'Enable it in the configured chain set, or use an enabled chain.' },
      });
    case 'unlisted':
      return check(NAMES.chain, 'fail', `The gateway does not list ${chain}.`, { code: 'CHAIN_NOT_SERVED', fix: { text: 'Use a chain the gateway serves.' } });
    case 'disabled':
      return check(NAMES.chain, 'fail', `The gateway lists ${chain} but has it switched off.`, { code: 'CHAIN_DISABLED', fix: { text: 'Use another chain, or wait until it is enabled.' } });
  }
  if (!account) {
    return check(NAMES.chain, 'fail', `${chain} is served, but this identity has no abstract account there, so it has no sender address on that chain.`, {
      code: 'CHAIN_NOT_LINKED', fix: { text: 'Link the chain to this identity.' },
    });
  }
  if (account.status === 'failed') {
    return check(NAMES.chain, 'fail', `This identity's account on ${chain} (${account.address}) failed to deploy.`, {
      code: 'CHAIN_ACCOUNT_FAILED', fix: { text: 'Unlink the chain and link it again.' },
    });
  }
  return check(NAMES.chain, 'ok', `${chain} is served and linked (abstract account ${account.address})`, { data: { chain, abstract_account: account.address, account_status: account.status } });
}

function keyPageCheck(
  ident: IdentityResponse,
  keyHash: string | undefined,
  hold: KeyPageHold | { state: 'not-checked'; why: string },
): ReadinessCheck {
  const gateway: 'yes' | 'no' | 'unknown' = ident.can_sign === true ? 'yes' : ident.can_sign === false ? 'no' : 'unknown';
  const data: Record<string, unknown> = {
    key_page_url: ident.key_page_url,
    gateway_can_sign: ident.can_sign ?? null,
    independent: hold.state === 'holds' ? 'holds' : hold.state === 'absent' ? 'absent' : hold.state === 'unreadable' ? 'unreadable' : 'not_checked',
  };
  if (!ident.key_page_url) {
    return check(NAMES.keyPage, 'fail', 'This identity has no key page on record.', {
      code: 'KEY_PAGE_MISSING', fix: { text: 'The identity did not finish provisioning. Retire it and create it again.' }, data,
    });
  }

  if (hold.state === 'holds' || hold.state === 'absent') {
    const r = hold.reading;
    Object.assign(data, { accumulate_rpc: r.rpc, keys_on_page: r.keyHashes.length, accept_threshold: r.acceptThreshold, version: r.version });
    const where = `read from Accumulate (${hostOf(r.rpc)}), not the gateway`;
    if (hold.state === 'holds') {
      if (gateway === 'no') {
        return check(NAMES.keyPage, 'fail', `Accumulate shows ${ident.key_page_url} holding your key, but the gateway says this identity cannot sign. The two disagree.`, {
          code: 'KEY_PAGE_DISAGREES',
          fix: { text: 'Do not sign yet. Check the identity with the gateway operator: one of the two reads is wrong, and this check will not choose between them.' }, data,
        });
      }
      const threshold = r.acceptThreshold && r.acceptThreshold > 1 ? `; ${r.acceptThreshold} signatures are needed, so your key alone will not execute` : '';
      return check(NAMES.keyPage, 'ok',
        `${ident.key_page_url} holds your key (${short(keyHash!)}), ${where}${gateway === 'unknown' ? ' (the gateway could not say)' : ''}${threshold}`, { data });
    }
    // absent: a fact about the page.
    return check(NAMES.keyPage, 'fail',
      `${ident.key_page_url} does not list your key (${short(keyHash!)}), ${where}. It lists ${r.keyHashes.length} other key(s).`
      + (gateway === 'yes' ? ' The gateway says this identity can sign, so it is signable by a different key than the one given.' : ''),
      {
        code: gateway === 'yes' ? 'KEY_PAGE_DISAGREES' : 'KEY_PAGE_LACKS_KEY',
        fix: { text: 'Use the key this identity was created with, or add this key to the key page.' }, data,
      });
  }

  if (hold.state === 'unreadable') {
    data.independent_error = hold.reason;
    if (gateway === 'no') {
      return check(NAMES.keyPage, 'fail', 'The gateway says this identity cannot sign: its key page does not hold the key it was created with.', {
        code: 'IDENTITY_CANNOT_SIGN', fix: { text: 'Check the identity, or create it again with this key.' }, data,
      });
    }
    return check(NAMES.keyPage, 'unknown',
      `Could not confirm from Accumulate that the key page holds your key: ${hold.reason}.`
      + (gateway === 'yes' ? ' The gateway says it can sign; that is one party\'s word.' : ' The gateway could not say either.'),
      {
        code: 'KEY_PAGE_UNCONFIRMED',
        fix: { text: hold.notFound ? 'The node has no such account: check the Accumulate endpoint, or wait for the identity to anchor.' : 'Retry, or name another Accumulate node.' },
        data,
      });
  }

  // Not checked independently: no key to compare. Say what the gateway said, and that it is only that.
  if (gateway === 'no') {
    return check(NAMES.keyPage, 'fail', 'The gateway says this identity cannot sign: its key page does not hold the key it was created with.', {
      code: 'IDENTITY_CANNOT_SIGN', fix: { text: 'Check the identity, or create it again with the right key.' }, data,
    });
  }
  return check(NAMES.keyPage, 'warn',
    `${gateway === 'yes' ? 'The gateway says this identity can sign' : 'The gateway could not say whether this identity can sign'}; not checked against Accumulate (${(hold as { why: string }).why}).`,
    { code: 'KEY_PAGE_NOT_INDEPENDENTLY_CHECKED', fix: { text: 'Give the signing key so the key page can be compared with it.' }, data });
}

function creditsCheck(ident: IdentityResponse, hold: KeyPageHold | { state: 'not-checked'; why: string }): ReadinessCheck {
  const fromAccumulate = hold.state === 'holds' || hold.state === 'absent' ? hold.reading.creditBalance : null;
  const fromGateway = typeof ident.credit_balance === 'number' && Number.isFinite(ident.credit_balance) ? ident.credit_balance : null;
  const value = fromAccumulate ?? fromGateway;
  const source = fromAccumulate !== null ? 'Accumulate' : 'the gateway';
  const data = { key_page_url: ident.key_page_url, credits: value, source: fromAccumulate !== null ? 'accumulate' : 'gateway', gateway_credits: fromGateway };
  if (value === null) {
    return check(NAMES.credits, 'unknown', 'Neither Accumulate nor the gateway reported the key page\'s credit balance.', {
      code: 'CREDITS_UNREADABLE', fix: { text: 'Retry. If it persists, read the key page on an Accumulate explorer.' }, data,
    });
  }
  if (value <= 0) {
    return check(NAMES.credits, 'fail', `The key page ${ident.key_page_url} has no credits (${source} reports ${value}), so Accumulate will refuse what it signs.`, {
      code: 'ACCUMULATE_CREDITS_EMPTY',
      fix: { text: 'Add credits to the key page. The gateway has no top-up call yet, so this is done from the Accumulate side or the portal.' }, data,
    });
  }
  // Shown exactly as reported: whether this is whole credits or hundredths of one is not pinned by the spec, so it is not converted and
  // not compared with a threshold. Zero is the only value that is certainly too low in either.
  const differs = fromAccumulate !== null && fromGateway !== null && fromAccumulate !== fromGateway;
  return check(NAMES.credits, 'ok', `${value} on the key page, as ${source} reports it${differs ? ` (the gateway reports ${fromGateway})` : ''}`, { data });
}

function balanceCheck(r: PromiseSettledResult<BalanceResponse | null>): ReadinessCheck {
  if (r.status === 'rejected') {
    const forbidden = statusOf(r.reason) === 403;
    return check(NAMES.balance, 'unknown', forbidden
      ? 'This key has no billing:read scope, so the organization\'s balance cannot be read.'
      : `Could not read the organization's balance: ${messageOf(r.reason)}`, {
      code: 'GATEWAY_BALANCE_UNREADABLE',
      fix: { text: forbidden ? 'Use a key with the billing:read scope.' : 'Retry. If it persists, check the gateway status.' },
    });
  }
  const balance = r.value!;
  const data = { spendable_usd: balance.spendable_usd, remaining_usd: balance.remaining_usd ?? null, pending_intents: balance.pending_intents ?? null, status: balance.status };
  if (balance.status !== 'active') {
    return check(NAMES.balance, 'fail', `The organization's account is ${balance.status}${balance.suspended_reason ? `: ${balance.suspended_reason}` : ''}.`, {
      code: 'GATEWAY_ACCOUNT_INACTIVE', fix: { text: 'Add funds to the organization\'s gateway balance.' }, data,
    });
  }
  // `remaining_usd` is what decides whether new work is accepted: a healthy-looking balance can be entirely committed to intents awaiting quorum.
  const left = balance.remaining_usd !== undefined ? Number(balance.remaining_usd) : Number(balance.spendable_usd);
  if (Number.isFinite(left) && left <= 0) {
    return check(NAMES.balance, 'fail',
      balance.remaining_usd !== undefined
        ? `Nothing left to commit: ${balance.pending_intents ?? 0} pending intent(s) have claimed the balance.`
        : 'The organization\'s gateway balance is empty.',
      { code: 'GATEWAY_BALANCE_EMPTY', fix: { text: 'Add funds to the organization\'s gateway balance (it pays CERTEN\'s fees).' }, data });
  }
  if (!Number.isFinite(left)) {
    return check(NAMES.balance, 'unknown', `The gateway reported a balance this client cannot read (${String(balance.remaining_usd ?? balance.spendable_usd)}).`, {
      code: 'GATEWAY_BALANCE_UNREADABLE', fix: { text: 'Retry. If it persists, check the gateway status.' }, data,
    });
  }
  return check(NAMES.balance, 'ok', `$${balance.spendable_usd} spendable${balance.remaining_usd !== undefined ? `, $${balance.remaining_usd} left to commit` : ''}`, { data });
}

function gasCheck(chain: string, address: string | undefined, reading: NativeBalanceReading, p: ReadinessParams): ReadinessCheck {
  const symbol = nativeSymbolFor(chain);
  const where = address ? `${address} on ${chain}` : chain;
  const faucet = faucetForChain(chain);
  const assessment: GasAssessment = assessGas({
    chain, reading, amount: nativeAmountOf(chain, { amount: p.amount, tokenSymbol: p.tokenSymbol }), reserve: p.gasReserve,
  });
  const base = { chain, abstract_account: address ?? null, symbol: symbol ?? null, gas_reserve_is_estimate: true };
  /** `howMuch` is "0.0011" or "0.0009 more"; null when the amount is not known and the instruction is just to fund it. */
  const fund = (howMuch: string | null, target?: string): ReadinessFix => ({
    text: `Send ${howMuch ? `at least ${howMuch}${symbol ? ` ${symbol}` : ''}` : 'gas'} to ${address ?? 'the abstract account'} on ${chain}`
      + `${target && howMuch?.endsWith('more') ? ` (to reach ${target}${symbol ? ` ${symbol}` : ''})` : ''}.`,
    ...(faucet ? { url: faucet } : {}),
  });

  switch (assessment.state) {
    case 'sufficient': {
      const data = { ...base, balance: assessment.balance, needed: assessment.needed, amount: assessment.amount, gas_reserve: assessment.reserve };
      if (!assessment.estimated) {
        return check(NAMES.gas, 'warn',
          `${where} holds ${assessment.balance} ${assessment.symbol}. There is no gas estimate for ${chain}, so only the amount (${assessment.amount}) was checked.`,
          { code: 'GAS_NOT_ESTIMATED', fix: { text: 'Check what one execution costs on this chain before moving value from it.' }, data });
      }
      return check(NAMES.gas, 'ok',
        `${where} holds ${assessment.balance} ${assessment.symbol}; `
        + (assessment.amount === '0'
          ? `about ${assessment.reserve} ${assessment.symbol} is needed for gas (an estimate)`
          : `${assessment.amount} to move + about ${assessment.reserve} for gas (an estimate) needs ${assessment.needed} ${assessment.symbol}`),
        { data });
    }
    case 'empty': {
      const data = { ...base, balance: assessment.balance, needed: assessment.needed, amount: assessment.amount, gas_reserve: assessment.reserve };
      return check(NAMES.gas, 'fail',
        `${where} holds 0 ${assessment.symbol}. A value transfer from it is accepted, signed and submitted, and then parks at "anchoring" forever.`,
        { code: 'ABSTRACT_ACCOUNT_UNFUNDED', fix: fund(assessment.needed === '0' ? null : assessment.needed), data });
    }
    case 'short': {
      const data = { ...base, balance: assessment.balance, needed: assessment.needed, amount: assessment.amount, gas_reserve: assessment.reserve, shortfall: assessment.shortfall, shortfall_kind: assessment.kind };
      return check(NAMES.gas, 'fail',
        assessment.kind === 'amount'
          ? `${where} holds ${assessment.balance} ${assessment.symbol}, less than the ${assessment.amount} ${assessment.symbol} to be moved.`
          : assessment.reserve === '0'
            ? `${where} holds ${assessment.balance} ${assessment.symbol}, which is all of the ${assessment.amount} ${assessment.symbol} to be moved: nothing would be left to pay for gas.`
            : `${where} holds ${assessment.balance} ${assessment.symbol}; moving ${assessment.amount} and paying for gas needs about ${assessment.needed} (the gas share, ${assessment.reserve}, is an estimate).`,
        { code: 'ABSTRACT_ACCOUNT_UNDERFUNDED', fix: fund(assessment.shortfall ? `${assessment.shortfall} more` : null, assessment.needed), data });
    }
    case 'unknown': {
      const r = assessment.reading;
      const why = r.state === 'no-balances'
        ? `The gateway has not reported a balance for ${where} yet (the account is not deployed or not indexed).`
        : describeUnverifiable(chain, r) ?? 'the balance could not be read';
      return check(NAMES.gas, 'unknown', `Cannot verify the gas on ${where}: ${why}. An intent from an unfunded account is accepted and then never executes.`, {
        code: 'ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE',
        fix: { text: 'Check the account\'s gas yourself before moving value from it.', ...(faucet ? { url: faucet } : {}) },
        data: { ...base, reading: r.state },
      });
    }
  }
}
