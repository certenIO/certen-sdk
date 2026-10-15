import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/measure-onboarding.mjs --journey`: the number the CLI UX plan is judged against.
 *
 * The plan sets targets for the first-transaction journey (commands, round trips, values copied by hand)
 * and says each phase must show before and after. A measurement that cannot be reproduced offline, or that
 * cannot go red, is a claim with nothing behind it, so this pins three things:
 *
 *   1. what is measured: the documented journeys, run through the real built CLI, against a fake gateway,
 *      in a throwaway HOME, with the network and the real ~/.certen out of reach;
 *   2. the baseline numbers themselves. They are pinned exactly, on purpose. A phase that improves one
 *      must change BASELINE below in the same PR, and the diff is the before/after the plan asks for;
 *   3. that the harness fails when a step does not behave as declared (`--fault`), because a harness that
 *      reports green for a broken journey is worse than none.
 *
 * The journeys sign and create identities, so they run only against the in-process fake: combining
 * `--journey` with `--url` is refused. Live runs are the human's (see the e2e-onboarding workflow).
 *
 * Wall-clock is reported but never pinned: it is the one number here that depends on the machine.
 */

/**
 * The baseline, measured on origin/main 558608f (sdk/cli 0.10.0) before any change in the CLI UX plan.
 *
 * Round trips are what reached the fake gateway for each `certen` command, in journey order. When a phase
 * changes one, edit it here and quote before and after in the PR body. Anything that gets worse than a
 * line below needs a reason in the PR.
 */
const BASELINE = {
  guide: {
    round_trips: 11,
    per_step: [
      ['certen auth login --api-key - --no-keyring', 1],
      ['certen init --name journey-probe --chains base-sepolia --key dev', 4],
      ['certen call --identity {identity_id} --chain base-sepolia --to {contract} --fn confirm(bytes32) --arg {arg32} --sign-with dev --wait', 4],
      ['certen proof get {intent_id}', 2],
    ],
  },
  published: {
    round_trips: 35,
    per_step: [
      ['certen --version', 0],
      ['certen chains --refresh', 1],
      ['certen auth login --api-key - --no-keyring', 1],
      ['certen whoami', 2],
      ['certen init --name journey-probe --chains base-sepolia --key dev', 4],
      ['certen identity list', 1],
      ['certen identity get {identity_id}', 1],
      ['certen portfolio', 1],
      ['certen doctor', 6],
      ['certen keys show dev', 0],
      ['certen balance', 1],
      ['certen tx create --identity {identity_id} --to-chain base-sepolia --from {abstract_account} --to {recipient} --amount 0.0001 --sign-with dev --wait --timeout 6', 5],
      ['certen tx status {intent_id}', 1],
      ['certen proof get {intent_id}', 2],
      ['certen proof verify {intent_id}', 4],
      ['certen proof verify {intent_id} --rpc {rpc_url}', 5],
    ],
  },
} as const;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'measure-onboarding.mjs');
const run = promisify(execFile);

interface Step {
  label: string;
  kind: 'certen' | 'external';
  command?: string;
  ok: boolean;
  exit?: number;
  round_trips?: number;
  endpoints?: string[];
  uses?: string[];
}
interface Report {
  journey: string;
  source: string;
  home: string;
  steps: Step[];
  totals: {
    commands: number;
    external: number;
    round_trips: number;
    values_copied: string[];
    compared_by_eye: string[];
    passphrase_prompts: number;
    all_steps_as_declared: boolean;
  };
}
interface Out { stdout: string; stderr: string; code: number }

async function measure(args: string[]): Promise<Out> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], {
      // Credentials and a base URL that would be fatal if the script honoured them: the journey must
      // ignore both, and talk only to its own fake.
      env: { ...(process.env as Record<string, string>), CERTEN_API_KEY: 'ck_live_must_not_be_used', CERTEN_API_URL: 'http://127.0.0.1:1' },
      encoding: 'utf8',
      timeout: 280_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : -1 };
  }
}

/** Each distinct run once: a journey drives a dozen subprocesses, and three tests read the same one. */
const runs = new Map<string, Promise<Out>>();
function measureOnce(...args: string[]): Promise<Out> {
  const key = args.join(' ');
  if (!runs.has(key)) runs.set(key, measure(args));
  return runs.get(key)!;
}
const report = (o: Out): Report => JSON.parse(o.stdout.trim()) as Report;
const certenSteps = (rep: Report): Step[] => rep.steps.filter((s) => s.kind === 'certen');

describe('--journey refuses what would be unsafe or unclear', () => {
  it('will not run a journey against a live gateway: it signs and creates identities', async () => {
    const r = await measure(['--journey', 'guide', '--url', 'https://gateway.example']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/offline|fake gateway/i);
  });

  it('names the journeys it knows when given one it does not', async () => {
    const r = await measure(['--journey', 'nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('guide');
    expect(r.stderr).toContain('published');
  });

  it('refuses a --fault it does not know, rather than running a clean journey and calling it a fault run', async () => {
    const r = await measure(['--journey', 'guide', '--fault', 'cannot-sing']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot-sign');
  });
});

describe('the baseline: the documented first-transaction journeys, as they are today', () => {
  it('guide: login, init, call, proof get (docs/guides/first-proof-in-three-commands.md)', async () => {
    const r = await measureOnce('--journey', 'guide', '--json');
    expect(r.code, r.stderr).toBe(0);
    const rep = report(r);

    expect(rep.journey).toBe('guide');
    expect(rep.source).toMatch(/first-proof-in-three-commands/);
    // Every step behaved as the journey declares: nothing was waved through on an exit code alone.
    expect(rep.totals.all_steps_as_declared).toBe(true);
    for (const s of certenSteps(rep)) expect(s.ok, `${s.label}: ${s.command}`).toBe(true);

    expect(rep.totals.commands).toBe(4);
    expect(rep.totals.external).toBe(1); // npm install
    expect(rep.totals.values_copied).toEqual(['identity_id', 'intent_id']);
    expect(rep.totals.passphrase_prompts).toBe(2); // init creates the key, call unlocks it
    expect(rep.totals.round_trips).toBe(BASELINE.guide.round_trips);
    expect(certenSteps(rep).map((s) => [s.command, s.round_trips])).toEqual(BASELINE.guide.per_step);
  }, 290_000);

  it('published: the 12-step walkthrough as PLAN section 1 transcribes it', async () => {
    const r = await measureOnce('--journey', 'published', '--json');
    expect(r.code, r.stderr).toBe(0);
    const rep = report(r);

    expect(rep.journey).toBe('published');
    expect(rep.source).toMatch(/PLAN/);
    expect(rep.totals.all_steps_as_declared).toBe(true);
    for (const s of certenSteps(rep)) expect(s.ok, `${s.label}: ${s.command}`).toBe(true);

    // The plan's own figures: "about 17 commands, one raw JSON-RPC call, five values copied by hand".
    // The 16 certen commands plus the install are the 17; the curl, the faucet, the wallet transfer and
    // the final by-hand check are the work that is not a certen command at all.
    expect(rep.totals.commands).toBe(16);
    expect(rep.totals.external).toBe(5);
    expect(rep.totals.values_copied).toEqual(['identity_id', 'adi_url', 'key_page_url', 'abstract_account', 'intent_id']);
    // The key hash is read off `keys show` and checked by eye against the key page, which the plan does
    // not count as a copied value.
    expect(rep.totals.compared_by_eye).toEqual(['key_hash']);
    expect(rep.totals.passphrase_prompts).toBe(2);
    expect(rep.totals.round_trips).toBe(BASELINE.published.round_trips);
    expect(certenSteps(rep).map((s) => [s.command, s.round_trips])).toEqual(BASELINE.published.per_step);
  }, 290_000);

  it('the proof steps checked real fixtures: an honest PARTIAL (exit 4), not a canned verdict', async () => {
    const rep = report(await measureOnce('--journey', 'published', '--json'));
    const verifies = certenSteps(rep).filter((s) => s.command!.startsWith('certen proof verify'));
    expect(verifies).toHaveLength(2);
    // Same fixtures, same verdict as proof-verify.test.ts: the page chains of the capture are unbound.
    for (const v of verifies) expect(v.exit).toBe(4);
  }, 290_000);
});

describe('isolation', () => {
  it('runs in a throwaway HOME that is gone afterwards, and ignores CERTEN_API_KEY / CERTEN_API_URL', async () => {
    const r = await measureOnce('--journey', 'guide', '--json');
    expect(r.code, r.stderr).toBe(0);
    const rep = report(r);
    expect(rep.home).toMatch(/certen-measure-/);
    expect(existsSync(rep.home)).toBe(false);
    // The only endpoints touched are the fake's: every step carries round trips to a 127.0.0.1 server,
    // which is what the 'CERTEN_API_URL=http://127.0.0.1:1' in this test's environment would have refused.
    for (const s of certenSteps(rep)) expect(s.ok).toBe(true);
  }, 290_000);

  it('refuses a journey whose login would write the real OS keyring', async () => {
    // The OS keyring is per-user, not per-HOME: a login that does not say --no-keyring would overwrite the
    // developer's real stored key with the fake one, whatever HOME the child is given.
    const mod = (await import('../../../scripts/lib/onboarding-journeys.mjs')) as {
      JOURNEYS: Record<string, unknown>;
      assertJourneyIsContained: (name: string, journey: unknown) => void;
    };
    for (const [name, journey] of Object.entries(mod.JOURNEYS)) {
      expect(() => mod.assertJourneyIsContained(name, journey), name).not.toThrow();
    }
    const login = { steps: [{ label: 'Sign in', args: ['auth', 'login', '--api-key', '-'] }] };
    expect(() => mod.assertJourneyIsContained('uncontained', login)).toThrow(/--no-keyring/);
    const signup = { steps: [{ label: 'Sign up', args: ['signup', '--with-key', 'dev'] }] };
    expect(() => mod.assertJourneyIsContained('uncontained', signup)).toThrow(/--no-keyring/);
  });
});

describe('the harness can go red', () => {
  it('exits 1 and names the step when an identity that cannot sign makes a step misbehave', async () => {
    const r = await measureOnce('--journey', 'guide', '--fault', 'cannot-sign', '--json');
    expect(r.code).toBe(1);
    const rep = report(r);
    expect(rep.totals.all_steps_as_declared).toBe(false);
    const bad = certenSteps(rep).filter((s) => !s.ok);
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0]!.command).toMatch(/init/);
  }, 290_000);
});
