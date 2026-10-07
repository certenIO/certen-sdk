/**
 * The other direction of the response contract.
 *
 * `response-shape.test.ts` proves every field the SDK DECLARES exists in the API. That cannot see a
 * field the API SENDS and the SDK never declared: a caller reading it gets a type error or an
 * `unknown`, and a polling loop that depends on it (`proof_lookup` says whether a null `proof_id`
 * means "not anchored yet" or "the proof service failed to answer") is written blind.
 *
 * Mechanical on purpose, like its sibling: read the property names declared on the interface in
 * `src/types.ts` and require each property of the gateway's response schema to be among them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = readFileSync(join(HERE, '..', 'src', 'types.ts'), 'utf8').replace(/\r\n/g, '\n');

interface Contract {
  paths: Record<string, Record<string, { responses: Record<string, string[]> }>>;
}
const CONTRACT: Contract = JSON.parse(readFileSync(join(HERE, 'fixtures/openapi-contract.json'), 'utf8'));

/** Property names declared directly on `export interface <name> { ... }`. */
function declaredProperties(name: string): string[] {
  const start = TYPES.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`types.ts has no interface ${name}`);
  const props: string[] = [];
  let depth = 0;
  for (const line of TYPES.slice(start).split('\n')) {
    if (depth === 1) {
      const m = line.match(/^ {2}(?:readonly )?([A-Za-z_][A-Za-z0-9_]*)\??:/);
      if (m) props.push(m[1]);
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0 && props.length > 0) break;
  }
  return props;
}

describe('response types declare everything the API returns', () => {
  it('GET /v1/transaction/{id} -> TransactionResponse', () => {
    const spec = CONTRACT.paths['/v1/transaction/{id}'].get.responses['200'];
    const declared = new Set(declaredProperties('TransactionResponse'));
    const missing = spec.filter((p) => !declared.has(p));
    expect(missing, 'properties the API returns that TransactionResponse does not declare').toEqual([]);
  });

  it('the property reader finds the declarations it is checking against', () => {
    // Guards the parser: an empty result would make the check above vacuous.
    expect(declaredProperties('TransactionResponse')).toContain('intent_id');
    expect(declaredProperties('TransactionResponse').length).toBeGreaterThan(10);
  });
});
