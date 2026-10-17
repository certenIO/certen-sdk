import { Command } from 'commander';
import {
  CertenClient, checkGas, gasFundingPlan, wholeUnitAmountProblem, type ChainDripResponse, type GasFundingPlan, type ReadinessCheck,
} from '@certen.io/sdk';
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
import { commandPrompter } from '../prompt.js';
import { printable } from '../gateway-text.js';
import { assertCanSpend, confirmSpend, resolveIdempotencyKey, spendClient, spendFailure } from '../spend.js';

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
 * **`--drip` asks the PLATFORM to send the gas** (a testnet, once per account per cooldown, an amount the operator sets). It is the one thing here
 * that spends anything, and it spends the platform's, so it is guarded like `credits topup` (spend.ts): asked first at a terminal, refused outright
 * where nobody can answer unless `--yes` was passed, one attempt, and the Idempotency-Key is printed. It is only ever requested when the account
 * is short; a funded account is reported as funded and nothing is sent. `sent`, `skipped` and `unconfirmed` are each said as they are: an
 * unconfirmed drip may have been sent, so it is never a success on its own, and with `--wait` the wait for the gas is how it is settled. When the
 * drip is off, refused or limited, the manual steps are printed as before. Without `--drip` nothing about this command changes.
 *
 * Exit codes: 0 the account has enough · 1 it does not, or it could not be read, or the drip was declined, refused or UNCONFIRMED (the envelope
 * carries the whole plan either way, so a script can show the address and the link) · 2 `--drip` with nobody to confirm it and no `--yes` · 3 the
 * gateway could not be reached (a drip MAY have been sent: repeat with the same `--idempotency-key`) · 130 stopped with Ctrl-C while waiting.
 */

