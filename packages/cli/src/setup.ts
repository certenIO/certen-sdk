import {
  CertenClient, CertenError, gasFundingPlan, redeemRegistrationToken, selfSignup,
  type ChainsListResponse, type GasFundingPlan, type Identity, type Readiness, type ReadinessCheck,
} from '@certen.io/sdk';
import {
  activeProfile, credentialInfo, forgetIdentity, getApiKey, getApiUrl, getPortalUrl, readProfile, recordedIdentities, rememberIdentity, setApiKey,
  updateProfile,
} from './config.js';
import { CliError, UsageError, EXIT } from './errors.js';
import { uuidArg } from './next-step.js';
import { assertChains, enabledChains, writeChainCache } from './chains.js';
import { generateKey, getKeyInfo, isEncrypted, keyExists, signHash } from './keystore.js';
import { passphraseFromEnv, resolveNewPassphrase, resolvePassphrase } from './passphrase.js';
import { deviceFlowOrPaste, registerPayer } from './credential-flow.js';
import { assertContextKeyExists, resolveCommandIdentity } from './command-context.js';
import { echoFromContext, requireIdentity, resolveContext, sourceLabel } from './context.js';
import { matchRecorded, type RecordedIdentity } from './identity-ref.js';
import { finishReadiness, signingKeyCheck } from './readiness-render.js';
import { suggestedName, type Prompter } from './prompt.js';
import { gasGapIsFundable, waitForGas, waitForIdentity, sleepUnlessAborted, type WaitBudget } from './wait.js';
import type { Interrupt } from './interrupt.js';

/**
 * `certen setup`: from nothing to an identity that can act on a chain, in one resumable command.
 *
 * The journey it replaces was seventeen commands and five values copied by hand. Almost none of it was a decision; it was bookkeeping the CLI
 * had the data for. This is the bookkeeping, and it stops to ask only about what is genuinely the person's call.
 *
 * **Steps, in this order**, each checked first and skipped when already satisfied, so running it again continues rather than repeats:
 *
 *   1. gateway      reachable, and serving the chain asked for (replaces `chains --refresh`)
 *   2. signing key  reuse or make it. BEFORE the credential, because a new account is created BY this key
 *   3. sign-in      an account that already works is kept; otherwise a registration token, a new account made with the key (no browser), or the
 *                   device flow for an account that already exists
 *   4. identity     the one already recorded here, or a new one, waited on until it can sign
 *   5. context      identity, key and chain written down, so the next command needs none of them typed
 *   6. readiness    `client.readiness()`: key page (read from Accumulate), credits, gateway balance and gas. The SDK's judgement, not a copy
 *   7. funds        gas is the one thing setup can wait for; credits and the gateway balance are money, so they end the run with their fix
 *
 * **What makes it safe to run twice.** The identity is recorded the moment the gateway returns its id, BEFORE the wait: an interrupted or timed-out
 * provisioning would otherwise lose the id, and the rerun would create a second identity, which an organisation made with a key (capped at one
 * until approved) refuses. A working credential is never replaced by an option. `--yes` never creates an organisation and never retires anything.
 *
 * **Exit 0 means ready.** Not "nothing crashed": every check is `ok` or `warn`. Unknown is not ready.
 *
 * Everything that touches the person or the clock goes through {@link SetupIo}, so each path is tested without a terminal or a real wait.
 */

export interface StepResult {
  step: string;
  status: 'done' | 'skipped' | 'created' | 'waited';
  detail: string;
}

export interface SetupOptions {
  /** A name for a NEW identity; when it matches one recorded here, that one is reused. */
  name?: string;
  /** Use this existing identity (UUID, ADI URL or name). Never creates one. */
  identity?: string;
  key?: string;
  /** `--chain` / `--chains`, as typed. Validated after the registry is read, because whether a chain is served is the registry's word. */
  chainsText?: string;
  yes: boolean;
  /** Which kind of account when none is configured. Undefined means ask (on a TTY) or refuse. */
  account?: 'new' | 'existing';
  token?: string;
  orgName?: string;
  noPassphrase: boolean;
  /** May a NEW credential go in the OS keyring? Only if the machine already keeps it there (credentials do not move between stores on their own). */
  keyring: boolean;
  browser: boolean;
  payer?: string;
  /** Explicit wish; undefined takes the default (wait when a person is at a terminal). */
  waitForFunds?: boolean;
  amount?: string;
  gasReserve?: string | null;
  accumulateRpc?: string;
  /** Provisioning wait (`--timeout`, `--poll-interval`). */
  provisioning: WaitBudget;
  /** Was `--poll-interval` typed? If not, the cadence the gateway publishes for provisioning is used. */
  pollIntervalGiven: boolean;
  /** Gas wait (`--funds-timeout`, `--poll-interval`). */
  funds: WaitBudget;
}

