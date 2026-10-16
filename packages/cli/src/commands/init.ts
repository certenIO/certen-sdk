import { Command } from 'commander';
import { CertenClient, readNativeBalance, describeUnverifiable } from '@certen.io/sdk';
import {
  getApiKey, getApiUrl, getPortalUrl, credentialInfo, rememberIdentity, lastIdentity,
} from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { listKeys, generateKey, keyExists } from '../keystore.js';
import { resolveSigner } from '../signer.js';
import { isInteractive, resolveNewPassphrase } from '../passphrase.js';
import { assertChains, normalizeChain } from '../chains.js';
import { waitForIdentity, parseWaitBudget, IDENTITY_WAIT } from '../wait.js';
import { faucetFor } from '../funding-guard.js';
import { deviceFlowOrPaste, registerPayer } from '../credential-flow.js';
import { suggestedName } from '../prompt.js';

/**
 * `certen init` — the whole onboarding path as one command.
 *
 * Getting from `npm install` to a usable identity took eighteen steps across four surfaces. Most
 * of them were not decisions; they were bookkeeping the CLI could do itself. This does the
 * bookkeeping and asks only about the two things that are genuinely the user's call: which key,
 * and what the identity is named.
 *
 * **Idempotent by construction.** Every step checks whether it is already satisfied and skips if
 * so, using the same conditions `doctor` reports on. Re-running on a healthy setup prints the
 * state and the next command; it must never mint a second key or create a duplicate identity,
 * because both cost real quota and neither is recoverable by re-running.
 *
 * The one step it cannot yet do is mint the API key. That needs the device-code flow (Phase 5);
 * until then it prompts for one. Everything else is automatic, and when `signup` lands it drops
 * into this same slot without changing the command's interface.
 */

interface StepResult {
  step: string;
  status: 'done' | 'skipped' | 'created';
  detail: string;
}

async function askLine(prompt: string, fallback: string): Promise<string> {
  if (!isInteractive()) return fallback;
  process.stdout.write(`${prompt} [${fallback}]: `);
  const answer = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      resolve(chunk.toString('utf8').trim());
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
  return answer.length > 0 ? answer : fallback;
}

