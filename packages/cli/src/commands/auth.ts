import { Command } from 'commander';
import { CertenClient, CertenError, revokeOAuthToken } from '@certen.io/sdk';
import {
  readConfig, writeConfig, setApiKey, clearApiKey, DEFAULT_API_URL, getPortalUrl, getApiUrl,
} from '../config.js';
import { printOutput, human, hint, isJsonMode } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { isInteractive, promptSecret, readSecretFromStdin } from '../passphrase.js';

/**
 * Credential management.
 *
 * Two properties this file is responsible for, both of which it previously failed:
 *
 * 1. **A saved key is a key that works.** `login` used to write whatever it was handed and report
 *    success. A typo, a revoked key, or a key for a different gateway was accepted silently and
 *    surfaced as an opaque 401 at whatever command the user ran next — arbitrarily far from the
 *    mistake that caused it. It is now verified against the gateway before anything is persisted.
 *
 * 2. **Failures go through the error path.** It used to call `process.exit(1)` directly, which
 *    bypasses `emitFailure` entirely: `certen --json auth login` exited 1 with an EMPTY stdout,
 *    violating the one-envelope contract that every automated caller depends on. Nothing here
 *    calls process.exit; it throws, and the top-level handler renders it.
 */

/** Where the key came from, for the message we print afterwards. */
type KeySource = 'flag' | 'stdin' | 'prompt';

async function resolveKeyInput(flagValue: string | undefined): Promise<{ key: string; source: KeySource }> {
  // `-` is the conventional "read it from stdin" spelling, and it is the one that keeps the secret
  // out of shell history and out of `ps` output.
  if (flagValue === '-') {
    const key = await readSecretFromStdin();
    if (!key) throw new UsageError('No API key on stdin.', 'NO_API_KEY');
    return { key, source: 'stdin' };
  }

  if (flagValue) return { key: flagValue.trim(), source: 'flag' };

  if (!isInteractive()) {
    throw new UsageError(
      'No API key given and no TTY to prompt on. Pass --api-key <key>, pipe it with '
      + '`--api-key -`, or set CERTEN_API_KEY.',
      'NO_API_KEY',
    );
  }

  const key = await promptSecret('API key (input hidden): ');
  if (!key) throw new UsageError('No API key entered.', 'NO_API_KEY');
  return { key, source: 'prompt' };
}

interface VerifyResult {
  /** false only when the gateway actively rejected the credential. */
  ok: boolean;
  /** A human note when the check could not be conclusive, e.g. the key lacks billing:read. */
  note?: string;
}

/**
 * Prove the key is accepted by the gateway before it is written anywhere.
 *
 * `billing.balance` is the probe because it is cheap, read-only, and mutates nothing. The status
 * codes are read carefully rather than treated as pass/fail:
 *
 * - **401** is the only conclusive rejection — the gateway does not recognise this credential.
 * - **403** means the key is REAL and simply lacks `billing:read`. Refusing it here would reject
 *   a perfectly good scoped key, so it is accepted with a note.
 * - **Anything else** (a 5xx, a route missing on an older gateway) is inconclusive. Saying so is
 *   honest; claiming verification we did not achieve is not.
 * - **A transport failure** is rethrown untouched, so it exits 3 and the caller knows nothing was
 *   written rather than assuming the key was bad.
 */
