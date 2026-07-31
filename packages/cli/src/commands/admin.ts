import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput } from '../output.js';

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

  apiKeys
    .command('create')
    .description('Create a new API key')
    .requiredOption('--name <name>', 'Key name')
    .requiredOption('--org-id <id>', 'Organization ID')
    .option('--permissions <perms>', 'Comma-separated permissions')
    .option('--rate-limit <rpm>', 'Rate limit RPM', parseInt)
    .option('--expires-at <date>', 'Expiration date (ISO)')
    .action(async (opts) => {
      const client = await getClient();
      const result = await client.admin.createApiKey({
        name: opts.name,
        orgId: opts.orgId,
        permissions: opts.permissions ? opts.permissions.split(',') : undefined,
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
