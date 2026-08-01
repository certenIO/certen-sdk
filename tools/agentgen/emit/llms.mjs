/**
 * Emit `llms.txt` — prose template plus a generated method inventory.
 *
 * The prose lives in `templates/llms.head.md` so that editing guidance does not mean editing a
 * generator, and the inventory is generated so it cannot drift from the code the way a
 * hand-maintained list always eventually does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'llms.head.md');

export function emitLlms({ ops, map, sdkVersion }) {
  const byId = new Map(ops.map((o) => [o.id, o]));
  const head = readFileSync(TEMPLATE, 'utf8').replaceAll('{{SDK_VERSION}}', sdkVersion);

  const L = [head.trimEnd(), ''];

  let methodCount = 0;
  for (const r of map) methodCount += r.methods.length;

  L.push('## Methods');
  L.push('');
  L.push(`${methodCount} methods across ${map.length} resources. Signatures and field-level detail: \`llms-full.txt\`.`);
  L.push('');
  for (const r of map) {
    L.push(`**certen.${r.resource}**`);
    for (const m of r.methods) {
      // The SDK's own doc comment wins: the spec summary describes the route, and several methods
      // share a route.
      const summary = m.doc || byId.get(m.calls[0]?.id)?.summary || '';
      L.push(`  - \`certen.${r.resource}.${m.name}()\`${summary ? ` — ${summary}` : ''}`);
    }
    L.push('');
  }

  const covered = new Set();
  for (const r of map) for (const m of r.methods) for (const c of m.calls) covered.add(c.id);
  L.push(
    `The gateway exposes ${ops.length} operations; the SDK wraps ${covered.size} of them. Anything not listed`,
  );
  L.push('above has **no SDK method** — see the closing section of `llms-full.txt` for what is reachable only');
  L.push('by raw HTTP. Do not invent a method name.');

  return `${L.join('\n')}\n`;
}
