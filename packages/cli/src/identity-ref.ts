import type { CertenClient } from '@certen.io/sdk';
import { recordedIdentities } from './config.js';
import { UsageError } from './errors.js';

/**
 * One identity reference type, everywhere: a UUID, an `acc://` ADI URL, or a name this machine knows the identity by.
 *
 * The gateway keys an identity three different ways: `/v1/identity/{id}` takes a UUID (and only a UUID: the route validates the
 * shape), `/v1/governance` takes the ADI URL, and `/v1/portfolio` and `/v1/pending` take either. The CLI used to make the person
 * know which, so `governance` wanted `acc://org.acme` while `call` wanted a UUID and nothing translated between them.
 *
 * Because the identity route will not take an ADI, an ADI or a name is resolved HERE, in this order:
 *
 *   1. what this machine recorded when it created the identity (`config.identities`): no request;
 *   2. the gateway's portfolio, which carries each identity's `id` (gateway 2026-08 on).
 *
 * It never guesses. Two identities answering to one name is a question for the person; an ADI nobody can map to a UUID is a named
 * failure with the way out; a string that is none of the three forms is refused before any request.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `acc://` and one or more DNS-like labels: an ADI, never an account under one. */
const ADI_RE = /^acc:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/** What `identity create --name` accepts, plus a dot: letters, digits, `.`, `_`, `-`. */
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export type IdentityRefKind = 'uuid' | 'adi' | 'alias';

export type ClassifiedRef =
  | { kind: 'uuid'; id: string }
  | { kind: 'adi'; adi_url: string }
  | { kind: 'alias'; alias: string };

/** Which form was given. Raised as a usage error before any request: a malformed reference should cost a message, not a round trip. */
export function classifyIdentityRef(text: string): ClassifiedRef {
  const raw = String(text ?? '').trim();
  if (UUID_RE.test(raw)) return { kind: 'uuid', id: raw.toLowerCase() };

  if (/^acc:\/\//i.test(raw)) {
    const adi = raw.toLowerCase().replace(/\/+$/, '');
    if (ADI_RE.test(adi)) return { kind: 'adi', adi_url: adi };
    throw new UsageError(
      `"${text}" is not an identity. Give the ADI itself, such as acc://org.acme, not an account or key page under it.`,
      'INVALID_IDENTITY_REF',
    );
  }

  if (ALIAS_RE.test(raw)) return { kind: 'alias', alias: raw };

  throw new UsageError(
    `"${text}" is not an identity reference. Use the identity's UUID, its ADI URL (acc://org.acme), or the name it was created with.`,
    'INVALID_IDENTITY_REF',
  );
}

export interface RecordedIdentity {
  id: string;
  adi_url: string;
  chains: string[];
  name?: string;
}

const normaliseAdi = (url: string): string => url.trim().toLowerCase().replace(/\/+$/, '');

