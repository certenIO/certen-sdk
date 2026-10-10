import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Every workflow must be valid YAML. A workflow GitHub cannot parse is not "a failing workflow": it silently disappears
 * (no Run workflow button, no run on a tag), which is how a staged-publish step named "(dry run: check only)" — a colon in a
 * plain scalar — took the release workflow away on main (RB7b).
 */
const dir = new URL('../../../.github/workflows/', import.meta.url);

describe('.github/workflows', () => {
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    it(`${f} is valid YAML with a name, triggers and jobs`, () => {
      const doc = parse(readFileSync(new URL(f, dir), 'utf8'), { strict: true }) as Record<string, unknown>;
      expect(typeof doc.name).toBe('string');
      expect(doc.on ?? doc.true).toBeTruthy(); // YAML 1.1 reads a bare `on` as true; either spelling is a trigger block
      expect(Object.keys(doc.jobs as object).length).toBeGreaterThan(0);
    });
  }

  it('the release workflow can be started by hand and by a package tag, and stages rather than publishes', () => {
    const doc = parse(readFileSync(new URL('release.yml', dir), 'utf8')) as any;
    const on = doc.on ?? doc.true;
    expect(on.workflow_dispatch.inputs.package.options).toEqual(['sdk', 'cli', 'mcp', 'verify']);
    expect(on.push.tags).toEqual(['sdk-v*.*.*', 'cli-v*.*.*', 'mcp-v*.*.*', 'verify-v*.*.*']);
    const runs = (doc.jobs.release.steps as { run?: string }[]).map((s) => s.run ?? '').join('\n');
    expect(runs).toMatch(/npm stage publish --provenance/);
    expect(runs).not.toMatch(/npm publish/);
  });
});
