import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Running the built CLI the way a person does, in a throwaway home.
 *
 * Both `HOME` and `USERPROFILE` are set: `os.homedir()` reads `USERPROFILE` on Windows, so setting only `HOME` would write the developer's real
 * `~/.certen`. Every `CERTEN_*` variable of the caller is dropped, so a real key or gateway in the environment cannot reach a child, and
 * loopback is never proxied (the SDK talks through axios, which honours `HTTP_PROXY`).
 */
export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');

export interface RunResult { stdout: string; stderr: string; code: number; home: string }

export function newHome(): string {
  return mkdtempSync(join(tmpdir(), 'certen-setup-'));
}

export function certen(
  args: string[],
  opts: { home: string; apiUrl?: string; env?: Record<string, string>; input?: string; timeoutMs?: number },
): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CERTEN_') && v !== undefined) env[k] = v;
  Object.assign(env, {
    HOME: opts.home, USERPROFILE: opts.home, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    ...(opts.apiUrl ? { CERTEN_API_URL: opts.apiUrl } : {}),
    ...opts.env,
  });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd: opts.home, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => { /* a command that never reads stdin closes the pipe */ });
    child.stdin.end(opts.input ?? '');
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? -1, home: opts.home }); });
  });
}

/** The single JSON envelope on stdout; fails the test loudly if there is not exactly one. */
export function envelope(run: RunResult): { ok: boolean; data?: Record<string, any>; error?: Record<string, any> } {
  const lines = run.stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length !== 1) throw new Error(`expected exactly one envelope line on stdout, got ${lines.length}:\n${run.stdout}\n--- stderr ---\n${run.stderr}`);
  return JSON.parse(lines[0]!);
}

export function readConfig(home: string): Record<string, any> {
  const file = join(home, '.certen', 'config.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export function keyNames(home: string): string[] {
  const dir = join(home, '.certen', 'keys');
  return existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.json$/, '')).sort() : [];
}

export function readKeyFile(home: string, name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(home, '.certen', 'keys', `${name}.json`), 'utf8'));
}
