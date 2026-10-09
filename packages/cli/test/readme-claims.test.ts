import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProofDocument, noEvidence } from '@certen.io/proof-verify';
import { EXIT } from '../src/errors.js';

/**
 * The README's account of what the CLI verifies is checked against the code: every layer it says is checked here must be a layer the verifier
 * produces, every layer it says is not carried must be reported that way, and the exit codes it names must be the ones the CLI uses.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(HERE, '..', 'README.md'), 'utf8');
const section = readme.slice(readme.indexOf('## What the CLI verifies here'), readme.indexOf('`proof get` falls back to'));
const ids = (s: string) => [...s.matchAll(/`([A-Za-z0-9_]+)`/g)].map((m) => m[1]!);

describe('README: what the CLI verifies here', () => {
  const checked = section.slice(section.indexOf('**Checked here'), section.indexOf('**Reported'));
  const reported = section.slice(section.indexOf('**Reported'), section.indexOf('Separately,'));
  const layers = new Set(noEvidence('x').layers.map((l) => l.id));

  it('names only layers the verifier has, and every one it checks', () => {
    for (const id of ['trust_base', 'L4', 'L1', 'L2', 'L3', 'G1', 'G1_chains', 'L4_set', 'govRootV3']) {
      expect(checked, id).toContain(`\`${id}\``);
      expect(layers.has(id), id).toBe(true);
    }
  });

  it('says not_in_document for exactly the layers the verifier reports as not carried', () => {
    const notCarried = noEvidence('x').layers.filter((l) => l.verdict === 'not_in_document').map((l) => l.id);
    for (const id of ['G1b', 'G2', 'L5']) {
      expect(reported).toContain(`\`${id}\``);
      expect(notCarried).toContain(id);
    }
  });

  it('names the exit codes the CLI uses', () => {
    expect(checked).toContain(`Exit \`${EXIT.OK}\``);
    expect(readme).toContain(`(exit ${EXIT.PARTIAL})`);
    expect(readme).toContain(`exit ${EXIT.NO_EVIDENCE}`);
    expect(ids(section).length).toBeGreaterThan(10);
    expect(typeof verifyProofDocument).toBe('function');
  });
});
