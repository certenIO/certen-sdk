/**
 * The route function (validator pkg/proof network_routing.go RoutePartition; design D5). The routing table itself is proven by
 * setcheck.ts (verifyRoutingProof).
 *
 * A page of evidence 2.1 names the partition it is proven through. That name is DERIVED from the partition anchor the page's receipt ends
 * at, and must equal the partition the network routes the page's URL to: Accumulate's own rule (internal/api/routing RouteTree) - an
 * override keyed by the account's identity hash wins; otherwise the route whose top Length bits of the routing number equal its Value. A
 * routing table is prefix-free, so exactly one route matches - anything else is refused, never resolved by order.
 */
import { equal, fail } from '../proof-v2/bytes.js';
import { AccUrl, isUnknown } from './acc.js';
import type { RoutingTable } from './setcheck.js';

export type { RoutingTable } from './setcheck.js';

/** RoutePartition: the partition a routing table sends account to, spelled as the table spells it. */
export function routePartition(table: RoutingTable, account: string): string {
  if (!table || table.routes.length === 0) fail('the routing table has no routes');
  const u = AccUrl.parse(account);
  if (!u) return fail(`account ${JSON.stringify(account)}: not a URL`);
  if (isUnknown(u)) fail(`account ${JSON.stringify(account)} is unknown and cannot be routed`);
  const id = u.identityAccountId();
  for (const o of table.overrides) {
    if (o.account && equal(o.account.identityAccountId(), id)) return o.partition;
  }
  const n = u.routing();
  const match: string[] = [];
  for (const rt of table.routes) {
    if (rt.length === 0 || rt.length > 64) fail(`routing table: route to ${rt.partition} has length ${rt.length}`);
    if (n >> BigInt(64 - rt.length) === rt.value) match.push(rt.partition);
  }
  if (match.length !== 1) fail(`route ${account}: ${match.length} routes match routing number ${n.toString(16).padStart(16, '0')} ([${match.join(' ')}]); the table is not a partition of the space`);
  return match[0]!;
}
