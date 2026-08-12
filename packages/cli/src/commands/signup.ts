import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
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
 * ── Why this talks HTTP directly instead of going through the SDK ───────────────────────────────
 *
 * `spec/openapi.json` is vendored from the DEPLOYED gateway, and `agentgen` fails if the SDK calls
 * an endpoint the vendored spec does not contain — a gate that exists to catch a wrong path or a
 * stale spec. These endpoints exist in the gateway source but are not deployed yet, so an SDK
 * resource for them would break that gate for everyone until a release happens.
 *
 * The correct sequence is: gateway ships → `npm run spec:refresh` → SDK resource → this file
 * becomes a thin wrapper. Until then, two `fetch` calls here keep the gate honest rather than
 * working around it.
 */

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface DevicePoll {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'claimed';
  api_key?: string;
  key_prefix?: string;
  org_id?: string;
  permissions?: string[];
  note?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** A name the approver will recognise on the portal screen. */
function deviceName(): string {
  try {
    return `certen-cli@${userInfo().username}-${hostname()}`.slice(0, 120);
  } catch {
    return 'certen-cli';
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Nothing was submitted, so this is exit 3 and a retry is safe.
    throw new CliError(
      `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      'NETWORK_ERROR', EXIT.UNREACHABLE, true,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 403) {
      throw new CliError(
        'This gateway does not have self-service onboarding enabled, so it cannot authorize a '
        + `device. Mint a key in the portal instead: ${getPortalUrl()}`,
        'SELF_SERVICE_DISABLED', EXIT.FAILED,
      );
    }
    if (response.status === 404) {
      // Precise, because the alternative diagnosis — "my code is wrong" — sends someone in the
      // wrong direction entirely.
      throw new CliError(
        `This gateway does not support device authorization (${url} returned 404). It is probably `
        + `running a build from before the feature shipped. Mint a key at ${getPortalUrl()}`,
        'DEVICE_FLOW_UNSUPPORTED', EXIT.FAILED,
      );
    }
    throw new CliError(
      `${url} returned ${response.status}: ${text.slice(0, 200)}`,
      'DEVICE_FLOW_FAILED', EXIT.FAILED, response.status >= 500,
    );
  }
  return JSON.parse(text) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new CliError(
      `${url} returned ${response.status}: ${text.slice(0, 200)}`,
      'DEVICE_FLOW_FAILED', EXIT.FAILED, response.status >= 500,
    );
  }
  return JSON.parse(text) as T;
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

  const start = await postJson<DeviceStart>(`${apiUrl}/v1/portal/device`, {
    device_name: deviceName(),
  });

  if (!isJsonMode()) {
    human('');
    human(`  Your code:  ${start.user_code}`);
    human('');
    human(`  Open ${start.verification_uri} and enter it.`);
    human('');
    human('  Nothing is granted until you approve it there. Ctrl-C is safe.');
    human('');
  }

  if (opts.browser) openBrowser(start.verification_uri_complete ?? start.verification_uri);

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

    const poll = await getJson<DevicePoll>(
      `${apiUrl}/v1/portal/device/${encodeURIComponent(start.device_code)}`,
    );

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
