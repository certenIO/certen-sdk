import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getOutputFormat } from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { printOutput, human, hint, isJsonMode } from '../output.js';

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

export function registerAdminCommands(program: Command): void {
  const admin = program.command('admin').description('Administration');

  // API Keys management
  const apiKeys = admin.command('api-keys').description('API key management');

  apiKeys
    .command('list')
    .description('List API keys')
    .action(async () => {
      const client = await getClient();
      const result = await client.admin.listApiKeys();
      printOutput(result as unknown as Record<string, unknown>);
    });

  program
    .command('scopes')
    .description('Every permission a key can be granted, and what each covers')
    .option('--all', 'Include operator scopes, which customer keys should not use')
    .action(async (opts: { all?: boolean }) => {
      // `--permissions` below takes a comma-separated list of a vocabulary published nowhere, so
      // the choice was made by guessing. Guessing wrong is asymmetric: under-grant and you get
      // 403s, which are visible; over-grant - and the obvious answer to uncertainty is `*` - and a
      // key that only needed to read a balance can retire identities and publish price books.
      const client = await getClient();
      const { scopes } = await client.admin.scopes();
      const shown = opts.all ? scopes : scopes.filter((s) => s.audience === 'customer');

      if (isJsonMode() || getOutputFormat() === 'json') {
        printOutput({ scopes: shown });
        return;
      }

      const w = Math.max(...shown.map((s) => s.name.length), 4);
      human('');
      for (const s of shown) {
        human(`  ${s.name.padEnd(w)}  ${s.description}`);
        if (s.operations.length > 0) {
          human(`  ${' '.repeat(w)}  ${s.operations.length} operation(s)`);
        }
      }
      human('');
      if (!opts.all) {
        human('  Operator scopes are hidden. See them all: certen scopes --all');
      }
      hint('certen admin api-keys create --name <n> --org-id <id> --permissions billing:read,proof:read');
    });

  apiKeys
    .command('create')
    .description('Create a new API key')
    .requiredOption('--name <name>', 'Key name')
    .requiredOption('--org-id <id>', 'Organization ID')
    .option('--permissions <perms>', 'Comma-separated scopes. List them: certen scopes')
    .option('--rate-limit <rpm>', 'Rate limit RPM', parseInt)
    .option('--expires-at <date>', 'Expiration date (ISO)')
    .action(async (opts) => {
      const client = await getClient();

      // Checked against the live catalogue BEFORE the key is minted. A typo used to produce a key
      // that authenticates fine and then 403s on the one call it exists to make - discovered in
      // production, and fixable only by issuing a new key, since permissions are set at creation.
      const requested: string[] | undefined = opts.permissions
        ? opts.permissions.split(',').map((p: string) => p.trim()).filter(Boolean)
        : undefined;
      if (requested?.length) {
        const { scopes } = await client.admin.scopes();
        const known = new Set(scopes.map((s) => s.name));
        const unknown = requested.filter((p) => !known.has(p));
        if (unknown.length > 0) {
          throw new CliError(
            `Not a permission: ${unknown.join(', ')}. See them all: certen scopes`,
            'UNKNOWN_SCOPE', EXIT.USAGE,
          );
        }
      }

      const result = await client.admin.createApiKey({
        name: opts.name,
        orgId: opts.orgId,
        permissions: requested,
        rateLimitRpm: opts.rateLimit,
        expiresAt: opts.expiresAt,
      });
      printOutput(result as unknown as Record<string, unknown>);
    });

  apiKeys
    .command('rotate')
    .description('Rotate an API key (mints a new key + deactivates the old)')
    .requiredOption('--id <uuid>', 'ID of the API key to rotate')
    .action(async (opts: { id: string }) => {
      const client = await getClient();
      const result = await client.admin.rotateApiKey(opts.id);
      printOutput(result as unknown as Record<string, unknown>);
    });

  apiKeys
    .command('revoke')
    .description('Revoke an API key (DELETE)')
    .requiredOption('--id <uuid>', 'ID of the API key to revoke')
    .action(async (opts: { id: string }) => {
      const client = await getClient();
      const result = await client.admin.revokeApiKey(opts.id);
      printOutput(result as unknown as Record<string, unknown>);
    });

  // Audit log
  admin
    .command('audit-log')
    .description('View audit log')
    .option('--action <action>', 'Filter by action')
    .option('--resource-type <type>', 'Filter by resource type')
    .option('--from <date>', 'From date (ISO)')
    .option('--to <date>', 'To date (ISO)')
    .option('--limit <n>', 'Max results', parseInt)
    .option('--offset <n>', 'Offset', parseInt)
    .action(async (opts) => {
      const client = await getClient();
      const result = await client.admin.getAuditLog({
        action: opts.action,
        resourceType: opts.resourceType,
        from: opts.from,
        to: opts.to,
        limit: opts.limit,
        offset: opts.offset,
      });
      printOutput(result as unknown as Record<string, unknown>);
    });

  // Usage
  admin
    .command('usage')
    .description('View usage summary')
    .option('--from <date>', 'From date (ISO)')
    .option('--to <date>', 'To date (ISO)')
    .action(async (opts) => {
      const client = await getClient();
      const result = await client.admin.getUsage({
        from: opts.from,
        to: opts.to,
      });
      printOutput(result as unknown as Record<string, unknown>);
    });
}
