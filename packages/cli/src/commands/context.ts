import { Command } from 'commander';
import { CertenClient, CertenError } from '@certen.io/sdk';
import {
  activeProfile, assertProfileKnown, credentialInfo, getApiKey, getApiUrl, listProfiles, readConfig, readProfile,
  rememberIdentity, setActiveProfile, updateProfile, DEFAULT_PROFILE,
} from '../config.js';
import { printOutput, human, hint } from '../output.js';
import { UsageError, CliError } from '../errors.js';
import { assertChain, isKnownTestnet } from '../chains.js';
import { getKeyInfo, keyExists, listKeys } from '../keystore.js';
import { resolveContext, type Resolved } from '../context.js';
import { adiLabel, classifyIdentityRef, matchRecorded, resolveIdentityRef, type RecordedIdentity } from '../identity-ref.js';

/**
 * `certen context` and `certen use`: see which identity, key, chain and gateway commands will use, and choose them once.
 *
 * The CLI recorded the identities it made and never used them again: every command asked for `--identity` and `--sign-with`
 * afresh. `use` writes the answer once, onto a profile; every command then reads it through `resolveContext()` (context.ts),
 * which is also what `context` prints, so what this command shows is exactly what the next command will do.
 *
 * Both are local. They read and write ~/.certen and touch the gateway only where a value is worth checking: `use identity` of a
 * UUID this machine has never seen. Nothing here signs, spends or creates anything.
 */

async function clientOrUndefined(): Promise<CertenClient | undefined> {
  try {
    return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
  } catch (err) {
    // No credential is not an error for a command that can do its job from this machine's own record.
    if (err instanceof CliError && err.code === 'NO_API_KEY') return undefined;
    throw err;
  }
}

function gatewaySource(profile: string): 'env' | 'profile' | 'default-profile' | 'default' {
  if (process.env.CERTEN_API_URL) return 'env';
  if (readProfile(profile).api_url) return 'profile';
  return readConfig().api_url ? 'default-profile' : 'default';
}

function credentialSource(profile: string): { source: 'env' | 'keyring' | 'file' | null; key_prefix: string | null } {
  if (process.env.CERTEN_API_KEY) return { source: 'env', key_prefix: `${process.env.CERTEN_API_KEY.substring(0, 12)}` };
  const c = credentialInfo(profile);
  if (c.storage === 'keyring') return { source: 'keyring', key_prefix: c.key_prefix ?? null };
  if (c.has_file_key) return { source: 'file', key_prefix: c.key_prefix ?? null };
  return { source: null, key_prefix: null };
}

const describeRecorded = (r: RecordedIdentity): string => `${r.name ?? adiLabel(r.adi_url)} (${r.adi_url})`;

function recordedFor(value: string): RecordedIdentity | undefined {
  try { return matchRecorded(value)[0]; } catch { return undefined; }
}

/** How a resolved value was arrived at, for a person: `from profile "default"`, `the only key on this machine`. */
const phrase = (r: Resolved): string => (r.source === 'single' ? r.detail : `from ${r.detail}`);

