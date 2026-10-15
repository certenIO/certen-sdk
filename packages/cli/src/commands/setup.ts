import { Command } from 'commander';
import { wholeUnitAmountProblem } from '@certen.io/sdk';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { isInteractive } from '../passphrase.js';
import { terminalPrompter } from '../prompt.js';
import { trapSigint } from '../interrupt.js';
import { parseWaitBudget, IDENTITY_WAIT, GAS_WAIT } from '../wait.js';
import { parseGasReserve, parseRpc } from '../flag-parsers.js';
import { parseSpanMs } from '../duration.js';
import { renderReadiness } from '../readiness-render.js';
import { runSetup, renderFunding, fundingJson, type SetupOutcome } from '../setup.js';
import { verdictError } from './status.js';

/**
 * `certen setup`: the whole onboarding path as one command, resumable, that exits 0 only when you can act.
 *
 * The logic is in `src/setup.ts`; this reads the command line, wires the terminal and the Ctrl-C trap in, and turns the outcome into the
 * card, the exit code and the envelope. See that file for what the steps are and why they are in this order.
 *
 * Exit codes: 0 ready · 1 blocked, or funds did not arrive (the envelope says which, with the first blocker and what to send where) ·
 * 2 usage · 3 the gateway could not be reached · 130 stopped with Ctrl-C while waiting for funds (nothing is half-done).
 *
 * `init` is unchanged and stays: it exits 0 once its own steps are done, whether or not the account can act yet. `setup` is the strict one.
 */

interface SetupFlags {
  name?: string; identity?: string; key?: string; chain?: string; chains?: string; yes?: boolean;
  existingAccount?: boolean; newAccount?: boolean; token?: string; orgName?: string;
  passphrase: boolean; keyring: boolean; browser: boolean; payer?: string;
  waitForFunds?: boolean; amount?: string; gasReserve?: string; accumulateRpc?: string;
  timeout?: string; fundsTimeout?: string; pollInterval?: string;
}

/** The `tx create` line that works today. Phase 4 replaces it with `certen send`. */
const nextCommand = (key: string): string => `certen tx create --to 0xRecipient --amount 0.0001 --sign-with ${key} --wait`;

export function registerSetupCommands(program: Command): void {
  program
    .command('setup')
    .description('Get ready to transact: key, account, identity, on-chain checks and gas, in one resumable command that exits 0 only when ready')
    .option('--name <name>', 'Name for a new identity (when one by this name is already recorded here, it is reused)')
    .option('--identity <ref>', 'Use this existing identity: UUID, ADI URL or name (never makes one)')
    .option('--key <name>', 'Local signing key to use or create (default: your context key, your only key, or "dev")')
    .option('--chain <chain>', 'Chain to set up for, e.g. base-sepolia (default: your context, or base-sepolia)')
    .option('--chains <chains>', 'Chains to link to a new identity, comma-separated; the first is the one set up (same as init)')
    .option('--yes', 'Accept every default without prompting. Never creates an account and never retires an identity')
    .option('--existing-account', 'No API key yet: sign in to an account you already have (browser)')
    .option('--new-account', 'No API key yet: create a new account with your signing key (no browser)')
    .option('--token <token>', 'No API key yet: redeem a registration token (for CI)')
    .option('--org-name <name>', 'Name for the new organization (with --new-account or --token)')
    .option('--no-passphrase', 'Store a new signing key unencrypted (otherwise set CERTEN_KEY_PASSPHRASE or be asked)')
    .option('--no-keyring', 'Store a new API key in ~/.certen/config.json instead of the OS keyring')
    .option('--no-browser', 'Do not try to open a browser during sign-in; just print the link')
    .option('--payer <address>', 'Wallet you will pay from. Deposits from it credit you automatically, with no payment intent')
    .option('--wait-for-funds', 'When gas is the only thing missing, wait for it to arrive (the default at a terminal)')
    .option('--no-wait-for-funds', 'Never wait for funds: stop and say what to send (the default when piped or with --json)')
    .option('--amount <amount>', 'The amount you mean to send first, in whole units, so the gas asked for covers it as well')
    .option('--gas-reserve <amount>', 'Gas to hold back, in whole native units, or "none". The default is an estimate, not a quote')
    .option('--accumulate-rpc <url>', 'Accumulate API to read the key page from (default: the one the gateway advertises)')
    .option('--timeout <duration>', `How long to wait for provisioning (90s, 6m, 1h; a bare number is minutes. Default ${IDENTITY_WAIT.timeoutMin}m)`)
    .option('--funds-timeout <duration>', `How long to wait for gas to arrive (default ${GAS_WAIT.timeoutMin}m)`)
    .option('--poll-interval <interval>', `How often to check while waiting (2s, 1m; a bare number is seconds. Default ${IDENTITY_WAIT.intervalSec}s for provisioning, ${GAS_WAIT.intervalSec}s for funds)`)
    .action(async (flags: SetupFlags) => {
      // Everything checkable without the network, a prompt or a key is checked first: a typo costs a message, not an identity.
      const modes = [flags.token !== undefined ? '--token' : '', flags.newAccount ? '--new-account' : '', flags.existingAccount ? '--existing-account' : ''].filter(Boolean);
      if (modes.length > 1) {
        throw new UsageError(`Pass only one of --token, --new-account and --existing-account (got ${modes.join(' and ')}).`, 'CONFLICTING_OPTIONS');
      }
      if (flags.chain !== undefined && flags.chains !== undefined) {
        throw new UsageError('Pass --chain or --chains, not both.', 'CONFLICTING_OPTIONS');
      }
      if (flags.amount !== undefined) {
        const problem = wholeUnitAmountProblem(flags.amount);
        if (problem) throw new UsageError(`--${problem}`, 'INVALID_AMOUNT');
      }
      const gasReserve = parseGasReserve(flags.gasReserve);
      const accumulateRpc = parseRpc(flags.accumulateRpc);
      const provisioning = parseWaitBudget(flags.timeout, flags.pollInterval, IDENTITY_WAIT);
      const funds = parseWaitBudget(undefined, flags.pollInterval, GAS_WAIT);
      if (flags.fundsTimeout !== undefined) funds.timeoutMs = parseSpanMs(flags.fundsTimeout, 'minutes', '--funds-timeout', 'INVALID_TIMEOUT');

      // A question is asked only of a person at a terminal, and never in --json mode (stdout is the envelope).
      const interactive = isInteractive() && !isJsonMode();
      const outcome = await runSetup({
        name: flags.name, identity: flags.identity, key: flags.key, chainsText: flags.chains ?? flags.chain, yes: flags.yes === true,
        account: flags.newAccount ? 'new' : flags.existingAccount ? 'existing' : undefined,
        token: flags.token, orgName: flags.orgName,
        noPassphrase: flags.passphrase === false, keyring: flags.keyring !== false, browser: flags.browser !== false,
        payer: flags.payer, waitForFunds: flags.waitForFunds, amount: flags.amount, gasReserve, accumulateRpc,
        provisioning, pollIntervalGiven: flags.pollInterval !== undefined, funds,
      }, {
        interactive,
        prompter: terminalPrompter(undefined, undefined, () => interactive),
        say: human,
        note: hint,
        interrupt: trapSigint,
      });

      report(outcome);
    });
}