export interface SetupIo {
  /** A person is at a terminal and this is not `--json`: questions may be asked, and waiting for funds is the default. */
  interactive: boolean;
  prompter: Prompter;
  /** Progress, as ordinary output (stdout in table mode, stderr in `--json`). */
  say(message: string): void;
  /** A note that is never the result: always stderr. */
  note(message: string): void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Start listening for Ctrl-C. Called only for the length of the wait for funds, so Ctrl-C keeps its ordinary meaning everywhere else; the
   * caller disposes it when the wait ends.
   */
  interrupt?: () => Interrupt;
}

export type SetupState = 'ready' | 'blocked' | 'timed-out' | 'interrupted';

export interface SetupOutcome {
  state: SetupState;
  ready: boolean;
  readiness: Readiness;
  steps: StepResult[];
  profile: string;
  apiUrl: string;
  chain: string;
  context: { identity_id: string; adi_url: string; key: string; chain: string };
  created: { key: boolean; account: boolean; identity: boolean };
  /** What to send, and where, when gas is what is missing. */
  funding?: GasFundingPlan;
  /** How long the wait for funds ran, when there was one. */
  waited_ms?: number;
}

const ACCOUNT_CHOICES = [
  { key: 'new', aliases: ['n'], label: 'create a new CERTEN account with this key (no browser)' },
  { key: 'existing', aliases: ['e'], label: 'sign in to an account you already have (opens your browser)' },
] as const;

type AccountMode = 'token' | 'new' | 'existing';

/**
 * Which way to get an account when none is configured. Asked BEFORE the signing key is made, so that a person who gives no answer leaves
 * nothing behind; the account itself is still made after the key, because a new account is created by it.
 *
 * Never guessed: creating an organisation is not something to do on an Enter. With nobody to ask (no terminal, or --yes) and nothing said, it
 * is a usage error that names the three ways.
 */
async function chooseMode(opts: SetupOptions, io: SetupIo, question: string): Promise<AccountMode> {
  if (opts.token !== undefined) return 'token';
  if (opts.account !== undefined) return opts.account;
  if (io.interactive && !opts.yes) {
    const answer = await io.prompter.choose(question, ACCOUNT_CHOICES);
    if (answer === 'new' || answer === 'existing') return answer;
  }
  throw usageForNoAccount();
}

function usageForNoAccount(): UsageError {
  return new UsageError(
    'No API key is configured, and setup cannot ask which kind of account you want (there is no terminal to ask on, or --yes was given). '
    + 'Say which: --existing-account (approve this machine in the portal), --new-account (create an account with your signing key, no browser), '
    + `or --token <registration token>. Or set CERTEN_API_KEY. The portal is ${getPortalUrl()}`,
    'NO_API_KEY',
  );
}

/** Everything that can be wrong with the command line, checked before a request, a prompt or a key. */
function validate(opts: SetupOptions): void {
  const modes = [opts.token ? '--token' : '', opts.account === 'new' ? '--new-account' : '', opts.account === 'existing' ? '--existing-account' : ''].filter(Boolean);
  if (modes.length > 1) {
    throw new UsageError(`Pass only one of --token, --new-account and --existing-account (got ${modes.join(' and ')}).`, 'CONFLICTING_OPTIONS');
  }
  if (opts.orgName && opts.account === 'existing') {
    throw new UsageError('--org-name names a NEW organisation; an account you sign in to already has one.', 'CONFLICTING_OPTIONS');
  }
  if (opts.identity && opts.name) {
    throw new UsageError('--identity uses an identity that already exists and --name makes (or finds) one by name; pass one of them.', 'CONFLICTING_OPTIONS');
  }
}

