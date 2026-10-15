/**
 * Run a documented journey through the real built CLI, against the fake gateway, and report what it cost.
 *
 * Used by `measure-onboarding --journey`. See onboarding-journeys.mjs for what is measured and what is
 * declared, and fake-gateway.mjs for what it talks to.
 *
 * Containment is the point of the structure here, because these journeys create keys, log in and sign:
 *
 *   - every child gets a throwaway HOME *and* USERPROFILE (`os.homedir()` reads USERPROFILE on Windows,
 *     so setting only HOME would write the developer's real ~/.certen);
 *   - every CERTEN_* variable of the caller is dropped, so a real API key or base URL in the environment
 *     cannot reach a child; the only base URL a child sees is the fake's;
 *   - the OS keyring is per-user, not per-HOME, so a login step must pass --no-keyring or the journey is
 *     refused before anything runs;
 *   - nothing here opens a socket to anything but the fake, on 127.0.0.1.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeGateway, FAULTS } from './fake-gateway.mjs';
import { JOURNEYS, GIVEN, copiedBy, assertJourneyIsContained } from './onboarding-journeys.mjs';

const FAKE_API_KEY = 'ck_live_journey_probe_not_a_real_key';
/** Answers every passphrase prompt, so a run never blocks. The prompts themselves are counted from the journey. */
const PASSPHRASE = 'measure-onboarding-passphrase';

function pathGet(obj, path) {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

function runCli(cli, args, env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.on('error', () => { /* a command that never reads stdin closes the pipe; that is fine */ });
    child.stdin.end(stdin ?? '');
  });
}

/** The caller's environment with every CERTEN_* variable removed, then ours added. */
function childEnv(home, apiUrl) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CERTEN_') && v !== undefined) env[k] = v;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CERTEN_API_URL: apiUrl,
    CERTEN_KEY_PASSPHRASE: PASSPHRASE,
    // The SDK talks through axios, which honours HTTP_PROXY: a proxy in the caller's environment would be
    // handed requests for 127.0.0.1 that it cannot serve, and the run would fail for a reason that has
    // nothing to do with the CLI. Loopback is never proxied.
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

/**
 * @returns {Promise<{ exitCode: number, report: object }>} exit 0 when every step behaved as declared, 1 when
 *   one did not, 2 when the request itself was wrong (unknown journey, an uncontained journey).
 */
