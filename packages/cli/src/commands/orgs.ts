import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getOutputFormat } from '../config.js';
import { printOutput, human, hint, isJsonMode } from '../output.js';

/**
 * Registration tokens — letting an organization be created without a browser.
 *
 * An org could only be born inside a portal login, so a platform could not provision its customers,
 * a CI job could not create a scratch org, and an agent could not take its first step. Everything
 * automated stopped and waited for a person.
 *
 * This does not remove the human decision, it separates it in time: an owner mints a token now, and
 * whatever holds it redeems it later, unattended. Redeeming lives on `certen signup --token`,
 * because that is the command someone reaches for when they have nothing yet.
 */

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

const machineOutput = (): boolean => isJsonMode() || getOutputFormat() === 'json';

/** `24h`, `30m`, `7d`, or a bare number of seconds. */
function parseDuration(raw: string): number | undefined {
  const m = /^(\d+)\s*([smhd])?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1);
}

export function registerOrgCommands(program: Command): void {
  const orgs = program
    .command('orgs')
    .description('Invite a new organization onto CERTEN, without a browser');

  orgs
    .command('invite', { isDefault: true })
    .description('Mint a one-time token that creates a new organization when redeemed')
    .option('--name <name>', 'Name for the organization it will create')
    .option('--scopes <list>', 'Comma-separated scopes for its first API key')
    .option('--plan <plan>', 'starter, pro or enterprise (default starter)')
    .option('--expires <duration>', 'How long it stays redeemable, e.g. 24h, 7d (default 24h)')
    .option('--note <text>', 'For your own records — who this was issued to')
    .action(async (opts: {
      name?: string; scopes?: string; plan?: string; expires?: string; note?: string;
    }) => {
      const expiresIn = opts.expires ? parseDuration(opts.expires) : undefined;
      if (opts.expires && expiresIn === undefined) {
        // Checked before the request: minting is not retry-safe, so a rejected call is cheaper
        // than a token issued with a lifetime the user did not mean.
        throw new Error(`"${opts.expires}" is not a duration. Use 30m, 24h, 7d, or seconds.`);
      }

      const minted = await (await getClient()).registrationTokens.mint({
        orgName: opts.name,
        plan: opts.plan as 'starter' | 'pro' | 'enterprise' | undefined,
        permissions: opts.scopes?.split(',').map((s) => s.trim()).filter(Boolean),
        expiresIn,
        note: opts.note,
      });

      if (machineOutput()) {
        printOutput({ ...minted });
        return;
      }

      printOutput({
        id: minted.id,
        org_name: minted.org_name,
        plan: minted.plan,
        permissions: minted.permissions,
        expires_at: minted.expires_at,
      });
      human('');
      human(`  Registration token: ${minted.token}`);
      human('  SAVE THIS NOW — it is shown once and no endpoint will return it again.');
      human('');
      human('  Whoever holds it can create ONE organization, billed from that point on:');
      human('');
      human(`    certen signup --token ${minted.token}`);
      human('');
      human(`  It stops working at ${minted.expires_at}.`);
      hint(`certen orgs revoke ${minted.id}   # if it goes to the wrong place`);
    });

  orgs
    .command('list')
    .description('Tokens this organization has minted, and what became of them')
    .action(async () => {
      const { tokens } = await (await getClient()).registrationTokens.list();
      if (machineOutput()) {
        printOutput({ tokens });
        return;
      }
      human('');
      if (tokens.length === 0) {
        human('  No registration tokens minted.');
        hint('certen orgs invite --name "Acme"');
        return;
      }
      for (const t of tokens) {
        human(`  ${t.token_prefix.padEnd(18)} ${t.state.toUpperCase()}`);
        human(`    ${t.id}${t.org_name ? `  (${t.org_name})` : ''}`);
        // What a redeemed token BECAME is the only thing worth knowing afterwards — it is the
        // link between a decision someone made and an organization now on their bill.
        if (t.redeemed_org_id) human(`    became org ${t.redeemed_org_id} at ${t.redeemed_at}`);
        else if (t.state === 'active') human(`    expires ${t.expires_at}`);
        if (t.note) human(`    note: ${t.note}`);
      }
      human('');
    });

  orgs
    .command('revoke <id>')
    .description('Stop an unredeemed token from being used')
    .action(async (id: string) => {
      const revoked = await (await getClient()).registrationTokens.revoke(id);
      printOutput({ ...revoked });
      if (machineOutput()) return;
      human('');
      human(`  ${id} can no longer be redeemed.`);
    });
}
