import { Command } from 'commander';
import { CertenClient, type DoctorCheck } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getPortalUrl } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { CliError, EXIT } from '../errors.js';
import { listKeys } from '../keystore.js';
import { faucetFor } from '../funding-guard.js';
import { normalizeChain } from '../chains.js';

/**
 * `certen doctor` — the one command a stuck user runs.
 *
 * The checks themselves live in the SDK (`client.doctor()`), because they are not a CLI concern:
 * every integration hits the same conditions, and two implementations of one diagnosis would
 * drift. What this command adds is the part the SDK cannot know — the state of THIS machine — and
 * the part the SDK should not decide: how to present it.
 *
 * The design constraint that shapes the presentation: **print the first blocking problem and its
 * fix, not a report.** A wall of seven results makes the reader do the triage, and the triage is
 * the part that needs expertise. Check 5 cannot be interpreted until check 2 passes, so showing
 * both at once is noise dressed as thoroughness.
 *
 * `--all` exists for when the whole picture genuinely is the question, and `--json` always returns
 * every check because a machine caller has no trouble reading seven of anything.
 */

type Check = DoctorCheck;

/** Checks that cannot run without a working credential, in the order they are reported. */
const CREDENTIALLED_CHECKS = [
  'identity can sign',
  'abstract accounts funded',
  'billing balance',
  'credit / trial',
] as const;

/**
 * Replace the SDK's generic remedies with the command that performs them here.
 *
 * The SDK says "Add funds." because it has no idea what is driving it. A terminal can say the
 * exact line to type, and a fix the reader can paste is worth more than a fix they have to
 * translate.
 */
function localizeFix(check: Check, chainHint: string, apiUrl: string): Check {
  // The URL belongs on this line whether it succeeded or failed: "am I even pointed at the right
  // gateway" is one of the first things a stuck user needs to rule out, and the SDK cannot say it
  // because it does not know what the caller configured.
  if (check.name === 'gateway reachable') {
    const detail = `${apiUrl} — ${check.detail}`;
    return check.status === 'ok'
      ? { ...check, detail }
      : {
        ...check,
        detail: `${apiUrl} did not answer: ${check.detail}`,
        fix: 'Check CERTEN_API_URL and your network. Nothing else can be diagnosed until this passes.',
      };
  }

  if (check.status === 'ok' || !check.fix) return check;
  switch (check.name) {
    case 'api key':
      return check.status === 'fail'
        ? { ...check, fix: `certen login   (or mint one at ${getPortalUrl()})` }
        : check;
    case 'identity can sign':
      return { ...check, fix: `certen init   (or: certen identity create --name <name> --sign-with <key> --chains ${chainHint} --wait)` };
    case 'abstract accounts funded': {
      // Name the faucets for the chains actually affected, rather than a generic instruction.
      const chains = [...check.detail.matchAll(/\b([a-z]+-[a-z]+)\b/g)].map((m) => normalizeChain(m[1]));
      const faucets = [...new Set(chains.map((c) => faucetFor(c)).filter(Boolean))];
      return { ...check, fix: faucets.length > 0 ? faucets.join('  ') : check.fix };
    }
    case 'billing balance':
    case 'credit / trial':
      return { ...check, fix: `certen fund <amount> --chain ${chainHint}` };
    default:
      return check;
  }
}

export function registerDoctorCommands(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose the setup and name the one thing blocking you')
    .option('--all', 'Show every check, not just the first problem')
    .action(async (opts: { all?: boolean }) => {
      const apiUrl = getApiUrl();
      const chainHint = 'base-sepolia';

      // ── the credential, resolved from THIS machine ────────────────────────────────────────────
      // The SDK is handed a key; only the CLI knows whether one is configured at all, and "no key"
      // needs a different fix from "the gateway rejected this key".
      let apiKey: string | null = null;
      let keyMissing = false;
      try {
        apiKey = await getApiKey();
      } catch {
        keyMissing = true;
      }

      const client = new CertenClient({ apiKey: apiKey ?? 'public', baseUrl: apiUrl });
      const report = await client.doctor();
      const checks: Check[] = report.checks.map((c) => localizeFix(c, chainHint, apiUrl));

      // The SDK probed with a placeholder key, so its verdict on a machine with no key at all is
      // not the one to show. Replace it, and skip everything that depends on it.
      if (keyMissing && !report.unreachable) {
        const index = checks.findIndex((c) => c.name === 'api key');
        checks[index] = {
          name: 'api key',
          status: 'fail',
          detail: 'No API key configured on this machine.',
          fix: `certen login   (or mint one at ${getPortalUrl()})`,
        };
        for (const name of CREDENTIALLED_CHECKS) {
          const at = checks.findIndex((c) => c.name === name);
          if (at >= 0) checks[at] = { name, status: 'skipped', detail: 'needs a working API key' };
        }
      }

      // ── the local signing key, which the SDK cannot see ───────────────────────────────────────
      // A question about this machine, so it is answered even when everything above failed.
      const local = listKeys();
      const localCheck: Check = local.length > 0
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
        };

      // Placed directly after the credential: both answer "can this machine act at all", and the
      // identity checks below are only meaningful once both do.
      const afterKey = checks.findIndex((c) => c.name === 'api key') + 1;
      checks.splice(afterKey, 0, localCheck);

      const failed = checks.filter((c) => c.status === 'fail');
      const warned = checks.filter((c) => c.status === 'warn');

      // Emitted only when nothing failed. A failing run carries the same checks under
      // `error.details` instead, so the machine interface never has to choose between knowing that
      // something is broken and knowing what.
      //
      // JSON only: the table renderer serialises the check array to one unreadable line, and the
      // rendered summary below is the human answer. Table mode is not a contract.
      if (failed.length === 0 && !report.unreachable && isJsonMode()) {
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
          hint('Next: certen call --identity <id> --chain base-sepolia --to <addr> --fn \'f()\' --sign-with <key> --wait');
        }
      }

      if (report.unreachable) {
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
