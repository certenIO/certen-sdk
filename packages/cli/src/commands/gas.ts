import { Command } from 'commander';
import { CertenClient, checkGas, gasFundingPlan, wholeUnitAmountProblem, type GasFundingPlan, type ReadinessCheck } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { chainArg, uuidArg } from '../next-step.js';
import { assertChain } from '../chains.js';
import { resolveContext, requireIdentity, requireChain, echoFromContext, sourceLabel } from '../context.js';
import { resolveCommandIdentity } from '../command-context.js';
import { trapSigint } from '../interrupt.js';
import { gasGapIsFundable, parseWaitBudget, waitForGas, GAS_WAIT } from '../wait.js';
import { parseGasReserve } from '../flag-parsers.js';
import { parseSpanMs } from '../duration.js';
import { fundingJson } from '../setup.js';

/**
 * `certen gas`: the gas an abstract account needs on a chain, where to get it, and (with `--wait`) the moment it arrives.
 *
 * Two different things have been called "funding". `certen fund` tops up the ORGANIZATION's balance at the gateway, in stablecoin, and pays
 * CERTEN's fees. This is the other one: the native token (ETH, TEL) the identity's abstract account on a chain spends to execute, which
 * nothing but a faucet or a wallet can supply and for which there was no command, only a URL. An intent from an account with none is accepted,
 * signed and submitted, and then parks at `anchoring` forever.
 *
 * It signs nothing, holds no key and moves no value. `--from-wallet` prints the transfer to make from a wallet YOU control, and that is all.
 *
 * Exit codes: 0 the account has enough · 1 it does not, or it could not be read (the envelope carries the whole plan either way, so a script
 * can show the address and the link) · 3 the gateway could not be reached · 130 stopped with Ctrl-C while waiting.
 */

interface GasFlags {
  chain?: string; identity?: string; amount?: string; gasReserve?: string; wait?: boolean; fromWallet?: boolean;
  timeout?: string; pollInterval?: string;
}

/** A gas reading that could not be taken becomes the failure it is, with the exit code that tells a script what to do. */
function unreadable(check: ReadinessCheck, chain: string): CliError {
  const http = typeof check.data?.status === 'number' ? check.data.status : undefined;
  if (http === 0 || http === undefined) {
    return new CliError(`Could not read the gas balance on ${chain}: ${check.detail}`, 'NETWORK_ERROR', EXIT.UNREACHABLE, true);
  }
  if (http === 401) return new CliError('The gateway rejected this API key. Sign in again: certen login', 'CREDENTIAL_REJECTED', EXIT.FAILED);
  if (http === 404) return new CliError('The gateway has no such identity in this organization.', 'IDENTITY_NOT_FOUND', EXIT.FAILED);
  return new CliError(check.detail, check.code ?? 'GAS_UNREADABLE', EXIT.FAILED, http >= 500);
}

function describeHeld(plan: GasFundingPlan | undefined, check: ReadinessCheck): string {
  if (plan?.balance != null) return `${plan.balance} ${plan.symbol}`;
  return typeof check.data?.balance === 'string' ? `${check.data.balance} ${String(check.data.symbol ?? '')}`.trim() : 'not reported (unknown)';
}

