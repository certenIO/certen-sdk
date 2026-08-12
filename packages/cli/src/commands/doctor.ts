import { Command } from 'commander';
import { CertenClient, CertenError } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getPortalUrl } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { CliError, EXIT } from '../errors.js';
import { listKeys } from '../keystore.js';
import { faucetFor } from '../funding-guard.js';
import { normalizeChain } from '../chains.js';

/**
 * `certen doctor` — the one command a stuck user runs.
 *
 * The design constraint that shapes everything here: **print the first blocking problem and its
 * fix, not a report.** A wall of seven check results makes the reader do the triage, and the
 * triage is the part that needs expertise. Check 4 cannot be interpreted until check 2 passes, so
 * showing both at once is noise dressed as thoroughness.
 *
 * `--all` exists for when the whole picture genuinely is the question, and `--json` always
 * returns every check because a machine caller has no trouble reading seven of anything.
 *
 * Checks are ordered by dependency: nothing below a failure is meaningful, so nothing below a
 * failure is run.
 */

type Health = 'ok' | 'fail' | 'warn' | 'skipped';

interface Check {
  name: string;
  status: Health;
  detail: string;
  /** The command or URL that resolves it. Absent when the check passed. */
  fix?: string;
}

/** First few, then a count. A check line is a summary; the full list is what `portfolio` is for. */
function summarize(items: string[], max = 3): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

/** The checks that cannot run without a working credential, in the order they are reported. */
const CREDENTIALLED_CHECKS = [
  'identity can sign',
  'abstract accounts funded',
  'billing balance',
  'credit / trial',
] as const;

