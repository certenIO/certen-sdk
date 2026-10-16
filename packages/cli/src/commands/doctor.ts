import { Command } from 'commander';
import {
  CertenClient, CREDENTIALLED_CHECKS, CONTEXT_CHECKS, type ChainsListResponse, type DoctorCheck, type ReadinessCheck,
} from '@certen.io/sdk';
import { getApiKey, getApiUrl, getPortalUrl } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { CliError, EXIT } from '../errors.js';
import { listKeys } from '../keystore.js';
import { faucetFor } from '../funding-guard.js';
import { normalizeChain, enabledChains } from '../chains.js';
import { resolveContext, echoFromContext, type ResolvedContext } from '../context.js';
import { resolveIdentityRef } from '../identity-ref.js';
import { localizeReadiness, signingKeyCheck } from '../readiness-render.js';

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
 *
 * **Scoped to the context.** The checks above are organization-wide. When the context names an identity and a chain (flag, environment,
 * profile, or the only candidate), the five checks about THAT pair are added: the identity, the chain, the key page, its credits and the gas on
 * the abstract account (see `certen status`, which shows the same ones as a card). Where a fix needs a chain it names the context's, or a
 * placeholder; it never names one nobody chose.
 */

type Check = DoctorCheck;

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
      return { ...check, fix: `certen setup   (or: certen identity create --name <name> --sign-with <key> --chains ${chainHint} --wait)` };
    case 'abstract accounts funded': {
      // Name the faucets for the chains actually affected, rather than a generic instruction.
      const chains = [...check.detail.matchAll(/\b([a-z]+-[a-z]+)\b/g)].map((m) => normalizeChain(m[1]));
      const faucets = [...new Set(chains.map((c) => faucetFor(c)).filter(Boolean))];
      // The command first: `gas` names the address, the amount and a wallet link, and waits for the funds. The faucets stay, for a reader who
      // wants somewhere to go.
      const command = `certen gas --chain ${chains[0] ?? chainHint} --wait`;
      return { ...check, fix: faucets.length > 0 ? `${command}   (faucet: ${faucets.join('  ')})` : command };
    }
    case 'billing balance':
    case 'credit / trial':
      return { ...check, fix: `certen fund <amount> --chain ${chainHint}` };
    default:
      return check;
  }
}

/**
 * The context, if there is one that can be read. Never throws: `doctor` is what a stuck person runs, and a context that is ambiguous or
 * unreadable is one of the things it is run to find out about, not a reason for it to fail before it starts.
 */
function readContext(flags: { identity?: string; chain?: string; signWith?: string }): ResolvedContext | undefined {
  try {
    return resolveContext({ identity: flags.identity, chain: flags.chain, key: flags.signWith });
  } catch {
    return undefined;
  }
}

/**
 * What a fix should say where it needs a chain: the context's, or a placeholder.
 *
 * This used to be one hardcoded testnet's slug, so a person on another chain was told to fund or link the wrong one, and a person on a
 * mainnet context was told to pay on a testnet. Nothing here knows which chain someone means unless the context says.
 */
function chainHintOf(ctx: ResolvedContext | undefined): string {
  return ctx?.chain?.value ?? '<chain>';
}

/** A readiness check in doctor's vocabulary. `unknown` has no place in it, and must not become a pass: it is a warning that says it could not confirm. */
function asDoctorCheck(c: ReadinessCheck): Check {
  // `doctor` has always reported an unfunded abstract account as a warning, not a failure: it is asked with no amount in mind, and a call that forwards
  // no value is unaffected. `certen status` asks "ready to move value?" and fails it; the same facts, a different question.
  const status = c.status === 'unknown' || (c.name === 'gas' && c.status === 'fail') ? 'warn' : c.status;
  const detail = c.status === 'unknown' ? `could not confirm: ${c.detail}` : c.detail;
  const fix = c.fix ? [c.fix.text, c.fix.command ? `(${c.fix.command})` : '', c.fix.url ?? ''].filter(Boolean).join('  ') : undefined;
  return { name: c.name, status, detail, ...(fix ? { fix } : {}) };
}

/**
 * The checks that are about the identity and chain in the context: the chain, the key page (read from Accumulate as well as from the
 * gateway), the key page's credits and the gas on the abstract account. The same ones `certen status` shows, from the same SDK call.
 *
 * Always the same five when a context names an identity and a chain, so the list is the same length however far the run got: when they cannot
 * be evaluated they are skipped, with the reason, not left out. (An identity that no longer resolves is one `context` warning instead.)
 */
