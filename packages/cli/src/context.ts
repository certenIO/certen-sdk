import { activeProfile, readProfile, recordedIdentities } from './config.js';
import { listKeys } from './keystore.js';
import { assertChain, isKnownTestnet } from './chains.js';
import { hint } from './output.js';
import { UsageError } from './errors.js';
import { adiLabel, matchRecorded, type RecordedIdentity } from './identity-ref.js';

/**
 * Which identity, which key and which chain a command runs with: decided here, once, for every command.
 *
 * Before this, only `init` read the identity the machine had recorded; `call`, `tx create` and `governance` each made the person
 * type it again, and `--sign-with` was required everywhere. The CLI knew the answer and asked anyway.
 *
 * **Precedence: flag > environment > profile > a single candidate.** A single candidate is a default only when there is exactly
 * one: one recorded identity, one local key, one linked chain. Several is a question, never a guess, and the error lists them.
 *
 * **Everything it hands back says where it came from**, and a command echoes every value that did NOT come from a flag
 * ({@link echoFromContext}). A default the person did not type must not act silently.
 *
 * **A default never points a value-moving command at a mainnet.** Whoever typed `--chain ethereum` meant it; whoever's profile
 * says `chain: ethereum` set that up on some other day and is not looking at it now. So on a value-moving command a chain that is
 * not a KNOWN testnet is refused unless it came from a flag, or the profile says `allow_mainnet_default`. "Not a known testnet"
 * rather than "a mainnet": a chain nobody can classify gets the same answer, because unknown is not ok.
 *
 * Synchronous and local: the config and the key directory, never the network. Every command can call it first and fail on a bad
 * invocation before anything else happens (before a request, before a passphrase prompt).
 */

export type ContextField = 'identity' | 'key' | 'chain';
export type ContextSource = 'flag' | 'env' | 'profile' | 'single';

export interface Resolved {
  value: string;
  source: ContextSource;
  /** Where, in words a person recognises: `CERTEN_CHAIN`, `profile "default"`, `the only identity recorded on this machine`. */
  detail: string;
}

export interface Candidates {
  /** Every identity recorded on this machine. */
  identity: RecordedIdentity[];
  /** Every local signing key. */
  key: string[];
  /** The chains of the resolved identity's record. */
  chain: string[];
}

export interface ResolvedContext {
  profile: string;
  identity?: Resolved;
  key?: Resolved;
  chain?: Resolved;
  /** The profile says a mainnet may be a default. Never set from the environment: a safety rule is not an ambient toggle. */
  allowMainnetDefault: boolean;
  /** What a field could have been, for the error that says which one to choose. */
  candidates: Candidates;
}

export interface ResolveOptions {
  /** The command moves value or authorises execution: apply the mainnet-default rule to the chain. */
  valueMoving?: boolean;
  /** Which fields the command uses. Default: all three. A field not listed is not looked up (the key directory is not read for it). */
  fields?: ContextField[];
  /**
   * Take the chain from the resolved identity's only linked chain when nothing else names one. On by default. A command that is not
   * about an identity (`fund` tops up the organization's balance) turns it off: the identity's chain is no reason to pick a chain
   * for that.
   */
  inferChain?: boolean;
}

const ENV_VAR: Record<ContextField, string> = {
  identity: 'CERTEN_IDENTITY',
  key: 'CERTEN_KEY',
  chain: 'CERTEN_CHAIN',
};

const present = (v: string | undefined): string | undefined => {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : undefined;
};