export function registerInitCommands(program: Command): void {
  program
    .command('init')
    .description('Set up everything: credential, signing key, identity — and check it works. `certen setup` also waits for gas and exits 0 only when ready')
    .option('--name <name>', 'Identity name (prompted, or generated with --yes)')
    .option('--key <name>', 'Local signing key name to use or create', 'dev')
    .option('--chains <chains>', 'Chains to link', 'base-sepolia')
    .option('--yes', 'Accept every default without prompting (for CI)')
    .option(
      '--payer <address>',
      'Wallet you will pay from. Deposits from it credit you automatically, with no payment intent.',
    )
    .option('--timeout <duration>', `How long to wait for provisioning (90s, 6m, 1h; a bare number is minutes. Default ${IDENTITY_WAIT.timeoutMin}m)`)
    .option('--poll-interval <interval>', `How often to check (2s, 1m; a bare number is seconds. Default ${IDENTITY_WAIT.intervalSec}s)`)
    .action(async (opts: {
      name?: string; key: string; chains: string; yes?: boolean; payer?: string;
      timeout?: string; pollInterval?: string;
    }) => {
      const steps: StepResult[] = [];
      const chains = assertChains(opts.chains);
      const budget = parseWaitBudget(opts.timeout, opts.pollInterval, IDENTITY_WAIT);
      const apiUrl = getApiUrl();

      const say = (message: string): void => { if (!isJsonMode()) human(message); };

      say('');
      say(`  Setting up against ${apiUrl}`);
      say('');

      // ── 1. Credential ─────────────────────────────────────────────────────────────────────────
      let apiKey: string | null = null;
      try {
        apiKey = await getApiKey();
        steps.push({ step: 'api key', status: 'skipped', detail: `${apiKey.substring(0, 12)}... already configured` });
        say(`  1. API key      already configured (${apiKey.substring(0, 12)}...)`);
      } catch {
        // No key. This is the step that still requires a human, and the only one.
        if (opts.yes || !isInteractive()) {
          throw new UsageError(
            'No API key configured, and there is no TTY to ask on. '
            + `Mint one at ${getPortalUrl()} and either set CERTEN_API_KEY or run `
            + '`certen auth login`, then run `certen init` again.',
            'NO_API_KEY',
          );
        }
        say('  1. API key      none found — authorizing this machine in the portal.');

        // The device flow, not a paste prompt. This is the step that used to send people to a
        // browser to copy a secret back by hand; running it here is the whole point of Phase 5.
        // Falls back to a hidden paste prompt only when the gateway cannot do device auth.
        // (Written once in credential-flow.ts: `setup` signs in the same way.)
        const acquired = await deviceFlowOrPaste({
          apiUrl,
          keyring: credentialInfo().storage === 'keyring',
          browser: true,
          say: (message) => say(`                  ${message}`),
        });
        apiKey = acquired.apiKey;
        steps.push({ step: 'api key', status: 'created', detail: acquired.detail });
        say(acquired.via === 'device' ? '                  authorized.' : '     saved.');
      }

      const client = new CertenClient({ apiKey, baseUrl: apiUrl });

      // ── 2. Signing key ────────────────────────────────────────────────────────────────────────
      const existing = listKeys();
      let keyName = opts.key;

      if (keyExists(keyName)) {
        steps.push({ step: 'signing key', status: 'skipped', detail: `${keyName} already exists` });
        say(`  2. Signing key  "${keyName}" already exists`);
      } else if (existing.length > 0 && !opts.yes) {
        // Reuse rather than proliferate: a machine with keys already on it usually wants one of
        // them, and quietly creating another is how people end up unsure which key owns what.
        keyName = await askLine(`  2. Signing key  use existing "${existing[0].name}" or name a new one`, existing[0].name);
        if (!keyExists(keyName)) {
          const passphrase = await resolveNewPassphrase(false);
          generateKey(keyName, passphrase);
          steps.push({ step: 'signing key', status: 'created', detail: keyName });
        } else {
          steps.push({ step: 'signing key', status: 'skipped', detail: `${keyName} already exists` });
        }
      } else {
        // `--yes` implies CI, where a passphrase prompt cannot be answered. An unencrypted key is
        // the honest option there, and the warning says so rather than hiding it.
        const passphrase = opts.yes ? null : await resolveNewPassphrase(false);
        const info = generateKey(keyName, passphrase);
        steps.push({ step: 'signing key', status: 'created', detail: keyName });
        say(`  2. Signing key  created "${keyName}"`);
        if (passphrase === null) {
          hint(`     Warning: "${keyName}" is stored UNENCRYPTED. Anyone who can read that file can sign as you.`);
        }
        void info;
      }

      // ── 3. Identity ───────────────────────────────────────────────────────────────────────────
      // An existing active identity is reused. Creating one per `init` run would burn org quota
      // every time someone re-ran the command to check their setup.
      const portfolio = await client.portfolio.get().catch(() => null);

      let identityId: string | undefined;
      let adiUrl: string | undefined;
      let accounts: Array<{ chain_id: string; address: string }> = [];

      // Reuse is keyed on what THIS machine recorded, not on what the organization happens to
      // own. An org with 39 identities from other machines and CI runs tells us nothing about
      // which one this user meant, and the portfolio cannot supply a UUID anyway — so reusing
      // from it produced a closing command with an unfillable `<id>` placeholder.
      const remembered = opts.name ? undefined : lastIdentity();
      const reusable = remembered
        // Only `can_sign`, `id` and `adi_url` are read below, none of which are enrichments.
        ? await client.identity.get(remembered.id, { include: [] }).catch(() => null)
        : null;

      if (reusable && reusable.can_sign === true) {
        identityId = reusable.id;
        adiUrl = reusable.adi_url;
        accounts = (reusable.chain_accounts ?? [])
          .filter((a) => a.address)
          .map((a) => ({ chain_id: a.chain_id, address: a.address }));
        steps.push({ step: 'identity', status: 'skipped', detail: `${adiUrl} (${identityId})` });
        say(`  3. Identity     reusing ${adiUrl}`);
      } else {
        const name = opts.name ?? (opts.yes ? suggestedName() : await askLine('  3. Identity     name', suggestedName()));
        const signer = await resolveSigner(keyName);

        say(`  3. Identity     creating "${name}" on ${chains.join(', ')}...`);
        const created = await client.identity.create({
          name,
          publicKey: signer.publicKey,
          publicKeyHash: signer.publicKeyHash,
          chains,
        });

        const id = created.id;
        if (!id) {
          throw new CliError('The gateway accepted the identity but returned no id.', 'NO_IDENTITY_ID', EXIT.FAILED);
        }

        // Waits for `can_sign`, not merely for a terminal status. An identity that provisioned but
        // cannot sign is the failure this whole command exists to avoid handing someone.
        const identity = await waitForIdentity(client, id, budget);
        identityId = identity.id;
        adiUrl = identity.adi_url;
        accounts = (identity.chain_accounts ?? [])
          .filter((a) => a.address)
          .map((a) => ({ chain_id: a.chain_id, address: a.address }));
        // Written down immediately: this is the only moment the UUID is knowable, and without a
        // record it is unrecoverable from any endpoint.
        rememberIdentity({ id: identityId, adi_url: adiUrl, chains, name });
        steps.push({ step: 'identity', status: 'created', detail: `${adiUrl} (${identityId})` });
        say(`                  ${adiUrl} is active and can sign`);
      }

      // ── 4. Funding ────────────────────────────────────────────────────────────────────────────
      const unfunded: string[] = [];
      const unverified: string[] = [];
      for (const account of accounts) {
        const chain = normalizeChain(account.chain_id);
        const balances = portfolio?.identities
          ?.flatMap((i) => i.chains ?? [])
          .find((c) => normalizeChain(c.chain_id) === chain && c.address === account.address);
        // Read by the chain's OWN native symbol from the catalogue. Matching `ETH` everywhere
        // reported a chain whose gas is something else as unfunded forever, however much it held.
        const reading = readNativeBalance(chain, balances?.balances);
        // A freshly created identity is not in the portfolio snapshot taken above, so treat an
        // unknown balance as unfunded here: a new abstract account is empty by definition, and
        // telling someone to fund it costs them nothing if it turns out to be funded already.
        if (reading.state !== 'funded') unfunded.push(chain);
        // Rows that cannot be identified or read are also named, so "needs gas" is not mistaken for
        // a reading of zero.
        const why = describeUnverifiable(chain, reading);
        if (why) unverified.push(why);
      }

      steps.push(unfunded.length === 0
        ? { step: 'funding', status: 'done', detail: 'abstract accounts have gas' }
        : {
          step: 'funding',
          status: 'done',
          detail: `needs gas on ${[...new Set(unfunded)].join(', ')}`
            + (unverified.length > 0 ? `; cannot verify gas: ${[...new Set(unverified)].join('; ')}` : ''),
        });

      // ── 4b. Where the money will come from ────────────────────────────────────────────────────
      //
      // Registering the wallet you pay from is what makes a deposit credit you ON SIGHT — no
      // payment intent, no exact-amount match, no TTL to beat. Without it every top-up is a
      // three-step dance: open an intent, send precisely that amount, wait for attribution.
      //
      // It is one API call and it was reachable only by knowing that `certen payers add` exists,
      // which nothing in the setup flow said. Folding it in here removes a step a user could only
      // take after learning it was available.
      if (opts.payer) {
        // A 409 means this address is already attributed — to this org, in which case there is
        // nothing to do, or to another, which is a genuine conflict the user must resolve. Either
        // way it must not fail the whole setup: everything above it already succeeded.
        const registered = await registerPayer(client, chains[0], opts.payer);

        steps.push(registered.ok
          ? { step: 'payer', status: 'done', detail: `${opts.payer} on ${chains[0]}` }
          : { step: 'payer', status: 'done', detail: `not registered: ${registered.why}` });
        say(registered.ok
          ? `  Deposits from ${opts.payer} will credit you automatically.`
          : `  Could not register ${opts.payer}: ${registered.why}`);
      }

      // ── 5. Balance ────────────────────────────────────────────────────────────────────────────
      const balance = await client.billing.balance().catch(() => null);
      // The balance carries `remaining_usd` now, so the separate obligations read is gone — it was
      // fetched for that one field, sequentially, on the command a new user runs first. Falls back
      // against a gateway that predates the change rather than treating `spendable_usd` as safe.
      const commitments = balance?.remaining_usd !== undefined
        ? { remaining_usd: balance.remaining_usd }
        : await client.billing.obligations().catch(() => null);
      steps.push({
        step: 'billing',
        status: 'done',
        detail: balance
          ? `${balance.spendable_usd} spendable, account ${balance.status}`
          : 'could not read the balance (no billing:read scope?)',
      });

      // ── Report ────────────────────────────────────────────────────────────────────────────────
      if (isJsonMode()) {
        printOutput({
        api_url: apiUrl,
        key_name: keyName,
        identity_id: identityId ?? null,
        adi_url: adiUrl ?? null,
        chains,
        abstract_accounts: accounts,
        unfunded_chains: [...new Set(unfunded)],
        spendable_usd: balance?.spendable_usd ?? null,
        account_status: balance?.status ?? null,
        steps,
        });
        return;
      }

      human('');
      if (accounts.length > 0) {
        human('  Abstract accounts (msg.sender on chain):');
        for (const account of accounts) {
          human(`    ${normalizeChain(account.chain_id).padEnd(18)} ${account.address}`);
        }
        human('');
      }

      if (unfunded.length > 0) {
        // Named as the remaining blocker rather than buried: an unfunded abstract account is the
        // difference between a call that executes and one that parks at `anchoring` forever.
        human('  These need testnet gas before they can execute anything:');
        for (const chain of [...new Set(unfunded)]) {
          const faucet = faucetFor(chain);
          human(`    ${chain.padEnd(18)} ${faucet ?? '(no faucet known)'}`);
        }
        for (const why of [...new Set(unverified)]) human(`    (cannot verify: ${why})`);
        human('');
      }

      if (balance && Number(commitments?.remaining_usd ?? balance.spendable_usd) <= 0) {
        human('  You have nothing left to commit to new work.');
        hint(`certen fund <amount> --chain ${chains[0]}`);
        human('');
      }

      // `init` stays exactly as it was (it exits 0 once its steps are done, ready or not), so the way on is the command that finishes the job: `setup`
      // skips everything already satisfied, saves the identity, key and chain as your defaults, and says plainly whether you can send yet. After it,
      // `send` needs only an amount, an asset and a recipient.
      human('  Done. Your next command:');
      human('');
      human('    certen setup                                   # checks the rest, saves your defaults, says when you are ready');
      human('    certen send 0.0001 ETH --to 0xRecipient        # then: preview, sign, wait, verify, receipt');
      human('');
      hint('Check everything at any time: certen status   (or certen doctor for the whole organization)');
    });
}