function contextAction(): void {
  const profile = activeProfile();
  assertProfileKnown(profile);
  const ctx = resolveContext({}, {});
  const settings = readProfile(profile);

  const identityRecord = ctx.identity ? recordedFor(ctx.identity.value) : undefined;
  const identity = ctx.identity
    ? {
      ...ctx.identity,
      adi_url: identityRecord?.adi_url ?? (classifyIdentityRef(ctx.identity.value).kind === 'adi' ? ctx.identity.value : null),
      name: identityRecord?.name ?? null,
    }
    : null;
  const key = ctx.key ? { ...ctx.key, exists: keyExists(ctx.key.value) } : null;
  const chain = ctx.chain ? { ...ctx.chain, known_testnet: isKnownTestnet(ctx.chain.value) } : null;
  const gateway = { url: getApiUrl(), source: gatewaySource(profile) };
  const credential = credentialSource(profile);

  printOutput({
    profile,
    profiles: listProfiles(),
    gateway,
    credential,
    identity,
    key,
    chain,
    allow_mainnet_default: settings.allow_mainnet_default === true,
    candidates: {
      identity: ctx.candidates.identity.map((r) => ({ id: r.id, adi_url: r.adi_url, name: r.name ?? null })),
      key: ctx.candidates.key,
      chain: ctx.candidates.chain,
    },
  }, { machineOnly: true });

  const row = (label: string, text: string): void => human(`  ${label.padEnd(11)}${text}`);
  human('');
  row('Profile', `${profile}  (gateway ${gateway.url}${gateway.source === 'default' ? ', the default' : `, from ${gateway.source}`})`);
  row('Credential', credential.source
    ? `${credential.key_prefix ?? ''}...  (${credential.source === 'env' ? 'CERTEN_API_KEY' : credential.source === 'keyring' ? 'OS keyring' : 'config file'})`
    : `none for this profile  (certen auth login${profile === DEFAULT_PROFILE ? '' : ` --profile ${profile}`})`);

  if (identity) {
    const shown = identity.adi_url ?? identity.value;
    row('Identity', `${shown}  (${identity.name ? `${identity.name}, ` : ''}${phrase(ctx.identity!)})`);
  } else if (ctx.candidates.identity.length > 1) {
    row('Identity', `not chosen. Recorded here: ${ctx.candidates.identity.map(describeRecorded).join(', ')}  ->  certen use identity <ref>`);
  } else {
    row('Identity', 'not chosen  ->  certen use identity <ref>   (certen init makes one)');
  }

  if (key) row('Key', `${key.value}  (${phrase(ctx.key!)}${key.exists ? '' : '; NOT FOUND on this machine'})`);
  else if (ctx.candidates.key.length > 1) row('Key', `not chosen. Local keys: ${ctx.candidates.key.join(', ')}  ->  certen use key <name>`);
  else row('Key', 'not chosen  ->  certen use key <name>   (certen keys generate --name dev makes one)');

  if (chain) row('Chain', `${chain.value}  (${phrase(ctx.chain!)})`);
  else if (ctx.candidates.chain.length > 1) row('Chain', `not chosen. This identity is linked to: ${ctx.candidates.chain.join(', ')}  ->  certen use chain <chain>`);
  else row('Chain', 'not chosen  ->  certen use chain <chain>');

  if (listProfiles().length > 1) row('Profiles', listProfiles().map((p) => (p === profile ? `${p}*` : p)).join(', '));
  human('');

  if (chain && !chain.known_testnet) {
    hint(`The chain "${chain.value}" is not a known testnet. A command that moves value will not take it as a default `
      + `${ctx.allowMainnetDefault ? '' : '(unless you pass --chain, or mark this profile: certen use allow-mainnet-default on)'}`.trimEnd());
  }
  if (key && !key.exists) hint(`The key "${key.value}" is not on this machine. See yours with: certen keys list`);
}

interface UseOptions { unset?: boolean }

/** `<value>` or `--unset`, never both and never neither. */
function valueOrUnset(value: string | undefined, opts: UseOptions, what: string): string | null {
  if (opts.unset && value !== undefined) {
    throw new UsageError(`Give either a ${what} or --unset, not both.`, 'CONFLICTING_UNSET');
  }
  if (opts.unset) return null;
  if (value === undefined || value.trim() === '') {
    throw new UsageError(`Which ${what}? Pass it, for example: certen use ${what} <value>. To clear it: certen use ${what} --unset`, 'MISSING_VALUE');
  }
  return value.trim();
}

function reportSet(field: string, profile: string, value: string | null, extra: Record<string, unknown> = {}): void {
  // The sentence below is the human output; the table would say it twice.
  printOutput({ profile, [field]: value, ...extra }, { machineOnly: true });
  human(value === null
    ? `  Cleared the ${field} on profile "${profile}".`
    : `  Set the ${field} on profile "${profile}" to ${extra.adi_url ?? value}.`);
}