export function resolveContext(
  flags: { identity?: string; key?: string; chain?: string },
  options: ResolveOptions = {},
): ResolvedContext {
  const fields = new Set<ContextField>(options.fields ?? ['identity', 'key', 'chain']);
  const profile = activeProfile();
  const settings = readProfile(profile);
  const allowMainnetDefault = settings.allow_mainnet_default === true;
  const candidates: Candidates = { identity: [], key: [], chain: [] };

  /** flag > env > profile, in that order. A single candidate is added by the caller when this finds nothing. */
  const explicit = (field: ContextField): Resolved | undefined => {
    const fromFlag = present(flags[field]);
    if (fromFlag) return { value: fromFlag, source: 'flag', detail: 'flag' };
    const fromEnv = present(process.env[ENV_VAR[field]]);
    if (fromEnv) return { value: fromEnv, source: 'env', detail: ENV_VAR[field] };
    const fromProfile = present(settings[field]);
    if (fromProfile) return { value: fromProfile, source: 'profile', detail: `profile "${profile}"` };
    return undefined;
  };

  // The chain's single candidate depends on which identity was resolved, so identity is looked at whenever the chain is.
  const inferChain = options.inferChain !== false;
  const needIdentity = fields.has('identity') || (fields.has('chain') && inferChain);
  let identity: Resolved | undefined;
  if (needIdentity) {
    candidates.identity = recordedIdentities() as RecordedIdentity[];
    identity = explicit('identity');
    if (!identity && candidates.identity.length === 1) {
      identity = { value: candidates.identity[0]!.id, source: 'single', detail: 'the only identity recorded on this machine' };
    }
  }

  let key: Resolved | undefined;
  if (fields.has('key')) {
    try { candidates.key = listKeys().map((k) => k.name); } catch { candidates.key = []; }
    key = explicit('key');
    if (!key && candidates.key.length === 1) {
      key = { value: candidates.key[0]!, source: 'single', detail: 'the only signing key on this machine' };
    }
  }

  let chain: Resolved | undefined;
  if (fields.has('chain')) {
    chain = explicit('chain');
    // The chains the RESOLVED identity is linked to, from this machine's record of it. Never the union over every identity.
    if (identity && inferChain) {
      let record: RecordedIdentity | undefined;
      try { record = matchRecorded(identity.value)[0]; } catch { record = undefined; }
      candidates.chain = record?.chains ?? [];
    }
    if (!chain && candidates.chain.length === 1) {
      chain = { value: candidates.chain[0]!, source: 'single', detail: 'the only chain this identity is linked to' };
    }
  }

  if (options.valueMoving && chain && chain.source !== 'flag' && !allowMainnetDefault && !isKnownTestnet(chain.value)) {
    // The rule speaks for a chain the CLI would otherwise ACCEPT, which is only so for someone who opted in to any chain
    // (CERTEN_ALLOW_ANY_CHAIN) or a configured set. A chain it would refuse anyway is refused by `assertChain` with the better
    // message, which names the source and suggests the nearest testnet: calling a typo a mainnet would send someone looking for
    // the wrong problem.
    assertChain(chain.value, sourceLabel(chain, '--chain'));
    throw new UsageError(
      `The chain "${chain.value}" comes from ${chain.detail}, and it is not a known testnet. A command that moves value never takes a `
      + 'chain that is not a known testnet from a default: spell it out, so it is the one you mean. '
      + `Run it with --chain ${chain.value}, or mark this profile with: certen use allow-mainnet-default on`,
      'MAINNET_DEFAULT_REFUSED',
    );
  }

  return {
    profile,
    ...(fields.has('identity') && identity ? { identity } : {}),
    ...(key ? { key } : {}),
    ...(chain ? { chain } : {}),
    allowMainnetDefault,
    candidates,
  };
}

const describeRecorded = (r: RecordedIdentity): string => `${r.name ?? adiLabel(r.adi_url)} (${r.adi_url})`;

/** The identity, or a usage error that says which one to choose (or that there is none). */
export function requireIdentity(ctx: ResolvedContext, flag = '--identity'): Resolved {
  if (ctx.identity) return ctx.identity;
  if (ctx.candidates.identity.length > 1) {
    throw new UsageError(
      `Which identity? Several are recorded on this machine and none is chosen: ${ctx.candidates.identity.map(describeRecorded).join(', ')}. `
      + `Pass ${flag} <uuid | acc://adi | name>, set CERTEN_IDENTITY, or choose one once with: certen use identity <ref>`,
      'AMBIGUOUS_IDENTITY',
    );
  }
  throw new UsageError(
    `No identity to act as. Pass ${flag} <uuid | acc://adi | name>, set CERTEN_IDENTITY, or choose one once with: certen use identity <ref>. `
    + (ctx.candidates.identity.length === 0 ? 'None is recorded on this machine yet: create one with: certen init' : ''),
    'MISSING_IDENTITY',
  );
}

/** The chain, or a usage error that says which one to choose. `flag` is the option the person would type for this command. */
export function requireChain(ctx: ResolvedContext, flag = '--chain'): Resolved {
  if (ctx.chain) return ctx.chain;
  if (ctx.candidates.chain.length > 1) {
    throw new UsageError(
      `Which chain? This identity is linked to ${ctx.candidates.chain.join(', ')}. Pass ${flag} <chain>, set CERTEN_CHAIN, or choose one once with: certen use chain <chain>`,
      'AMBIGUOUS_CHAIN',
    );
  }
  throw new UsageError(
    `No chain given. Pass ${flag} <chain>, set CERTEN_CHAIN, or choose one once with: certen use chain <chain>. Chains: certen chains`,
    'MISSING_CHAIN',
  );
}

/** How a value is described when it is reported: `using chain base-sepolia (from CERTEN_CHAIN)`. */
function phrase(r: Resolved): string {
  return r.source === 'single' ? r.detail : `from ${r.detail}`;
}

/**
 * Say, on stderr, that a value was taken from context rather than typed. Silent for a flag, which the person just typed.
 *
 * stderr in both modes: in `--json` mode stdout is exactly one envelope, and this is not part of it. `shown` is what the person
 * will recognise (the ADI URL for an identity whose context value is a UUID).
 */
export function echoFromContext(field: ContextField, r: Resolved | undefined, shown?: string): void {
  if (!r || r.source === 'flag') return;
  hint(`using ${field} ${shown ?? r.value} (${phrase(r)})`);
}

/**
 * What to call the source of a value in an error that blames it (`CERTEN_CHAIN: "x" is not a supported chain`), where for a flag
 * the message should name the flag the person typed.
 */
export function sourceLabel(r: Resolved, flagName: string): string {
  if (r.source === 'flag') return flagName;
  if (r.source === 'single') return "this identity's only chain";
  return r.detail;
}
