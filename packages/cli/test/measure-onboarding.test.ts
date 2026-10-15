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
 * **Phase 2 moved one line, on purpose: `doctor` costs 8 round trips, not 6.** It now also checks the identity and chain in the context
 * (the same checks as `certen status`), which is two more reads: the identity (for the key page and the credits) and the key page itself
 * from Accumulate. The chain registry it needs, it already read. That is what makes `published` 37 and `context` 36 (they were 35 and 34).
 * Every other line is exactly as it was measured, which is the evidence that nothing else changed.
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
    round_trips: 37,
    per_step: [
      ['certen --version', 0],
      ['certen chains --refresh', 1],
      ['certen auth login --api-key - --no-keyring', 1],
      ['certen whoami', 2],
      ['certen init --name journey-probe --chains base-sepolia --key dev', 4],
      ['certen identity list', 1],
      ['certen identity get {identity_id}', 1],
      ['certen portfolio', 1],
      ['certen doctor', 8],
      ['certen keys show dev', 0],
      ['certen balance', 1],
      ['certen tx create --identity {identity_id} --to-chain base-sepolia --from {abstract_account} --to {recipient} --amount 0.0001 --sign-with dev --wait --timeout 6', 5],
      ['certen tx status {intent_id}', 1],
      ['certen proof get {intent_id}', 2],
      ['certen proof verify {intent_id}', 4],
      ['certen proof verify {intent_id} --rpc {rpc_url}', 5],
    ],
  },
  /**
   * The same transaction on the Phase 1 CLI. It differs from `published` in exactly what Phase 1 changed: `identity get` and
   * `tx create` take the identity from the context, `tx create` derives `--from` and the chain, and one identity read now serves
   * the ADI, the account and the funding guard (5 round trips become 4). The identity UUID is no longer copied by hand (5 values
   * become 4); the abstract account is still copied once, to fund it, which is Phase 3's.
   */
  context: {
    round_trips: 36,
    per_step: [
      ['certen --version', 0],
      ['certen chains --refresh', 1],
      ['certen auth login --api-key - --no-keyring', 1],
      ['certen whoami', 2],
      ['certen init --name journey-probe --chains base-sepolia --key dev', 4],
      ['certen identity list', 1],
      ['certen identity get', 1],
      ['certen portfolio', 1],
      ['certen doctor', 8],
      ['certen keys show dev', 0],
      ['certen balance', 1],
      ['certen tx create --to {recipient} --amount 0.0001 --sign-with dev --wait --timeout 6m', 4],
      ['certen tx status {intent_id}', 1],
      ['certen proof get {intent_id}', 2],
      ['certen proof verify {intent_id}', 4],
      ['certen proof verify {intent_id} --rpc {rpc_url}', 5],
    ],
  },
  /**
   * The same transaction once `certen status` exists. It replaces the six steps that find, copy and compare the key page (`identity list`,
   * `identity get`, `portfolio`, `doctor`, `keys show`, the hand-written curl) and the balance check, and it runs twice: once to see what is in
   * the way (the new account has no gas, so it exits 1 on purpose, for that reason and no other), and once to see everything green.
   */
  readiness: {
    round_trips: 32,
    per_step: [
      ['certen --version', 0],
      ['certen chains --refresh', 1],
      ['certen auth login --api-key - --no-keyring', 1],
      ['certen whoami', 2],
      ['certen init --name journey-probe --chains base-sepolia --key dev', 4],
      ['certen status --amount 0.0001', 4],
      ['certen status --amount 0.0001', 4],
      ['certen tx create --to {recipient} --amount 0.0001 --sign-with dev --wait --timeout 6m', 4],
      ['certen tx status {intent_id}', 1],
      ['certen proof get {intent_id}', 2],
      ['certen proof verify {intent_id}', 4],
      ['certen proof verify {intent_id} --rpc {rpc_url}', 5],
    ],
  },
  /**
   * The same transaction once `certen setup` exists. One command makes the key, the account, the identity and the readiness card (it replaces
   * the gateway check, the sign-in, init and status), and it runs twice, as a person would who cannot fund the account on the spot: the first
   * run exits 1 on purpose (everything is made, and the new account has no gas), the second skips all of it. Round trips are the same 32 as
   * `readiness`: what changed is the number of commands and what each one asks the person to do.
   */
  setup: {
    round_trips: 32,
    per_step: [
      ['certen setup --yes --new-account --org-name journey --name journey-probe --chain base-sepolia --no-keyring', 9],
      ['certen setup --yes --no-keyring', 7],
      ['certen tx create --to {recipient} --amount 0.0001 --sign-with dev --wait --timeout 6m', 4],
      ['certen tx status {intent_id}', 1],
      ['certen proof get {intent_id}', 2],
      ['certen proof verify {intent_id}', 4],
      ['certen proof verify {intent_id} --rpc {rpc_url}', 5],
    ],
  },
  /**
   * One setup that WAITS for the gas, so there is no second run. Its 16 round trips include the polls (the identity read, once per interval
   * while the funds were on their way: five more than the 9 of a setup that does not wait), which is the cost of not typing the command again.
   */
  'setup-wait': {
    round_trips: 32,
    per_step: [
      ['certen setup --yes --new-account --org-name journey --name journey-probe --chain base-sepolia --no-keyring --wait-for-funds --poll-interval 0.2 --funds-timeout 10s', 16],
      ['certen tx create --to {recipient} --amount 0.0001 --sign-with dev --wait --timeout 6m', 4],
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
    expect(r.stderr).toContain('context');
    expect(r.stderr).toContain('readiness');
    expect(r.stderr).toContain('setup-wait');
  });

  it('refuses a --fault it does not know, rather than running a clean journey and calling it a fault run', async () => {
    const r = await measure(['--journey', 'guide', '--fault', 'cannot-sing']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot-sign');
    expect(r.stderr).toContain('key-page-lacks-key');
    expect(r.stderr).toContain('funds-never-arrive');
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

  it('context: the same transaction on the Phase 1 CLI. The identity, chain and abstract account come from the context', async () => {
    const r = await measureOnce('--journey', 'context', '--json');
    expect(r.code, r.stderr).toBe(0);
    const rep = report(r);

    expect(rep.journey).toBe('context');
    expect(rep.totals.all_steps_as_declared).toBe(true);
    for (const s of certenSteps(rep)) expect(s.ok, `${s.label}: ${s.command}`).toBe(true);

    // Same shape as the published journey: Phase 1 changes what each step costs and what has to be copied, not how many steps there are.
    expect(rep.totals.commands).toBe(16);
    expect(rep.totals.external).toBe(5);
    // Before: identity_id, adi_url, key_page_url, abstract_account, intent_id. The identity UUID is gone.
    expect(rep.totals.values_copied).toEqual(['adi_url', 'key_page_url', 'abstract_account', 'intent_id']);
    expect(rep.totals.compared_by_eye).toEqual(['key_hash']);
    expect(rep.totals.passphrase_prompts).toBe(2);
    expect(rep.totals.round_trips).toBe(BASELINE.context.round_trips);
    expect(certenSteps(rep).map((s) => [s.command, s.round_trips])).toEqual(BASELINE.context.per_step);

    // It is strictly cheaper than the published journey, and by exactly the read that tx create no longer repeats.
    const published = report(await measureOnce('--journey', 'published', '--json'));
    expect(rep.totals.round_trips).toBe(published.totals.round_trips - 1);
    expect(rep.totals.values_copied.length).toBe(published.totals.values_copied.length - 1);
  }, 290_000);

  it('readiness: the same transaction once status reads the key page. No curl, no key compared by eye, two values copied', async () => {
    const r = await measureOnce('--journey', 'readiness', '--json');
    expect(r.code, r.stderr).toBe(0);
    const rep = report(r);

    expect(rep.journey).toBe('readiness');
    expect(rep.totals.all_steps_as_declared).toBe(true);
    for (const s of certenSteps(rep)) expect(s.ok, `${s.label}: ${s.command}`).toBe(true);

    // 16 commands become 12: identity list, identity get, portfolio, doctor, keys show and balance are replaced by two runs of status, and
    // the hand-written curl is gone from the outside-the-CLI steps (install, fund, the effect check remain).
    expect(rep.totals.commands).toBe(12);
    expect(rep.totals.external).toBe(3);
    // The ADI and key page URL existed only to feed the curl, and the key hash only to be compared with it by eye.
    expect(rep.totals.values_copied).toEqual(['abstract_account', 'intent_id']);
    expect(rep.totals.compared_by_eye).toEqual([]);
    expect(rep.totals.passphrase_prompts).toBe(2);
    expect(rep.totals.round_trips).toBe(BASELINE.readiness.round_trips);
    expect(certenSteps(rep).map((s) => [s.command, s.round_trips])).toEqual(BASELINE.readiness.per_step);

    // Cheaper than the journey it improves on, in commands, copied values and round trips.
    const context = report(await measureOnce('--journey', 'context', '--json'));
    expect(rep.totals.commands).toBeLessThan(context.totals.commands);
    expect(rep.totals.values_copied.length).toBeLessThan(context.totals.values_copied.length);
    expect(rep.totals.round_trips).toBeLessThan(context.totals.round_trips);
  }, 290_000);

  it('setup: one command does the front of the walkthrough. 7 commands, not 12; no auth login, whoami, init, status or chains check', async () => {
    const r = await measureOnce('--journey', 'setup', '--json');
    expect(r.code, r.stderr).toBe(0);
    const rep = report(r);

    expect(rep.journey).toBe('setup');
    expect(rep.totals.all_steps_as_declared).toBe(true);
    for (const s of certenSteps(rep)) expect(s.ok, `${s.label}: ${s.command}`).toBe(true);

    // 12 commands become 7: `chains --refresh`, `auth login`, `whoami`, `init` and the two `status` runs are two runs of `setup`.
    expect(rep.totals.commands).toBe(7);
    expect(rep.totals.external).toBe(3); // install, fund, the effect check
    // The faucet needs the address pasted: still copied once. The intent id is Phase 4's.
    expect(rep.totals.values_copied).toEqual(['abstract_account', 'intent_id']);
    expect(rep.totals.compared_by_eye).toEqual([]);
    expect(rep.totals.passphrase_prompts).toBe(2);
    expect(rep.totals.round_trips).toBe(BASELINE.setup.round_trips);
    expect(certenSteps(rep).map((s) => [s.command, s.round_trips])).toEqual(BASELINE.setup.per_step);

    // The first run exits 1 because the account has no gas, and the second is ready: the pair a person runs when they cannot fund it at once.
    const setups = certenSteps(rep).filter((s) => s.command!.startsWith('certen setup'));
    expect(setups.map((s) => s.exit)).toEqual([1, 0]);
    // It is cheaper than the journey it improves on, in commands, and no dearer in round trips.
    const readiness = report(await measureOnce('--journey', 'readiness', '--json'));
    expect(rep.totals.commands).toBeLessThan(readiness.totals.commands);
    expect(rep.totals.round_trips).toBeLessThanOrEqual(readiness.totals.round_trips);
  }, 290_000);

  it('setup-wait: one setup that waits for the gas. 6 commands, and the gas arrives while it polls', async () => {
    const r = await measureOnce('--journey', 'setup-wait', '--json');
    expect(r.code, r.stderr).toBe(0);
    const rep = report(r);

    expect(rep.journey).toBe('setup-wait');
    expect(rep.totals.all_steps_as_declared).toBe(true);
    for (const s of certenSteps(rep)) expect(s.ok, `${s.label}: ${s.command}`).toBe(true);

    expect(rep.totals.commands).toBe(6);
    expect(rep.totals.external).toBe(3);
    expect(rep.totals.values_copied).toEqual(['abstract_account', 'intent_id']);
    expect(rep.totals.round_trips).toBe(BASELINE['setup-wait'].round_trips);
    expect(certenSteps(rep).map((s) => [s.command, s.round_trips])).toEqual(BASELINE['setup-wait'].per_step);

    // It waited: more reads of the identity than a setup that does not, and it exited 0 in one run.
    const setup = report(await measureOnce('--journey', 'setup', '--json'));
    const waiting = certenSteps(rep)[0]!;
    const first = certenSteps(setup)[0]!;
    expect(waiting.exit).toBe(0);
    expect(waiting.round_trips!).toBeGreaterThan(first.round_trips!);
    expect(rep.totals.commands).toBe(setup.totals.commands - 1);
  }, 290_000);

  it('status reads the key page from the Accumulate stand-in, with no CERTEN credential, and is blocked on the gas before funding and on nothing else', async () => {
    const rep = report(await measureOnce('--journey', 'readiness', '--json'));
    const statuses = certenSteps(rep).filter((s) => s.command!.startsWith('certen status'));
    expect(statuses).toHaveLength(2);
    // Before funding: exit 1, and the step is only "as declared" because the failure was the gas (the journey says so, not just the exit).
    expect(statuses[0]!.exit).toBe(1);
    expect(statuses[1]!.exit).toBe(0);
    for (const s of statuses) expect(s.endpoints).toContain('POST /acc/v3');
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
  it('exits 1 and names the reason when the Accumulate node lists a different key than the identity was created with', async () => {
    const r = await measureOnce('--journey', 'readiness', '--fault', 'key-page-lacks-key', '--json');
    expect(r.code).toBe(1);
    const rep = report(r);
    expect(rep.totals.all_steps_as_declared).toBe(false);
    const bad = certenSteps(rep).filter((s) => !s.ok);
    expect(bad.map((s) => s.command)).toEqual(['certen status --amount 0.0001', 'certen status --amount 0.0001']);
    // The first of the two was declared to fail, and did: but for the wrong reason, which is what is reported.
    expect((bad[0] as unknown as { reason: string }).reason).toMatch(/first_blocker\.name to be "gas", got "key page"/);
    expect((bad[1] as unknown as { reason: string }).reason).toMatch(/KEY_PAGE_DISAGREES|does not list your key/);
  }, 290_000);

  it('exits 1 and names the reason when the gas never arrives while setup waits', async () => {
    const r = await measureOnce('--journey', 'setup-wait', '--fault', 'funds-never-arrive', '--json');
    expect(r.code).toBe(1);
    const rep = report(r);
    expect(rep.totals.all_steps_as_declared).toBe(false);
    const bad = certenSteps(rep).filter((s) => !s.ok);
    // The setup step is the first to go wrong, for the declared reason: it waited, and the funds did not come.
    expect(bad[0]!.command).toMatch(/^certen setup .* --wait-for-funds/);
    expect((bad[0] as unknown as { reason: string }).reason).toMatch(/FUNDS_WAIT_TIMEOUT/);
  }, 290_000);

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
