import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AGENTS.md opens by naming the packages this repo publishes and their versions. It sat at sdk 0.3.1 /
 * cli 0.4.0 / mcp 0.1.0 while the packages moved to 0.10.0 / 0.10.0 / 0.5.0, and named three of the four
 * packages, because nothing compared it with the `package.json` files. An agent reading that header is
 * told the wrong thing about what it is working on, and the file is the first thing it reads.
 *
 * So the header is checked against the manifests. A release that bumps a version must edit that line;
 * this test says which.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
const header = agents.slice(0, agents.indexOf('\n## '));

const PACKAGES: Array<{ dir: string; name: string }> = [
  { dir: 'sdk', name: '@certen.io/sdk' },
  { dir: 'cli', name: '@certen.io/cli' },
  { dir: 'mcp', name: '@certen.io/mcp' },
  { dir: 'verify', name: '@certen.io/proof-verify' },
];

describe('AGENTS.md header', () => {
  for (const { dir, name } of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8')) as { name: string; version: string };

    it(`names ${name} at the version packages/${dir}/package.json declares`, () => {
      expect(manifest.name).toBe(name);
      expect(header, `AGENTS.md header should contain \`${name}\` (v${manifest.version})`).toContain(`\`${name}\` (v${manifest.version})`);
    });
  }

  it('lists every workspace package in its layout block', () => {
    for (const { dir } of PACKAGES) expect(agents).toContain(`packages/${dir}/`);
  });
});