async function verifyKey(apiKey: string, baseUrl: string): Promise<VerifyResult> {
  const client = new CertenClient({ apiKey, baseUrl });
  try {
    await client.billing.balance();
    return { ok: true };
  } catch (err) {
    if (err instanceof CertenError) {
      if (err.status === 401) return { ok: false };
      if (err.status === 403) {
        return { ok: true, note: 'Key accepted, but it has no billing:read scope — `certen balance` will not work with it.' };
      }
      // status 0 is the SDK's "never reached the gateway". That is an unreachable-gateway
      // condition, not a bad key, and it must exit 3 rather than be reported as a rejection.
      if (err.status === 0) throw err;
      return { ok: true, note: `Could not fully verify the key (gateway answered ${err.status}). Saved anyway.` };
    }
    throw err;
  }
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication management');

  auth
    .command('login')
    .description('Verify an API key and save it (OS keyring by default; --no-keyring writes ~/.certen/config.json at 0600)')
    // No longer required: omitting it prompts on a TTY, which keeps the secret out of shell
    // history. `--api-key -` reads it from stdin for scripts that want the same guarantee.
    .option('--api-key <key>', 'API key to save. Use "-" to read it from stdin; omit to be prompted')
    .option('--api-url <url>', 'API base URL')
    .option('--no-keyring', 'Store in ~/.certen/config.json instead of the OS keyring')
    .option('--no-verify', 'Skip the check that the gateway accepts this key (offline setup)')
    .action(async (opts: { apiKey?: string; apiUrl?: string; keyring: boolean; verify: boolean }) => {
      const useKeyring = opts.keyring !== false;
      const { key, source } = await resolveKeyInput(opts.apiKey);

      // The URL the key will be checked against has to be the one it will be USED against, so a
      // --api-url passed in the same invocation applies to the verification too.
      const cfg = readConfig();
      const baseUrl = opts.apiUrl ?? process.env.CERTEN_API_URL ?? cfg.api_url ?? DEFAULT_API_URL;

      let note: string | undefined;
      if (opts.verify !== false) {
        const result = await verifyKey(key, baseUrl);
        if (!result.ok) {
          // Nothing is written. The old behaviour saved first and discovered this later, which
          // left a broken credential on disk that every subsequent command tripped over.
          throw new UsageError(
            `That API key was rejected by ${baseUrl}. Nothing was saved. `
            + `Check it, or mint a new one at ${getPortalUrl()}`,
            'INVALID_API_KEY',
          );
        }
        note = result.note;
      }

      try {
        await setApiKey(key, useKeyring);
      } catch (err) {
        // Was `process.exit(1)`, which skipped the envelope entirely in --json mode.
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(`Failed to save API key: ${msg}`, 'KEY_STORAGE_FAILED', EXIT.FAILED);
      }

      if (opts.apiUrl) {
        const updated = readConfig();
        updated.api_url = opts.apiUrl;
        writeConfig(updated);
      }

      printOutput({
        storage: useKeyring ? 'keyring' : 'file',
        key_prefix: `${key.substring(0, 12)}...`,
        api_url: baseUrl,
        verified: opts.verify !== false,
      });

      human(useKeyring
        ? 'API key saved to the OS keyring.'
        : 'API key saved to ~/.certen/config.json (mode 0600).');
      if (note) hint(note);
      if (source === 'flag') {
        hint('Tip: `--api-key -` reads the key from stdin, which keeps it out of your shell history.');
      }
      hint('');
      hint('Next: certen keys generate --name dev');
    });

  auth
    .command('revoke-token [token]')
    .description('Revoke an OAuth2 access or refresh token (no API key needed)')
    .option('--refresh', 'The token is a refresh token — revoking it kills its whole chain')
    .action(async (token: string | undefined, opts: { refresh?: boolean }) => {
      // Reachable without a configured API key on purpose. This is the command someone runs when a
      // token has leaked, and requiring the credential they are trying to contain would be exactly
      // backwards. The gateway authenticates the request with the token itself.
      let value = token;
      if (!value) {
        // Read from stdin or a prompt rather than argv: a token pasted as an argument lands in
        // shell history and process listings, which is a poor place for a live credential.
        value = isInteractive()
          ? await promptSecret('Token to revoke: ')
          : await readSecretFromStdin();
      }
      if (!value) {
        throw new UsageError('No token given. Pass it as an argument, or pipe it on stdin.', 'MISSING_TOKEN');
      }

      await revokeOAuthToken(value.trim(), {
        baseUrl: getApiUrl(),
        tokenTypeHint: opts.refresh ? 'refresh_token' : 'access_token',
      });

      printOutput({ revoked: true });
      if (!isJsonMode()) {
        human('');
        human('  That token is no longer valid.');
        // Said explicitly because RFC 7009 makes success ambiguous by design, and someone
        // containing an incident deserves to know what they have and have not learned.
        human('  Revocation never reveals whether a token existed, so this succeeds either way —');
        human('  it confirms the token is not valid now, not that it was valid before.');
        if (opts.refresh) {
          human('  Its descendant access tokens were revoked with it.');
        }
      }
    });

  auth
    .command('logout')
    .description('Remove the saved API key from keyring or config file')
    .action(async () => {
      await clearApiKey();
      human('API key cleared');
    });

  auth
    .command('status')
    .description('Show LOCAL authentication config (offline — never contacts the gateway, never reveals the full key)')
    .action(() => {
      const cfg = readConfig();
      // Round-2 #43: when storage=keyring the prefix is persisted at login
      // time, so we can still display "which key is selected" without
      // round-tripping through the OS keyring. The prefix has zero
      // exfiltration risk — it's used as the public lookup field.
      let apiKey: string;
      if (process.env.CERTEN_API_KEY) {
        apiKey = `${process.env.CERTEN_API_KEY.substring(0, 12)}... (from CERTEN_API_KEY env)`;
      } else if (cfg.api_key) {
        apiKey = `${cfg.api_key.substring(0, 12)}...`;
      } else if (cfg.storage === 'keyring' && cfg.key_prefix) {
        apiKey = `${cfg.key_prefix}... (in OS keyring)`;
      } else if (cfg.storage === 'keyring') {
        apiKey = '(in OS keyring; prefix unknown — re-run `certen auth login` to record it)';
      } else {
        apiKey = '(not set)';
      }
      printOutput({
        storage: cfg.storage ?? 'file (default)',
        api_key: apiKey,
        api_url: cfg.api_url ?? `${DEFAULT_API_URL} (default)`,
        output: cfg.output ?? 'table (default)',
      });
      // This command answers "what is configured here", not "does it work". Those are different
      // questions and conflating them is how a user concludes their setup is fine while every
      // request 401s. `certen doctor` (Phase 2) answers the second one.
      hint('This is local config only. It does not check that the key still works.');
    });
}
