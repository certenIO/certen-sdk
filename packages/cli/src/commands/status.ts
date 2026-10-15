import { Command } from 'commander';
import { CertenClient, wholeUnitAmountProblem, summarizeReadiness, type Readiness } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getPortalUrl, recordedIdentities } from '../config.js';
import { printOutput, hint, isJsonMode } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { assertChain, enabledChains } from '../chains.js';
import { resolveContext, requireIdentity, requireChain, echoFromContext, sourceLabel } from '../context.js';
import { resolveCommandIdentity } from '../command-context.js';
import { matchRecorded } from '../identity-ref.js';
import { localizeReadiness, renderReadiness, signingKeyCheck, withLocalChecks } from '../readiness-render.js';

/**
 * `certen status` - is the identity and chain I am about to use able to act, and if not, what is the first thing in the way?
 *
 * `doctor` answers organization-wide questions ("some identity can sign"). Nothing answered the one a person has before sending: whether
 * THIS identity, on THIS chain, with THIS key, will actually execute. The checks that decide it were scattered - the gateway's own
 * `can_sign` (one party's word on the key page), a funding guard that refuses only on an observed zero, and a hand-written `curl` to
 * Accumulate in the docs. This is those, in one card, from `client.readiness()`; the SDK owns the judgement and this renders it.
 *
 * Which identity, chain and key comes from the context (flag > environment > profile > the only candidate), and every value taken from
 * context is said on stderr first, as everywhere else.
 *
 * Exit codes: 0 only when READY; 1 when blocked or when something could not be confirmed (the envelope says which, in `readiness.state`:
 * a check that could not be answered is never shown as ready); 3 when the gateway could not be reached.
 */

async function credential(): Promise<{ apiKey: string; missing: boolean }> {
  try {
    return { apiKey: await getApiKey(), missing: false };
  } catch {
    // A diagnosis that refused to run because the thing it diagnoses is absent would be useless. A placeholder gets the SDK as far as the
    // gateway, and the credential check is replaced below with the truth about THIS machine.
    return { apiKey: 'public', missing: true };
  }
}

/** The SDK probed with a placeholder, so its verdict on a machine with no key at all is not the one to show. */
function noCredential(r: Readiness): Readiness {
  const at = r.checks.findIndex((c) => c.name === 'credential');
  if (at < 0 || r.checks[at]!.status === 'skipped') return r;
  const checks = [...r.checks];
  checks[at] = {
    name: 'credential', status: 'fail', code: 'CREDENTIAL_REJECTED',
    detail: 'No API key is configured on this machine.',
    fix: { text: 'Sign this machine in.' },
  };
  for (let i = at + 1; i < checks.length; i++) {
    if (checks[i]!.status !== 'skipped') checks[i] = { name: checks[i]!.name, status: 'skipped', detail: 'needs a working API key' };
  }
  return { ...r, ...summarizeReadiness(checks), checks };
}

function parseGasReserve(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === 'none') return null;
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new UsageError(`--gas-reserve "${value}" must be a decimal number of whole native units (e.g. 0.0002), or "none".`, 'INVALID_AMOUNT');
  }
  return value;
}

function parseRpc(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch {
    throw new UsageError(`--accumulate-rpc "${value}" is not a URL. Give the Accumulate API endpoint, e.g. https://kermit.accumulatenetwork.io/v3`, 'INVALID_ACCUMULATE_RPC');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new UsageError(`--accumulate-rpc "${value}" must be an http(s) URL with no username or password in it.`, 'INVALID_ACCUMULATE_RPC');
  }
  return value;
}

