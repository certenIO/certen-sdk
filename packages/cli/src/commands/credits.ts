import { Command } from 'commander';
import type { CreditTopUpResponse } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint, human } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';
import { uuidArg } from '../next-step.js';
import { resolveContext, requireIdentity } from '../context.js';
import { resolveCommandIdentity } from '../command-context.js';
import { commandPrompter } from '../prompt.js';
import { printable } from '../gateway-text.js';
import { assertCanSpend, confirmSpend, resolveIdempotencyKey, spendClient, spendFailure } from '../spend.js';

/**
 * `certen credits topup --credits <n>`: credits for an identity's key page, paid by the platform.
 *
 * Every write to Accumulate spends a fraction of a credit, and an identity is provisioned with a fixed grant. When it runs low the gateway can add
 * more from its own sponsor account: the organization is not charged, which is exactly why this is guarded the way it is (see spend.ts). The
 * operator has it switched off by default, so against most gateways today the answer is `CREDIT_TOPUP_DISABLED`, said plainly.
 *
 * **`--credits` is a count of credits, never ACME.** 1 credit is $0.01. The bridge turns the count into the ACME it needs from the network's
 * oracle price on that call; nothing here knows a price. A whole number of at least 1 is checked here, before anything is sent.
 *
 * **Submitted is not confirmed.** The gateway answers 202: the transaction is accepted and the network has not yet confirmed it. `unconfirmed` is
 * worse: the bridge did not say whether it submitted, so the credits MAY already be there. That is reported as exactly that, with a failing exit
 * code and the one command that settles it, and it is never worded as a success.
 *
 * Exit codes: 0 submitted (accepted, not yet confirmed) · 1 refused, declined, or UNCONFIRMED (`CREDIT_TOPUP_UNCONFIRMED`; the credits may have
 * been added) · 2 a bad invocation, or nobody to confirm it without `--yes` · 3 the gateway did not answer (the credits MAY have been added: repeat
 * with the same `--idempotency-key`).
 */

/** A count of credits: digits only, no sign, no exponent, no leading zero, and a number JSON can carry exactly. */
function parseCredits(raw: string): number {
  const n = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n)) {
    throw new UsageError(
      `--credits: "${printable(raw, 60)}" is not a whole number of credits of at least 1. It is a COUNT of credits (1 credit = $0.01), never an amount of ACME; for example --credits 500.`,
      'INVALID_CREDITS',
    );
  }
  return n;
}

const cents = (credits: number): string => `$${Math.floor(credits / 100)}.${String(credits % 100).padStart(2, '0')}`;

