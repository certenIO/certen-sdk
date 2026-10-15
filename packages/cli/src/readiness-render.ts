import {
  summarizeReadiness, type Readiness, type ReadinessCheck, type ReadinessFix,
} from '@certen.io/sdk';
import { human } from './output.js';
import { getKeyInfo, isEncrypted, keyExists } from './keystore.js';

/**
 * Putting a `Readiness` in front of a person, and the two things the SDK cannot know.
 *
 * The SDK states what to do in words and never names a command, because it does not know it is being driven by a CLI. This is where the
 * command goes on: from a check's machine-readable `code`, the line to type. That is the same split `doctor` already makes between the
 * SDK's generic remedies and `localizeFix`, and for the same reason: a fix the reader can paste is worth more than one they translate.
 *
 * It is also where the one check that is about THIS machine is made: whether a signing key is there to compare the key page with.
 */

export interface LocalizeEnv {
  /** The chain the checks are about. */
  chain: string;
  /** The identity as a UUID, which every command takes. */
  identityId: string;
  /** Where credentials and credits are managed. */
  portalUrl: string;
  /** The signing key's name, when one is in play. */
  keyName?: string;
}

/** The command that performs the fix for a check, by its code. Absent when there is no CLI command (yet) that does. */
function commandFor(code: string, env: LocalizeEnv): string | undefined {
  switch (code) {
    case 'CREDENTIAL_REJECTED':
    case 'CREDENTIAL_UNCONFIRMED':
      return 'certen login';
    case 'IDENTITY_NOT_FOUND':
      return 'certen init';
    case 'IDENTITY_PROVISIONING':
    case 'IDENTITY_NOT_ACTIVE':
      return `certen identity get ${env.identityId}`;
    case 'IDENTITY_PROVISIONING_FAILED':
    case 'KEY_PAGE_MISSING':
      return `certen identity retire ${env.identityId}`;
    case 'IDENTITY_CANNOT_SIGN':
    case 'KEY_PAGE_DISAGREES':
      return `certen identity get ${env.identityId}`;
    case 'CHAIN_NOT_LINKED':
      return `certen identity link-chain ${env.identityId} --chain ${env.chain}`;
    case 'CHAIN_NOT_SERVED':
    case 'CHAIN_NOT_ENABLED':
    case 'CHAIN_DISABLED':
    case 'CHAIN_RETIRED':
    case 'CHAIN_REGISTRY_UNREADABLE':
      return 'certen chains --refresh';
    case 'KEY_PAGE_LACKS_KEY':
      return 'certen keys list';
    case 'KEY_PAGE_NOT_INDEPENDENTLY_CHECKED':
      return 'certen use key <name>';
    case 'KEY_PAGE_UNCONFIRMED':
      return 'certen status --accumulate-rpc <url>';
    case 'GATEWAY_BALANCE_EMPTY':
    case 'GATEWAY_ACCOUNT_INACTIVE':
      return `certen fund <amount> --chain ${env.chain}`;
    // The abstract account's gas is NOT the gateway balance above: `gas` shows the address, the amount, the faucet and a wallet link, and
    // `--wait` returns the moment it arrives.
    case 'ABSTRACT_ACCOUNT_UNFUNDED':
    case 'ABSTRACT_ACCOUNT_UNDERFUNDED':
      return `certen gas --chain ${env.chain} --wait`;
    case 'ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE':
      return `certen gas --chain ${env.chain}`;
    case 'MISSING_SIGNING_KEY':
      return 'certen keys generate --name dev';
    case 'AMBIGUOUS_KEY':
      return 'certen use key <name>';
    default:
      return undefined;
  }
}

/**
 * Add the command (and, where the CLI knows one, the link) to each failing check's fix.
 *
 * A passing check is returned untouched. The SDK's `text` and `url` are kept: the command is added to them, never in place of them.
 */
export function localizeReadiness(checks: readonly ReadinessCheck[], env: LocalizeEnv): ReadinessCheck[] {
  return checks.map((c) => {
    if (c.status === 'ok' || !c.code) return c;
    const command = commandFor(c.code, env);
    // Credits are bought on the Accumulate side; the portal is where this CLI sends people for that.
    const url = c.code === 'ACCUMULATE_CREDITS_EMPTY' || c.code === 'GATEWAY_BALANCE_UNREADABLE' ? env.portalUrl : undefined;
    if (!command && !url) return c;
    const fix: ReadinessFix = { ...(c.fix ?? { text: '' }), ...(command ? { command } : {}), ...(url && !c.fix?.url ? { url } : {}) };
    return { ...c, fix };
  });
}

/**
 * The check about this machine: is there a signing key to compare the key page with?
 *
 * Resolved by the context (flag, environment, profile, or the only key there is), so this receives the outcome rather than deciding it.
 * A key that is named and not on this machine is a fail, not a shrug: it came from somewhere the person set, and they should be told.
 */
