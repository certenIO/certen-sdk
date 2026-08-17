#!/usr/bin/env node
/**
 * The whole first-run journey, from nothing, with nobody present.
 *
 *   signup (keypair) → identity → funding check → proof-gated call → verified proof
 *
 * This is the journey every customer walks and the only one with no automated coverage, because
 * until self-service signup landed its first step required a human in a browser. **Until this runs,
 * "onboarding works unattended" is argued rather than measured.**
 *
 * Deliberately a script rather than logic inside a workflow file. YAML cannot be run locally, cannot
 * be typechecked, and cannot be read by anyone debugging a failure at 3am — and this needs to be
 * runnable by hand against staging before it is ever trusted in CI.
 *
 *   node scripts/e2e-onboarding.mjs --url https://staging.example
 *   node scripts/e2e-onboarding.mjs --url … --contract 0xAbc…   # includes a real call + proof
 *
 * Keypair signup, not a registration token: nothing has to be handed to CI, which is the entire
 * reason that path exists. The key is generated per run and thrown away.
 *
 * Every step asserts a PROPERTY, not an exit code. A run that reports success because five commands
 * exited zero would pass against a gateway that created an identity which cannot sign and a proof
 * that does not verify — the two failures this journey exists to catch.
 *
 * Exit codes: 0 all asserted steps passed · 1 an assertion failed · 2 the run could not be set up.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const TARGET = (arg('url', process.env.CERTEN_API_URL ?? '') || '').replace(/\/+$/, '');
const CHAIN = arg('chain', 'base-sepolia');
const CONTRACT = arg('contract', '');
/**
 * A funded identity to run the proof cycle with, and the local key that signs for it.
 *
 * The proof cycle cannot run on the organization this script just created, and that is a fact about
 * chains rather than a gap in the tooling: a brand-new abstract account holds no gas, so its
 * execution leg parks at `anchoring` forever. Nothing the gateway or this script can do changes
 * that — somebody has to put testnet ETH in the account.
 *
 * So the journey splits honestly. Signup and identity creation run FROM NOTHING, which is the part
 * that was impossible until keypair signup existed. The proof cycle runs against an identity that is
 * kept funded, because that is the only way to exercise it repeatedly.
 *
 * A value transfer is used rather than a contract call: it exercises the same proof-gated path —
 * open, sign, submit, anchor, prove — and needs no contract ABI, so the check has one fewer external
 * dependency to go stale.
 */
const PROOF_IDENTITY = arg('proof-identity', '');
const PROOF_KEY = arg('sign-with', '');
const PROOF_FROM = arg('proof-from', '');
/**
 * How long to wait for provisioning, in minutes.
 *
 * Bounded explicitly because the unbounded case is a real trap: an identity whose `can_sign` comes
 * back `null` — the key page could not be READ — is polled until the budget runs out, and the SDK's
 * default budget is five minutes. In CI that is five minutes of a runner spent learning nothing, and
 * in a local run it looks like a hang. Real provisioning is a chain of anchored Accumulate
 * transactions and takes ~90s, so six minutes is generous and still finite.
 */
const WAIT_MINUTES = arg('wait-minutes', '6');
const KEEP = process.argv.includes('--keep');

if (!TARGET) {
  console.error('need --url <gateway> (or CERTEN_API_URL)');
  process.exit(2);
}

/**
 * An isolated HOME per run.
 *
 * The CLI stores its credential under HOME. Without this the run would pick up — or overwrite — the
 * developer's own key, and a CI job would leak state between runs.
 */
const HOME = mkdtempSync(join(tmpdir(), 'certen-e2e-'));

/**
 * Carry ONE signing key into the isolated home, when the proof cycle needs it.
 *
 * The isolated `HOME` is what keeps this run from picking up — or overwriting — the operator's own
 * credential, and it must stay that way: the point of the run is that signup obtains a fresh one.
 * But the keystore lives under the same directory, so isolation also hides the local key the proof
 * step signs with.
 *
 * Copying exactly the named key keeps both properties: the API key is still the one this run just
 * obtained, and the private key never leaves the machine it was already on.
 */
if (PROOF_KEY) {
  const from = join(homedir(), '.certen', 'keys', `${PROOF_KEY}.json`);
  if (existsSync(from)) {
    mkdirSync(join(HOME, '.certen', 'keys'), { recursive: true });
    copyFileSync(from, join(HOME, '.certen', 'keys', `${PROOF_KEY}.json`));
  } else {
    console.error(`e2e: no local key named "${PROOF_KEY}" — the proof cycle will be skipped`);
  }
}
const env = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
  CERTEN_API_URL: TARGET,
  // Must be unset: it takes precedence over the credential this run is about to obtain, so leaving
  // it in place would silently test an existing account instead of a new one.
  CERTEN_API_KEY: '',
};

function certen(args) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

/** The single `--json` envelope, or null when the command did not produce one. */
function payload(stdout) {
  try {
    const env_ = JSON.parse(stdout.trim());
    return env_?.ok ? (env_.data ?? {}) : null;
  } catch {
    return null;
  }
}