function verdictError(r: Readiness, chain: string): CliError {
  const first = r.first_blocker;
  const down = first?.code === 'GATEWAY_UNREACHABLE';
  return new CliError(
    r.state === 'blocked'
      ? `Not ready on ${chain}: ${first?.name ?? 'a check'} failed. ${first?.detail ?? ''}`.trim()
      : `Cannot confirm readiness on ${chain}: ${first?.name ?? 'a check'} could not be ${first?.status === 'skipped' ? 'evaluated' : 'confirmed'}. ${first?.detail ?? ''}`.trim(),
    down ? 'NETWORK_ERROR' : r.state === 'blocked' ? 'NOT_READY' : 'NOT_CONFIRMED',
    down ? EXIT.UNREACHABLE : EXIT.FAILED,
    down,
    { readiness: r },
  );
}

export function registerStatusCommands(program: Command): void {
  program
    .command('status')
    .description('Is this identity ready to act on this chain? Names the first thing in the way')
    .option('--identity <ref>', 'Identity: UUID, ADI URL or name (default: your context, see `certen context`)')
    .option('--chain <chain>', 'Chain to check, e.g. base-sepolia (default: your context)')
    .option('--sign-with <key>', 'Local key the key page must hold (default: your context key, or your only key)')
    .option('--amount <amount>', 'Check there is enough gas to move this much, in whole units ("0.001" = a thousandth of an ETH)')
    .option('--token <symbol>', 'Token being moved. If it is not the chain\'s native token the amount is not counted against its gas')
    .option('--accumulate-rpc <url>', 'Accumulate API to read the key page from (default: the one the gateway advertises)')
    .option('--gas-reserve <amount>', 'Gas to hold back, in whole native units, or "none". The default is an estimate, not a quote')
    .option('--all', 'Check every identity recorded on this machine, on each chain it is linked to')
    .action(async (opts: {
      identity?: string; chain?: string; signWith?: string; amount?: string; token?: string;
      accumulateRpc?: string; gasReserve?: string; all?: boolean;
    }) => {
      // Everything checkable without the network is checked first, so a typo costs a message rather than a round trip.
      if (opts.amount !== undefined) {
        const problem = wholeUnitAmountProblem(opts.amount);
        if (problem) throw new UsageError(`--${problem}`, 'INVALID_AMOUNT');
      }
      const gasReserve = parseGasReserve(opts.gasReserve);
      const accumulateRpc = parseRpc(opts.accumulateRpc);
      const configuredChains = enabledChains();

      const { apiKey, missing } = await credential();
      const client = new CertenClient({ apiKey, baseUrl: getApiUrl() });
      const portalUrl = getPortalUrl();

      if (opts.all) {
        await runAll({ client, missing, portalUrl, opts, gasReserve, accumulateRpc, configuredChains });
        return;
      }

      // Which identity, which chain, which key: from the context. Nothing here moves value, so no default is refused for being a mainnet:
      // asking whether a mainnet account is ready is exactly what someone about to use one should do.
      const ctx = resolveContext({ identity: opts.identity, chain: opts.chain, key: opts.signWith });
      requireIdentity(ctx);
      const chainFrom = requireChain(ctx);
      const chain = assertChain(chainFrom.value, sourceLabel(chainFrom, '--chain'));

      const who = await resolveCommandIdentity(ctx, client, 'id');
      echoFromContext('chain', ctx.chain);
      echoFromContext('key', ctx.key);

      const key = signingKeyCheck({ name: ctx.key?.value, candidates: ctx.candidates.key });
      let readiness = await client.readiness({
        identityId: who.id!, chain, keyHash: key.keyHash, amount: opts.amount, tokenSymbol: opts.token,
        gasReserve, accumulateRpc, configuredChains,
      });
      if (missing) readiness = noCredential(readiness);
      readiness = withLocalChecks(readiness, [key.check]);
      readiness = { ...readiness, checks: localizeReadiness(readiness.checks, { chain, identityId: who.id!, portalUrl, keyName: ctx.key?.value }) };
      readiness = { ...readiness, ...summarizeReadiness(readiness.checks) };

      if (!isJsonMode()) renderReadiness(readiness, chain);
      if (!readiness.ready) throw verdictError(readiness, chain);
      // Machine-only: the card above is the human answer, and a table of the same facts would say everything twice.
      printOutput({ ok: true, readiness } as unknown as Record<string, unknown>, { machineOnly: true });
    });
}