export function signingKeyCheck(input: { name?: string; candidates: string[] }): { check: ReadinessCheck; keyHash?: string } {
  const { name, candidates } = input;
  if (name !== undefined) {
    if (!keyExists(name)) {
      return {
        check: {
          name: 'signing key', status: 'fail', code: 'UNKNOWN_KEY',
          detail: `There is no signing key named "${name}" on this machine.`,
          fix: { text: 'Choose a key that exists, or make one.', command: 'certen keys list' },
        },
      };
    }
    const info = getKeyInfo(name);
    const short = info.publicKeyHash.length > 12 ? `${info.publicKeyHash.slice(0, 6)}…${info.publicKeyHash.slice(-4)}` : info.publicKeyHash;
    return {
      check: {
        name: 'signing key', status: 'ok',
        detail: `${name} (${isEncrypted(name) ? 'encrypted' : 'not encrypted'}), hash ${short}`,
        data: { key: name, public_key_hash: info.publicKeyHash, encrypted: isEncrypted(name) },
      },
      keyHash: info.publicKeyHash,
    };
  }
  if (candidates.length > 1) {
    return {
      check: {
        name: 'signing key', status: 'fail', code: 'AMBIGUOUS_KEY',
        detail: `Several keys are on this machine and none is chosen: ${candidates.join(', ')}.`,
        fix: { text: 'Choose the key to check the key page against.', command: 'certen use key <name>' },
      },
    };
  }
  return {
    check: {
      name: 'signing key', status: 'fail', code: 'MISSING_SIGNING_KEY',
      detail: 'No signing key is on this machine, so nothing could be signed.',
      fix: { text: 'Make a key.', command: 'certen keys generate --name dev' },
    },
  };
}

/** `unknown` is its own mark: it is neither a pass nor a fault, and a card that blurred it into either would be the lie this exists to avoid. */
const MARK: Record<ReadinessCheck['status'], string> = {
  ok: ' ok ', warn: 'warn', fail: 'FAIL', unknown: ' ?? ', skipped: ' -- ',
};

/** A plain-words verdict line for the top of the card. */
function headline(r: Readiness, chain: string): string {
  if (r.state === 'ready') return `Ready to transact on ${chain}`;
  const first = r.first_blocker;
  if (r.state === 'blocked') return `Not ready on ${chain}: ${first ? `${first.name} is failing` : 'a check failed'}`;
  return `Cannot confirm readiness on ${chain}: ${first ? `${first.name} could not be ${first.status === 'skipped' ? 'evaluated' : 'confirmed'}` : 'a check could not be answered'}`;
}

/**
 * The readiness card, for a person.
 *
 * Every check gets a line, in dependency order. Anything that is not ok also gets what to do about it, because the point of the card is
 * the next step. Goes through `human()`, so it is ordinary output in table mode and silent where the caller has chosen `--json`.
 */
export function renderReadiness(r: Readiness, chain: string, heading?: string): void {
  human('');
  if (heading) human(`  ${heading}`);
  human(`  ${headline(r, chain)}`);
  human('');
  const width = Math.max(...r.checks.map((c) => c.name.length), 8);
  for (const c of r.checks) {
    human(`  [${MARK[c.status]}] ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.status === 'ok') continue;
    if (c.fix?.text) human(`  ${' '.repeat(6)} ${' '.repeat(width)}  fix: ${c.fix.text}`);
    if (c.fix?.command) human(`  ${' '.repeat(6)} ${' '.repeat(width)}  run: ${c.fix.command}`);
    if (c.fix?.url) human(`  ${' '.repeat(6)} ${' '.repeat(width)}  see: ${c.fix.url}`);
  }
  human('');
}

/**
 * Add this machine's checks to an SDK readiness and recompute the verdict, so the verdict is still the SDK's rule and not a copy of it.
 *
 * `afterName` is where the new check goes: directly after the named one when present, else first.
 */
export function withLocalChecks(r: Readiness, extra: ReadinessCheck[], afterName = 'credential'): Readiness {
  const at = r.checks.findIndex((c) => c.name === afterName);
  const checks = [...r.checks];
  checks.splice(at + 1, 0, ...extra);
  return { ...r, ...summarizeReadiness(checks), checks };
}

/** The SDK probed with a placeholder, so its verdict on a machine with no key at all is not the one to show. */
export function noCredential(r: Readiness): Readiness {
  const at = r.checks.findIndex((c) => c.name === 'credential');
  if (at < 0 || r.checks[at]!.status === 'skipped') return r;
  const checks = [...r.checks];
  checks[at] = {
    name: 'credential', status: 'fail', code: 'CREDENTIAL_REJECTED',
    detail: 'No API key is configured on this machine.',
    fix: { text: 'Sign this machine in.' },
  };
  for (let i = at + 1; i < checks.length; i++) {
    if (checks[i]!.status !== 'skipped') checks[i] = { name: checks[i]!.name, status: 'skipped', detail: 'needs a working API key' };
  }
  return { ...r, ...summarizeReadiness(checks), checks };
}

/**
 * The steps every command that shows a readiness takes after `client.readiness()` has answered, in one place so `status` and `setup` cannot
 * show two different verdicts for the same facts:
 *
 * 1. a machine with no credential says so (the SDK was probed with a placeholder);
 * 2. this machine's own check (is there a signing key to compare the key page with) is added;
 * 3. each failing check gets the command that fixes it;
 * 4. the verdict is recomputed from the final list by the SDK's rule, not restated here.
 */
export function finishReadiness(
  readiness: Readiness,
  opts: { missingCredential?: boolean; localChecks?: ReadinessCheck[]; env: LocalizeEnv },
): Readiness {
  let r = opts.missingCredential ? noCredential(readiness) : readiness;
  if (opts.localChecks && opts.localChecks.length > 0) r = withLocalChecks(r, opts.localChecks);
  r = { ...r, checks: localizeReadiness(r.checks, opts.env) };
  return { ...r, ...summarizeReadiness(r.checks) };
}