const results = [];
let failed = false;

/**
 * Run one step and assert a property of its result.
 *
 * `assert` returns a string to fail with, or null to pass. Steps continue after a failure so one run
 * reports everything rather than only the first thing — a journey that stops at step two tells you
 * nothing about steps three to five.
 */
async function step(name, args, assertFn, { skipIf } = {}) {
  if (skipIf) {
    results.push({ name, status: 'skip', detail: skipIf });
    return null;
  }
  const t0 = Date.now();
  const res = await certen(args);
  const ms = Date.now() - t0;
  const data = payload(res.stdout);
  const problem = res.code !== 0
    ? `exit ${res.code}: ${(res.stderr || res.stdout).trim().split('\n').slice(-2).join(' ')}`
    : assertFn(data, res);

  if (problem) failed = true;
  results.push({ name, status: problem ? 'fail' : 'pass', ms, detail: problem ?? '' });
  console.log(`${problem ? 'FAIL' : 'pass'}  ${name.padEnd(34)} ${String(ms).padStart(6)}ms`
    + `${problem ? `\n      ${problem}` : ''}`);
  return data;
}

// ── 1. Sign up, from nothing ───────────────────────────────────────────────────────────────────
//
// The step that could not be automated at all until this month. A fresh keypair, a signature over a
// server-issued nonce, and an organization exists — no browser, no email, no operator.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
// `generateKeyPairSync` already returns KeyObjects, so this exports directly. Passing the public
// one through `createPublicKey` throws — that function takes a private key or raw material.
// The last 32 bytes of the SPKI DER are the raw Ed25519 point, which is what the API expects.
const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const PUBLIC_KEY_HEX = rawPub.toString('hex');

console.log(`\ne2e onboarding against ${TARGET}`);
console.log(`  chain ${CHAIN} · key ${PUBLIC_KEY_HEX.slice(0, 16)}…`
  + `${PROOF_IDENTITY ? ` · proof via ${PROOF_IDENTITY.slice(0, 8)}` : ' · proof cycle skipped'}
`);

let orgId = null;

{
  // Driven over HTTP rather than through the CLI, because the key is generated here: `signup
  // --with-key` reads from the local keystore, and importing a raw key into it would be a second
  // thing to get right. The gateway contract is what matters.
  const challenge = await fetch(`${TARGET}/v1/signup/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: PUBLIC_KEY_HEX }),
  }).then((r) => r.json()).catch((e) => ({ error: String(e) }));

  if (!challenge?.nonce) {
    console.error(`FAIL  signup challenge — ${challenge?.error ?? 'no nonce returned'}`);
    // Name the actual cause rather than one plausible cause.
    //
    // This printed "Is SELF_SERVICE_ENABLED set?" for every failure, and the first time it fired in
    // anger the reason was a rate limit — so it pointed at a config flag that was correctly set and
    // said nothing about the ceiling that had actually been hit. A diagnostic that guesses is worse
    // than one that reports, because it sends the reader somewhere confidently wrong.
    if (challenge?.code === 'RATE_LIMIT_EXCEEDED' || /rate limit/i.test(String(challenge?.error))) {
      console.error('      Signup is rate limited per address. This run is fine; it is too soon.');
      console.error(`      ${challenge?.retry_after_seconds ?? '?'}s to wait.`);
    } else {
      console.error('      If this says the route is unknown, SELF_SERVICE_ENABLED may be off.');
    }
    rmSync(HOME, { recursive: true, force: true });
    process.exit(1);
  }

  // Signed over the nonce BYTES, not its hex text — the one mistake the gateway calls out by name.
  const signature = edSign(null, Buffer.from(challenge.nonce, 'hex'), privateKey).toString('hex');

  const t0 = Date.now();
  const created = await fetch(`${TARGET}/v1/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key: PUBLIC_KEY_HEX,
      nonce: challenge.nonce,
      signature,
      org_name: `e2e-${Date.now()}`,
    }),
  }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  const ms = Date.now() - t0;

  if (!created?.api_key) {
    console.error(`FAIL  signup — ${created?.error ?? 'no api_key returned'}`);
    rmSync(HOME, { recursive: true, force: true });
    process.exit(1);
  }

  env.CERTEN_API_KEY = created.api_key;
  orgId = created.org.id;
  results.push({ name: 'signup (keypair, no human)', status: 'pass', ms, detail: '' });
  console.log(`pass  ${'signup (keypair, no human)'.padEnd(34)} ${String(ms).padStart(6)}ms`);
  // Printed so a runaway-spend or leaked-credential question has an answer later.
  console.log(`      org ${orgId}`);
}