export function registerGasCommands(program: Command): void {
  program
    .command('gas')
    .description("Gas for the identity's abstract account on a chain: where to send it, and (with --wait) when it arrives. Not `fund`, which is the gateway balance")
    .option('--chain <chain>', 'Chain to check, e.g. base-sepolia (default: your context)')
    .option('--identity <ref>', 'Identity: UUID, ADI URL or name (default: your context, see `certen context`)')
    .option('--amount <amount>', 'The amount you mean to send, in whole units, so the gas asked for covers it as well')
    .option('--gas-reserve <amount>', 'Gas to hold back, in whole native units, or "none". The default is an estimate, not a quote')
    .option('--wait', 'Wait until the gas arrives (Ctrl-C is safe; run it again to continue)')
    .option('--from-wallet', 'Print the two-step route for a faucet that refuses a contract address: a wallet you control, then the transfer from it')
    .option('--timeout <duration>', `With --wait: how long to wait (90s, 6m, 1h; a bare number is minutes. Default ${GAS_WAIT.timeoutMin}m)`)
    .option('--poll-interval <interval>', `With --wait: how often to check (2s, 1m; a bare number is seconds. Default ${GAS_WAIT.intervalSec}s)`)
    .action(async (flags: GasFlags) => {
      if (flags.amount !== undefined) {
        const problem = wholeUnitAmountProblem(flags.amount);
        if (problem) throw new UsageError(`--${problem}`, 'INVALID_AMOUNT');
      }
      const gasReserve = parseGasReserve(flags.gasReserve);
      const budget = parseWaitBudget(undefined, flags.pollInterval, GAS_WAIT);
      if (flags.timeout !== undefined) budget.timeoutMs = parseSpanMs(flags.timeout, 'minutes', '--timeout', 'INVALID_TIMEOUT');

      // Asking about gas does not move value, so no default is refused for being a mainnet: someone about to fund a mainnet account should be
      // able to ask what it needs.
      const ctx = resolveContext({ identity: flags.identity, chain: flags.chain });
      requireIdentity(ctx);
      const chainFrom = requireChain(ctx);
      const chain = assertChain(chainFrom.value, sourceLabel(chainFrom, '--chain'));

      const client = new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
      const who = await resolveCommandIdentity(ctx, client, 'id');
      echoFromContext('chain', ctx.chain);

      const params = { identityId: who.id!, chain, amount: flags.amount, gasReserve };
      let check = await checkGas(client, params);
      if (check.status === 'unknown' && check.code === 'GAS_UNREADABLE') throw unreadable(check, chain);

      const address = typeof check.data?.abstract_account === 'string' ? check.data.abstract_account : undefined;
      if (!address) {
        throw new CliError(
          `This identity has no abstract account on ${chain}, so there is nowhere to send gas. Link the chain: certen identity link-chain ${who.id} --chain ${chain}`,
          'CHAIN_NOT_LINKED', EXIT.FAILED, false, undefined,
          `certen identity link-chain ${uuidArg(who.id)} --chain ${chainArg(chain)}`,
        );
      }

      const plan = (c: ReadinessCheck): GasFundingPlan | undefined => gasFundingPlan({
        chain, address, balance: typeof c.data?.balance === 'string' ? c.data.balance : null, amount: flags.amount, reserve: gasReserve,
      });
      const funded = (c: ReadinessCheck): boolean => c.status === 'ok' || c.status === 'warn';
      let current = plan(check);

      // `funded` is the readiness check's verdict; the rest is the same plan `setup` carries (one function builds both).
      const envelope = (c: ReadinessCheck, p: GasFundingPlan | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        identity_id: who.id, abstract_account: address, funded: funded(c),
        ...(p ? fundingJson(p) : { chain }),
        check: c, ...extra,
      });

      if (!isJsonMode()) {
        human('');
        human(`  Gas on ${chain}`);
        human(`    account   ${address}${who.adi_url ? `   (abstract account of ${who.adi_url})` : ''}`);
        human(`    holds     ${describeHeld(current, check)}`);
        human(`    verdict   ${check.detail}`);
        if (!funded(check) && current) {
          human('');
          for (const line of flags.fromWallet ? current.twoStep : current.steps) human(`    ${line}`);
          if (flags.fromWallet && current.paymentUri) human(`    ${current.paymentUri}`);
        }
        human('');
      }

      if (funded(check)) {
        printOutput(envelope(check, current), { machineOnly: true });
        return;
      }

      if (!flags.wait || !gasGapIsFundable(check)) {
        if (gasGapIsFundable(check)) hint('Send the gas, then check again with: certen gas --wait   (it waits for the gas to arrive)');
        throw new CliError(
          check.detail, check.code ?? 'ABSTRACT_ACCOUNT_UNFUNDED', EXIT.FAILED, false, envelope(check, current),
          gasGapIsFundable(check) ? `certen gas --chain ${chainArg(chain)} --wait` : undefined,
        );
      }

      human('  Waiting for funds... (Ctrl-C to stop; run `certen gas --wait` again to continue)');
      let lastLine = '';
      const stop = trapSigint();
      let waited: Awaited<ReturnType<typeof waitForGas>>;
      try {
        waited = await waitForGas(client, params, budget, {
          signal: stop.signal,
          onCheck: (c) => {
            const line = `  ${address} holds ${describeHeld(plan(c), c)}`;
            if (line !== lastLine) { lastLine = line; human(line); }
          },
        });
      } finally {
        stop.dispose();
      }

      if (waited.result === 'interrupted') {
        throw new CliError('Stopped while waiting for funds. Nothing is half-done. Run `certen gas --wait` again to continue.', 'INTERRUPTED', EXIT.INTERRUPTED, false, envelope(waited.check ?? check, plan(waited.check ?? check), { interrupted: true }));
      }
      if (waited.result === 'timeout') {
        throw new CliError(
          `No gas arrived on ${chain} in ${Math.round(waited.waitedMs / 60_000)} minutes. Send it, then run \`certen gas --wait\` again (or wait longer with --timeout).`,
          'FUNDS_WAIT_TIMEOUT', EXIT.FAILED, false, envelope(waited.check, plan(waited.check), { timed_out: true }),
        );
      }
      check = waited.check;
      current = plan(check);
      human('  Funds arrived.');
      human(`  ${check.detail}`);
      printOutput(envelope(check, current, { waited: true }), { machineOnly: true });
    });
}