export async function runSetup(opts: SetupOptions, io: SetupIo): Promise<SetupOutcome> {
  validate(opts);
  // Before the network and before a key is made: with no credential and no answer to which kind of account, there is nothing setup can do,
  // and it must not leave a new signing key behind on the way to saying so.
  let mode: AccountMode | undefined;
  if ((await configuredKey()) === null) mode = await chooseMode(opts, io, '  Sign-in         no API key is configured. What do you want to do?');
  const apiUrl = getApiUrl();
  const profile = activeProfile();
  const steps: StepResult[] = [];
  const created = { key: false, account: false, identity: false };
  const sleep = io.sleep ?? sleepUnlessAborted;

  io.say('');
  io.say(`  Setting up against ${apiUrl}`);
  io.say('');

  // ── 1. gateway ──────────────────────────────────────────────────────────────────────────────────────
  // Public, needs no credential, and is the cheapest possible "is it up". An unreachable gateway exits 3 here, before anything is made.
  const registry = await gatewayStep(apiUrl, steps, io);
  const defaultChains = resolveContext({}, { fields: ['chain'], inferChain: false }).chain;
  const chains = assertChains(
    opts.chainsText ?? defaultChains?.value ?? 'base-sepolia',
    opts.chainsText ? '--chain' : defaultChains ? sourceLabel(defaultChains, '--chain') : '--chain',
  );
  if (!opts.chainsText && defaultChains) echoFromContext('chain', defaultChains);

  // ── 2. signing key ──────────────────────────────────────────────────────────────────────────────────
  const key = await keyStep(opts, io, steps);
  created.key = key.created;

  // ── 3. sign-in ──────────────────────────────────────────────────────────────────────────────────────
  const account = await accountStep(opts, io, steps, apiUrl, key, mode);
  created.account = account.created;
  const client = new CertenClient({ apiKey: account.apiKey, baseUrl: apiUrl });

  // ── 4. identity ─────────────────────────────────────────────────────────────────────────────────────
  const identity = await identityStep(opts, io, steps, client, key.name, chains);
  created.identity = identity.created;

  if (opts.payer) {
    const registered = await registerPayer(client, chains[0]!, opts.payer);
    steps.push({ step: 'payer', status: 'done', detail: registered.ok ? `${opts.payer} on ${chains[0]}` : `not registered: ${registered.why}` });
    io.say(registered.ok ? `  Deposits from ${opts.payer} will credit you automatically.` : `  Could not register ${opts.payer}: ${registered.why}`);
  }

  // The chain this run is about: asked for, else the context's, else the identity's only linked chain.
  const chain = await chainFor(opts, io, identity, chains, defaultChains !== undefined);

  // ── 5. context ──────────────────────────────────────────────────────────────────────────────────────
  // Written as soon as identity, key and chain are settled and NOT at the end: an interruption while waiting for funds must leave the next
  // command (`certen gas`, `certen status`, this one again) knowing which account is meant.
  const before = readProfile(profile);
  updateProfile(profile, { identity: identity.id, key: key.name, chain });
  const context = { identity_id: identity.id, adi_url: identity.adiUrl, key: key.name, chain };
  steps.push({
    step: 'context',
    status: 'done',
    detail: `identity ${identity.adiUrl}, key ${key.name}, chain ${chain}${before.identity && before.identity !== identity.id ? ' (replaced the identity this profile used before)' : ''}`,
  });

  // ── 6. readiness ────────────────────────────────────────────────────────────────────────────────────
  const keyCheck = signingKeyCheck({ name: key.name, candidates: [key.name] });
  const portalUrl = getPortalUrl();
  const evaluate = async (): Promise<Readiness> => finishReadiness(
    await client.readiness({
      identityId: identity.id, chain, keyHash: keyCheck.keyHash, amount: opts.amount, gasReserve: opts.gasReserve,
      accumulateRpc: opts.accumulateRpc, configuredChains: enabledChains(),
    }),
    { localChecks: [keyCheck.check], env: { chain, identityId: identity.id, portalUrl, keyName: key.name } },
  );

  let readiness = await evaluate();
  // A key page just created may not be visible to a public Accumulate node yet. A check that could not be ANSWERED (unknown) is asked again a
  // few times; one that FAILED is not: a certain answer does not change by asking.
  for (let attempt = 0; attempt < 3 && readiness.first_blocker?.status === 'unknown' && (identity.created || identity.waited); attempt += 1) {
    await sleep(opts.provisioning.intervalMs);
    readiness = await evaluate();
  }

  const outcome = (state: SetupState, extra: Partial<SetupOutcome> = {}): SetupOutcome => ({
    state, ready: state === 'ready', readiness, steps, profile, apiUrl, chain, context, created, ...extra,
  });
  if (readiness.ready) {
    steps.push({ step: 'readiness', status: 'done', detail: `ready on ${chain}` });
    return outcome('ready');
  }

  // ── 7. funds ────────────────────────────────────────────────────────────────────────────────────────
  const gas = waitableGas(readiness);
  if (!gas) {
    steps.push({ step: 'readiness', status: 'done', detail: `not ready: ${readiness.first_blocker?.name ?? 'a check'}` });
    return outcome('blocked');
  }
  const funding = gasFundingPlan({
    chain, address: gas.address, balance: typeof gas.check.data?.balance === 'string' ? gas.check.data.balance : null,
    amount: opts.amount, reserve: opts.gasReserve,
  });
  const wait = opts.waitForFunds ?? io.interactive;
  if (!wait) {
    steps.push({ step: 'gas', status: 'done', detail: `needs gas on ${chain}: ${gas.address}` });
    return outcome('blocked', { funding });
  }

  if (funding) renderFunding(funding, io.say);
  io.say('');
  io.say(`  Waiting for funds... (Ctrl-C to stop; run \`certen setup\` again to continue)`);
  let lastLine = '';
  const stop = io.interrupt?.();
  let waited: Awaited<ReturnType<typeof waitForGas>>;
  try {
    waited = await waitForGas(client, { identityId: identity.id, chain, amount: opts.amount, gasReserve: opts.gasReserve }, opts.funds, {
      signal: stop?.signal,
      sleep: io.sleep,
      onCheck: (check) => {
        const held = typeof check.data?.balance === 'string' ? `${check.data.balance} ${String(check.data.symbol ?? '')}`.trim() : 'not reported yet';
        // Said once per change: a half-hour wait is not a wall of identical lines.
        const line = `  ${gas.address} holds ${held}`;
        if (line !== lastLine) { lastLine = line; io.say(line); }
      },
    });
  } finally {
    stop?.dispose();
  }

  if (waited.result === 'interrupted') {
    steps.push({ step: 'gas', status: 'waited', detail: 'stopped while waiting for funds' });
    return outcome('interrupted', { funding });
  }
  if (waited.result === 'timeout') {
    steps.push({ step: 'gas', status: 'waited', detail: `no funds arrived in ${Math.round(waited.waitedMs / 60_000)} min` });
    return outcome('timed-out', { funding, waited_ms: waited.waitedMs });
  }

  steps.push({ step: 'gas', status: 'waited', detail: 'funds arrived' });
  io.say('  Funds arrived.');
  readiness = await evaluate();
  steps.push({ step: 'readiness', status: 'done', detail: readiness.ready ? `ready on ${chain}` : `not ready: ${readiness.first_blocker?.name ?? 'a check'}` });
  return outcome(readiness.ready ? 'ready' : 'blocked');
}

