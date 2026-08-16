import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getOutputFormat } from '../config.js';
import { printOutput, human, hint, isJsonMode } from '../output.js';
import { CliError, EXIT } from '../errors.js';

/**
 * Webhooks — where events go, and what happened to each one.
 *
 * CERTEN has pushed events since early on, with a delivery queue, a retry policy and a published
 * signature-verification guide. None of it was reachable from here, so an endpoint could not be
 * registered and a failed delivery could not be seen. That is the worst shape for a push mechanism:
 * it fails quietly, and from the outside a dropped delivery is indistinguishable from an event that
 * never happened.
 *
 * `deliveries` is the command that earns this group. Everything else configures; that one answers
 * the question someone actually arrives with.
 */

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

const machineOutput = (): boolean => isJsonMode() || getOutputFormat() === 'json';

export function registerWebhookCommands(program: Command): void {
  const webhooks = program
    .command('webhooks')
    .description('Where events are delivered, and what happened to each one');

  webhooks
    .command('list', { isDefault: true })
    .description('Endpoints registered for this organization')
    .action(async () => {
      const { endpoints } = await (await getClient()).webhooks.list();
      if (machineOutput()) {
        printOutput({ endpoints });
        return;
      }
      human('');
      if (endpoints.length === 0) {
        human('  No endpoints registered — CERTEN is not pushing events anywhere.');
        hint('certen webhooks add https://example.com/hooks');
        return;
      }
      for (const e of endpoints) {
        // `verified` and `is_active` are the two states that decide whether anything arrives, so
        // they belong on the same line as the URL rather than behind a second command.
        const state = [
          e.is_active ? 'active' : 'INACTIVE',
          e.verified ? 'verified' : 'UNVERIFIED',
        ].join(', ');
        human(`  ${e.url}`);
        human(`    ${e.id}  (${state})`);
        if (e.event_types?.length) human(`    events: ${e.event_types.join(', ')}`);
        else human('    events: all');
        if (e.verification_error) human(`    last verification error: ${e.verification_error}`);
      }
      human('');
    });

  webhooks
    .command('add <url>')
    .description('Register an endpoint to receive events')
    .option('--events <list>', 'Comma-separated event types. Omit to receive everything.')
    .option('--secret <secret>', 'Your own signing secret, so it is never in a response body')
    .option('--description <text>', 'A note for your own reference')
    .option('--skip-verification', 'Register without sending the verification ping')
    .action(async (url: string, opts: {
      events?: string; secret?: string; description?: string; skipVerification?: boolean;
    }) => {
      // Checked here so a typo does not become a registered endpoint that silently never fires.
      if (!/^https?:\/\//i.test(url)) {
        throw new CliError(
          `"${url}" is not a URL. Expected something starting http:// or https://`,
          'INVALID_URL', EXIT.USAGE,
        );
      }
      const created = await (await getClient()).webhooks.register({
        url,
        secret: opts.secret,
        eventTypes: opts.events?.split(',').map((e) => e.trim()).filter(Boolean),
        description: opts.description,
        skipVerification: opts.skipVerification,
      });

      printOutput({ ...created });
      if (machineOutput()) return;

      human('');
      human(`  Registered ${created.url}`);
      human(`  ${created.id}`);
      if (created.secret) {
        human('');
        human(`  Signing secret: ${created.secret}`);
        // Said plainly because there is no second chance: rotating is the only recovery, and it
        // invalidates whatever the previous secret was already signing.
        human('  SAVE THIS NOW — it is shown once and cannot be retrieved. Verify every delivery');
        human('  against it, or you cannot tell a real event from anything else that finds the URL.');
      }
      if (created.verified === false) {
        human('');
        human(`  Not verified${created.verification_error ? `: ${created.verification_error}` : '.'}`);
        hint(`certen webhooks verify ${created.id}`);
      }
    });

  webhooks
    .command('remove <id>')
    .description('Stop delivering to an endpoint')
    .action(async (id: string) => {
      const result = await (await getClient()).webhooks.remove(id);
      printOutput({ ...result });
      if (!machineOutput()) {
        human('');
        human(`  ${id} will no longer receive events.`);
      }
    });

  webhooks
    .command('verify <id>')
    .description('Re-run the verification ping against an endpoint')
    .action(async (id: string) => {
      const result = await (await getClient()).webhooks.verify(id);
      printOutput({ ...result });
      if (machineOutput()) return;
      human('');
      human(result.verified
        ? `  ${result.url} responded correctly.`
        : `  ${result.url} did not verify${result.verification_error ? `: ${result.verification_error}` : '.'}`);
    });

  webhooks
    .command('rotate-secret <id>')
    .description('Issue a new signing secret (invalidates the current one)')
    .action(async (id: string) => {
      const result = await (await getClient()).webhooks.rotateSecret(id);
      printOutput({ ...result });
      if (machineOutput()) return;
      human('');
      human(`  New signing secret: ${result.secret}`);
      human('  SAVE THIS NOW. The previous secret stopped working the moment this was issued, so');
      human('  deliveries will fail verification until your receiver is using the new one.');
    });

  webhooks
    .command('deliveries')
    .description('Delivery attempts, newest first — including why one failed')
    .option('--limit <n>', 'How many to fetch (page size with --all)', '50')
    .option('--offset <n>', 'Skip this many')
    .option('--all', 'Fetch every page')
    .option('--failed', 'Only deliveries that did not succeed')
    .action(async (opts: { limit: string; offset?: string; all?: boolean; failed?: boolean }) => {
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new CliError(`"${opts.limit}" is not a whole number for --limit.`, 'INVALID_NUMBER', EXIT.USAGE);
      }
      const offset = opts.offset === undefined ? undefined : Number(opts.offset);
      if (opts.all && offset !== undefined) {
        throw new CliError(
          '--all starts from the beginning, so --offset has no meaning with it. Use one or the other.',
          'CONFLICTING_PAGING_FLAGS', EXIT.USAGE,
        );
      }

      const client = await getClient();
      const all = [];
      if (opts.all) {
        for await (const d of client.webhooks.deliveriesAll(limit)) all.push(d);
      } else {
        all.push(...(await client.webhooks.deliveries({ limit, offset })).deliveries);
      }

      // Filtered here rather than server-side because the endpoint takes no status filter; doing
      // it locally is honest about that and still answers the question people arrive with.
      const deliveries = opts.failed
        ? all.filter((d) => d.status !== 'delivered' && d.status !== 'succeeded')
        : all;

      if (machineOutput()) {
        printOutput({ deliveries });
        return;
      }
      human('');
      if (deliveries.length === 0) {
        human(opts.failed ? '  No failed deliveries.' : '  No deliveries yet.');
        return;
      }
      for (const d of deliveries) {
        const when = String(d.created_at ?? '').slice(0, 19).replace('T', ' ');
        human(`  ${when}  ${String(d.event_type ?? '?').padEnd(28)} ${d.status ?? '?'}`);
        if (d.response_status) human(`    HTTP ${d.response_status}, attempt ${d.attempts ?? 1}`);
        if (d.error) human(`    ${d.error}`);
        if (d.status && d.status !== 'delivered' && d.status !== 'succeeded') {
          human(`    retry it: certen webhooks redeliver ${d.id}`);
        }
      }
      human('');
    });

  webhooks
    .command('redeliver <id>')
    .description('Send a delivery again')
    .action(async (id: string) => {
      const result = await (await getClient()).webhooks.redeliver(id);
      printOutput({ ...result });
      if (!machineOutput()) {
        human('');
        human('  Queued for delivery again.');
        // Worth saying: this is one of the few genuinely non-idempotent operations on the API.
        human('  Each call delivers again — make sure your receiver can handle a repeat.');
      }
    });
}
