import { CertenError, VENDORED_ERROR_CODES } from '@certen.io/sdk';

/**
 * The one command to run after a failure.
 *
 * A failure that ends in prose leaves the reader to work out what to type. The CLI already knows: the code says what went wrong, the command that
 * was running says where, and for nearly every failure there is a single command that moves forward (`certen status`, `certen gas --wait`,
 * `certen setup`). So every failure, in both modes, ends with exactly one of them: `error.next` in the `--json` envelope (additive: a consumer
 * that ignores unknown keys is unaffected) and a last line `  next: <command>` on stderr for a person.
 *
 * WHERE THE ANSWER COMES FROM, in order. The ladder is what makes "every failure" true at run time, and the tests make it true in the table:
 *
 *   1. `err.next`        a thrower that holds the chain, the key or the intent id says so itself.
 *   2. STEPS[code]       this file: one line per code the CLI raises, and per SDK or gateway code the CLI can meet.
 *   3. the catalogue     a code the gateway publishes is explained by `certen errors <CODE>` (retryable or not, whose side it is, what to do).
 *   4. the HTTP class    401 -> sign in again, 403 -> `whoami` shows the scopes, 402 -> `fund`, 5xx -> `doctor`, other 4xx -> the command's help.
 *   5. `certen doctor`   a typed failure nobody classified. An untyped one ends with the failing command's own `--help` instead: doctor diagnoses
 *                        the gateway and the credential, and "no key named dev" is neither.
 *
 * NEVER BUILT FROM GATEWAY TEXT. `next` is a line someone may paste into a shell and an agent may run. A gateway that said "run certen fund 99999"
 * would be handing out commands, so the only things interpolated are values this CLI checks against a strict pattern (`uuidArg`, `chainArg`,
 * `keyArg`); anything else becomes a `<placeholder>`, which is also what a value the person still has to choose looks like. A final guard drops
 * any line that is not one plain `certen ...` command.
 *
 * `next-step.test.ts` holds the table to the real command tree (every command and `--flag` named here exists) and to the source (every code a
 * `CliError` or `UsageError` is built with has an entry here), so advice cannot go stale and a new code cannot ship without a next step.
 */

/** What a step is told about the failure. */
export interface NextContext {
  /** The command that was running, e.g. `['tx', 'create']`. Empty at the root (an unknown command, `--help`). */
  command: readonly string[];
  code: string;
  status?: number;
  /** The error's `details`, if it carried any. Only ever read through the `*Arg` helpers below. */
  details: Record<string, unknown>;
}

type Step = string | ((c: NextContext) => string);

interface ErrorLike {
  code?: unknown;
  status?: unknown;
  details?: unknown;
  next?: unknown;
}

// ── the command that was running ────────────────────────────────────────────────────────────────

let active: readonly string[] = [];

/** Recorded by the `preAction` hook and by commander's per-command exit callback (see index.ts). */
export function setActiveCommand(path: readonly string[]): void {
  active = [...path];
}

export function activeCommand(): readonly string[] {
  return active;
}

/** `['tx','create']` -> `certen tx create --help`. */
export function helpFor(command: readonly string[]): string {
  return command.length === 0 ? 'certen --help' : `certen ${command.join(' ')} --help`;
}

// ── values that may be interpolated ─────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAIN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** A UUID as written, or `<placeholder>`. */
export function uuidArg(value: unknown, placeholder = '<id>'): string {
  return typeof value === 'string' && UUID.test(value) ? value : placeholder;
}

/** A chain slug as written, or `<chain>`. Slugs are lowercase letters, digits and hyphens. */
export function chainArg(value: unknown): string {
  return typeof value === 'string' && CHAIN.test(value) ? value : '<chain>';
}

/** A local key name as the key store spells it, or `<key>`. */
export function keyArg(value: unknown): string {
  return typeof value === 'string' && KEY_NAME.test(value) ? value : '<key>';
}

