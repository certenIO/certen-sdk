import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { checkWorkspacePins, accepts } = (await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'check-workspace-pins.mjs')).href)) as {
  checkWorkspacePins: (root?: string) => string[];
  accepts: (range: string, version: string) => boolean;
};

function repo(mcpSdkRange: string, nestedCopy: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'pins-'));
  const pkg = (dir: string, json: unknown): void => {
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify(json));
  };
  pkg('sdk', { name: '@certen.io/sdk', version: '0.9.0' });
  pkg('mcp', { name: '@certen.io/mcp', version: '0.4.2', dependencies: { '@certen.io/sdk': mcpSdkRange } });
  if (nestedCopy) {
    mkdirSync(join(root, 'packages', 'mcp', 'node_modules', '@certen.io', 'sdk'), { recursive: true });
    writeFileSync(join(root, 'packages', 'mcp', 'node_modules', '@certen.io', 'sdk', 'package.json'), '{"version":"0.7.1"}');
  }
  return root;
}

describe('internal @certen.io/* dependencies resolve to the workspace', () => {
  it('holds in this checkout', () => {
    expect(checkWorkspacePins(REPO_ROOT)).toEqual([]);
  });

  it('refuses the range that made MCP build against registry sdk 0.7.1', () => {
    const root = repo('^0.7.0', false);
    try {
      expect(checkWorkspacePins(root).join('\n')).toMatch(/@certen\.io\/mcp dependencies\.@certen\.io\/sdk is "\^0\.7\.0" but the workspace is 0\.9\.0/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a nested registry copy even when the range is right', () => {
    const root = repo('^0.9.0', true);
    try {
      expect(checkWorkspacePins(root).join('\n')).toMatch(/nested registry copy of a workspace package/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts a correct range with no nested copy', () => {
    const root = repo('^0.9.0', false);
    try { expect(checkWorkspacePins(root)).toEqual([]); } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('applies semver caret and tilde rules, including 0.x', () => {
    expect(accepts('^0.9.0', '0.9.0')).toBe(true);
    expect(accepts('^0.9.0', '0.10.0')).toBe(false);
    expect(accepts('^0.7.0', '0.9.0')).toBe(false);
    expect(accepts('^0.0.3', '0.0.3')).toBe(true);
    expect(accepts('^0.0.3', '0.0.4')).toBe(false);
    expect(accepts('^1.2.0', '1.9.9')).toBe(true);
    expect(accepts('^1.2.0', '2.0.0')).toBe(false);
    expect(accepts('~1.2.3', '1.2.9')).toBe(true);
    expect(accepts('~1.2.3', '1.3.0')).toBe(false);
    expect(accepts('1.2.3', '1.2.3')).toBe(true);
    expect(accepts('>=0.7.0', '0.9.0')).toBe(false); // looser than the three forms we allow is itself a finding
  });
});
