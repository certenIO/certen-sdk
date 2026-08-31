import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run the CLI the way an INSTALL runs it: through a symlink.
 *
 * Every other suite spawns `node dist/index.js` — the real path, which is the one path a user
 * never takes. `npm i -g`, a local `node_modules/.bin`, and `npx` all place a symlink pointing
 * into `dist/`, and node records `import.meta.url` as the resolved target while leaving
 * `process.argv[1]` as the link that was typed. The entrypoint guard compares those two, so for
 * the whole of 0.7.1 it was false on every POSIX install: the binary parsed nothing, sent
 * nothing, printed nothing, and exited 0. A user reported it as "it seems to run but prints
 * nothing", and no test could have caught it, because none of them had a symlink in the path.
 *
 * `--version` is the assertion because it needs no network, no config and no credential: if
 * anything at all reaches stdout, `run()` was entered.
 *
 * Skipped where symlinks cannot be created — an unprivileged Windows shell without Developer
 * Mode. That is the platform whose shim never had the bug, so skipping loses no coverage.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

let binDir: string | undefined;
let link: string | undefined;

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`built CLI not found at ${CLI} — run \`npm run build\` before the CLI suite`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'certen-bin-'));
  const candidate = join(dir, 'certen');
  try {
    symlinkSync(CLI, candidate, 'file');
    binDir = dir;
    link = candidate;
  } catch {
    // No symlink privilege. `link` stays undefined and the cases below skip themselves.
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (binDir) rmSync(binDir, { recursive: true, force: true });
});

describe('the installed binary', () => {
  it('runs when invoked through a symlink, as every POSIX install invokes it', () => {
    if (!link) return; // see the skip note above
    const stdout = execFileSync(process.execPath, [link, '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('still runs when invoked by its real path', () => {
    const stdout = execFileSync(process.execPath, [CLI, '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