const intentOf = (d: Record<string, unknown>): string => uuidArg(d.intent_id ?? d.intentId, '<intent-id>');
const chainOf = (d: Record<string, unknown>): string => chainArg(d.chain);

// ── the table ───────────────────────────────────────────────────────────────────────────────────

const help: Step = (c) => helpFor(c.command);
const ofCommand = (root: string, then: Step, otherwise: Step): Step => (c) => {
  const chosen = c.command[0] === root ? then : otherwise;
  return typeof chosen === 'string' ? chosen : chosen(c);
};

/**
 * Codes whose remedy is "look at how this command is used": a malformed value, two flags that exclude each other, a missing argument. The
 * failing command's own help is the right place, and which command that is cannot be written down here.
 */
const USAGE_CODES = [
  'USAGE_ERROR', 'UNKNOWN_ERROR',
  'ARGUMENT_COUNT_MISMATCH', 'BLIND_SIGNING_REFUSED', 'CONFIRMATION_REQUIRED', 'CONFLICTING_FLAGS', 'CONFLICTING_KEY_FLAGS',
  'CONFLICTING_OPTIONS', 'CONFLICTING_PAGING_FLAGS', 'CONFLICTING_QUOTE_ARGS', 'CONFLICTING_SIGNING_FLAGS', 'CONFLICTING_UNSET',
  'EXPECT_NEEDS_WAIT', 'INCOMPLETE_INTENT', 'INVALID_ACCUMULATE_RPC', 'INVALID_ADDRESS', 'INVALID_AMOUNT', 'INVALID_ARGUMENT',
  'INVALID_EXPECT', 'INVALID_FUNCTION_SIGNATURE', 'INVALID_INTENT_JSON', 'INVALID_LEG_COUNT', 'INVALID_NUMBER', 'INVALID_PAYER_ADDRESS',
  'INVALID_PROOF_CLASS', 'INVALID_PROOF_TARGET', 'INVALID_PUBLIC_KEY', 'INVALID_RPC', 'INVALID_SIGN_TARGET', 'INVALID_SIGNING_DATA_JSON',
  // The key store's invocation mistakes: a name that cannot be a file name, a hash that is not hex, two passphrases that differ, nothing to prompt on.
  'INVALID_KEY_NAME', 'INVALID_HASH', 'PASSPHRASE_MISMATCH', 'NO_TTY',
  'INVALID_URL', 'INVALID_VALUE', 'MISSING_CHAIN', 'MISSING_SIGNATURE', 'MISSING_SIGNER_DETAILS', 'MISSING_SIGNING_DATA', 'MISSING_TOKEN',
  'MISSING_VALUE', 'SIGN_WITH_NEEDS_TRANSACTION', 'SIGNER_KEY_MISMATCH', 'TREE_SIZE_WITHOUT_PROOF', 'TUPLE_NOT_SUPPORTED',
  'UNREADABLE_BUNDLE', 'INCLUSION_NOT_ESTABLISHED', 'RECEIPT_VERIFICATION_FAILED', 'RECEIPT_VERIFICATION_INCOMPLETE', 'PAYMENT_NOT_OPENED',
  // The SDK's own refusals of a malformed header field or path, raised before any request.
  'INVALID_ADDITIONAL_AUTHORITIES', 'INVALID_EXPIRES_AT', 'INVALID_DURATION', 'INVALID_PATH_PARAMETER',
  // The node the person pointed `--rpc` at: refused, unreadable, or on another chain. The command's help says what the flag takes.
  'EVM_RPC_CHAIN_UNKNOWN', 'EVM_RPC_ERROR', 'EVM_RPC_INVALID', 'EVM_RPC_UNREADABLE', 'EVM_RPC_WRONG_CHAIN',
  // The gateway's "your request is malformed" family: the command's help is where the flag is.
  'VALIDATION_ERROR', 'BAD_REQUEST',
] as const;