/** Turn what happened into the card, the exit code and the envelope. */
function report(o: SetupOutcome): void {
  const details = (): Record<string, unknown> => ({
    readiness: o.readiness, steps: o.steps, context: o.context, created: o.created,
    ...(o.funding ? { funding: fundingJson(o.funding) } : {}),
  });

  if (o.state === 'interrupted') {
    throw new CliError(
      'Stopped while waiting for funds. Nothing is half-done: your key, account and identity are saved. Send the gas, then run `certen setup` again to continue.',
      'INTERRUPTED', EXIT.INTERRUPTED, false, details(),
    );
  }
  if (o.state === 'timed-out') {
    renderReadiness(o.readiness, o.chain);
    throw new CliError(
      `No gas arrived on ${o.chain} in ${Math.round((o.waited_ms ?? 0) / 60_000)} minutes. Nothing is lost: your setup is saved. `
      + 'Send the gas, then run `certen setup` again (it picks up here), or wait longer with --funds-timeout.',
      'FUNDS_WAIT_TIMEOUT', EXIT.FAILED, false, details(),
    );
  }

  renderReadiness(o.readiness, o.chain);

  if (o.state === 'blocked') {
    // The funding instructions were already printed when setup waited; when it did not, this is the first the person sees of them.
    if (o.funding) {
      renderFunding(o.funding, human);
      human('');
      hint('Send the gas, then run `certen setup` again. Or run it with --wait-for-funds and it will wait for the gas to arrive.');
    }
    hint(`Your setup is saved (identity ${o.context.adi_url}, key ${o.context.key}, chain ${o.context.chain}); running \`certen setup\` again continues from here.`);
    const base = verdictError(o.readiness, o.chain);
    throw new CliError(base.message, base.code, base.exitCode, base.retryable, details());
  }

  human(`  Saved as your default context: identity ${o.context.adi_url}, key ${o.context.key}, chain ${o.context.chain}.`);
  human('  Next:');
  human(`    ${nextCommand(o.context.key)}`);
  human('');
  // Machine-only: the card above is the human answer, and a table of the same facts would say everything twice.
  printOutput({
    ok: true, ready: true, api_url: o.apiUrl, profile: o.profile, chain: o.chain,
    context: o.context, created: o.created, readiness: o.readiness, steps: o.steps,
    next_command: nextCommand(o.context.key),
  } as unknown as Record<string, unknown>, { machineOnly: true });
}
