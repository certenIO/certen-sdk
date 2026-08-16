import { Command } from 'commander';
import { CertenClient, CertenError } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getPortalUrl, readConfig } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';

/**
 * `certen whoami` — which credential is this, against which gateway, and what standing does it
 * have.
 *
 * Distinct from `certen auth status`, which reads local config and never contacts anything. The
 * two questions are different and conflating them is how someone concludes their setup is fine
 * while every request 401s.
 *
 * **What this deliberately does NOT show: the organization name and the caller's role.** With a
 * machine API key there is no endpoint that returns either. `GET /v1/me` exists but requires a
 * Firebase ID token from the self-service portal, and nothing on the API-key surface echoes an
 * org name. Inventing a plausible-looking value, or silently omitting the fields as though they
 * were merely absent, would both be worse than saying where they live.
 */

function usd(amount: string): string {
  const [whole, frac = ''] = String(amount).split('.');
  return `$${whole}.${(frac + '00').slice(0, 2)}`;
}

export function registerWhoamiCommands(program: Command): void {
  program
    .command('whoami')
    .description('Which key, which gateway, and what standing it has (contacts the gateway)')
    .action(async () => {
      const config = readConfig();
      const apiUrl = getApiUrl();

      // Resolved rather than read from config, so the env var takes the precedence it actually has.
      const apiKey = await getApiKey();
      const source = process.env.CERTEN_API_KEY
        ? 'CERTEN_API_KEY env'
        : config.storage === 'keyring' ? 'OS keyring' : '~/.certen/config.json';

      const client = new CertenClient({ apiKey, baseUrl: apiUrl });

      // `me` is the credential asking about itself; `balance` is its standing. Each degrades
      // independently, so a key that can read one but not the other still reports what it can.
      //
      // The old third call to `admin.getUsage` is gone. It existed only to INFER whether the key
      // held `admin:read`, by seeing whether the call succeeded — and `me.scopes` now says so
      // outright. Inferring permissions by making calls and reading the refusals is a strange way
      // to answer a question the gateway can answer directly.
      const [me, balance] = await Promise.all([
        client.me().catch(() => null),
        client.billing.balance().catch((err: unknown) => (err instanceof CertenError ? err : null)),
      ]);

      const balanceOk = balance !== null && !(balance instanceof CertenError);
      const b = balanceOk ? balance : null;

      // The full structure goes to machines; humans get the rendered summary below. The table
      // renderer flattens `credit` and `usage` to raw JSON on one line, which is strictly worse
      // than the three lines that follow.
      if (isJsonMode()) {
        printOutput({
          api_url: apiUrl,
          portal_url: getPortalUrl(),
          key_prefix: `${apiKey.substring(0, 12)}...`,
          key_source: source,
          organization: me ? { id: me.org.id, name: me.org.name } : null,
          key_id: me?.key?.id ?? null,
          rate_limit_rpm: me?.key?.rate_limit_rpm ?? null,
          account_status: b?.status ?? 'unknown',
          spendable_usd: b?.spendable_usd ?? null,
          available_usd: b?.available_usd ?? null,
          held_usd: b?.held_usd ?? null,
          credit: b?.credit ?? null,
          // Granted, not observed. This used to be a guess assembled from which probe calls
          // happened to succeed, which could only ever describe the scopes it had thought to test.
          scopes: me?.scopes ?? null,
        });
        return;
      }

      human('');
      human(`  Key      ${apiKey.substring(0, 12)}...  (${source})`);
      human(`  Gateway  ${apiUrl}`);

      if (b) {
        human(`  Account  ${b.status}`);
        human(`  Spendable ${usd(b.spendable_usd)}`);
        if (b.credit && b.credit.kind !== 'none') {
          if (b.credit.expired) {
            human(`  Credit   ${b.credit.kind} — EXPIRED`);
          } else if (b.credit.expires_at) {
            const days = Math.max(0, Math.round((new Date(b.credit.expires_at).getTime() - Date.now()) / 86_400_000));
            human(`  Credit   ${b.credit.label ?? b.credit.kind} — ends in ${days} day(s)`);
          }
        }
      } else if (balance instanceof CertenError && balance.status === 403) {
        human('  Account  (this key has no billing:read scope)');
      } else {
        human('  Account  (could not read)');
      }

      human('');
      human('  Organization name, your role, and team management are not available to an API key.');
      human('  Inviting a teammate needs a signed-in portal session — deliberately, since a leaked');
      human('  machine key must not be able to add people to your organization.');
      human(`  ${getPortalUrl()}`);

      hint('');
      hint('Check the whole setup end to end: certen doctor');
    });
}
