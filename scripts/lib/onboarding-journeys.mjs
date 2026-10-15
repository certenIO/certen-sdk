/**
 * The documented first-transaction journeys, as data.
 *
 * A journey is the list of things a new developer is told to do, in order. `measure-onboarding --journey`
 * runs the ones that are `certen` commands through the real built CLI and counts what they cost; the ones
 * that are not (an install, a `curl`, a faucet) are listed and counted but cannot be run offline.
 *
 * **What is measured and what is declared.** Round trips and wall-clock are measured: the fake gateway
 * counts what arrives. Which values a person has to carry between steps, and which steps prompt for a
 * passphrase, are properties of the documented journey, not something a subprocess can observe, so they
 * are DECLARED here and reported as such:
 *
 *   - a value is "copied by hand" when a step takes it from an earlier step's output. A `{name}`
 *     placeholder in a command's args is a use, and the run fills it from what an earlier step really
 *     printed, so a journey that referred to a value the CLI never prints would fail rather than count.
 *   - `compares` names a value read off one step and checked by eye against another. It is listed, and not
 *     counted as copied, which is how PLAN section 1 counts it.
 *   - `prompts` is how many times the step asks for a passphrase when it is run by a person. In the run it
 *     is answered from `CERTEN_KEY_PASSPHRASE`, so nothing blocks.
 *
 * **Values given, not copied.** The recipient, the contract and the user's own node are the person's
 * choices, not output from an earlier step, so they are `given` and never counted.
 *
 * Step fields:
 *   label      what the person is doing, in their words
 *   args       the `certen` arguments (omit for an external step); `{name}` is filled from a capture or a given
 *   stdin      text piped to the command
 *   capture    { name: 'path.in.data' } values to remember from this step's `--json` output
 *   exit       exit codes that mean "behaved as declared" (default [0]); `proof verify` uses 0/4/5 because those
 *              are verdicts, not failures
 *   expectError  { 'path.in.error': value } for a step declared to fail: the failure must be this one, not just any
 *              non-zero exit (`status` before funding blocks on the gas, and on nothing else)
 *   uses       values consumed outside `args` (an external step has no args)
 *   compares   values checked by eye, not copied
 *   prompts    passphrase prompts when a person runs it
 *   external   a non-certen action; `description` says what it is
 *   effect     'fund': after this step the abstract account holds gas (what the faucet and the wallet do)
 *   substitutes  the documented command this step stands in for when it cannot run offline
 */

/** A bare address and a 32-byte argument the journeys pass where the person would pass their own. */
export const GIVEN = Object.freeze({
  contract: '0x1111111111111111111111111111111111111111',
  recipient: '0x2222222222222222222222222222222222222222',
  arg32: `0x${'00'.repeat(32)}`,
});