/** `acc://jason-dev.acme` → `jason-dev`. The part of the ADI a person would call the identity. */
export function adiLabel(adiUrl: string): string {
  return normaliseAdi(adiUrl).replace(/^acc:\/\//, '').replace(/\.acme$/, '');
}

/** Every locally recorded identity a reference could mean. Synchronous and offline: the resolver and the context resolver share it. */
export function matchRecorded(ref: string): RecordedIdentity[] {
  const classified = classifyIdentityRef(ref);
  const all = recordedIdentities() as RecordedIdentity[];
  if (classified.kind === 'uuid') return all.filter((r) => r.id.toLowerCase() === classified.id);
  if (classified.kind === 'adi') return all.filter((r) => normaliseAdi(r.adi_url) === classified.adi_url);
  const wanted = classified.alias.toLowerCase();
  return all.filter((r) => (r.name ?? '').toLowerCase() === wanted || adiLabel(r.adi_url) === wanted);
}

/**
 * The form of an identity to send where a gateway route takes a filter and accepts either spelling (`/v1/portfolio`, `/v1/pending`,
 * `/v1/sign`): what the person typed, normalised, or, for a name, the UUID it stands for. Offline: a name is only ever known here.
 */
export async function filterIdentity(text: string): Promise<string> {
  const ref = classifyIdentityRef(text);
  if (ref.kind === 'uuid') return ref.id;
  if (ref.kind === 'adi') return ref.adi_url;
  const r = await resolveIdentityRef(text, { need: 'any' });
  return (r.id ?? r.adi_url)!;
}

export interface ResolvedIdentity {
  /** The UUID, when the caller asked for it (`need: 'id'`) or it was known anyway. */
  id?: string;
  /** The ADI URL, when the caller asked for it (`need: 'adi'`) or it was known anyway. */
  adi_url?: string;
  /** Which form the reference was given in. */
  via: IdentityRefKind;
  /** Where the answer came from: the reference itself, this machine's record, or the gateway. */
  source: 'as-given' | 'local' | 'gateway';
  name?: string;
}

export interface ResolveIdentityOptions {
  /** Needed whenever the answer is not already known locally. Omit it for a purely offline resolution. */
  client?: Pick<CertenClient, 'identity' | 'portfolio'>;
  /**
   * What the caller will use: `id` for a UUID route, `adi` for the governance route, `any` for a route that takes either.
   * Only what is asked for is looked up, so a command that needs the ADI and has it recorded makes no request.
   */
  need: 'id' | 'adi' | 'any';
}

function describe(r: RecordedIdentity): string {
  return `${r.name ?? adiLabel(r.adi_url)} (${r.adi_url}, ${r.id})`;
}

function needClient(opts: ResolveIdentityOptions, what: string): NonNullable<ResolveIdentityOptions['client']> {
  if (!opts.client) {
    // A caller that could not build a client (no credential) lands here: say what is missing and the two ways out.
    throw new UsageError(
      `${what} is not recorded on this machine, and looking it up needs the gateway, which needs a credential. `
      + 'Sign in (certen auth login), or give the identity\'s UUID.',
      'NO_API_KEY',
    );
  }
  return opts.client;
}

export async function resolveIdentityRef(text: string, opts: ResolveIdentityOptions): Promise<ResolvedIdentity> {
  const ref = classifyIdentityRef(text);

  // ── a UUID ─────────────────────────────────────────────────────────────────────────────────
  if (ref.kind === 'uuid') {
    const known = matchRecorded(text)[0];
    if (opts.need !== 'adi') {
      return { id: ref.id, ...(known ? { adi_url: known.adi_url, name: known.name } : {}), via: 'uuid', source: known ? 'local' : 'as-given' };
    }
    if (known) return { id: ref.id, adi_url: known.adi_url, name: known.name, via: 'uuid', source: 'local' };
    // Not recorded here: the gateway knows. A 404 is the gateway's answer and is left to propagate: inventing an ADI is worse.
    const found = await needClient(opts, `the ADI of ${ref.id}`).identity.get(ref.id, { include: [] });
    return { id: ref.id, adi_url: found.adi_url, via: 'uuid', source: 'gateway' };
  }

  // ── an ADI URL ─────────────────────────────────────────────────────────────────────────────
  if (ref.kind === 'adi') {
    const known = matchRecorded(text)[0];
    if (known) return { id: known.id, adi_url: known.adi_url, name: known.name, via: 'adi', source: 'local' };
    if (opts.need !== 'id') return { adi_url: ref.adi_url, via: 'adi', source: 'as-given' };

    const portfolio = await needClient(opts, `the UUID of ${ref.adi_url}`).portfolio.get(ref.adi_url);
    const rows = (portfolio.identities ?? []).filter((i) => normaliseAdi(i.adi_url) === ref.adi_url);
    if (rows.length === 0) {
      throw new UsageError(
        `No identity of this organization has the ADI ${ref.adi_url}. Check it, or list yours with: certen identity list`,
        'IDENTITY_NOT_FOUND',
      );
    }
    const id = rows[0]!.id;
    if (!id) {
      // A gateway older than 2026-08 returns no ids in the portfolio. Naming that is the honest answer; picking some other id is not.
      throw new UsageError(
        `This machine has no record of ${ref.adi_url}, and this gateway does not return identity ids in the portfolio view, so its UUID cannot be found. `
        + 'Give the UUID printed when the identity was created.',
        'IDENTITY_ID_UNRESOLVED',
      );
    }
    return { id: id.toLowerCase(), adi_url: ref.adi_url, via: 'adi', source: 'gateway' };
  }

  // ── a name ─────────────────────────────────────────────────────────────────────────────────
  const matches = matchRecorded(text);
  if (matches.length === 1) {
    const m = matches[0]!;
    return { id: m.id, adi_url: m.adi_url, name: m.name, via: 'alias', source: 'local' };
  }
  if (matches.length > 1) {
    throw new UsageError(
      `"${ref.alias}" is the name of more than one identity on this machine: ${matches.map(describe).join('; ')}. Use the UUID or the ADI URL.`,
      'AMBIGUOUS_IDENTITY',
    );
  }
  const recorded = recordedIdentities() as RecordedIdentity[];
  throw new UsageError(
    recorded.length === 0
      ? `No identity is recorded on this machine under the name "${ref.alias}" (nothing recorded yet). Use the identity's UUID or ADI URL, or create one with: certen init`
      : `No identity recorded on this machine is called "${ref.alias}". Recorded: ${recorded.map(describe).join('; ')}. The identity's UUID or ADI URL always works.`,
    'UNKNOWN_IDENTITY_ALIAS',
  );
}
