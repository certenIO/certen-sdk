import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { checkInstallScripts } = (await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'check-install-scripts.mjs')).href)) as {
  checkInstallScripts: (root?: string, allowFile?: string) => string[];
};

/** A scratch repo whose lockfile holds the given packages, plus an allow-list file. */
function scratch(packages: Record<string, unknown>, allowed: unknown[]): { root: string; allow: string } {
  const root = mkdtempSync(join(tmpdir(), 'install-scripts-'));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } }));
  const allow = join(root, 'allow.json');
  writeFileSync(allow, JSON.stringify({ allowed }));
  return { root, allow };
}
const REASON = 'a dev-only native addon, never installed for consumers';

describe('install-time scripts are an explicit, reviewed allow-list', () => {
  it('holds for this repository: every script-bearing dependency is named, with a reason, and is dev-only', () => {
    expect(checkInstallScripts(REPO_ROOT)).toEqual([]);
  });

  it('fails on a dependency with an install script that nobody reviewed', () => {
    const { root, allow } = scratch({ 'node_modules/evil-postinstall': { version: '1.0.0', hasInstallScript: true, dev: true } }, []);
    try {
      expect(checkInstallScripts(root, allow).join('\n')).toMatch(/evil-postinstall@1\.0\.0 has an install script and is not in scripts\/install-scripts\.allow\.json/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails when an allow-listed script has reached the production dependency tree', () => {
    const { root, allow } = scratch({ 'node_modules/native-thing': { version: '2.0.0', hasInstallScript: true } }, [{ package: 'native-thing', reason: REASON }]);
    try {
      expect(checkInstallScripts(root, allow).join('\n')).toMatch(/native-thing@2\.0\.0 has an install script and is in the production dependency tree/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails on an entry with no reason, and on a stale entry the lockfile no longer needs', () => {
    const { root, allow } = scratch({ 'node_modules/a': { version: '1.0.0', hasInstallScript: true, dev: true } }, [
      { package: 'a', reason: '' },
      { package: 'gone', reason: REASON },
    ]);
    try {
      const out = checkInstallScripts(root, allow).join('\n');
      expect(out).toMatch(/a: the allow-list entry needs a reason/);
      expect(out).toMatch(/gone is allow-listed but no longer in the lockfile with an install script/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts a named, reasoned, dev-only script (including a nested path)', () => {
    const { root, allow } = scratch({ 'node_modules/x/node_modules/fsevents': { version: '2.3.3', hasInstallScript: true, devOptional: true } }, [
      { package: 'fsevents', reason: REASON },
    ]);
    try { expect(checkInstallScripts(root, allow)).toEqual([]); } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