export const JOURNEYS = Object.freeze({
  guide: {
    source: 'docs/guides/first-proof-in-three-commands.md',
    summary: 'login, init, call, proof get: the path this repo documents today',
    steps: [
      { label: 'Install the CLI', external: true, description: 'npm install -g @certen.io/cli' },
      {
        label: 'Sign this machine in',
        args: ['auth', 'login', '--api-key', '-', '--no-keyring'],
        stdin: 'API_KEY',
        // `certen login` is a device flow that opens a browser and waits for a person. The guide documents
        // piping a key in as its fallback, and that is the part that can run offline.
        substitutes: 'certen login',
      },
      {
        label: 'Create the key and the identity',
        args: ['init', '--name', 'journey-probe', '--chains', 'base-sepolia', '--key', 'dev'],
        capture: { identity_id: 'identity_id' },
        prompts: 1,
      },
      {
        label: 'Make the proof-gated call',
        args: [
          'call', '--identity', '{identity_id}', '--chain', 'base-sepolia', '--to', '{contract}',
          '--fn', 'confirm(bytes32)', '--arg', '{arg32}', '--sign-with', 'dev', '--wait',
        ],
        capture: { intent_id: 'intent_id' },
        prompts: 1,
      },
      { label: 'Read the proof', args: ['proof', 'get', '{intent_id}'] },
    ],
  },

  published: {
    source: 'PLAN.md section 1 (the "Run a first CERTEN transaction" walkthrough, transcribed from the plan; the page itself is not in this repo)',
    summary: 'the 12-step walkthrough the plan sets out to shorten',
    steps: [
      { label: 'Install the CLI', external: true, description: 'npm i -g @certen.io/cli' },
      { label: 'Check the install', args: ['--version'], noJson: true },
      { label: 'Check the gateway serves the chain', args: ['chains', '--refresh'] },
      {
        label: 'Sign this machine in',
        args: ['auth', 'login', '--api-key', '-', '--no-keyring'],
        stdin: 'API_KEY',
        substitutes: 'certen login',
      },
      { label: 'Check the credential', args: ['whoami'] },
      {
        label: 'Create the key and the identity',
        args: ['init', '--name', 'journey-probe', '--chains', 'base-sepolia', '--key', 'dev'],
        capture: { identity_id: 'identity_id', adi_url: 'adi_url', abstract_account: 'abstract_accounts.0.address' },
        prompts: 1,
      },
      { label: 'List identities', args: ['identity', 'list'] },
      { label: 'Find the key page', args: ['identity', 'get', '{identity_id}'], capture: { key_page_url: 'key_page_url' } },
      { label: 'Read the portfolio', args: ['portfolio'] },
      { label: 'Run the checks', args: ['doctor'] },
      { label: 'Read the key hash', args: ['keys', 'show', 'dev'], capture: { key_hash: 'public_key_hash' } },
      {
        label: 'Check the key page really holds the key',
        external: true,
        description: 'a hand-written curl to the Accumulate API (raw JSON-RPC)',
        uses: ['adi_url', 'key_page_url'],
        compares: ['key_hash'],
      },
      { label: 'Check the gateway balance', args: ['balance'] },
      { label: 'Get testnet gas from a faucet', external: true, description: 'a faucet website, into a wallet' },
      {
        label: 'Send the gas to the abstract account',
        external: true,
        description: 'a wallet transfer to the abstract account',
        uses: ['abstract_account'],
        effect: 'fund',
      },
      {
        label: 'Make the transaction',
        args: [
          'tx', 'create', '--identity', '{identity_id}', '--to-chain', 'base-sepolia', '--from', '{abstract_account}',
          '--to', '{recipient}', '--amount', '0.0001', '--sign-with', 'dev', '--wait', '--timeout', '6',
        ],
        capture: { intent_id: 'intent_id' },
        prompts: 1,
      },
      { label: 'Read the outcome', args: ['tx', 'status', '{intent_id}'] },
      { label: 'Fetch the proof', args: ['proof', 'get', '{intent_id}'] },
      { label: 'Verify the proof', args: ['proof', 'verify', '{intent_id}'], exit: [0, 4, 5] },
      { label: 'Verify against your own node', args: ['proof', 'verify', '{intent_id}', '--rpc', '{rpc_url}'], exit: [0, 4, 5] },
      {
        label: 'Check the effect by hand',
        external: true,
        description: 'compare the proved recipient, amount and chain with your own notes, and read the recipient\'s balance',
      },
    ],
  },

  /**
   * The published walkthrough, written the way the CLI UX plan's Phase 1 allows: the identity, key and chain come from the context
   * that `init` already recorded (one identity, one key, one linked chain), so `identity get` and `tx create` need no identity
   * UUID, no abstract account and no chain. Everything else is the same step for step, so the two journeys differ in exactly what
   * Phase 1 changed. The baseline journeys above stay as the documented path is TODAY; this is what that path becomes.
   */
  context: {
    source: 'PLAN.md section 1, with the Phase 1 CLI: the context supplies the identity, the chain and the abstract account',
    summary: 'the same transaction once the context is used',
    steps: [
      { label: 'Install the CLI', external: true, description: 'npm i -g @certen.io/cli' },
      { label: 'Check the install', args: ['--version'], noJson: true },
      { label: 'Check the gateway serves the chain', args: ['chains', '--refresh'] },
      {
        label: 'Sign this machine in',
        args: ['auth', 'login', '--api-key', '-', '--no-keyring'],
        stdin: 'API_KEY',
        substitutes: 'certen login',
      },
      { label: 'Check the credential', args: ['whoami'] },
      {
        label: 'Create the key and the identity',
        args: ['init', '--name', 'journey-probe', '--chains', 'base-sepolia', '--key', 'dev'],
        capture: { adi_url: 'adi_url', abstract_account: 'abstract_accounts.0.address' },
        prompts: 1,
      },
      { label: 'List identities', args: ['identity', 'list'] },
      // No UUID: the only identity recorded on this machine is the default.
      { label: 'Find the key page', args: ['identity', 'get'], capture: { key_page_url: 'key_page_url' } },
      { label: 'Read the portfolio', args: ['portfolio'] },
      { label: 'Run the checks', args: ['doctor'] },
      { label: 'Read the key hash', args: ['keys', 'show', 'dev'], capture: { key_hash: 'public_key_hash' } },
      {
        label: 'Check the key page really holds the key',
        external: true,
        description: 'a hand-written curl to the Accumulate API (raw JSON-RPC)',
        uses: ['adi_url', 'key_page_url'],
        compares: ['key_hash'],
      },
      { label: 'Check the gateway balance', args: ['balance'] },
      { label: 'Get testnet gas from a faucet', external: true, description: 'a faucet website, into a wallet' },
      {
        label: 'Send the gas to the abstract account',
        external: true,
        description: 'a wallet transfer to the abstract account',
        uses: ['abstract_account'],
        effect: 'fund',
      },
      {
        // No --identity, no --from, no --to-chain: the identity is the only one recorded, its account on its only chain is derived.
        label: 'Make the transaction',
        args: ['tx', 'create', '--to', '{recipient}', '--amount', '0.0001', '--sign-with', 'dev', '--wait', '--timeout', '6m'],
        capture: { intent_id: 'intent_id' },
        prompts: 1,
      },
      { label: 'Read the outcome', args: ['tx', 'status', '{intent_id}'] },
      { label: 'Fetch the proof', args: ['proof', 'get', '{intent_id}'] },
      { label: 'Verify the proof', args: ['proof', 'verify', '{intent_id}'], exit: [0, 4, 5] },
      { label: 'Verify against your own node', args: ['proof', 'verify', '{intent_id}', '--rpc', '{rpc_url}'], exit: [0, 4, 5] },
      {
        label: 'Check the effect by hand',
        external: true,
        description: 'compare the proved recipient, amount and chain with your own notes, and read the recipient\'s balance',
      },
    ],
  },

  /**
   * The same transaction once `certen status` exists (Phase 2). `status` is the check the walkthrough spreads over six steps: finding the
   * key page and the ADI (`identity get`, `portfolio`), reading the key hash (`keys show`), the hand-written curl that compares the two,
   * `doctor`, and the gateway balance. It reads the key page from Accumulate itself, so nothing is copied to a terminal and compared by eye.
   *
   * It runs twice, as a person would: once to learn what is in the way (the abstract account has no gas, and it names the account to
   * fund, so it exits 1 on purpose), and once after funding to see everything green. `chains --refresh` and `whoami` stay: `setup`
   * (Phase 3) is what retires them. Funding stays a faucet and a wallet until `gas` (Phase 3).
   */
  readiness: {
    source: 'PLAN.md section 1, with the Phase 2 CLI: `status` replaces the key-page curl, the by-eye key comparison, doctor and the balance check',
    summary: 'the same transaction once status reads the key page for you',
    steps: [
      { label: 'Install the CLI', external: true, description: 'npm i -g @certen.io/cli' },
      { label: 'Check the install', args: ['--version'], noJson: true },
      { label: 'Check the gateway serves the chain', args: ['chains', '--refresh'] },
      {
        label: 'Sign this machine in',
        args: ['auth', 'login', '--api-key', '-', '--no-keyring'],
        stdin: 'API_KEY',
        substitutes: 'certen login',
      },
      { label: 'Check the credential', args: ['whoami'] },
      {
        label: 'Create the key and the identity',
        args: ['init', '--name', 'journey-probe', '--chains', 'base-sepolia', '--key', 'dev'],
        capture: { abstract_account: 'abstract_accounts.0.address' },
        prompts: 1,
      },
      // Exit 1 on purpose: a new account has no gas, and `status` says so and names the account to fund. Reading the key page from
      // Accumulate (and the credits, and the balance) is in the same card, and is checked on the second run.
      {
        label: 'See what is in the way',
        args: ['status', '--amount', '0.0001'],
        exit: [1],
        expectError: { code: 'NOT_READY', 'details.readiness.first_blocker.name': 'gas', 'details.readiness.first_blocker.code': 'ABSTRACT_ACCOUNT_UNFUNDED' },
      },
      {
        label: 'Send gas to the abstract account',
        external: true,
        description: 'a faucet website, then a wallet transfer to the abstract account',
        uses: ['abstract_account'],
        effect: 'fund',
      },
      { label: 'Check it is ready', args: ['status', '--amount', '0.0001'] },
      {
        label: 'Make the transaction',
        args: ['tx', 'create', '--to', '{recipient}', '--amount', '0.0001', '--sign-with', 'dev', '--wait', '--timeout', '6m'],
        capture: { intent_id: 'intent_id' },
        prompts: 1,
      },
      { label: 'Read the outcome', args: ['tx', 'status', '{intent_id}'] },
      { label: 'Fetch the proof', args: ['proof', 'get', '{intent_id}'] },
      { label: 'Verify the proof', args: ['proof', 'verify', '{intent_id}'], exit: [0, 4, 5] },
      { label: 'Verify against your own node', args: ['proof', 'verify', '{intent_id}', '--rpc', '{rpc_url}'], exit: [0, 4, 5] },
      {
        label: 'Check the effect by hand',
        external: true,
        description: 'compare the proved recipient, amount and chain with your own notes, and read the recipient\'s balance',
      },
    ],
  },

  /**
   * The same transaction once `certen setup` exists (Phase 3). `setup` is the whole front of the walkthrough: the gateway check that
   * `chains --refresh` was, the sign-in (`auth login`, `whoami`), the key and the identity (`init`), and the readiness card (`status`). It runs
   * twice, as a person would when they cannot fund the account on the spot: once to make everything and learn what is still in the way (the new
   * account has no gas, so it exits 1 on purpose, for that reason and no other, and names the account to fund), and once after funding, which
   * skips every step already done and comes back ready.
   *
   * The account is made WITH the signing key (`--new-account`: no browser, no pasted secret), so this journey needs no `auth login`.
   */
  setup: {
    source: 'PLAN.md section 1, with the Phase 3 CLI: `setup` replaces the gateway check, the sign-in, init and the readiness check',
    summary: 'the same transaction once setup does the whole front of the walkthrough',
    steps: [
      { label: 'Install the CLI', external: true, description: 'npm i -g @certen.io/cli' },
      {
        // Exit 1 on purpose: everything is made, and the account has no gas. Setup says so and names the account.
        label: 'Set everything up',
        args: ['setup', '--yes', '--new-account', '--org-name', 'journey', '--name', 'journey-probe', '--chain', 'base-sepolia', '--no-keyring'],
        exit: [1],
        expectError: { code: 'NOT_READY', 'details.readiness.first_blocker.name': 'gas', 'details.readiness.first_blocker.code': 'ABSTRACT_ACCOUNT_UNFUNDED' },
        captureFrom: 'error',
        capture: { abstract_account: 'details.readiness.context.abstract_account' },
        prompts: 1,
      },
      {
        label: 'Send gas to the abstract account',
        external: true,
        description: 'a faucet website, then a wallet transfer to the abstract account',
        uses: ['abstract_account'],
        effect: 'fund',
      },
      // Everything is already done, so this skips it all and checks that it is ready.
      { label: 'Continue where it stopped', args: ['setup', '--yes', '--no-keyring'] },
      {
        label: 'Make the transaction',
        args: ['tx', 'create', '--to', '{recipient}', '--amount', '0.0001', '--sign-with', 'dev', '--wait', '--timeout', '6m'],
        capture: { intent_id: 'intent_id' },
        prompts: 1,
      },
      { label: 'Read the outcome', args: ['tx', 'status', '{intent_id}'] },
      { label: 'Fetch the proof', args: ['proof', 'get', '{intent_id}'] },
      { label: 'Verify the proof', args: ['proof', 'verify', '{intent_id}'], exit: [0, 4, 5] },
      { label: 'Verify against your own node', args: ['proof', 'verify', '{intent_id}', '--rpc', '{rpc_url}'], exit: [0, 4, 5] },
      {
        label: 'Check the effect by hand',
        external: true,
        description: 'compare the proved recipient, amount and chain with your own notes, and read the recipient\'s balance',
      },
    ],
  },

  /**
   * The headline of Phase 3: ONE `setup` that waits for the gas, so there is no second run. At a terminal that is the default; here
   * `--wait-for-funds` says it, because a journey is not a terminal. The gas arrives while it waits, which is what a faucet and a wallet do, and
   * the fake models it: the account is funded after a few reads of the identity, so the wait polls more than once and then returns.
   *
   * `--poll-interval 0.2` and `--funds-timeout 10s` only make the offline wait short; the budgets a person gets are 6 seconds and 30 minutes.
   */
  'setup-wait': {
    source: 'PLAN.md section 2, with the Phase 3 CLI: `setup` waits for the funds to arrive',
    summary: 'the same transaction with one setup that waits for the gas',
    steps: [
      { label: 'Install the CLI', external: true, description: 'npm i -g @certen.io/cli' },
      {
        label: 'Set everything up, and wait for gas',
        args: [
          'setup', '--yes', '--new-account', '--org-name', 'journey', '--name', 'journey-probe', '--chain', 'base-sepolia', '--no-keyring',
          '--wait-for-funds', '--poll-interval', '0.2', '--funds-timeout', '10s',
        ],
        // Provisioning, then the readiness read, then two polls that find nothing: the gas lands on the fifth read.
        fundsArrive: { afterReads: 5 },
        capture: { abstract_account: 'readiness.context.abstract_account' },
        prompts: 1,
      },
      {
        // Done by a person while the step above waits. It is not a certen command and it cannot be skipped; it is shown where it happens.
        label: 'Send gas to the abstract account, while setup waits',
        external: true,
        description: 'a faucet website (or the wallet link setup printed), into the abstract account',
        uses: ['abstract_account'],
        effect: 'during',
      },
      {
        label: 'Make the transaction',
        args: ['tx', 'create', '--to', '{recipient}', '--amount', '0.0001', '--sign-with', 'dev', '--wait', '--timeout', '6m'],
        capture: { intent_id: 'intent_id' },
        prompts: 1,
      },
      { label: 'Read the outcome', args: ['tx', 'status', '{intent_id}'] },
      { label: 'Fetch the proof', args: ['proof', 'get', '{intent_id}'] },
      { label: 'Verify the proof', args: ['proof', 'verify', '{intent_id}'], exit: [0, 4, 5] },
      { label: 'Verify against your own node', args: ['proof', 'verify', '{intent_id}', '--rpc', '{rpc_url}'], exit: [0, 4, 5] },
      {
        label: 'Check the effect by hand',
        external: true,
        description: 'compare the proved recipient, amount and chain with your own notes, and read the recipient\'s balance',
      },
    ],
  },
});