async function contextChecks(args: {
  client: CertenClient;
  ctx: ResolvedContext | undefined;
  skip?: string;
  /** The registry `client.doctor()` already read, so it is not read twice. */
  registry?: ChainsListResponse;
}): Promise<Check[]> {
  const { client, ctx, skip, registry } = args;
  if (!ctx?.identity || !ctx.chain) {
    // Several candidates and none chosen is a question, not an absence: say so, so a missing section is not read as a clean one.
    if (ctx && !ctx.identity && ctx.candidates.identity.length > 1) {
      hint(`Several identities are recorded and none is chosen, so the identity-and-chain checks were not made. Check one: certen status --identity <ref>   (or choose it once: certen use identity <ref>)`);
    } else if (ctx?.identity && !ctx.chain && ctx.candidates.chain.length > 1) {
      hint(`This identity is linked to ${ctx.candidates.chain.join(', ')} and none is chosen, so the identity-and-chain checks were not made. Check one: certen status --chain <chain>`);
    }
    return [];
  }
  const skipped = (why: string): Check[] => (CONTEXT_CHECKS as readonly string[]).map((name) => ({ name, status: 'skipped' as const, detail: why }));
  if (skip) return skipped(skip);

  let identityId: string;
  let shown: string;
  try {
    const who = await resolveIdentityRef(ctx.identity.value, { client, need: 'id' });
    identityId = who.id!;
    shown = who.adi_url ?? identityId;
  } catch (err) {
    return [{
      name: 'context', status: 'warn',
      detail: `Could not resolve the identity from your context (${ctx.identity.value}): ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Choose one: certen use identity <ref>',
    }];
  }
  // Said on stderr, as everywhere a default the person did not type is used.
  echoFromContext('identity', ctx.identity, shown);
  echoFromContext('chain', ctx.chain);

  const key = signingKeyCheck({ name: ctx.key?.value, candidates: ctx.candidates.key });
  // A misconfigured CERTEN_ENABLED_CHAINS is a usage error everywhere else; here it must not stop the diagnosis that exists to find such things.
  let configuredChains: string[] | undefined;
  try { configuredChains = enabledChains(); } catch { configuredChains = undefined; }
  const r = await client.readiness({
    identityId, chain: ctx.chain.value, keyHash: key.keyHash, scope: 'context', configuredChains, registry,
  });
  return localizeReadiness(r.checks, { chain: ctx.chain.value, identityId, portalUrl: getPortalUrl(), keyName: ctx.key?.value }).map(asDoctorCheck);
}

export function registerDoctorCommands(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose the setup and name the one thing blocking you')
    .option('--all', 'Show every check, not just the first problem')
    .option('--identity <ref>', 'Also check this identity: UUID, ADI URL or name (default: your context, see `certen context`)')
    .option('--chain <chain>', 'Also check this chain (default: your context)')
    .option('--sign-with <key>', 'Local key the key page must hold (default: your context key, or your only key)')
    .action(async (opts: { all?: boolean; identity?: string; chain?: string; signWith?: string }) => {
      const apiUrl = getApiUrl();
      const ctx = readContext(opts);
      const chainHint = chainHintOf(ctx);

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
      const report = await client.doctor({ includeRegistry: true });
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

      // ── the identity and chain in the context ─────────────────────────────────────────────────
      // Everything above is organization-wide ("some identity can sign"). This is the question asked just before sending: THIS identity,
      // on THIS chain, with THIS key. Only when a context exists to name them; skipped, not omitted, when they cannot be evaluated.
      const credentialFailed = checks.find((c) => c.name === 'api key')?.status === 'fail';
      checks.push(...await contextChecks({
        client,
        ctx,
        skip: report.unreachable ? 'gateway unreachable' : keyMissing || credentialFailed ? 'needs a working API key' : undefined,
        registry: report.registry,
      }));

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
          // Only what the context does not already supply is left for the person to type. The chain is always spelled out: a chain that
          // came from a default is refused for a command that moves value unless it is a known testnet, and a hint must work as printed.
          // `send` is the first thing to do with a working setup (a contract call is the second, and `certen call --help` is one command away).
          const parts = [
            'certen send <amount> <asset>',
            ctx?.identity ? '' : '--identity <id>',
            `--chain ${chainHint}`,
            '--to <addr>',
            ctx?.key ? '' : '--sign-with <key>',
          ].filter(Boolean);
          hint(`Next: ${parts.join(' ')}`);
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
