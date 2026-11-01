import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  CertenClient, CertenError, signWebhookPayload, verifyWebhookSignature, DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  WEBHOOK_DELIVERY_STATUSES, isWebhookDeliveryStatus, webhookEndpointVerified,
} from '@certen.io/sdk';
import type { WebhookDelivery, WebhookDeliveryStatus } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getOutputFormat } from '../config.js';
import { printOutput, human, hint, isJsonMode } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';

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

/** Where the signing secret is read from when no file is named. */
const SECRET_ENV = 'CERTEN_WEBHOOK_SECRET';

/**
 * The signing secret, from a file or the environment — never from a flag.
 *
 * A secret on the command line lands in shell history and in every process listing on the machine, which is exactly where a value that
 * authenticates every delivery should not be. (`webhooks add --secret` takes one because the person is choosing it for the gateway to
 * store; these commands only ever USE a secret that already exists.) A single trailing newline is dropped from a file, because editors and
 * `echo` add one and the secret does not contain it; the SDK says so, by hint, if a newline is left on anyway.
 */
function readSecret(opts: { secretFile?: string }): string {
  if (opts.secretFile) {
    let text: string;
    try {
      text = readFileSync(opts.secretFile, 'utf8');
    } catch (err) {
      throw new UsageError(`Cannot read the secret file ${opts.secretFile}: ${(err as Error).message}`, 'SECRET_FILE_UNREADABLE', 'certen webhooks --help');
    }
    return text.replace(/\r?\n$/, '');
  }
  const fromEnv = process.env[SECRET_ENV];
  if (!fromEnv) {
    throw new UsageError(
      `No signing secret. Put it in $${SECRET_ENV} or name a file with --secret-file <path>. It is not accepted as a flag: that would put it in your shell history and the process list.`,
      'WEBHOOK_SECRET_REQUIRED', 'certen webhooks --help',
    );
  }
  return fromEnv;
}

/** The SDK refuses an unusable secret or option with a CertenError; at a command line that is a wrong invocation (exit 2), not a failed operation. */
function asUsage(err: unknown): never {
  // Literal codes, not `err.code`: the drift gate in next-step.test.ts can only hold a code to its next-step entry when it can read it.
  if (err instanceof CertenError && err.code === 'WEBHOOK_SECRET_INVALID') {
    throw new UsageError(err.message, 'WEBHOOK_SECRET_INVALID', 'certen webhooks --help');
  }
  if (err instanceof CertenError && err.code === 'INVALID_WEBHOOK_OPTION') {
    throw new UsageError(err.message, 'INVALID_WEBHOOK_OPTION', 'certen webhooks --help');
  }
  throw err;
}

/** Text from a file, or standard input when the path is `-`. Bytes, because a signature is over bytes. */
function readInput(path: string, what: string): Buffer {
  try {
    return readFileSync(path === '-' ? 0 : path);
  } catch (err) {
    throw new UsageError(`Cannot read ${what} ${path === '-' ? 'from standard input' : path}: ${(err as Error).message}`, 'INPUT_UNREADABLE', 'certen webhooks --help');
  }
}

