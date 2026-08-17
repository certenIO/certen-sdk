import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getOutputFormat } from '../config.js';
import { printOutput, human, hint, isJsonMode } from '../output.js';

/**
 * OAuth2 clients — the credential a service of yours uses to authenticate.
 *
 * `certen auth revoke-token` could kill a token and `fetchOAuthToken` could mint one, but the
 * client both of those depend on existed only if a human opened the portal and made it. So a
 * deployment could not provision its own credential, which is the point at which "automated" stops
 * being true.
 *
 * `rotate-secret` is the command that earns this group: it is the only way to change a credential
 * without an outage, and the grace window is what makes that possible.
 */

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

const machineOutput = (): boolean => isJsonMode() || getOutputFormat() === 'json';

/**
 * A secret is shown once, so the warning is not optional and not a footnote.
 *
 * Deliberately not routed through the table renderer: a secret that lands in a column ends up in
 * scrollback and CI logs, where it long outlives the moment it was needed.
 */
function announceSecret(secret: string, what: string): void {
  human('');
  human(`  ${what}: ${secret}`);
  human('  SAVE THIS NOW — it is shown once and no endpoint will return it again.');
}

export function registerOAuthClientCommands(program: Command): void {
  const clients = program
    .command('oauth-clients')
    .description('OAuth2 clients your services authenticate as');

  clients
    .command('list', { isDefault: true })
    .description('Clients this organization owns')
    .action(async () => {
      const { clients: rows } = await (await getClient()).oauthClients.list();
      if (machineOutput()) {
        printOutput({ clients: rows });
        return;
      }
      human('');
      if (rows.length === 0) {
        human('  No OAuth clients — nothing can authenticate with client credentials yet.');
        hint('certen oauth-clients create --scopes proof:read');
        return;
      }
      for (const c of rows) {
        human(`  ${c.client_id}`);
        // `is_active` decides whether any token can be minted at all, so it sits with the id
        // rather than behind a second lookup.
        human(`    ${c.id}  (${c.is_active ? 'active' : 'DEACTIVATED'})`);
        human(`    scopes: ${c.scopes?.length ? c.scopes.join(', ') : 'none — its tokens can do nothing'}`);
        if (c.last_rotated_at) human(`    secret last rotated: ${c.last_rotated_at}`);
      }
      human('');
    });

  clients
    .command('create')
    .description('Create a client and receive its credentials once')
    .requiredOption('--scopes <list>', 'Comma-separated scopes its tokens may use')
    .option('--org <id>', 'Place the client in another organization (operators only)')
    .action(async (opts: { scopes: string; org?: string }) => {
      const scopes = opts.scopes.split(',').map((s) => s.trim()).filter(Boolean);
      const created = await (await getClient()).oauthClients.create({
        scopes,
        orgId: opts.org,
      });

      if (machineOutput()) {
        printOutput({ ...created });
        return;
      }
      printOutput({ client_id: created.client_id, org_id: created.org_id, scopes: created.scopes });
      announceSecret(created.client_secret, 'Client secret');
      human('');
      human('  A token minted by this client can do exactly what the client may do, so these');
      human(`  scopes are the ceiling: ${scopes.join(', ')}`);
      hint('certen oauth-clients rotate-secret <id>   # change it later without an outage');
    });

  clients
    .command('rotate-secret <id>')
    .description('Issue a new secret, optionally keeping the old one alive while you deploy')
    .option(
      '--grace <seconds>',
      'How long the previous secret keeps working. Default 300; 0 cuts over immediately.',
    )
    .action(async (id: string, opts: { grace?: string }) => {
      const graceSeconds = opts.grace === undefined ? undefined : Number(opts.grace);
      const rotated = await (await getClient()).oauthClients.rotateSecret(id, { graceSeconds });

      if (machineOutput()) {
        printOutput({ ...rotated });
        return;
      }
      printOutput({
        client_id: rotated.client_id,
        grace_seconds: rotated.grace_seconds,
        previous_secret_expires_at: rotated.previous_secret_expires_at,
      });
      announceSecret(rotated.client_secret, 'New client secret');
      human('');
      // The grace window is the difference between a rotation and an outage, so what it means is
      // spelled out rather than left as a number in a table.
      if (rotated.grace_seconds) {
        human(`  The previous secret keeps working for ${rotated.grace_seconds}s`
          + `${rotated.previous_secret_expires_at ? ` (until ${rotated.previous_secret_expires_at})` : ''}.`);
        human('  Deploy the new one before then; anything still using the old one fails after.');
      } else {
        human('  No grace window — the previous secret is dead already.');
        human('  Anything still holding it is failing now.');
      }
      human('');
      human('  Do not run this again until the deploy lands: a second rotation invalidates the');
      human('  secret you just received.');
    });

  clients
    .command('remove <id>')
    .description('Deactivate a client and revoke every token it issued')
    .action(async (id: string) => {
      await (await getClient()).oauthClients.remove(id);
      printOutput({ id, deactivated: true });
      if (machineOutput()) return;
      human('');
      human(`  ${id} is deactivated and all of its outstanding tokens are revoked.`);
      // Said because the cascade is immediate and total — someone reaching for this to change a
      // credential wants the other command.
      human('  Anything authenticating as this client stops working now, including tokens that');
      human('  had hours left. To change the credential instead, use rotate-secret.');
    });
}
