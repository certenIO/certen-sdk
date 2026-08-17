import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { CertenClient, CertenError, type DeviceAuthorization, type DeviceAuthorizationStatus } from '@certen.io/sdk';
import { getApiUrl, getPortalUrl, setApiKey, readConfig } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';

/**
 * `certen signup` / `certen login` — obtain an API key without copying a secret.
 *
 * This closes the last step of onboarding that required leaving the terminal. Before it, the
 * first credential could only be minted in a browser and carried back by hand: sign in, click
 * create, select the key, copy it, paste it into `certen auth login`. Four steps in another
 * application, and a long-lived secret through the clipboard and usually into shell history.
 *
 * This is the OAuth 2.0 device authorization grant (RFC 8628). The CLI asks the gateway for a
 * code, the human approves it in a portal session they already trust, and the CLI collects the
 * key over its own channel. **The key is never displayed and never pasted.**
 *
 * Approval and denial are not driven from here. They need a Firebase portal session, and the
 * gateway refuses an approval carrying `X-API-Key` — so a machine key cannot escalate itself into
 * minting more keys, and this command must not imply that it could.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** A name the approver will recognise on the portal screen. */
function deviceName(): string {
  try {
    return `certen-cli@${userInfo().username}-${hostname()}`.slice(0, 120);
  } catch {
    return 'certen-cli';
  }
}

/**
 * Translate an SDK error into a CLI failure that names the cause.
 *
 * The two statuses worth distinguishing are the ones a user could otherwise misdiagnose: a 404
 * means this gateway predates the feature, not that the code was mistyped, and a 403 means
 * self-service is switched off rather than that anything was refused.
 */
function translate(err: unknown, url: string): never {
  if (err instanceof CertenError) {
    if (err.status === 0) {
      // Nothing was submitted, so exit 3 and a retry is safe.
      throw new CliError(`Could not reach ${url}: ${err.message}`, 'NETWORK_ERROR', EXIT.UNREACHABLE, true);
    }
    if (err.status === 403) {
      throw new CliError(
        'This gateway does not have self-service onboarding enabled, so it cannot authorize a '
        + `device. Mint a key in the portal instead: ${getPortalUrl()}`,
        'SELF_SERVICE_DISABLED', EXIT.FAILED,
      );
    }
    if (err.status === 404) {
      throw new CliError(
        'This gateway does not support device authorization. It is probably running a build from '
        + `before the feature shipped. Mint a key at ${getPortalUrl()}`,
        'DEVICE_FLOW_UNSUPPORTED', EXIT.FAILED,
      );
    }
    throw new CliError(
      `${url} returned ${err.status}: ${err.message}`,
      'DEVICE_FLOW_FAILED', EXIT.FAILED, err.isRetryable,
    );
  }
  throw err;
}

/** Best effort. A browser that will not open is an inconvenience, never a failure. */
function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Ignored: the URL is printed either way, and it is the printed one people actually use.
  }
}

/**
 * The device flow, exported so `certen init` can run it as its credential step rather than
 * telling the user to go and run another command first. One flow, two entry points.
 */
