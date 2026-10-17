import type { IdentityReadinessResponse } from '@certen.io/sdk';
import { dollars, printable } from './gateway-text.js';

/**
 * The facts `GET /v1/identity/{id}/readiness` states, one section at a time, as lines to print.
 *
 * The gateway reports facts and says nothing like "ready", and neither does this. Each section has a state of its own, and a section that could
 * not be read is shown as exactly that: unknown is never rounded to a yes or a no, and never drawn as a zero. The sections were read moments
 * apart, so there is no single moment the whole is true of; the footer says so.
 *
 * It differs from `certen status` and `certen doctor` (and the SDK's `client.readiness()`) in what it is: ONE read of the gateway's own view,
 * with no verdict. Those assemble several reads, check the key page against Accumulate directly and judge the gas for an amount. This is the
 * cheap look; that is the check that should gate a signature.
 */

const bool = (v: unknown): string => (v === true ? 'yes' : v === false ? 'NO' : 'unknown');

function row(label: string, text: string): string {
  return `  ${label.padEnd(13)} ${text}`;
}
const more = (text: string): string => row('', text);

/** The key section. `value` is null exactly when the key page could not be read. */
function keyLines(r: IdentityReadinessResponse): string[] {
  const s = r.can_sign ?? {};
  if (s.state === 'ok') {
    return [row('key', `the identity's key is on its key page: ${bool(s.value)}`)];
  }
  if (s.state === 'unreadable') {
    return [row('key', 'unknown: the key page could not be read, so whether the identity\'s key is on it is not known')];
  }
  return [row('key', `state ${printable(s.state) || 'not given'}`)];
}

function creditsLines(r: IdentityReadinessResponse): string[] {
  const c = r.credits ?? {};
  const value = c.value === undefined ? 'not given' : String(c.value);
  if (c.source === 'key_page') return [row('credits', `${value}   (read from the key page)`)];
  if (c.source === 'recorded') return [row('credits', `${value}   (the figure recorded at provisioning: the key page could not be read, so it may be out of date)`)];
  return [row('credits', `${value}   (source ${printable(c.source) || 'not given'})`)];
}

function chainLines(r: IdentityReadinessResponse): string[] {
  const c = r.chain;
  if (!c) return [];
  const label = printable(c.chain, 40) || 'chain';
  const out: string[] = [];
  const account = c.account ?? {};
  if (account.state === 'not_linked') out.push(row(label, 'no account on this chain: the identity is not linked to it'));
  else out.push(row(label, `account ${printable(account.state) || 'state not given'}${account.address ? ` at ${printable(account.address, 80)}` : ''}`));

  const b = c.balance ?? {};
  if (b.state === 'ok') {
    out.push(more(`balance ${printable(b.balance, 80)} ${printable(b.symbol, 20)}`.trimEnd() + (b.read_at ? `   (read ${printable(b.read_at, 40)})` : '')));
  } else if (b.state === 'unreadable') {
    out.push(more(`balance unreadable${b.code ? ` (${printable(b.code, 60)})` : ''}: the node did not answer. This is NOT a balance of zero`));
  } else if (b.state === 'not_applicable') {
    out.push(more(`balance not applicable${b.reason ? `: ${printable(b.reason)}` : ''}`));
  } else {
    out.push(more(`balance state ${printable(b.state) || 'not given'}`));
  }
  return out;
}

function orgLines(r: IdentityReadinessResponse): string[] {
  const o = r.org ?? {};
  switch (o.state) {
    case 'ok': {
      const enforcing = o.enforcing === true ? 'a shortfall is refused' : o.enforcing === false ? 'a shortfall is only recorded' : 'enforcement not given';
      const out = [row('organisation', `spendable ${dollars(o.spendable_usd)}, remaining ${dollars(o.remaining_usd)} after what pending intents will consume`)];
      out.push(more(`billing account ${printable(o.status) || 'status not given'}; ${enforcing}`));
      return out;
    }
    case 'billing_disabled':
      return [row('organisation', 'billing is off on this gateway, so there is no spendable balance to report')];
    case 'not_permitted':
      return [row('organisation', `not shown: this API key lacks the scope that reads it${o.scope ? ` (${printable(o.scope, 60)})` : ''}`)];
    case 'unreadable':
      return [row('organisation', 'unknown: the balance could not be read')];
    default:
      return [row('organisation', `state ${printable(o.state) || 'not given'}`)];
  }
}

export function factsLines(r: IdentityReadinessResponse): string[] {
  const id = r.identity ?? {};
  const lines: string[] = [''];
  lines.push(`  Facts about ${printable(id.adi_url, 120) || printable(id.id, 60) || 'this identity'}`);
  lines.push('');
  lines.push(row('identity', `status ${printable(id.status) || 'not given'}${id.key_page_url ? `   key page ${printable(id.key_page_url, 120)}` : ''}`));
  if (id.error_message) lines.push(more(`provisioning failed: ${printable(id.error_message)}`));
  lines.push(...keyLines(r));
  lines.push(...creditsLines(r));
  lines.push(...chainLines(r));
  lines.push(...orgLines(r));
  lines.push('');
  lines.push(`  As of ${printable(r.read_at, 40) || 'an unstated time'}; each section was read on its own, moments apart.`);
  lines.push('  These are facts, not a verdict: nothing here says you can send. `certen status` is the check that does, and it reads the key page from Accumulate itself.');
  lines.push('');
  return lines;
}