// ── 2. An identity that can actually sign ──────────────────────────────────────────────────────
const identity = await step(
  'identity created and can sign',
  ['identity', 'create', '--name', `e2e-${Date.now()}`, '--chains', CHAIN,
    // The FULL public key, not its hash.
    //
    // Passing `--public-key-hash` alone is refused, and the gateway is right to refuse it: a hash
    // cannot sign, so an identity registered with only a hash is accepted and then fails at the
    // signing step of every later flow. That is the exact trap the SDK's own docs warn about, and
    // this script walked straight into it on its first real run against production — which is
    // precisely what an end-to-end check is for.
    '--public-key', PUBLIC_KEY_HEX, '--wait', '--timeout', WAIT_MINUTES, '--json'],
  (data) => {
    if (!data?.id) return 'no identity id returned';
    // `can_sign` has three values and only one of them is usable, so this asserts on the value
    // rather than on the command having exited zero.
    //
    // `false` and `null` are usually caught upstream — the SDK refuses to return an identity it
    // knows cannot sign, and reports an unreadable key page as unknown rather than as ready — and
    // that surfaces here as a non-zero exit carrying IDENTITY_CANNOT_SIGN or
    // IDENTITY_CAN_SIGN_UNKNOWN. This check is the backstop for a gateway or SDK that ever stops
    // making that distinction, which is precisely the regression worth catching.
    if (data.can_sign !== true) return `can_sign is ${JSON.stringify(data.can_sign)}, not true`;
    return null;
  },
);

// ── 3. Can it pay for work? ────────────────────────────────────────────────────────────────────
await step(
  'trial credit covers new work',
  ['balance', '--json'],
  (data) => {
    // A self-service org receives an expiring trial grant on creation. Without it the very first
    // proof-gated call is a 402 — so this asserts the grant, not merely that the balance parsed.
    if (!data) return 'balance did not parse';
    const remaining = Number(data.remaining_usd ?? data.spendable_usd ?? '0');
    if (!(remaining > 0)) return `nothing left to commit (remaining ${data.remaining_usd})`;
    return null;
  },
);

// ── 4. The product: a proof-gated call ─────────────────────────────────────────────────────────
//
// Needs a contract to call and a funded abstract account, neither of which this script can conjure.
// Skipped explicitly rather than silently, so a green run never overstates what it covered.
const canProve = Boolean(PROOF_IDENTITY && PROOF_KEY && PROOF_FROM);
const skipReason = canProve
  ? undefined
  : 'needs --proof-identity, --sign-with and --proof-from (a funded abstract account)';

// A tiny transfer to the burn address. The amount is irrelevant — what is being tested is that the
// authorization anchors and the proof verifies — so it is kept as small as the chain allows.
const call = await step(
  'proof-gated transfer executed',
  ['tx', 'create', '--identity', PROOF_IDENTITY, '--to-chain', CHAIN,
    '--from', PROOF_FROM, '--to', '0x000000000000000000000000000000000000dEaD',
    '--amount', '0.0001', '--sign-with', PROOF_KEY, '--json'],
  (data) => (data?.intent_id ? null : 'no intent_id returned'),
  { skipIf: skipReason },
);

// The proof cycle is real validator work — 60 to 110 seconds — so this waits for the intent to
// reach a terminal state before asking for its proof. Asking immediately would reliably fail
// against a system that is working correctly, which is the worst kind of check.
if (call?.intent_id) {
  const deadline = Date.now() + 6 * 60_000;
  for (;;) {
    const s = await certen(['tx', 'status', call.intent_id, '--json']);
    const state = payload(s.stdout)?.status;
    if (['completed', 'failed', 'error'].includes(String(state))) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => { setTimeout(r, 15_000); });
  }
}

await step(
  'proof anchored and verifiable',
  ['proof', 'get', call?.intent_id ?? 'missing', '--json'],
  (data) => {
    if (!data) return 'proof did not parse';
    // Anchored is the property that makes the proof worth anything. A proof that exists and is not
    // anchored is a claim about a claim.
    if (data.anchored !== true) return `proof is not anchored (${JSON.stringify(data.anchored)})`;
    if (!data.receipt) return 'proof carries no receipt';
    return null;
  },
  { skipIf: skipReason ?? (call ? undefined : 'the transfer step did not produce an intent') },
);

// ── Summary ────────────────────────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.status === 'pass');
const skipped = results.filter((r) => r.status === 'skip');
const totalMs = results.reduce((a, r) => a + (r.ms ?? 0), 0);

console.log('');
console.log(`  ${passed.length} passed · ${results.length - passed.length - skipped.length} failed`
  + ` · ${skipped.length} skipped · ${(totalMs / 1000).toFixed(1)}s`);
for (const s of skipped) console.log(`  skipped: ${s.name} — ${s.detail}`);
if (orgId) console.log(`  organization created: ${orgId}`);

if (KEEP) console.log(`  credential kept at ${HOME}`);
else rmSync(HOME, { recursive: true, force: true });

// A skip is not a pass. The exit code reflects only what was actually asserted, and the skip lines
// above are the record of what was not — so a green CI run cannot quietly mean "we checked two
// things".
process.exit(failed ? 1 : 0);