interface AllArgs {
  client: CertenClient;
  missing: boolean;
  portalUrl: string;
  opts: { identity?: string; signWith?: string; amount?: string; token?: string };
  gasReserve: string | null | undefined;
  accumulateRpc: string | undefined;
  configuredChains: string[];
}

/**
 * `status --all`: every identity this machine has recorded, on every chain it is linked to.
 *
 * The organization-wide checks (gateway, credential, balance) are made once, with the first pair, and the rest run in `context` scope:
 * asking the gateway the same three questions N times would be noise. The local record does not say which key an identity was created
 * with, so the signing key is compared with only the identity the context names; the others say plainly that their key page was not
 * checked against a key, rather than being compared with one that may not be theirs.
 */
async function runAll(a: AllArgs): Promise<void> {
  const recorded = recordedIdentities();
  if (recorded.length === 0) {
    throw new UsageError('No identity is recorded on this machine, so there is nothing to check. Create one with: certen init', 'NO_IDENTITIES');
  }

  const ctx = resolveContext({ identity: a.opts.identity, key: a.opts.signWith }, { fields: ['identity', 'key'] });
  let contextId: string | undefined;
  try { contextId = ctx.identity ? matchRecorded(ctx.identity.value)[0]?.id : undefined; } catch { contextId = undefined; }
  if (!contextId && recorded.length === 1) contextId = recorded[0]!.id;
  const key = signingKeyCheck({ name: ctx.key?.value, candidates: ctx.candidates.key });
  echoFromContext('key', ctx.key);

  const pairs = recorded.flatMap((r) => (r.chains ?? []).map((chain) => ({ r, chain: assertChain(chain, 'a chain recorded for this identity') })));
  if (pairs.length === 0) {
    throw new UsageError('The identities recorded on this machine have no linked chain on record. Link one: certen identity link-chain <id> --chain <chain>', 'NO_CHAINS');
  }

  const contexts: Array<{ identity_id: string; adi_url: string; chain: string; readiness: Readiness }> = [];
  for (const [index, { r, chain }] of pairs.entries()) {
    const own = r.id === contextId;
    let readiness = await a.client.readiness({
      identityId: r.id, chain, keyHash: own ? key.keyHash : undefined, amount: a.opts.amount, tokenSymbol: a.opts.token,
      gasReserve: a.gasReserve, accumulateRpc: a.accumulateRpc, configuredChains: a.configuredChains,
      scope: index === 0 ? 'full' : 'context',
    });
    if (a.missing && index === 0) readiness = noCredential(readiness);
    // The signing key is a fact about this machine and is reported once, with the first pair (and with whichever pair it is compared on).
    if (index === 0) readiness = withLocalChecks(readiness, [key.check]);
    readiness = { ...readiness, checks: localizeReadiness(readiness.checks, { chain, identityId: r.id, portalUrl: a.portalUrl, keyName: ctx.key?.value }) };
    readiness = { ...readiness, ...summarizeReadiness(readiness.checks) };
    contexts.push({ identity_id: r.id, adi_url: r.adi_url, chain, readiness });
    if (!isJsonMode()) renderReadiness(readiness, chain, `${r.name ? `${r.name} ` : ''}${r.adi_url}`);
  }

  const allReady = contexts.every((c) => c.readiness.ready);
  if (!allReady) {
    const worst = contexts.find((c) => c.readiness.state === 'blocked') ?? contexts.find((c) => !c.readiness.ready)!;
    const err = verdictError(worst.readiness, worst.chain);
    throw new CliError(
      `${contexts.filter((c) => !c.readiness.ready).length} of ${contexts.length} context(s) are not ready. ${err.message}`,
      err.code, err.exitCode, err.retryable, { contexts },
    );
  }
  hint(`${contexts.length} context(s) checked.`);
  printOutput({ ok: true, contexts } as unknown as Record<string, unknown>, { machineOnly: true });
}
