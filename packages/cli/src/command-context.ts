import type { CertenClient, Identity } from '@certen.io/sdk';
import { UsageError } from './errors.js';
import { normalizeChain } from './chains.js';
import {
  echoFromContext, requireIdentity, type Resolved, type ResolvedContext,
} from './context.js';
import { resolveIdentityRef, type ResolvedIdentity } from './identity-ref.js';

/**
 * What nearly every command does with the context, in one place: resolve the identity, say where it came from, and when a value
 * that came from context turns out wrong, blame the context rather than the command line.
 */

const BLAMED = new Set([
  'INVALID_IDENTITY_REF', 'UNKNOWN_IDENTITY_ALIAS', 'AMBIGUOUS_IDENTITY', 'IDENTITY_NOT_FOUND', 'IDENTITY_ID_UNRESOLVED',
]);

/**
 * An identity value from context that no longer resolves (a profile naming an alias that was since retired) must not read as if
 * the person had just typed it. The error says where it came from and how to change it.
 */
function blame(err: unknown, source: Resolved): unknown {
  if (source.source === 'flag' || !(err instanceof UsageError) || !BLAMED.has(err.code)) return err;
  return new UsageError(
    `${err.message} (This identity came from ${source.detail}. Pass --identity to use another, or change it with: certen use identity <ref>)`,
    err.code,
  );
}

/**
 * The identity a command acts as: the flag, or the context's, resolved to the form(s) the command needs.
 *
 * `need` says which: `id` for a UUID route, `adi` for the governance route, `any` for a route that takes either. Only what is asked
 * for is looked up, so a command that needs the ADI and has it recorded makes no request. The value is echoed on stderr unless the
 * person typed it, AFTER it resolves, so the echo can show the ADI a person recognises rather than the UUID stored in the profile.
 */
export async function resolveCommandIdentity(
  ctx: ResolvedContext,
  client: Pick<CertenClient, 'identity' | 'portfolio'> | undefined,
  need: 'id' | 'adi' | 'any',
  flag = '--identity',
): Promise<ResolvedIdentity> {
  const wanted = requireIdentity(ctx, flag);
  let resolved: ResolvedIdentity;
  try {
    resolved = await resolveIdentityRef(wanted.value, { client, need });
  } catch (err) {
    throw blame(err, wanted);
  }
  echoFromContext('identity', wanted, resolved.adi_url ?? resolved.id);
  return resolved;
}

/** The abstract account an identity has on a chain, from whichever spelling of `chain_id` the gateway used. */
export function abstractAccountFor(identity: Identity, chain: string): string | undefined {
  const want = normalizeChain(chain);
  return (identity.chain_accounts ?? [])
    .find((account) => normalizeChain(account.chain_id) === want && account.address)?.address;
}