// ── step 1 ───────────────────────────────────────────────────────────────────────────────────────────

async function gatewayStep(apiUrl: string, steps: StepResult[], io: SetupIo): Promise<ChainsListResponse> {
  // `CERTEN_API_KEY` is irrelevant to a public route, but the client wants the field.
  const client = new CertenClient({ apiKey: process.env.CERTEN_API_KEY ?? 'public', baseUrl: apiUrl });
  const registry = await client.chains.list();
  // The same cache `certen chains --refresh` writes, so every later validation in this run (and the commands after it) judges a chain by what
  // the gateway just said it serves.
  writeChainCache(registry.chains.map((c) => ({ id: c.id, chainId: c.chainId, enabled: c.enabled, environment: c.environment })));
  steps.push({ step: 'gateway', status: 'done', detail: `registry v${registry.version}, ${registry.count} chains` });
  io.say(`  1. Gateway      reachable (registry v${registry.version}, ${registry.count} chains)`);
  return registry;
}

// ── step 2 ───────────────────────────────────────────────────────────────────────────────────────────

interface KeyOutcome {
  name: string;
  created: boolean;
  /** The passphrase typed to create it in this run, so signing the signup nonce does not ask a second time. `undefined`: not known here. */
  passphrase: string | null | undefined;
}

async function keyStep(opts: SetupOptions, io: SetupIo, steps: StepResult[]): Promise<KeyOutcome> {
  const ctx = resolveContext({ key: opts.key }, { fields: ['key'] });
  let name = ctx.key?.value;

  if (name === undefined) {
    if (ctx.candidates.key.length > 1) {
      if (!io.interactive || opts.yes) {
        throw new UsageError(
          `Which signing key? Several are on this machine and none is chosen: ${ctx.candidates.key.join(', ')}. `
          + 'Pass --key <name>, set CERTEN_KEY, or choose one once with: certen use key <name>',
          'AMBIGUOUS_KEY',
        );
      }
      name = await io.prompter.ask('  2. Signing key  which one to use', ctx.candidates.key[0]!);
    } else {
      // Nothing on this machine: a new one. Asked about only when a person can answer; otherwise the conventional name.
      name = io.interactive && !opts.yes ? await io.prompter.ask('  2. Signing key  name for the new key', 'dev') : 'dev';
    }
  }

  if (keyExists(name)) {
    if (ctx.key) echoFromContext('key', ctx.key);
    const info = getKeyInfo(name);
    steps.push({ step: 'signing key', status: 'skipped', detail: `${name} already exists (hash ${info.publicKeyHash.slice(0, 8)}…)` });
    io.say(`  2. Signing key  "${name}" already exists`);
    return { name, created: false, passphrase: undefined };
  }
  // A name that came from the environment or a profile and is not on this machine is an error, not an instruction to make it: the person
  // set it somewhere and should be told it is gone. A name typed on the command line is a request, and is made.
  if (ctx.key && ctx.key.value === name) assertContextKeyExists(ctx.key);

  // Encrypted by default. Where nobody can type a passphrase, it has to come from the environment, or be declined by name: an unencrypted
  // key is the person's explicit choice, never what happens because a prompt had no one to ask.
  if (opts.yes && !opts.noPassphrase && passphraseFromEnv() === null) {
    throw new UsageError(
      `Setup would create the signing key "${name}", and --yes means no prompts, so it cannot ask for a passphrase. `
      + 'Set CERTEN_KEY_PASSPHRASE to encrypt it, or pass --no-passphrase to store it unencrypted (anyone who can read the file can then sign as you).',
      'PASSPHRASE_REQUIRED',
    );
  }
  const passphrase = await resolveNewPassphrase(opts.noPassphrase);
  generateKey(name, passphrase);
  steps.push({ step: 'signing key', status: 'created', detail: `${name}${passphrase === null ? ' (not encrypted)' : ' (encrypted)'}` });
  io.say(`  2. Signing key  created "${name}"${passphrase === null ? '' : ' (encrypted)'}`);
  if (passphrase === null) {
    io.note(`     Warning: "${name}" is stored UNENCRYPTED. Anyone who can read that file can sign as you.`);
  }
  return { name, created: true, passphrase };
}