/** The `{name}` placeholders in a step's args, in order. */
export function placeholdersOf(step) {
  const found = [];
  for (const a of step.args ?? []) for (const m of a.matchAll(/\{([a-z_0-9]+)\}/g)) found.push(m[1]);
  return found;
}

/** Everything a step takes from an earlier step's output: placeholders that are not `given`, plus declared uses. */
export function copiedBy(step, given) {
  const fromArgs = placeholdersOf(step).filter((n) => !(n in given));
  return [...new Set([...fromArgs, ...(step.uses ?? [])])];
}

/**
 * Steps that would write a credential somewhere the throwaway HOME does not reach.
 *
 * `certen login` and `auth login` default to the OS keyring, which is per-user rather than per-HOME: run
 * in a measurement, they would overwrite the developer's real stored key with the fake one. So any step
 * that logs in or signs up must say `--no-keyring`, and the runner refuses to start otherwise.
 */
export function writesCredential(step) {
  const a = step.args ?? [];
  // `setup` can write one too: a new account's key, a registration token's, or the one the device flow returns.
  return a.includes('login') || a.includes('signup') || a.includes('setup');
}

export function assertJourneyIsContained(name, journey) {
  for (const step of journey.steps) {
    if (writesCredential(step) && !step.args.includes('--no-keyring')) {
      throw new Error(`journey "${name}", step "${step.label}": a login must pass --no-keyring, or it writes the real OS keyring`);
    }
  }
}
