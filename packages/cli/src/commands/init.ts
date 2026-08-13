import { Command } from 'commander';
import { CertenClient, CertenError } from '@certen.io/sdk';
import {
  getApiKey, getApiUrl, getPortalUrl, setApiKey, readConfig, rememberIdentity, lastIdentity,
} from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { listKeys, generateKey, keyExists } from '../keystore.js';
import { resolveSigner } from '../signer.js';
import { isInteractive, promptSecret, readSecretFromStdin, resolveNewPassphrase } from '../passphrase.js';
import { assertChains, SUPPORTED_CHAINS, normalizeChain } from '../chains.js';
import { waitForIdentity, parseWaitBudget, IDENTITY_WAIT } from '../wait.js';
import { faucetFor } from '../funding-guard.js';
import { runDeviceFlow } from './signup.js';

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

/** A default identity name that is valid (3-63 chars) and unlikely to collide on a retry. */
function suggestedName(): string {
  return `bot-${Math.floor(Date.now() / 1000) % 1_000_000}`;
}

export function registerInitCommands(program: Command): void {
  program
    .command('init')
    .description('Set up everything: credential, signing key, identity — and check it works')
    .option('--name <name>', 'Identity name (prompted, or generated with --yes)')
    .option('--key <name>', 'Local signing key name to use or create', 'dev')
    .option('--chains <chains>', 'Chains to link', 'base-sepolia')
    .option('--yes', 'Accept every default without prompting (for CI)')
    .option('--timeout <minutes>', `How long to wait for provisioning (default ${IDENTITY_WAIT.timeoutMin})`)
    .option('--poll-interval <seconds>', `How often to check (default ${IDENTITY_WAIT.intervalSec})`)
    .action(async (opts: {
      name?: string; key: string; chains: string; yes?: boolean;
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
        try {
          const granted = await runDeviceFlow({ browser: true, keyring: readConfig().storage === 'keyring' });
          apiKey = await getApiKey();
          steps.push({ step: 'api key', status: 'created', detail: `${granted.prefix}... authorized` });
          say('                  authorized.');
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== 'DEVICE_FLOW_UNSUPPORTED' && code !== 'SELF_SERVICE_DISABLED') throw err;

          say(`                  this gateway cannot authorize devices. Mint a key at ${getPortalUrl()}`);
          const entered = process.stdin.isTTY
            ? await promptSecret('     Paste your API key (hidden): ')
            : await readSecretFromStdin();
          if (!entered) throw new UsageError('No API key entered.', 'NO_API_KEY');

          // Verified before it is stored, exactly as `auth login` does — a key that does not work
          // must not be written and then tripped over by every step below.
          const probe = new CertenClient({ apiKey: entered, baseUrl: apiUrl });
          try {
            await probe.billing.balance();
          } catch (probeErr) {
            if (probeErr instanceof CertenError && probeErr.status === 401) {
              throw new UsageError(
                `That API key was rejected by ${apiUrl}. Nothing was saved.`,
                'INVALID_API_KEY',
              );
            }
            if (probeErr instanceof CertenError && probeErr.status === 0) throw probeErr;
            // 403 and other statuses mean the credential is real; carry on.
          }
          await setApiKey(entered, readConfig().storage === 'keyring');
          apiKey = entered;
          steps.push({ step: 'api key', status: 'created', detail: `${entered.substring(0, 12)}... saved` });
          say('     saved.');
        }
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
        ? await client.identity.get(remembered.id).catch(() => null)
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
        rememberIdentity({ id: identityId, adi_url: adiUrl, chains });
        steps.push({ step: 'identity', status: 'created', detail: `${adiUrl} (${identityId})` });
        say(`                  ${adiUrl} is active and can sign`);
      }

      // ── 4. Funding ────────────────────────────────────────────────────────────────────────────
      const unfunded: string[] = [];
      for (const account of accounts) {
        const chain = normalizeChain(account.chain_id);
        const balances = portfolio?.identities
          ?.flatMap((i) => i.chains ?? [])
          .find((c) => normalizeChain(c.chain_id) === chain && c.address === account.address);
        const native = (balances?.balances ?? [])
          .find((b) => !b.token || b.token === 'ETH' || b.token === 'native');
        // A freshly created identity is not in the portfolio snapshot taken above, so treat an
        // unknown balance as unfunded here: a new abstract account is empty by definition, and
        // telling someone to fund it costs them nothing if it turns out to be funded already.
        if (!native || Number(native.balance) === 0) unfunded.push(chain);
      }

      steps.push(unfunded.length === 0
        ? { step: 'funding', status: 'done', detail: 'abstract accounts have gas' }
        : { step: 'funding', status: 'done', detail: `needs gas on ${[...new Set(unfunded)].join(', ')}` });

      // ── 5. Balance ────────────────────────────────────────────────────────────────────────────
      const balance = await client.billing.balance().catch(() => null);
      const obligations = await client.billing.obligations().catch(() => null);
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
        human('');
      }

      if (balance && Number(obligations?.remaining_usd ?? balance.spendable_usd) <= 0) {
        human('  You have nothing left to commit to new work.');
        hint(`certen fund <amount> --chain ${chains[0]}`);
        human('');
      }

      human('  Done. Your next command:');
      human('');
      human(identityId
        ? `    certen call --identity ${identityId} --chain ${chains[0]} \\`
        : '    certen call --identity <id> --chain ' + chains[0] + ' \\');
      human(`        --to 0xYourContract --fn 'confirm(bytes32)' --arg 0x${'00'.repeat(32)} \\`);
      human(`        --sign-with ${keyName} --wait`);
      human('');
      hint('Check everything at any time: certen doctor');
    });
}