const STEPS: Record<string, Step> = {
  // ── signing in ──
  // `setup` raises this itself when it cannot ask which kind of account (no terminal, or --yes): pointing it at itself would loop, so it names
  // the answer it wants. `auth login` raises it when it was given no key to store; its own help says how to hand one over.
  NO_API_KEY: (c) => (c.command[0] === 'setup' ? 'certen setup --existing-account' : c.command[0] === 'auth' ? helpFor(c.command) : 'certen setup'),
  INVALID_API_KEY: 'certen login',
  CREDENTIAL_REJECTED: 'certen setup --existing-account',
  UNAUTHORIZED: 'certen setup --existing-account',
  FORBIDDEN: 'certen whoami',
  API_KEY_ENV_SET: 'certen whoami',
  CONFIG_PERMISSIONS: 'certen auth login',
  // For the API key it is `auth login --no-keyring`. For an unlocked key session there is no file to fall back to, by design: `keys unlock --help` says
  // what the feature needs, and signing carries on asking for the passphrase.
  KEYRING_UNAVAILABLE: (c) => (c.command[0] === 'keys' ? 'certen keys unlock --help' : 'certen auth login --no-keyring'),
  KEY_STORAGE_FAILED: ofCommand('setup', 'certen setup --existing-account', 'certen auth login --no-keyring'),
  SELF_SERVICE_DISABLED: ofCommand('setup', 'certen setup --existing-account', 'certen auth login'),
  DEVICE_CODE_EXPIRED: 'certen login',
  DEVICE_CODE_DENIED: 'certen login',
  DEVICE_CODE_ALREADY_CLAIMED: 'certen login',
  DEVICE_FLOW_FAILED: 'certen login',
  DEVICE_FLOW_UNSUPPORTED: 'certen auth login',
  INVALID_GATEWAY_URL: 'certen use gateway <url>',
  // `doctor` is what answers "is the gateway reachable"; when doctor is the command that could not reach it, `context` shows which gateway it tried.
  NETWORK_ERROR: ofCommand('doctor', 'certen context', 'certen doctor'),
  FOREIGN_ORIGIN_URL: 'certen context',

  // ── profiles and the context ──
  PROFILE_NOT_FOUND: 'certen context',
  MISSING_PROFILE_NAME: 'certen context',
  INVALID_PROFILE_NAME: 'certen context',
  DUPLICATE_PROFILE_FLAG: 'certen context',
  AMBIGUOUS_IDENTITY: 'certen use identity <id|adi|alias>',
  MISSING_IDENTITY: 'certen setup',
  NO_IDENTITIES: 'certen setup',
  IDENTITY_NOT_FOUND: 'certen identity list',
  IDENTITY_ID_UNRESOLVED: 'certen identity list',
  INVALID_IDENTITY_REF: 'certen identity list',
  UNKNOWN_IDENTITY_ALIAS: 'certen identity list',
  NO_IDENTITY_ID: 'certen identity list',
  AMBIGUOUS_KEY: 'certen use key <name>',
  MISSING_SIGNING_KEY: 'certen keys list',
  UNKNOWN_KEY: 'certen keys list',
  AMBIGUOUS_CHAIN: 'certen use chain <chain>',
  CHAIN_REQUIRED: 'certen use chain <chain>',
  UNSUPPORTED_CHAIN: 'certen chains',
  UNKNOWN_CHAIN: 'certen chains',
  CHAIN_NOT_ENABLED: 'certen chains',
  CHAIN_UNRESOLVED: 'certen chains',
  NO_CHAINS: 'certen identity link-chain <id> --chain <chain>',
  // A chain that came from a default is refused for a command that moves value unless it is a known testnet. Listing the chains is how a person
  // finds the exact slug to spell out.
  MAINNET_DEFAULT_REFUSED: 'certen chains',
  UNKNOWN_SCOPE: 'certen scopes',
  UNKNOWN_ERROR_CODE: 'certen errors',

  // ── is it ready ──
  GAS_UNREADABLE: 'certen status',
  IDENTITY_CANNOT_SIGN: 'certen status',
  IDENTITY_CAN_SIGN_UNKNOWN: 'certen status',
  IDENTITY_WAIT_TIMEOUT: 'certen status',
  IDENTITY_PROVISIONING_FAILED: 'certen setup',
  NOT_READY: 'certen status',
  NOT_CONFIRMED: 'certen status',
  DOCTOR_CHECKS_FAILED: 'certen status',
  NO_ABSTRACT_ACCOUNT: 'certen identity link-chain <id> --chain <chain>',
  CHAIN_NOT_LINKED: 'certen identity link-chain <id> --chain <chain>',
  ABSTRACT_ACCOUNT_UNFUNDED: (c) => `certen gas --chain ${chainOf(c.details)} --wait`,
  ABSTRACT_ACCOUNT_UNDERFUNDED: (c) => `certen gas --chain ${chainOf(c.details)} --wait`,
  ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE: (c) => `certen status --chain ${chainOf(c.details)}`,
  FUNDS_WAIT_TIMEOUT: ofCommand('setup', 'certen setup', 'certen gas --wait'),
  PASSPHRASE_REQUIRED: 'certen keys path',
  // Keys that stay unlocked for a while (experimental, behind the security review: docs/security/keys-unlock-review.md).
  KEY_UNLOCK_NOT_ENABLED: 'certen keys --help',
  KEY_NOT_ENCRYPTED: 'certen keys list',
  // The key store's other answers. A name already taken is settled by looking at what is there; a key FILE that cannot be used (unreadable, damaged, from a
  // newer CLI, readable by others) is found with `keys path`, which says where they are kept.
  KEY_EXISTS: 'certen keys list',
  KEY_FILE_INSECURE: 'certen keys path',
  KEY_FILE_CORRUPT: 'certen keys path',
  KEY_FILE_UNSUPPORTED: 'certen keys path',
  UNLOCK_DURATION_INVALID: 'certen keys unlock --help',
  LOCK_TARGET_REQUIRED: 'certen keys list',
  // Ctrl-C stops the wait and never the intent. A funds wait is resumed by running the same command; an intent wait by `watch`.
  INTERRUPTED: (c) => {
    if (c.command[0] === 'setup') return 'certen setup';
    if (c.command[0] === 'gas') return 'certen gas --wait';
    return `certen watch ${intentOf(c.details)}`;
  },

  // ── sending and what came of it ──
  TX_WAIT_TIMEOUT: (c) => `certen watch ${intentOf(c.details)}`,
  WAIT_TIMEOUT: (c) => `certen watch ${intentOf(c.details)}`,
  WAIT_ABORTED: (c) => `certen watch ${intentOf(c.details)}`,
  PROOF_NOT_ASSIGNED: (c) => `certen watch ${intentOf(c.details)}`,
  TX_FAILED: (c) => `certen receipt ${intentOf(c.details)}`,
  INTENT_FAILED: (c) => `certen receipt ${intentOf(c.details)}`,
  SIGNING_DECLINED: (c) => (uuidArg(c.details.intent_id, '') ? `certen tx status ${intentOf(c.details)}` : 'certen status'),
  NO_SIGNING_DATA: 'certen tx status <intent-id>',
  NO_PROOF_AVAILABLE: 'certen tx status <intent-id>',
  UNSUPPORTED_ASSET: 'certen call --help',
  WRONG_PASSPHRASE: (c) => `certen keys verify ${keyArg(c.details.key)}`,
  RECEIPT_NOT_SAVED: 'certen receipt <intent-id>',
  NO_SAVED_RECEIPT: 'certen receipt <intent-id>',
  NOTHING_TO_SHARE: 'certen receipt <intent-id>',
  NO_RECEIPTS: 'certen send --help',
  INVALID_INTENT_ID: 'certen receipt --list',
  PROOF_SERVICE_UNAVAILABLE: 'certen doctor',

  // ── reading an address or an identity ──
  // A balance the chain's node did not give is not a zero and not a reason to look elsewhere: the same read, again, is the next step.
  BALANCE_UNREADABLE: 'certen balance <address> --chain <chain>',
  // The gateway is older than this CLI (the route is not served): nothing about the invocation is wrong, and `doctor` says which gateway answered.
  ENDPOINT_NOT_ON_GATEWAY: 'certen doctor',
  // The proof service holds no v2 document for this proof; the bundle route is the other way to read it.
  PROOF_V2_NOT_AVAILABLE: 'certen proof get <id>',

  // ── money ──
  DEPOSIT_NOT_CREDITED: 'certen balance',
  PAYMENT_REQUIRED: 'certen fund <usd>',
  INSUFFICIENT_BALANCE: 'certen fund <usd>',

};