// ── step 3 ───────────────────────────────────────────────────────────────────────────────────────────

interface AccountOutcome {
  apiKey: string;
  created: boolean;
}

/** The configured credential, or null when there is none. Only "no key" is null: a keyring that cannot be read is an error to show. */
async function configuredKey(): Promise<string | null> {
  try {
    return await getApiKey();
  } catch (err) {
    if ((err as { code?: string }).code === 'NO_API_KEY') return null;
    throw err;
  }
}

async function accountStep(
  opts: SetupOptions, io: SetupIo, steps: StepResult[], apiUrl: string, key: KeyOutcome, chosen: AccountMode | undefined,
): Promise<AccountOutcome> {
  const explicit = opts.token !== undefined || opts.account !== undefined;
  const existing = await configuredKey();

  if (existing !== null) {
    // One cheap read proves the gateway accepts it. Only a 401 is a rejection; a 403 is a real key without billing:read, and anything else is
    // not conclusive and is not a reason to throw away a credential.
    let rejected = false;
    try {
      await new CertenClient({ apiKey: existing, baseUrl: apiUrl }).billing.balance();
    } catch (err) {
      if (err instanceof CertenError && err.status === 401) rejected = true;
      else if (err instanceof CertenError && err.status === 0) throw err;
    }
    if (!rejected) {
      steps.push({ step: 'sign-in', status: 'skipped', detail: `${existing.substring(0, 12)}... already configured${explicit ? ' (the option for a new sign-in was not used)' : ''}` });
      io.say(`  3. Sign-in      already configured (${existing.substring(0, 12)}...)`);
      return { apiKey: existing, created: false };
    }

    // A credential that is rejected. Never silently replaced: which key was in use is exactly what the person needs to know.
    if (process.env.CERTEN_API_KEY) {
      throw new CliError(
        `CERTEN_API_KEY was rejected by ${apiUrl}. It takes precedence over anything saved here, so setup cannot replace it: fix or unset it.`,
        'CREDENTIAL_REJECTED', EXIT.FAILED,
      );
    }
    const replace = explicit || (io.interactive && !opts.yes && await io.prompter.confirm(`  3. Sign-in      the saved API key was rejected by ${apiUrl}. Sign in again?`, true));
    if (!replace) {
      throw new CliError(
        `The saved API key was rejected by ${apiUrl}. Sign in again: certen setup --existing-account (or --new-account, or --token <token>).`,
        'CREDENTIAL_REJECTED', EXIT.FAILED,
      );
    }
  }

  if (process.env.CERTEN_API_KEY) {
    // Unreachable in practice (the env key counts as configured above), kept so a future change cannot write a key that is then ignored.
    throw new UsageError('CERTEN_API_KEY is set, and it takes precedence over any key saved here. Unset it first if you want to replace it.', 'API_KEY_ENV_SET');
  }

  const keyring = opts.keyring && credentialInfo().storage === 'keyring';
  // Normally decided already, before the key was made. Left open only when a SAVED key turned out to be rejected and the person agreed to replace it.
  const mode: AccountMode = chosen ?? await chooseMode(opts, io, '  3. Sign-in      how do you want to sign in?');

  if (mode === 'existing') {
    io.say('  3. Sign-in      authorizing this machine in the portal.');
    const got = await deviceFlowOrPaste({ apiUrl, keyring, browser: opts.browser, say: (m) => io.say(`                  ${m}`) });
    steps.push({ step: 'sign-in', status: 'created', detail: got.detail });
    io.say(got.via === 'device' ? '                  authorized.' : '                  saved.');
    return { apiKey: got.apiKey, created: true };
  }

  if (mode === 'token') {
    const redeemed = await redeemRegistrationToken(opts.token!, { baseUrl: apiUrl, orgName: opts.orgName });
    await storeNewKey(redeemed.api_key, keyring);
    steps.push({ step: 'sign-in', status: 'created', detail: `organization ${redeemed.org.name} created from a registration token (${redeemed.key_prefix}...)` });
    io.say(`  3. Sign-in      organization ${redeemed.org.name} created from the registration token`);
    return { apiKey: redeemed.api_key, created: true };
  }

  // A new account, made with the key: the only thing that crosses the wire is a signature over a nonce. The private half never leaves.
  const passphrase = key.passphrase !== undefined ? key.passphrase : await resolvePassphrase(isEncrypted(key.name), key.name);
  const info = getKeyInfo(key.name);
  const redeemed = await selfSignup({
    publicKey: info.publicKey,
    // The nonce arrives as hex and must be signed as BYTES; `signHash` decodes it, which is why this lines up with no conversion here.
    sign: (nonceHex) => signHash(key.name, passphrase, nonceHex),
    orgName: opts.orgName,
  }, { baseUrl: apiUrl }).catch((err: unknown) => {
    if (err instanceof CertenError && err.status === 403) {
      throw new CliError(
        'This gateway does not have self-service onboarding enabled, so it cannot create an account from a key. '
        + `Sign in to an existing account (--existing-account), redeem a registration token (--token), or mint a key at ${getPortalUrl()}`,
        'SELF_SERVICE_DISABLED', EXIT.FAILED,
      );
    }
    throw err;
  });
  await storeNewKey(redeemed.api_key, keyring);
  steps.push({ step: 'sign-in', status: 'created', detail: `organization ${redeemed.org.name} created with key "${key.name}" (${redeemed.key_prefix}...)` });
  io.say(`  3. Sign-in      organization ${redeemed.org.name} created with "${key.name}"; this machine is signed in`);
  io.note(`     The API key was returned once and is stored here. "${key.name}" is the key that created the organization: keep it.`);
  return { apiKey: redeemed.api_key, created: true };
}