export async function runJourney({ name, cli, fault }) {
  const journey = JOURNEYS[name];
  if (!journey) {
    return {
      exitCode: 2,
      report: { error: `unknown journey "${name}". Known: ${Object.keys(JOURNEYS).join(', ')}` },
    };
  }
  // A typo'd fault would run a clean journey and report it as a fault run: green for the wrong reason.
  if (fault !== undefined && !FAULTS.includes(fault)) {
    return { exitCode: 2, report: { error: `unknown fault "${fault}". Known: ${FAULTS.join(', ')}` } };
  }
  try {
    assertJourneyIsContained(name, journey);
  } catch (err) {
    return { exitCode: 2, report: { error: err.message } };
  }

  const home = mkdtempSync(join(tmpdir(), 'certen-measure-'));
  const fake = await startFakeGateway({ fault });
  try {
    const env = childEnv(home, fake.url);
    const given = { ...GIVEN, rpc_url: fake.rpcUrl };
    /** Values remembered from earlier steps' output: the ones a person would copy. */
    const captured = {};
    const steps = [];
    const copied = [];
    const compared = [];
    let promptTotal = 0;

    for (const step of journey.steps) {
      for (const n of copiedBy(step, given)) if (!copied.includes(n)) copied.push(n);
      for (const n of step.compares ?? []) if (!compared.includes(n)) compared.push(n);

      if (step.external) {
        if (step.effect === 'fund') fake.fundAbstractAccount();
        steps.push({
          label: step.label, kind: 'external', description: step.description, ok: true,
          ...(step.uses ? { uses: step.uses } : {}), ...(step.compares ? { compares: step.compares } : {}),
        });
        continue;
      }

      const values = { ...given, ...captured };
      const missing = [];
      const args = step.args.map((a) => a.replace(/\{([a-z_0-9]+)\}/g, (_m, n) => {
        if (values[n] === undefined) missing.push(n);
        return values[n] ?? `{${n}}`;
      }));
      const command = `certen ${step.args.join(' ')}`;
      const base = {
        label: step.label, kind: 'certen', command,
        ...(step.substitutes ? { substitutes: step.substitutes } : {}),
        ...(placeholdersUsed(step, given).length ? { uses: placeholdersUsed(step, given) } : {}),
        prompts: step.prompts ?? 0,
      };
      promptTotal += step.prompts ?? 0;

      if (missing.length > 0) {
        // A value the journey says it took from an earlier step, which that step never printed. Reported,
        // never invented: a journey that cites output the CLI does not give is wrong, and says so.
        fake.take();
        steps.push({ ...base, ok: false, reason: `needs ${missing.join(', ')} from an earlier step, which did not produce it` });
        continue;
      }

      const t0 = Date.now();
      const { code, out, err } = await runCli(cli, step.noJson ? args : ['--json', ...args], env, step.stdin === 'API_KEY' ? FAKE_API_KEY : step.stdin);
      const ms = Date.now() - t0;
      const seen = fake.take();

      const wanted = step.exit ?? [0];
      const problems = [];
      if (!wanted.includes(code)) problems.push(`exited ${code}, declared ${wanted.join('/')}${errorOf(out)}`);
      const unrouted = seen.filter((r) => r.unrouted).map((r) => `${r.method} ${r.path}`);
      if (unrouted.length > 0) problems.push(`the fake gateway has no route for: ${[...new Set(unrouted)].join(', ')}`);

      if (step.capture && problems.length === 0) {
        let data;
        try { data = JSON.parse(out.trim()).data; } catch { data = undefined; }
        for (const [n, path] of Object.entries(step.capture)) {
          const v = data === undefined ? undefined : pathGet(data, path);
          if (typeof v === 'string' && v.length > 0) captured[n] = v;
          else problems.push(`expected "${path}" in the output to carry ${n}, and it did not`);
        }
      }

      steps.push({
        ...base,
        exit: code,
        ms,
        round_trips: seen.length,
        endpoints: [...new Set(seen.map((r) => `${r.method} ${r.path}`))],
        ok: problems.length === 0,
        ...(problems.length ? { reason: problems.join('; '), stderr: err.trim().split('\n').slice(-3).join(' | ') } : {}),
      });
    }

    const certenSteps = steps.filter((s) => s.kind === 'certen');
    const report = {
      journey: name,
      source: journey.source,
      summary: journey.summary,
      fault: fault ?? null,
      home,
      steps,
      totals: {
        commands: certenSteps.length,
        external: steps.length - certenSteps.length,
        round_trips: certenSteps.reduce((n, s) => n + (s.round_trips ?? 0), 0),
        ms: certenSteps.reduce((n, s) => n + (s.ms ?? 0), 0),
        values_copied: copied,
        compared_by_eye: compared,
        passphrase_prompts: promptTotal,
        all_steps_as_declared: steps.every((s) => s.ok),
      },
    };
    return { exitCode: report.totals.all_steps_as_declared ? 0 : 1, report };
  } finally {
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/** In --json mode a failure's reason is in the stdout envelope, not on stderr: say what the CLI said. */
function errorOf(stdout) {
  try {
    const e = JSON.parse(stdout.trim()).error;
    return e ? ` (${e.code}: ${String(e.message).slice(0, 160)})` : '';
  } catch {
    return '';
  }
}

function placeholdersUsed(step, given) {
  return copiedBy(step, given).filter((n) => (step.args ?? []).some((a) => a.includes(`{${n}}`)));
}

/** A plain-text table for a person; `--json` is for machines. */
export function renderJourney(report) {
  const lines = [];
  lines.push('');
  lines.push(`journey: ${report.journey}  (${report.summary})`);
  lines.push(`source:  ${report.source}`);
  lines.push('offline: real CLI, fake gateway, throwaway HOME. Round trips are what reached the fake.');
  lines.push('');
  lines.push(`   #  ${'STEP'.padEnd(40)} ${'CALLS'.padStart(5)}  ${'MS'.padStart(6)}  COMMAND`);
  report.steps.forEach((s, i) => {
    const n = String(i + 1).padStart(4);
    if (s.kind === 'external') {
      lines.push(`${n}  ${s.label.slice(0, 40).padEnd(40)} ${'-'.padStart(5)}  ${'-'.padStart(6)}  [not a certen command] ${s.description}`);
      return;
    }
    const flag = s.ok ? ' ' : '!';
    lines.push(`${flag}${n.slice(1)}  ${s.label.slice(0, 40).padEnd(40)} ${String(s.round_trips ?? 0).padStart(5)}  ${String(s.ms ?? 0).padStart(6)}  ${s.command}${s.substitutes ? `   (stands in for: ${s.substitutes})` : ''}`);
    if (!s.ok) lines.push(`        ${s.reason}${s.stderr ? `\n        stderr: ${s.stderr}` : ''}`);
  });
  const t = report.totals;
  lines.push('');
  lines.push(`  commands ${t.commands} · outside the CLI ${t.external} · round trips ${t.round_trips} · ${t.ms} ms`);
  lines.push(`  values copied by hand ${t.values_copied.length}${t.values_copied.length ? ` (${t.values_copied.join(', ')})` : ''}`
    + `${t.compared_by_eye.length ? ` · compared by eye: ${t.compared_by_eye.join(', ')}` : ''}`);
  lines.push(`  passphrase prompts ${t.passphrase_prompts} (declared by the journey, not observed)`);
  lines.push(t.all_steps_as_declared ? '  every step behaved as declared' : '  ! a step did not behave as declared (marked above)');
  lines.push('');
  return lines.join('\n');
}