function wholeSeconds(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new UsageError(`"${value}" is not a whole number of seconds for ${flag}.`, 'INVALID_NUMBER', 'certen webhooks --help');
  return Number(value);
}

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
        // Verified and active are the two states that decide whether anything arrives, so they belong on the
        // same line as the URL rather than behind a second command. The list route sends `verified_at`, not
        // `verified` (only register and verify send that), so read it through the helper that knows both:
        // reading `e.verified` here called every verified endpoint UNVERIFIED.
        const verified = webhookEndpointVerified(e);
        const state = [
          e.is_active ? 'active' : 'INACTIVE',
          verified === undefined ? 'verification unknown' : verified ? 'verified' : 'UNVERIFIED',
        ].join(', ');
        human(`  ${e.url}`);
        human(`    ${e.id}  (${state})`);
        if (e.event_types?.length) human(`    events: ${e.event_types.join(', ')}`);
        else human('    events: all');
        if (e.verification_error) human(`    last verification error: ${e.verification_error}`);
        // The gateway counts failed ATTEMPTS (every retry adds one) and switches an endpoint off when the count reaches
        // its limit; one success resets it. That is the usual reason for INACTIVE.
        if ((e.consecutive_failures ?? 0) > 0) {
          const n = e.consecutive_failures;
          const last = e.last_success_at ? `last success ${String(e.last_success_at).slice(0, 19).replace('T', ' ')}` : 'none has succeeded';
          human(`    ${n} failed ${n === 1 ? 'attempt' : 'attempts'} in a row; ${last}`);
        }
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
    .option('--status <status>', `Only this status, asked of the gateway: ${WEBHOOK_DELIVERY_STATUSES.join(', ')} (dlq = used every retry)`)
    .option('--failed', 'Only deliveries that are not delivered (pending, failed and dlq), filtered from the page fetched; for one status across every page use --status')
    .action(async (opts: { limit: string; offset?: string; all?: boolean; failed?: boolean; status?: string }) => {
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new CliError(`"${opts.limit}" is not a whole number for --limit.`, 'INVALID_NUMBER', EXIT.USAGE);
      }
      // Checked before any request. The gateway does not check it: an unknown status comes back as an empty list, which reads as "nothing has failed".
      if (opts.status !== undefined && !isWebhookDeliveryStatus(opts.status)) {
        throw new UsageError(
          `"${opts.status}" is not a delivery status. Use one of: ${WEBHOOK_DELIVERY_STATUSES.join(', ')} (lowercase).`,
          'INVALID_VALUE', 'certen webhooks deliveries --help',
        );
      }
      if (opts.status !== undefined && opts.failed) {
        throw new CliError(
          '--failed and --status both narrow the list. Use --status failed or --status dlq for one status, or --failed for everything not delivered.',
          'CONFLICTING_FLAGS', EXIT.USAGE,
        );
      }
      const status = opts.status as WebhookDeliveryStatus | undefined;
      const offset = opts.offset === undefined ? undefined : Number(opts.offset);
      if (opts.all && offset !== undefined) {
        throw new CliError(
          '--all starts from the beginning, so --offset has no meaning with it. Use one or the other.',
          'CONFLICTING_PAGING_FLAGS', EXIT.USAGE,
        );
      }

      const client = await getClient();
      const all: WebhookDelivery[] = [];
      if (opts.all) {
        for await (const d of client.webhooks.deliveriesAll(limit, status ? { status } : {})) all.push(d);
      } else {
        all.push(...(await client.webhooks.deliveries({ limit, offset, ...(status ? { status } : {}) })).deliveries);
      }

      // `--status` is the gateway's own filter, so a page is a page of that status. `--failed` is "anything not delivered", which is
      // three statuses and one query cannot ask for, so it is applied to the page that was fetched.
      const deliveries = opts.failed ? all.filter((d) => d.status !== 'delivered') : all;

      if (machineOutput()) {
        printOutput({ deliveries });
        return;
      }
      human('');
      if (deliveries.length === 0) {
        human(status ? `  No ${status} deliveries.` : opts.failed ? '  No failed deliveries.' : '  No deliveries yet.');
        return;
      }
      for (const d of deliveries) {
        const when = String(d.created_at ?? '').slice(0, 19).replace('T', ' ');
        human(`  ${when}  ${String(d.event_type ?? '?').padEnd(28)} ${d.status ?? '?'}`);
        if (d.response_status) human(`    HTTP ${d.response_status}, attempt ${d.attempts ?? 1}`);
        // `last_error` is the field the gateway sends. This printed `d.error`, which it never has, so no failure reason was ever shown.
        if (d.last_error) human(`    ${d.last_error}`);
        if (d.dlq_at) human(`    gave up after ${d.attempts ?? '?'} attempts, ${String(d.dlq_at).slice(0, 19).replace('T', ' ')}`);
        if (d.status === 'pending' && d.last_error) human('    retrying on its own');
        else if (d.status === 'failed' || d.status === 'dlq') human(`    retry it: certen webhooks redeliver ${d.id}`);
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

  // ── Signing and verifying ───────────────────────────────────────────────────────────────────────
  // The gateway signs every delivery; these are the other half. `sign` and `check-signature` are
  // local — no API key, no network — because the only thing they need is the secret you already hold.

  webhooks
    .command('sign')
    .description('Sign a payload the way the gateway signs a delivery, to try your receiver (local; needs the endpoint secret)')
    .option('--payload <json>', 'The JSON payload to sign')
    .option('--payload-file <path>', 'Read the payload from a file ("-" for standard input)')
    .option('--event <name>', 'Also emit X-Certen-Event, e.g. transaction.completed')
    .option('--delivery-id <id>', 'Also emit X-Certen-Delivery')
    .option('--timestamp <unix>', 'Sign at this unix time instead of now')
    .option('--secret-file <path>', `Read the secret from a file (default: $${SECRET_ENV})`)
    .action((opts: {
      payload?: string; payloadFile?: string; event?: string; deliveryId?: string; timestamp?: string; secretFile?: string;
    }) => {
      if ((opts.payload === undefined) === (opts.payloadFile === undefined)) {
        throw new UsageError('Give the payload with exactly one of --payload <json> or --payload-file <path>.', 'PAYLOAD_REQUIRED', 'certen webhooks sign --help');
      }
      const secret = readSecret(opts);
      const text = opts.payload ?? readInput(opts.payloadFile as string, 'the payload').toString('utf8');
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (err) {
        throw new UsageError(`The payload is not valid JSON: ${(err as Error).message}`, 'INVALID_PAYLOAD', 'certen webhooks sign --help');
      }
      let signed;
      try {
        signed = signWebhookPayload(secret, payload, {
          timestamp: wholeSeconds(opts.timestamp, '--timestamp'), event: opts.event, deliveryId: opts.deliveryId,
        });
      } catch (err) {
        if (err instanceof TypeError) throw new UsageError(err.message, 'INVALID_PAYLOAD', 'certen webhooks sign --help');
        return asUsage(err);
      }

      printOutput({
        body: signed.canonicalPayload, headers: signed.headers, signature: signed.header, timestamp: signed.timestamp,
      }, { machineOnly: true });
      if (machineOutput()) return;
      human('');
      human('  Send this body EXACTLY as written — the signature is over these bytes:');
      human('');
      human(`  ${signed.canonicalPayload}`);
      human('');
      human('  with these headers:');
      for (const [name, value] of Object.entries(signed.headers)) human(`    ${name}: ${value}`);
      human('');
      human(`  Your receiver accepts it for ${DEFAULT_WEBHOOK_TOLERANCE_SECONDS} seconds from ${signed.timestamp} (its default replay window).`);
    });

  webhooks
    .command('check-signature')
    .description('Check a captured delivery\'s signature against your secret (local; exits 1 when it does not verify)')
    .requiredOption('--signature <header>', 'The X-Certen-Signature header value: t=<unix>,v1=<hex>')
    .option('--body <text>', 'The request body. Prefer --body-file: a shell can alter a body passed as an argument')
    .option('--body-file <path>', 'Read the raw request body from a file ("-" for standard input)')
    .option('--tolerance <seconds>', `How far from now the timestamp may be (default ${DEFAULT_WEBHOOK_TOLERANCE_SECONDS})`)
    .option('--now <unix>', 'Treat this as the current time — to check a capture taken earlier')
    .option('--secret-file <path>', `Read the secret from a file (default: $${SECRET_ENV})`)
    .action((opts: {
      signature: string; body?: string; bodyFile?: string; tolerance?: string; now?: string; secretFile?: string;
    }) => {
      if ((opts.body === undefined) === (opts.bodyFile === undefined)) {
        throw new UsageError('Give the body with exactly one of --body <text> or --body-file <path>.', 'BODY_REQUIRED', 'certen webhooks check-signature --help');
      }
      const secret = readSecret(opts);
      const body = opts.body ?? readInput(opts.bodyFile as string, 'the request body');
      let result;
      try {
        result = verifyWebhookSignature({
          body: typeof body === 'string' ? body : new Uint8Array(body),
          signature: opts.signature,
          secret,
          toleranceSeconds: wholeSeconds(opts.tolerance, '--tolerance'),
          now: wholeSeconds(opts.now, '--now'),
        });
      } catch (err) {
        return asUsage(err);
      }

      if (!result.ok) {
        throw new CliError(
          result.message, 'WEBHOOK_SIGNATURE_INVALID', EXIT.FAILED, false,
          {
            reason: result.reason,
            ...(result.hint ? { hint: result.hint } : {}),
            ...(result.timestamp !== undefined ? { timestamp: result.timestamp, age_seconds: result.ageSeconds } : {}),
          },
          'certen webhooks check-delivery <delivery-id>',
        );
      }
      printOutput({ valid: true, timestamp: result.timestamp, age_seconds: result.ageSeconds, version: result.version }, { machineOnly: true });
      if (machineOutput()) return;
      human('');
      human(`  Signature verified (${result.version}, signed ${result.ageSeconds}s ago).`);
      human('');
    });

  webhooks
    .command('check-delivery <id>')
    .description('Is your secret the one the gateway signed this delivery with? (the secret never leaves this machine)')
    .option('--secret-file <path>', `Read the secret from a file (default: $${SECRET_ENV})`)
    .action(async (id: string, opts: { secretFile?: string }) => {
      const secret = readSecret(opts);
      let check;
      try {
        check = await (await getClient()).webhooks.checkDelivery(id, secret);
      } catch (err) {
        return asUsage(err);
      }

      if (!check.ok) {
        throw new CliError(
          check.message, 'WEBHOOK_SIGNATURE_INVALID', EXIT.FAILED, false,
          { reason: check.reason, delivery_id: check.deliveryId, ...(check.hint ? { hint: check.hint } : {}) },
          check.reason === 'not-signed' ? 'certen webhooks deliveries' : undefined,
        );
      }
      printOutput({ valid: true, delivery_id: check.deliveryId, signed_at: check.timestamp, version: check.version }, { machineOnly: true });
      if (machineOutput()) return;
      human('');
      human('  Yes — that secret signed this delivery. If your receiver still rejects it, the secret is not the problem:');
      human('  look at how the body reaches the verifier (a framework parsing it first, a proxy rewriting it).');
      human('');
    });
}