/** Store a key that was returned ONCE. If storing fails the key is gone, and the message says exactly that and what to do about it. */
async function storeNewKey(apiKey: string, keyring: boolean): Promise<void> {
  try {
    await setApiKey(apiKey, keyring);
  } catch (err) {
    throw new CliError(
      `The organization was created, but its API key could not be saved (${err instanceof Error ? err.message : String(err)}). The key was returned once and is shown nowhere else. `
      + 'Sign in to the organization you just made with: certen setup --existing-account (it was created by your signing key).',
      'KEY_STORAGE_FAILED', EXIT.FAILED,
    );
  }
}

// ── step 4 ───────────────────────────────────────────────────────────────────────────────────────────

interface IdentityOutcome {
  id: string;
  adiUrl: string;
  created: boolean;
  /** Provisioning was waited on in this run (made now, or found still in flight). */
  waited: boolean;
  /** The chains the identity has an account on, as slugs. */
  linked: string[];
}

const slugsOf = (identity: Pick<Identity, 'chain_accounts'>): string[] =>
  (identity.chain_accounts ?? []).filter((a) => a.address).map((a) => a.chain_id);

async function identityStep(
  opts: SetupOptions, io: SetupIo, steps: StepResult[], client: CertenClient, keyName: string, chains: string[],
): Promise<IdentityOutcome> {
  const settle = (id: string, adiUrl: string, how: StepResult['status'], note: string, waited: boolean, linked: string[]): IdentityOutcome => {
    steps.push({ step: 'identity', status: how, detail: `${adiUrl} (${id})${note}` });
    return { id, adiUrl, created: how === 'created', waited, linked };
  };

  // Which existing identity, if any. `--identity` names one and is an error if it is gone; `--name` finds one by name; otherwise the context
  // (environment, profile, or the only one recorded here).
  let target: { id: string; adiUrl?: string; typed: boolean } | undefined;
  if (opts.identity !== undefined) {
    const ctx = resolveContext({ identity: opts.identity }, { fields: ['identity'] });
    const who = await resolveCommandIdentity(ctx, client, 'id');
    target = { id: who.id!, adiUrl: who.adi_url, typed: true };
  } else if (opts.name !== undefined) {
    const hits = matchRecorded(opts.name);
    if (hits.length > 1) {
      throw new UsageError(
        `"${opts.name}" matches more than one identity recorded on this machine: ${hits.map((h) => `${h.adi_url} (${h.id})`).join(', ')}. Pass --identity <uuid> to say which.`,
        'AMBIGUOUS_IDENTITY',
      );
    }
    if (hits[0]) target = { id: hits[0].id, adiUrl: hits[0].adi_url, typed: false };
  } else {
    const ctx = resolveContext({}, { fields: ['identity'] });
    if (ctx.identity) {
      const who = await resolveCommandIdentity(ctx, client, 'id');
      target = { id: who.id!, adiUrl: who.adi_url, typed: false };
    } else if (ctx.candidates.identity.length > 1) {
      requireIdentity(ctx); // several recorded and none chosen: the usage error that lists them
    }
  }

  let retiredFailed = false;
  if (target) {
    const read = await client.identity.get(target.id, { include: [] }).then((i) => ({ i }), (e: unknown) => ({ e }));
    if ('e' in read) {
      if (read.e instanceof CertenError && read.e.status === 404) {
        if (target.typed) {
          throw new CliError(`The gateway has no identity ${target.id} in this organization.`, 'IDENTITY_NOT_FOUND', EXIT.FAILED);
        }
        // Retired from another machine, or made in another organisation: the record here is stale. Dropped, so it is not offered again.
        forgetIdentity(target.id);
        io.note(`     The identity ${target.adiUrl ?? target.id} is no longer in this organization; making a new one.`);
        target = undefined;
      } else {
        throw read.e;
      }
    } else {
      let identity = read.i;
      const inFlight = ['provisioning', 'pending', 'creating'].includes(identity.status);

      if (identity.status === 'error') {
        // The failed identity holds the organisation's one slot until it is retired, and a second create would be refused. Offered, never done
        // unasked: retiring is a decision, so `--yes` does not make it.
        const why = identity.error_message ? `: ${identity.error_message}` : '';
        const retire = !target.typed && io.interactive && !opts.yes
          && await io.prompter.confirm(`  4. Identity     ${identity.adi_url} failed to provision${why}. Retire it and create a fresh one?`, true);
        if (!retire) {
          throw new CliError(
            `The identity ${identity.adi_url} failed to provision${why}. It holds this organization's identity slot until it is retired. `
            + `Retire it, then run setup again: certen identity retire ${identity.id} --yes`,
            'IDENTITY_PROVISIONING_FAILED', EXIT.FAILED, false, undefined,
            `certen identity retire ${uuidArg(identity.id)} --yes`,
          );
        }
        await client.identity.retire(identity.id);
        forgetIdentity(identity.id);
        io.say(`                  retired ${identity.adi_url}`);
        retiredFailed = true;
        target = undefined;
      } else if (inFlight) {
        io.say(`  4. Identity     ${identity.adi_url} is still ${identity.status}; waiting for it (not making another)`);
        identity = await waitForIdentity(client, identity.id, opts.provisioning);
        recordIfNew(identity, chains);
        return settle(identity.id, identity.adi_url, 'skipped', ' (was still provisioning; waited for it)', true, slugsOf(identity));
      } else {
        recordIfNew(identity, chains);
        io.say(`  4. Identity     reusing ${identity.adi_url}`);
        return settle(identity.id, identity.adi_url, 'skipped', '', false, slugsOf(identity));
      }
    }
  }

  // ── make one ──
  // After a retire the same name may still be taken on Accumulate (an ADI is permanent), so a name nobody typed is a fresh one.
  const name = opts.name ?? (io.interactive && !opts.yes ? await io.prompter.ask('  4. Identity     name', suggestedName()) : suggestedName());
  const info = getKeyInfo(keyName); // the public half: reading it asks for no passphrase
  io.say(`  4. Identity     creating "${name}" on ${chains.join(', ')}${retiredFailed ? ' (after retiring the failed one)' : ''}...`);
  const made = await client.identity.create({ name, publicKey: info.publicKey, publicKeyHash: info.publicKeyHash, chains });
  if (!made.id) throw new CliError('The gateway accepted the identity but returned no id.', 'NO_IDENTITY_ID', EXIT.FAILED);
  // Written down NOW, before the wait. This is the only moment the UUID is knowable, and an interrupted wait that had not recorded it would
  // leave a rerun to create a second identity, which an organisation made with a key (one identity until approved) refuses.
  // `?? ''`: a 202 that carried no ADI yet must not leave a record that crashes whatever reads it; the full record is written when the wait ends.
  rememberIdentity({ id: made.id, adi_url: made.adi_url ?? '', chains, name });

  // Wait at the cadence the gateway publishes, unless one was typed. Provisioning is a chain of Accumulate transactions that each wait for
  // the last to anchor, so asking before the first can have is only requests.
  let budget = opts.provisioning;
  const hint = made.polling;
  if (hint) {
    if (!opts.pollIntervalGiven && hint.interval_seconds > 0) {
      budget = { ...budget, intervalMs: Math.min(30_000, Math.max(2_000, Math.round(hint.interval_seconds * 1000))) };
    }
    if (hint.estimated_ready_in_seconds > 0) io.say(`                  usually ready in about ${Math.round(hint.estimated_ready_in_seconds)} seconds`);
    const first = Math.min(60_000, Math.max(0, Math.round((hint.first_poll_after_seconds ?? 0) * 1000)));
    if (first > 0) await (io.sleep ?? sleepUnlessAborted)(first);
  }
  const ready = await waitForIdentity(client, made.id, budget);
  rememberIdentity({ id: ready.id, adi_url: ready.adi_url, chains, name });
  io.say(`                  ${ready.adi_url} is active and can sign`);
  return settle(ready.id, ready.adi_url, 'created', '', true, slugsOf(ready));
}