export function registerCreditsCommands(program: Command): void {
  const credits = program.command('credits').description('Credits on an identity\'s key page: top them up from the platform\'s sponsor account');

  credits
    .command('topup')
    .description('Add credits to an identity\'s key page, paid by the PLATFORM (your organization is not charged). Asks first; --yes to say yes in advance')
    .requiredOption('--credits <n>', 'How many credits to add: a whole number of at least 1. A COUNT of credits (1 credit = $0.01), never an amount of ACME')
    .option('--identity <ref>', 'Identity whose key page is topped up: UUID, ADI URL or name (default: your context, see `certen context`)')
    .option('--idempotency-key <key>', 'Repeat an earlier attempt: the key it printed. A repeat with the same key is never a second draw (one is generated if omitted)')
    .option('--yes', 'Say yes to the confirmation in advance (needed when nobody is at a terminal; --json is not an answer)')
    .addHelpText('after', `
This spends the platform's ACME, so it is limited and switched off unless the operator enables it (CREDIT_TOPUP_DISABLED otherwise). The answer is
"submitted" (accepted, not yet confirmed) or "unconfirmed" (the credits MAY have been added: it exits 1; read them back with \`certen identity
readiness\` before doing anything else). The Idempotency-Key is printed every time: pass it back with --idempotency-key to repeat the SAME attempt.
`)
    .action(async (opts: { credits: string; identity?: string; idempotencyKey?: string; yes?: boolean }) => {
      // ── the invocation, with nothing read and nothing sent ─────────────────────────────────────────────
      const count = parseCredits(opts.credits);
      const key = resolveIdempotencyKey(opts.idempotencyKey);
      const prompter = commandPrompter();
      assertCanSpend({ yes: Boolean(opts.yes), prompter, command: 'certen credits topup', what: `${count} credits of ACME` });
      const ctx = resolveContext({ identity: opts.identity }, { fields: ['identity'] });
      requireIdentity(ctx);

      // ── who, and the question ───────────────────────────────────────────────────────────────────────
      const apiKey = await getApiKey();
      const client = spendClient(apiKey, getApiUrl());
      const who = await resolveCommandIdentity(ctx, client, 'id');
      const label = who.adi_url ?? who.id!;

      hint('');
      hint(`  Add ${count} credits to the key page of ${label}`);
      hint(`    credits  ${count}   (1 credit = $0.01, so ${cents(count)} of credits; a count of credits, not ACME)`);
      hint('    paid by  the platform\'s sponsor account. Your organization is not charged, and the platform\'s funds are limited.');
      hint(`    key      Idempotency-Key ${key}   (a repeat with this key can never draw twice)`);
      hint('');
      if (!(await confirmSpend(prompter, Boolean(opts.yes), `  Add ${count} credits?`))) {
        throw new CliError('Not topped up. Nothing was sent and nothing was charged.', 'TOPUP_DECLINED', EXIT.FAILED, false, undefined, `certen identity readiness ${uuidArg(who.id, '<ref>')}`);
      }

      // ── the request ─────────────────────────────────────────────────────────────────────────────────
      const repeat = `certen credits topup --credits ${count} --identity ${uuidArg(who.id, '<id>')} --idempotency-key ${key} --yes`;
      let result: CreditTopUpResponse;
      try {
        result = await client.identity.topUpCredits(who.id!, { credits: count, idempotencyKey: key });
      } catch (err) {
        throw spendFailure(err, {
          what: 'credit top-up', mayHave: 'the credits may have been added', key, repeat,
          instead: 'Nothing here can add credits until the operator enables it.',
        });
      }

      const readBack = `certen identity readiness ${uuidArg(who.id, '<ref>')}`;
      if (result.status !== 'submitted') {
        // Not a success, and not hidden: the bridge did not say whether it submitted (`unconfirmed`), or the gateway said something this CLI does
        // not know, which is not "submitted" either. Exit 1 with everything the gateway said, the key, and the one command that settles it
        // (TX_WAIT_TIMEOUT is the precedent: neither success nor failure, and it exits 1).
        throw new CliError(
          `The top-up of ${count} credits is UNCONFIRMED: the gateway does not know whether it was applied, so the credits MAY already be on the key page. `
          + `Do not top up again with a new key (that would be a second draw). Read the credits back first: ${readBack}. `
          + `Repeating with the same key (--idempotency-key ${key}) returns this same answer and can never draw twice.`,
          'CREDIT_TOPUP_UNCONFIRMED', EXIT.FAILED, false,
          { result, idempotency_key: key, credits: count, may_have_been_applied: true },
          readBack,
        );
      }

      printOutput({ ...result, idempotency_key: key } as unknown as Record<string, unknown>, { machineOnly: true });
      human('');
      human(`  Submitted: ${result.credits} credits for the key page of ${label}.`);
      human(`    key page        ${printable(result.key_page_url, 160)}`);
      human(`    credits before  ${result.credits_before === null || result.credits_before === undefined ? 'not read' : result.credits_before}`);
      human(`    transaction     ${result.tx_id ? printable(result.tx_id, 200) : 'the bridge returned none'}`);
      human(`    top-up id       ${printable(result.topup_id, 80)}`);
      human(`    key             ${key}   (a repeat with this key can never draw twice)`);
      human('');
      human('  Submitted means accepted, not yet confirmed by the network. Read the credits back when you need them:');
      human(`    ${readBack}`);
      human('');
    });
}