export function registerDoctorCommands(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose the setup and name the one thing blocking you')
    .option('--all', 'Show every check, not just the first problem')
    .action(async (opts: { all?: boolean }) => {
      const checks: Check[] = [];
      let unreachable = false;

      const apiUrl = getApiUrl();

      // ── 1. Is the gateway there at all? ───────────────────────────────────────────────────────
      // `GET /v1/chains` is public, so this works before the user has any credential — which is
      // exactly when they most need to know whether the address is wrong or the network is down.
      let client: CertenClient | null = null;
      try {
        const probe = new CertenClient({ apiKey: 'public', baseUrl: apiUrl });
        const registry = await probe.chains.list();
        checks.push({
          name: 'gateway reachable',
          status: 'ok',
          detail: `${apiUrl} — registry v${registry.version}, ${registry.count} chains`,
        });
      } catch (err) {
        unreachable = true;
        checks.push({
          name: 'gateway reachable',
          status: 'fail',
          detail: `${apiUrl} did not answer: ${err instanceof Error ? err.message : String(err)}`,
          fix: 'Check CERTEN_API_URL and your network. Nothing else can be diagnosed until this passes.',
        });
      }

      // ── 2. Is there a key, and does the gateway accept it? ────────────────────────────────────
      let keyOk = false;
      if (unreachable) {
        checks.push({ name: 'api key', status: 'skipped', detail: 'gateway unreachable' });
      } else {
        let apiKey: string | null = null;
        try {
          apiKey = await getApiKey();
        } catch {
          checks.push({
            name: 'api key',
            status: 'fail',
            detail: 'No API key configured.',
            fix: `certen auth login   (mint one at ${getPortalUrl()})`,
          });
        }

        if (apiKey) {
          client = new CertenClient({ apiKey, baseUrl: apiUrl });
          try {
            await client.billing.balance();
            keyOk = true;
            checks.push({ name: 'api key', status: 'ok', detail: `${apiKey.substring(0, 12)}... accepted` });
          } catch (err) {
            if (err instanceof CertenError && err.status === 403) {
              // The key is real; it just cannot read billing. Not a blocker for signing work.
              keyOk = true;
              checks.push({
                name: 'api key',
                status: 'warn',
                detail: `${apiKey.substring(0, 12)}... accepted, but has no billing:read scope`,
                fix: 'Balance and funding checks below will be skipped.',
              });
            } else if (err instanceof CertenError && err.status === 401) {
              checks.push({
                name: 'api key',
                status: 'fail',
                detail: 'The gateway rejected this key.',
                fix: `certen auth login   (mint a new one at ${getPortalUrl()})`,
              });
            } else {
              checks.push({
                name: 'api key',
                status: 'warn',
                detail: `Could not confirm the key (gateway answered ${err instanceof CertenError ? err.status : '?'}).`,
              });
              keyOk = true;
            }
          }
        }
      }

      // ── 3. Is there a local signing key? ──────────────────────────────────────────────────────
      // Independent of the gateway: it is a question about this machine, so it is answered even
      // when everything above failed.
      const local = listKeys();
      checks.push(local.length > 0
        ? {
          name: 'local signing key',
          status: 'ok',
          detail: `${local.length} key(s): ${local.map((k) => k.name).join(', ')}`,
        }
        : {
          name: 'local signing key',
          status: 'fail',
          detail: 'No signing keys on this machine. Nothing can be signed without one.',
          fix: 'certen keys generate --name dev',
        });

      // ── 4-6. Identity, funding, balance ───────────────────────────────────────────────────────
      if (!client || !keyOk) {
        // Every check appears in every run, skipped ones included. A list whose LENGTH depends on
        // how far the run got is one a machine caller cannot index into, and one a human reads as
        // "that check does not exist" rather than "that check could not run".
        for (const name of CREDENTIALLED_CHECKS) {
          checks.push({ name, status: 'skipped', detail: 'needs a working API key' });
        }
      } else {
        const portfolio = await client.portfolio.get().catch(() => null);

        if (!portfolio) {
          checks.push({ name: 'identity can sign', status: 'warn', detail: 'Could not read the portfolio.' });
          checks.push({ name: 'abstract accounts funded', status: 'skipped', detail: 'portfolio unavailable' });
        } else if ((portfolio.identities ?? []).length === 0) {
          checks.push({
            name: 'identity can sign',
            status: 'fail',
            detail: 'No identities in this organization.',
            fix: 'certen identity create --name <name> --sign-with <key> --chains base-sepolia --wait',
          });
          checks.push({ name: 'abstract accounts funded', status: 'skipped', detail: 'no identities' });
        } else {
          const active = portfolio.identities.filter((i) => i.status === 'active');
          checks.push(active.length > 0
            ? {
              name: 'identity can sign',
              status: 'ok',
              // Truncated: a mature organization has dozens, and printing all of them turns a
              // one-line health check into a paragraph that pushes the actual problem off screen.
              detail: `${active.length} active: ${summarize(active.map((i) => i.adi_url))}`,
            }
            : {
              name: 'identity can sign',
              status: 'fail',
              detail: `${portfolio.identities.length} identity(ies), none active.`,
              fix: 'certen identity list   then   certen identity get <id>',
            });

          // The zero-balance abstract account: accepted, signed, submitted, then parked at
          // `anchoring` forever with nothing reporting why. This is the check that exists
          // specifically to make that failure visible before it happens.
          const empty: string[] = [];
          let accounts = 0;
          for (const identity of portfolio.identities) {
            for (const chain of identity.chains ?? []) {
              const native = (chain.balances ?? [])
                .find((bal) => !bal.token || bal.token === 'ETH' || bal.token === 'native');
              if (!native) continue;
              accounts += 1;
              // Normalized before deduping: the gateway spells the same chain two ways, so the
              // raw values reported "ethereum-sepolia" and "11155111" as two separate chains,
              // one of which had no faucet because nothing maps a bare number to one.
              if (Number(native.balance) === 0) empty.push(normalizeChain(chain.chain_id));
            }
          }
          const emptyChains = [...new Set(empty)];
          checks.push(emptyChains.length === 0
            ? { name: 'abstract accounts funded', status: 'ok', detail: `all ${accounts} chain account(s) have gas` }
            : {
              name: 'abstract accounts funded',
              // Counted, not just listed. "No gas on: ethereum-sepolia" reads as a statement about
              // the CHAIN; with 39 identities the truth was "30 of 34 accounts are empty, spread
              // across these chains", and the two mean very different things to someone deciding
              // whether their own identity is affected.
              status: 'warn',
              detail: `${empty.length} of ${accounts} chain account(s) have no gas, on ${emptyChains.join(', ')}. `
                + 'A value transfer from an empty one parks at "anchoring" forever.',
              fix: emptyChains.map((c) => faucetFor(c)).filter(Boolean).join('  ')
                || 'Fund the abstract account on that chain.',
            });
        }

        const [balance, obligations] = await Promise.all([
          client.billing.balance().catch(() => null),
          client.billing.obligations().catch(() => null),
        ]);

        if (!balance) {
          checks.push({ name: 'billing balance', status: 'skipped', detail: 'balance unavailable' });
        } else if (balance.status !== 'active') {
          checks.push({
            name: 'billing balance',
            status: 'fail',
            detail: `Account is ${balance.status}${balance.suspended_reason ? `: ${balance.suspended_reason}` : ''}.`,
            fix: 'certen fund <amount> --chain base-sepolia',
          });
        } else if (obligations && Number(obligations.remaining_usd) <= 0) {
          // Balance can look healthy while every cent is committed to intents awaiting quorum.
          // `remaining_usd` is the number that decides whether new work is accepted.
          checks.push({
            name: 'billing balance',
            status: 'fail',
            detail: `Nothing left to commit — ${obligations.pending_intents} pending intent(s) have claimed it.`,
            fix: 'certen fund <amount> --chain base-sepolia',
          });
        } else {
          checks.push({
            name: 'billing balance',
            status: 'ok',
            detail: `${balance.spendable_usd} spendable`
              + (obligations ? `, ${obligations.remaining_usd} left to commit` : ''),
          });
        }

        // ── 7. Trial / credit expiry ────────────────────────────────────────────────────────────
        const credit = balance?.credit;
        if (!credit || credit.kind === 'none') {
          checks.push({ name: 'credit / trial', status: 'ok', detail: 'no credit line in play' });
        } else if (credit.expired) {
          checks.push({
            name: 'credit / trial',
            status: 'fail',
            detail: `Your ${credit.kind} credit has EXPIRED.`,
            fix: 'certen fund <amount> --chain base-sepolia',
          });
        } else {
          const days = credit.expires_at
            ? Math.max(0, Math.round((new Date(credit.expires_at).getTime() - Date.now()) / 86_400_000))
            : null;
          checks.push(days !== null && days <= 3
            ? {
              name: 'credit / trial',
              status: 'warn',
              detail: `${credit.label ?? credit.kind} ends in ${days} day(s).`,
              fix: 'certen fund <amount> --chain base-sepolia',
            }
            : {
              name: 'credit / trial',
              status: 'ok',
              detail: `${credit.label ?? credit.kind}${days !== null ? `, ${days} day(s) left` : ''}`,
            });
        }
      }

      const failed = checks.filter((c) => c.status === 'fail');
      const warned = checks.filter((c) => c.status === 'warn');

      // Emitted only when nothing failed. A failing run carries the same checks under
      // `error.details` instead, so the machine interface never has to choose between knowing
      // that something is broken and knowing what.
      //
      // JSON only: the table renderer serialises the check array to one unreadable line, and the
      // rendered summary below is the human answer. Table mode is not a contract, so the two
      // audiences get the form each can actually use.
      if (failed.length === 0 && !unreachable && isJsonMode()) {
        printOutput({ ok: true, checks } as unknown as Record<string, unknown>);
      }

      if (!isJsonMode()) {
        if (opts.all) {
          human('');
          for (const check of checks) {
            const mark = { ok: ' ok ', fail: 'FAIL', warn: 'warn', skipped: ' -- ' }[check.status];
            human(`  [${mark}] ${check.name.padEnd(26)} ${check.detail}`);
            if (check.fix && check.status !== 'ok') human(`           ${check.fix}`);
          }
          human('');
        } else if (failed.length > 0) {
          // One problem, one fix. Everything after the first failure is either caused by it or
          // cannot be evaluated until it is resolved.
          const first = failed[0];
          human('');
          human(`  ${first.name}: ${first.detail}`);
          if (first.fix) {
            human('');
            human(`  Fix:  ${first.fix}`);
          }
          human('');
          if (failed.length > 1) hint(`${failed.length - 1} further problem(s). See them all: certen doctor --all`);
        } else if (warned.length > 0) {
          human('');
          human('  Everything essential is working. Worth knowing:');
          for (const warn of warned) {
            human(`    ${warn.name}: ${warn.detail}`);
            if (warn.fix) human(`      ${warn.fix}`);
          }
          human('');
        } else {
          human('');
          human('  Everything checks out.');
          human('');
          hint('Next: certen tx create --identity <id> --to-chain base-sepolia --to <addr> --amount <n> --sign-with <key>');
        }
      }

      if (unreachable) {
        // Exit 3, not 1: nothing was submitted and a retry is worth attempting. That is the same
        // promise every other command makes for an unreachable gateway.
        throw new CliError(
          `The gateway at ${apiUrl} could not be reached.`,
          'NETWORK_ERROR',
          EXIT.UNREACHABLE,
          true,
          { checks },
        );
      }
      if (failed.length > 0) {
        throw new CliError(
          `${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`,
          'DOCTOR_CHECKS_FAILED',
          EXIT.FAILED,
          false,
          { checks },
        );
      }
    });
}