/** An identity reached by a typed reference may not be on this machine's record; recorded so `status --all` and a rerun know it. */
function recordIfNew(identity: Identity, chains: string[]): void {
  if ((recordedIdentities() as RecordedIdentity[]).some((r) => r.id === identity.id)) return;
  rememberIdentity({ id: identity.id, adi_url: identity.adi_url, chains: slugsOf(identity).length > 0 ? slugsOf(identity) : chains });
}

// ── the chain ────────────────────────────────────────────────────────────────────────────────────────

async function chainFor(opts: SetupOptions, io: SetupIo, identity: IdentityOutcome, chains: string[], fromContext: boolean): Promise<string> {
  // Asked for in so many words, or the context's: the first.
  if (opts.chainsText !== undefined || fromContext || identity.created) return chains[0]!;
  // An identity that was already there: the one chain it is linked to; with several, a question for a person, a usage error for a script.
  if (identity.linked.length === 1) return identity.linked[0]!;
  if (identity.linked.length === 0) return chains[0]!;
  if (io.interactive && !opts.yes) return io.prompter.ask('  Which chain', identity.linked[0]!);
  throw new UsageError(
    `Which chain? This identity is linked to ${identity.linked.join(', ')}. Pass --chain <chain>, set CERTEN_CHAIN, or choose one once with: certen use chain <chain>`,
    'AMBIGUOUS_CHAIN',
  );
}