export async function runDeviceFlow(opts: {
  browser: boolean;
  keyring: boolean;
  timeoutMs?: number;
}): Promise<{ prefix: string; orgId?: string }> {
  const apiUrl = getApiUrl().replace(/\/+$/, '');
  // These two calls are public; the key field is required by the constructor and unused by them.
  const client = new CertenClient({ apiKey: 'device-flow', baseUrl: apiUrl });

  const start: DeviceAuthorization = await client.device
    .start({ deviceName: deviceName() })
    .catch((err: unknown) => translate(err, `${apiUrl}/v1/portal/device`));

  // RFC 8628 defines `verification_uri_complete` precisely so the code never has to be typed, and
  // the gateway sends one. It was being handed to the browser and withheld from the terminal — so
  // anyone the browser could not serve, which is every SSH session, container, WSL shell and CI
  // job, got the bare URL and a code to retype. Those are the users with the most friction and the
  // least patience for it, and `openBrowser` says as much three lines up: "it is the printed one
  // people actually use."
  const approvalUrl = start.verification_uri_complete ?? start.verification_uri;
  const carriesCode = Boolean(start.verification_uri_complete);

  if (!isJsonMode()) {
    human('');
    human(`  Your code:  ${start.user_code}`);
    human('');
    if (carriesCode) {
      // The code is still shown above: it is what appears on the approval screen, and checking that
      // the two match is how someone confirms they are approving THIS terminal and not another.
      human('  Approve it here — the link carries the code:');
      human(`  ${approvalUrl}`);
    } else {
      human(`  Open ${start.verification_uri} and enter it.`);
    }
    human('');
    if (opts.browser) human('  Opening your browser. If nothing happens, use the link above.');
    human('  Nothing is granted until you approve it there. Ctrl-C is safe.');
    human('');
  }

  if (opts.browser) openBrowser(approvalUrl);

  const intervalMs = Math.max(1, start.interval || 5) * 1000;
  const deadline = Date.now() + (opts.timeoutMs ?? (start.expires_in || 600) * 1000);
  let announced = false;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new CliError(
        `The code ${start.user_code} expired before it was approved. Nothing was created. `
        + 'Run the command again for a fresh one.',
        'DEVICE_CODE_EXPIRED', EXIT.FAILED,
      );
    }

    await sleep(intervalMs);

    const poll: DeviceAuthorizationStatus = await client.device
      .poll(start.device_code)
      .catch((err: unknown) => translate(err, `${apiUrl}/v1/portal/device`));

    if (poll.status === 'pending') {
      if (!announced && !isJsonMode()) {
        human('  Waiting for approval...');
        announced = true;
      }
      continue;
    }

    if (poll.status === 'denied') {
      throw new CliError(
        'That request was denied in the portal. No key was created.',
        'DEVICE_CODE_DENIED', EXIT.FAILED,
      );
    }

    if (poll.status === 'expired') {
      throw new CliError(
        `The code ${start.user_code} expired. Nothing was created. Run the command again.`,
        'DEVICE_CODE_EXPIRED', EXIT.FAILED,
      );
    }

    if (poll.status === 'claimed') {
      // Someone else collected the key with this code. Alarming rather than reassuring, and worth
      // saying so plainly.
      throw new CliError(
        'This code has already been used to collect a key — but not by this command. '
        + `If that was not you, revoke it now: ${getPortalUrl()}`,
        'DEVICE_CODE_ALREADY_CLAIMED', EXIT.FAILED,
      );
    }

    if (poll.status === 'approved' && poll.api_key) {
      await setApiKey(poll.api_key, opts.keyring);
      return { prefix: poll.key_prefix ?? poll.api_key.substring(0, 12), orgId: poll.org_id };
    }

    // Approved with no key is not a state the gateway should produce; treating it as success
    // would store `undefined` as a credential.
    throw new CliError(
      'The gateway approved the device but returned no key.',
      'DEVICE_FLOW_FAILED', EXIT.FAILED,
    );
  }
}

export function registerSignupCommands(program: Command): void {
  const attach = (name: string, description: string): void => {
    program
      .command(name)
      .description(description)
      .option('--no-browser', 'Do not try to open a browser; just print the URL')
      .option('--no-keyring', 'Store the key in ~/.certen/config.json instead of the OS keyring')
      .option('--timeout <minutes>', 'How long to wait for approval')
      .action(async (opts: { browser: boolean; keyring: boolean; timeout?: string }) => {
        const existing = readConfig();
        if (process.env.CERTEN_API_KEY) {
          // The env var wins over stored config everywhere else, so a key obtained here would be
          // written and then ignored — a confusing no-op rather than an error.
          throw new UsageError(
            'CERTEN_API_KEY is set, and it takes precedence over any key saved here. '
            + 'Unset it first if you want to replace it.',
            'API_KEY_ENV_SET',
          );
        }

        let timeoutMs: number | undefined;
        if (opts.timeout !== undefined) {
          const minutes = Number(opts.timeout);
          if (!Number.isFinite(minutes) || minutes <= 0) {
            throw new UsageError('--timeout must be a positive number of minutes', 'INVALID_TIMEOUT');
          }
          timeoutMs = minutes * 60_000;
        }

        const result = await runDeviceFlow({
          browser: opts.browser !== false,
          // Match however this machine already stores credentials, rather than silently moving
          // them between the keyring and a file.
          keyring: opts.keyring !== false && existing.storage === 'keyring',
          timeoutMs,
        });

        printOutput({
          key_prefix: `${result.prefix}...`,
          org_id: result.orgId ?? null,
          api_url: getApiUrl(),
          storage: readConfig().storage ?? 'file',
        });

        if (isJsonMode()) return;
        human('');
        human('  Authorized. The key was written straight to this machine — it was never displayed.');
        human('');
        hint('Next: certen init');
      });
  };

  // Two names for one flow. "Sign up" and "log in" are the same act to the gateway — a Firebase
  // session either exists or gets created — and making the user pick correctly before they know
  // which they are would be a decision with no consequence.
  attach('login', 'Get an API key for this machine by approving it in the portal');
  attach('signup', 'Create an account and get an API key for this machine (same as login)');
}