async function useIdentity(ref: string | undefined, opts: UseOptions): Promise<void> {
  const profile = activeProfile();
  const value = valueOrUnset(ref, opts, 'identity');
  if (value === null) {
    updateProfile(profile, { identity: null });
    reportSet('identity', profile, null);
    return;
  }

  const classified = classifyIdentityRef(value);
  const known = recordedFor(value);
  let verified = false;
  let note: string | undefined;
  let resolved: { id: string; adi_url?: string } | undefined;

  if (classified.kind === 'alias') {
    // A name only ever means something on this machine: resolve it from the record, or say what is recorded.
    const r = await resolveIdentityRef(value, { need: 'id' });
    resolved = { id: r.id!, adi_url: r.adi_url };
  } else if (known) {
    resolved = { id: known.id, adi_url: known.adi_url };
  } else {
    // Never seen here. The gateway can say whether it is real, when there is a credential to ask with.
    const client = await clientOrUndefined();
    try {
      const r = await resolveIdentityRef(value, { client, need: 'id' });
      resolved = { id: r.id!, adi_url: r.adi_url };
      if (client) {
        const found = await client.identity.get(resolved.id, { include: [] });
        resolved.adi_url = found.adi_url;
        verified = true;
        // Recorded, so its name and ADI resolve from now on with no request.
        rememberIdentity({
          id: resolved.id,
          adi_url: found.adi_url,
          chains: (found.chain_accounts ?? []).map((a) => a.chain_id),
          ...((found as { name?: string }).name ? { name: (found as { name?: string }).name } : {}),
        });
      }
    } catch (err) {
      if (err instanceof CertenError && err.status === 404) {
        throw new UsageError(
          `The gateway has no identity ${classified.kind === 'uuid' ? classified.id : value} for this organization. Check it, or list yours with: certen identity list`,
          'IDENTITY_NOT_FOUND',
        );
      }
      // A UUID that cannot be checked right now (no credential, gateway unreachable) is saved and said to be unchecked: it will
      // fail with the gateway's own answer the first time it is used, which is soon and clear. An ADI cannot be saved unresolved.
      if (classified.kind !== 'uuid') throw err;
      resolved = { id: classified.id };
      note = err instanceof CertenError && err.status === 0
        ? 'The gateway could not be reached, so this UUID was not verified.'
        : err instanceof UsageError && err.code === 'NO_API_KEY'
          ? 'There is no credential to ask the gateway with, so this UUID was not verified.'
          : `The gateway could not check this UUID (${err instanceof Error ? err.message : String(err)}), so it was not verified.`;
    }
    if (!resolved) throw new UsageError(`Could not resolve "${value}".`, 'IDENTITY_NOT_FOUND');
    if (!verified && !note) note = 'This UUID was not verified: there is no credential to ask the gateway with.';
  }

  updateProfile(profile, { identity: resolved.id });
  reportSet('identity', profile, resolved.id, { adi_url: resolved.adi_url ?? null, verified });
  if (note) hint(`Not verified: ${note} It is saved, and the first command that uses it will say if it is wrong.`);
}

async function useKey(name: string | undefined, opts: UseOptions): Promise<void> {
  const profile = activeProfile();
  const value = valueOrUnset(name, opts, 'key');
  if (value === null) {
    updateProfile(profile, { key: null });
    reportSet('key', profile, null);
    return;
  }
  if (!keyExists(value)) {
    const local = listKeys().map((k) => k.name);
    throw new UsageError(
      `There is no signing key named "${value}" on this machine. ${local.length ? `Yours: ${local.join(', ')}.` : 'You have none yet.'} Make one with: certen keys generate --name ${value}`,
      'UNKNOWN_KEY',
    );
  }
  const info = getKeyInfo(value);
  updateProfile(profile, { key: value });
  reportSet('key', profile, value, { public_key_hash: info.publicKeyHash, encrypted: info.encrypted });
}