// ── funds ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Is gas the ONLY thing in the way, and is it the kind of gap that sending funds fixes?
 *
 * Every other check must be ok or warn: waiting for a faucet while the key page is wrong would be waiting for nothing. And the gas gap itself
 * must be money-shaped: an empty or short account, or one whose balance is not reported yet (a fresh account may not be indexed for a minute).
 * A gas row that cannot be IDENTIFIED (the wrong token, an unknown chain) is not fixed by sending anything.
 */
export function waitableGas(readiness: Readiness): { check: ReadinessCheck; address: string } | undefined {
  const gas = readiness.checks.find((c) => c.name === 'gas');
  if (!gas) return undefined;
  if (!readiness.checks.every((c) => c.name === 'gas' || c.status === 'ok' || c.status === 'warn')) return undefined;
  if (!gasGapIsFundable(gas)) return undefined;
  const address = readiness.context.abstract_account ?? (typeof gas.data?.abstract_account === 'string' ? gas.data.abstract_account : undefined);
  return address ? { check: gas, address } : undefined;
}

/**
 * The funding plan as the `--json` contract carries it (snake_case, like the readiness it travels with). One function, used by `setup` and
 * `gas`, so the two envelopes cannot describe the same plan differently.
 */
export function fundingJson(plan: GasFundingPlan): Record<string, unknown> {
  return {
    chain: plan.chain, symbol: plan.symbol, address: plan.address, balance: plan.balance,
    minimum: plan.minimum, suggested: plan.suggested, send: plan.send, least: plan.least, satisfied: plan.satisfied, estimated: plan.estimated,
    faucet: plan.faucet, payment_uri: plan.paymentUri, steps: plan.steps, wallet_steps: plan.twoStep,
  };
}

/** The instructions for funding an account, indented under the step that needs them. */
export function renderFunding(plan: GasFundingPlan, say: (message: string) => void): void {
  say('');
  say(`  Gas             ${plan.address} holds ${plan.balance ?? 'an unknown amount of'} ${plan.symbol} on ${plan.chain}`);
  for (const line of plan.steps) say(`                  ${line}`);
}