interface GasFlags {
  chain?: string; identity?: string; amount?: string; gasReserve?: string; wait?: boolean; fromWallet?: boolean;
  timeout?: string; pollInterval?: string; drip?: boolean; yes?: boolean; idempotencyKey?: string;
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

/** The same error with the plan attached, so a script gets the address and the manual steps whatever the drip said. Other errors are left alone. */
function withPlan(err: unknown, plan: Record<string, unknown>): unknown {
  if (!(err instanceof CliError)) return err;
  const failure = new CliError(err.message, err.code, err.exitCode, err.retryable, { ...plan, ...(err.details ?? {}) }, err.next);
  return Object.assign(failure, { status: (err as { status?: number }).status, requestId: (err as { requestId?: string }).requestId });
}

/** What a drip came to, in words that do not claim more than the gateway said. */
function describeDrip(r: ChainDripResponse): string[] {
  const amount = r.amount ? `${printable(r.amount, 40)} ${printable(r.symbol, 20)}`.trim() : 'an amount the gateway did not state';
  if (r.status === 'sent') {
    const lines = [`Drip sent: ${amount} to ${printable(r.address, 80)} on ${printable(r.chain, 40)} (mined; the platform paid for it).`];
    if (r.tx_hash) lines.push(`  tx        ${printable(r.tx_hash, 120)}`);
    if (r.explorer_url) lines.push(`  explorer  ${printable(r.explorer_url, 300)}`);
    return lines;
  }
  if (r.status === 'skipped') {
    return ['Drip skipped: the gateway found the account already holding enough for its own threshold, so nothing was sent.'];
  }
  return [`Drip UNCONFIRMED: the platform does not know whether it sent ${amount} to ${printable(r.address, 80)}, so it MAY have been sent.`];
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
    .option('--drip', 'Testnets: if the account is short, ask the PLATFORM to send it gas (an amount the operator sets; asks first). With --wait, then wait for it')
    .option('--idempotency-key <key>', 'With --drip: repeat an earlier attempt, using the key it printed. A repeat with the same key is never a second drip')
    .option('--yes', 'With --drip: say yes to the confirmation in advance (needed when nobody is at a terminal; --json is not an answer)')
    .action(async (flags: GasFlags) => {
      // --yes and --idempotency-key only mean something to a drip. Accepted silently they would read as having done something.
      if (!flags.drip && (flags.yes || flags.idempotencyKey !== undefined)) {
        throw new UsageError('--yes and --idempotency-key belong to --drip, the only thing here that spends anything. Add --drip, or leave them off.', 'CONFLICTING_FLAGS');
      }
      // Before the network and before anything is read: a drip with nobody to confirm it, and a key the gateway would refuse, cost a message.
      const dripKey = flags.drip ? resolveIdempotencyKey(flags.idempotencyKey) : undefined;
      const prompter = commandPrompter();
      if (flags.drip) assertCanSpend({ yes: Boolean(flags.yes), prompter, command: 'certen gas --drip', what: 'native gas for an account' });

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

      const apiKey = await getApiKey();
      const client = new CertenClient({ apiKey, baseUrl: getApiUrl() });
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

      // What a drip came to, once one was asked for: carried in every envelope after that, success or failure.
      let dripInfo: Record<string, unknown> | undefined;

      // `funded` is the readiness check's verdict; the rest is the same plan `setup` carries (one function builds both).
      const envelope = (c: ReadinessCheck, p: GasFundingPlan | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        identity_id: who.id, abstract_account: address, funded: funded(c),
        ...(p ? fundingJson(p) : { chain }),
        check: c, ...(dripInfo ? { drip: dripInfo } : {}), ...extra,
      });

      /** The manual route: what to send, from where. It is the fallback whenever a drip is not going to be the answer. */
      const printSteps = (p: GasFundingPlan | undefined): void => {
        if (!p) return;
        human('');
        for (const line of flags.fromWallet ? p.twoStep : p.steps) human(`    ${line}`);
        if (flags.fromWallet && p.paymentUri) human(`    ${p.paymentUri}`);
      };

      // With --drip the steps wait: if the drip works they are never needed, and printed first they read as "do this by hand" above a request to
      // do it for you. A gap that gas cannot fix gets no drip, so its steps (and its verdict) are shown as usual.
      const dripWanted = Boolean(flags.drip) && gasGapIsFundable(check);
      if (!isJsonMode()) {
        human('');
        human(`  Gas on ${chain}`);
        human(`    account   ${address}${who.adi_url ? `   (abstract account of ${who.adi_url})` : ''}`);
        human(`    holds     ${describeHeld(current, check)}`);
        human(`    verdict   ${check.detail}`);
        if (!funded(check) && !dripWanted) printSteps(current);
        human('');
      }

      if (funded(check)) {
        printOutput(envelope(check, current), { machineOnly: true });
        return;
      }

      if (flags.drip && !dripWanted) {
        hint('  --drip: this is a gap that gas cannot fix, so no drip was requested.');
      }

      if (dripWanted) {
        const key = dripKey!;
        const spend = spendClient(apiKey, getApiUrl());
        hint(`  Ask the platform to send gas to ${address} on ${chain}`);
        hint('    amount   the operator\'s, set at the gateway: not yours to choose, and sent only to this account');
        hint('    paid by  the platform\'s sponsor wallet (your organization is not charged). Testnets only, and once per account per cooldown.');
        hint(`    key      Idempotency-Key ${key}   (a repeat with this key can never be a second drip)`);
        hint('');
        if (!(await confirmSpend(prompter, Boolean(flags.yes), `  Request a drip to ${address}?`))) {
          dripInfo = { requested: false, declined: true };
          printSteps(current);
          throw new CliError(
            'No drip requested. Nothing was sent and nothing was charged. The manual steps are above.', 'DRIP_DECLINED', EXIT.FAILED, false,
            envelope(check, current), `certen gas --chain ${chainArg(chain)} --wait`,
          );
        }

        let dripped: ChainDripResponse;
        try {
          dripped = await spend.identity.drip(who.id!, chain, { idempotencyKey: key });
        } catch (err) {
          dripInfo = { requested: true, idempotency_key: key };
          const explained = spendFailure(err, {
            what: 'gas drip', mayHave: 'the drip may have been sent', key, chain,
            repeat: `certen gas --drip --chain ${chainArg(chain)} --identity ${uuidArg(who.id, '<id>')} --idempotency-key ${key} --yes`,
            instead: 'Fund the account by hand instead (the steps are below).',
          });
          // A refusal says what to do by hand; an unknown outcome (the gateway did not answer) may have sent it, so the steps would mislead.
          if (!(explained instanceof CliError) || explained.code !== 'NETWORK_ERROR') printSteps(current);
          throw withPlan(explained, envelope(check, current));
        }

        dripInfo = { requested: true, ...dripped, idempotency_key: key };
        const lines = describeDrip(dripped);
        human(`  ${lines[0]}`);
        for (const line of lines.slice(1)) human(`  ${line}`);
        if (typeof dripped.address === 'string' && dripped.address.toLowerCase() !== address.toLowerCase()) {
          hint(`  Note: the gateway sent it to ${printable(dripped.address, 80)}, which is not the account shown above (${address}).`);
        }
        human(`    key       ${key}   (a repeat with this key can never be a second drip)`);
        if (dripped.status !== 'sent' && dripped.note) human(`    note      ${printable(dripped.note, 300)}`);

        // An unconfirmed drip is not a success and is not hidden. With --wait the wait for the gas is how it is settled; without, it ends here.
        if (dripped.status !== 'sent' && dripped.status !== 'skipped' && !flags.wait) {
          throw new CliError(
            `The drip is UNCONFIRMED: the platform does not know whether it was sent, so gas MAY be on its way to ${address}. Do not ask again with a new key (that is a second drip). `
            + `Look for the gas: certen gas --chain ${chain} --wait. Repeating with the same key (--idempotency-key ${key}) returns this same answer.`,
            'DRIP_UNCONFIRMED', EXIT.FAILED, false, envelope(check, current), `certen gas --chain ${chainArg(chain)} --wait`,
          );
        }
        if (dripped.status !== 'sent' && dripped.status !== 'skipped') {
          human('  Waiting to see whether the gas arrives (Ctrl-C is safe).');
        }

        // Read again: the drip is only worth anything if the gas is there. The gateway may not show it at once, which is the wait's business.
        check = await checkGas(client, params);
        current = plan(check);
        if (funded(check)) {
          human('  Funds arrived.');
          human(`  ${check.detail}`);
          printOutput(envelope(check, current), { machineOnly: true });
          return;
        }
        if (!flags.wait || !gasGapIsFundable(check)) printSteps(current);
      }

      if (!flags.wait || !gasGapIsFundable(check)) {
        if (gasGapIsFundable(check)) hint('Send the gas, then check again with: certen gas --wait   (it waits for the gas to arrive)');
        // After a drip, say what became of it before saying the account is still short: "holds 0 ETH" alone would read as if nothing had been sent.
        const afterDrip = dripInfo?.status === 'sent' ? 'The drip was sent, but the account does not show the gas yet (the gateway can lag a block). '
          : dripInfo?.status === 'skipped' ? 'The gateway skipped the drip (it found enough), but the account is still short of what you asked for. ' : '';
        throw new CliError(
          `${afterDrip}${check.detail}`, check.code ?? 'ABSTRACT_ACCOUNT_UNFUNDED', EXIT.FAILED, false, envelope(check, current),
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