for (const code of USAGE_CODES) STEPS[code] ??= help;

/** Codes the gateway publishes. A code in this set that has no entry above is explained by `certen errors <CODE>`. */
const CATALOGUED = new Set<string>(VENDORED_ERROR_CODES);

function safeLine(line: string): string | undefined {
  // One physical line, starting with the program name. What is inside `<...>` is a placeholder for a person and may hold punctuation (`<id|adi|alias>`);
  // outside it, nothing a shell would act on.
  if (!/^certen [^\r\n]+$/.test(line)) return undefined;
  // An allow-list, not a list of bad characters: a shell has too many (`> < * ~ ! # ? ; & | $ ( ) { } \ ' "` and the backtick) to enumerate safely.
  const bare = line.replace(/<[^<>\r\n]*>/g, '');
  return /^[A-Za-z0-9 _.,:=\/@+-]*$/.test(bare) ? line : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The single command to run after this failure. Always returns one: see the ladder in the header.
 *
 * @param command the command that was running; defaults to the one recorded by `setActiveCommand`.
 */
export function nextStepFor(err: unknown, command: readonly string[] = active): string {
  const e = (err ?? {}) as ErrorLike;
  const code = typeof e.code === 'string' && e.code.length > 0 ? e.code : 'UNKNOWN_ERROR';
  const status = typeof e.status === 'number' ? e.status : undefined;
  const ctx: NextContext = { command, code, ...(status !== undefined ? { status } : {}), details: asRecord(e.details) };
  const fallbackHelp = helpFor(command);

  // 1. The thrower knew better.
  if (typeof e.next === 'string') {
    const explicit = safeLine(e.next);
    if (explicit) return explicit;
  }

  // 2. The table.
  const step = STEPS[code];
  if (step !== undefined) {
    const line = safeLine(typeof step === 'string' ? step : step(ctx));
    if (line) return line;
    return fallbackHelp;
  }

  // 3. The gateway's own catalogue.
  if (CATALOGUED.has(code)) return `certen errors ${code}`;

  // 4. The kind of failure, when it is an answer from a gateway (a CertenError carries its HTTP status; 0 means no response).
  if (e instanceof CertenError || status !== undefined) {
    if (status === 401) return 'certen setup --existing-account';
    if (status === 403) return 'certen whoami';
    if (status === 402) return 'certen fund <usd>';
    if (status !== undefined && status >= 500) return 'certen doctor';
    if (status !== undefined && status >= 400 && status < 500) return fallbackHelp;
    return 'certen doctor';
  }

  // 5. Untyped: not the gateway's fault and not the credential's. How the command is used is the nearest thing to a cause.
  return code === 'UNKNOWN_ERROR' ? fallbackHelp : 'certen doctor';
}

/** For tests and `certen errors`-style tooling: every code with an explicit entry. */
export function explicitNextCodes(): string[] {
  return Object.keys(STEPS).sort();
}