async function useChain(chain: string | undefined, opts: UseOptions): Promise<void> {
  const profile = activeProfile();
  const value = valueOrUnset(chain, opts, 'chain');
  if (value === null) {
    updateProfile(profile, { chain: null });
    reportSet('chain', profile, null);
    return;
  }
  // A positional, not a flag: the standard message, with no flag name in front of it.
  const slug = assertChain(value);
  updateProfile(profile, { chain: slug });
  const known = isKnownTestnet(slug);
  reportSet('chain', profile, slug, { known_testnet: known });
  if (!known) {
    hint(`"${slug}" is not a known testnet. A command that moves value will not take it as a default: pass --chain ${slug} `
      + 'each time, or mark this profile with: certen use allow-mainnet-default on');
  }
}

export function registerContextCommands(program: Command): void {
  program
    .command('context')
    .description('Show the identity, key, chain and gateway commands will use, and where each came from (local; no network)')
    .action(() => { contextAction(); });

  const use = program
    .command('use')
    .description('Choose, once, the identity, key, chain or gateway that commands use when you do not say');

  use
    .command('identity [ref]')
    .description('Act as this identity: its UUID, its ADI URL (acc://org.acme), or the name it was created with')
    .option('--unset', 'Clear it')
    .action(async (ref: string | undefined, opts: UseOptions) => { await useIdentity(ref, opts); });

  use
    .command('key [name]')
    .description('Sign with this local key when a command that signs is not told which (see `certen keys list`)')
    .option('--unset', 'Clear it')
    .action(async (name: string | undefined, opts: UseOptions) => { await useKey(name, opts); });

  use
    .command('chain [chain]')
    .description('Target this chain when a command is not told which, e.g. base-sepolia')
    .option('--unset', 'Clear it')
    .action(async (chain: string | undefined, opts: UseOptions) => { await useChain(chain, opts); });

  use
    .command('gateway [url]')
    .description('Talk to this gateway under the active profile (its credential is the profile\'s own)')
    .option('--unset', 'Clear it (back to the default profile\'s gateway)')
    .action((url: string | undefined, opts: UseOptions) => {
      const profile = activeProfile();
      const value = valueOrUnset(url, opts, 'gateway');
      updateProfile(profile, { api_url: value });
      reportSet('gateway', profile, value, value ? { gateway: value } : {});
      if (value) {
        const cred = credentialSource(profile);
        if (cred.source === null) {
          hint(`Profile "${profile}" has no API key yet: certen auth login --profile ${profile}`);
        } else if (cred.source !== 'env') {
          // The credential is the profile's own, so it follows the profile to its new host. If that key was not issued by this
          // gateway it is about to be sent to one that cannot use it, and that host now holds it.
          hint(`Profile "${profile}" already has an API key (${cred.key_prefix}...), and it will now be sent to ${value}. `
            + `If that key was not issued by that gateway, replace it: certen auth login --profile ${profile}`);
        }
      }
    });

  use
    .command('profile <name>')
    .description('Make this the active profile from now on (overridden by --profile and CERTEN_PROFILE)')
    .option('--create', 'Create it if it does not exist')
    .action((name: string, opts: { create?: boolean }) => {
      if (opts.create && !listProfiles().includes(name)) updateProfile(name, {});
      setActiveProfile(name);
      printOutput({ active_profile: name, profiles: listProfiles() }, { machineOnly: true });
      human(`  The active profile is now "${name}".`);
    });

  use
    .command('allow-mainnet-default <on|off>')
    .description('Let a chain that is not a known testnet be a DEFAULT for commands that move value (off unless you say so)')
    .action((state: string) => {
      const profile = activeProfile();
      if (state !== 'on' && state !== 'off') {
        throw new UsageError(`Say "on" or "off", not "${state}".`, 'INVALID_VALUE');
      }
      updateProfile(profile, { allow_mainnet_default: state === 'on' });
      printOutput({ profile, allow_mainnet_default: state === 'on' }, { machineOnly: true });
      human(state === 'on'
        ? `  Profile "${profile}" may now take a mainnet chain from its context. --chain on the command line always works.`
        : `  Profile "${profile}" will not take a chain that is not a known testnet from its context.`);
    });
}
