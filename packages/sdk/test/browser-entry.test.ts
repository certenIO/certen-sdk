import { describe, it, expect, beforeAll } from 'vitest';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

/**
 * The SDK is claimed to run in a browser. That claim was false for the whole package entry: `agent.ts` imports node:crypto and
 * `shared-proof.ts` imports node:zlib, and the client itself imported node:crypto, read `process.env.npm_package_version` unguarded and
 * used `Buffer` (recorded in RUNLOG_RB7b F18/F29: bundling the entry for a browser failed to resolve `node:zlib`).
 *
 * The browser-safe entry (src/browser.ts, the `browser` export condition and `@certen.io/sdk/browser`) is held to this:
 *   1. statically: nothing reachable from it imports a Node built-in;
 *   2. dynamically: it is bundled the way a browser build would bundle it and RUN in a context that has no `process`, no `Buffer`
 *      and no `require`, and the client still works.
 */
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, 'src');

const NODE_BUILTIN = /^(node:|(assert|buffer|child_process|cluster|crypto|dgram|dns|events|fs|http|http2|https|net|os|path|perf_hooks|querystring|readline|stream|tls|url|util|vm|worker_threads|zlib)(\/|$))/;

/** Every module reachable from `entry` by relative import, and the bare/builtin specifiers each one names. */
function graph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    const text = readFileSync(file, 'utf8');
    const specs = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
    seen.set(file, specs);
    for (const s of specs) if (s.startsWith('.')) visit(resolve(dirname(file), s.replace(/\.js$/, '.ts')));
  };
  visit(entry);
  return seen;
}

describe('the browser entry, statically', () => {
  const g = graph(join(SRC, 'browser.ts'));

  it('reaches the client and its resources but not the two Node-only modules', () => {
    const files = [...g.keys()].map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
    expect(files).toContain('client.ts');
    expect(files).toContain('resources/execute.ts');
    expect(files).toContain('share-target.ts');
    expect(files).not.toContain('agent.ts');
    expect(files).not.toContain('shared-proof.ts');
  });

  it('imports no Node built-in from anywhere in its graph', () => {
    const offenders = [...g].flatMap(([f, specs]) => specs.filter((s) => NODE_BUILTIN.test(s)).map((s) => `${f.slice(SRC.length + 1)} -> ${s}`));
    expect(offenders).toEqual([]);
  });

  it('uses Buffer and process only behind a typeof guard', () => {
    const offenders: string[] = [];
    for (const f of g.keys()) {
      const code = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
      code.forEach((line, i) => {
        if (/(?<![\w.'"`])Buffer\b/.test(line) && !/typeof Buffer/.test(line)) offenders.push(`${f.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`);
        if (/(?<![\w.'"`-])process\.(env|versions|platform|argv|cwd|exit)/.test(line) && !/typeof process/.test(line)) offenders.push(`${f.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`);
      });
    }
    // The guards that exist are on the same line (`typeof process !== 'undefined' ? process.env... : ...`), or inside isNode()'s own expression.
    expect(offenders.filter((o) => !/isNode|versions\?\.node|process\.versions === 'object'/.test(o))).toEqual([]);
  });

  it('is what the package.json browser condition points at', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { exports: Record<string, Record<string, string> | string> };
    const root = pkg.exports['.'] as Record<string, string>;
    expect(root.browser).toBe('./dist/browser.js');
    expect(root.import).toBe('./dist/index.js');
    expect(Object.keys(root)[0]).toBe('types');
    expect(pkg.exports['./browser']).toEqual({ types: './dist/browser.d.ts', default: './dist/browser.js' });
    expect(existsSync(join(SRC, 'browser.ts'))).toBe(true);
  });

  it('exports everything the default entry does except the four Node-only names', async () => {
    const full = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(full).toMatch(/export \* from '\.\/browser\.js'/);
    const nodeOnly = [...full.matchAll(/export (?:type )?\{([^}]+)\} from '\.\/(?:shared-proof|agent)\.js'/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
    expect(nodeOnly.sort()).toEqual(['AgentSigner', 'CertenAgent', 'CertenAgentState', 'ProvisionParams', 'decodeSharedBundle', 'ed25519Signer', 'fetchSharedProof']);
  });
});

describe('the browser entry, bundled for a browser and run without Node globals', () => {
  let code = '';
  beforeAll(async () => {
    const out = await build({
      configFile: false,
      root: PKG,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        target: 'es2022',
        lib: { entry: join(SRC, 'browser.ts'), name: 'CertenSdk', formats: ['iife'], fileName: 'certen-sdk' },
      },
    });
    const bundles = Array.isArray(out) ? out : [out as { output: Array<{ type: string; code?: string }> }];
    code = (bundles[0] as { output: Array<{ type: string; code?: string }> }).output.find((o) => o.type === 'chunk')?.code ?? '';
  }, 120_000);

  /** A context with the Web platform and nothing Node-specific: no process, Buffer, require, module or __dirname. */
  function browserLike(): { sdk: any; ctx: vm.Context } {
    const ctx = vm.createContext({
      console, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, crypto: globalThis.crypto,
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, AbortController, AbortSignal, structuredClone, performance,
    });
    vm.runInContext(`${code}\n;globalThis.CertenSdk = CertenSdk;`, ctx, { filename: 'certen-sdk.browser.js' });
    for (const name of ['process', 'Buffer', 'require', 'module', '__dirname']) expect(vm.runInContext(`typeof ${name}`, ctx), name).toBe('undefined');
    return { sdk: (ctx as { CertenSdk: any }).CertenSdk, ctx };
  }

  /** Replace the transport so no network is needed; the interceptors (credentials, origin check, idempotency) still run. */
  function recordingClient(sdk: any, answers: Array<Record<string, unknown>>): { client: any; sent: Array<{ method: string; url: string; headers: Record<string, string> }> } {
    const client = new sdk.CertenClient({ apiKey: 'ck_live_browser_test', baseUrl: 'https://gateway.example.test', maxRetries: 0 });
    const sent: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    let i = 0;
    client.http.defaults.adapter = async (config: any) => {
      sent.push({ method: String(config.method).toUpperCase(), url: String(config.url), headers: { ...config.headers.toJSON() } });
      return { data: answers[Math.min(i++, answers.length - 1)], status: 200, statusText: 'OK', headers: {}, config };
    };
    return { client, sent };
  }

  it('produces a bundle with no node built-in left behind', () => {
    expect(code.length).toBeGreaterThan(10_000);
    expect(code).not.toContain('__vite-browser-external');
    // Imports and requires, not prose: the unminified bundle keeps comments that name node:crypto to explain why it is not used.
    expect(code).not.toMatch(/(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*["'](?:node:|crypto["']|zlib["']|fs["']|os["']|path["'])/);
  });

  it('loads and exposes the client, errors and helpers; the Node-only exports are absent', () => {
    const { sdk } = browserLike();
    for (const name of ['CertenClient', 'CertenError', 'CertenForeignOriginError', 'CertenWaitTimeoutError', 'intentOutcome', 'classifyIntentStatus', 'parseShareTarget', 'verifyExecutionProof', 'chainInfo', 'DEFAULT_BASE_URL']) {
      expect(typeof sdk[name], name).not.toBe('undefined');
    }
    for (const name of ['CertenAgent', 'ed25519Signer', 'fetchSharedProof', 'decodeSharedBundle']) expect(sdk[name], name).toBeUndefined();
  });

  it('sends a request with the key, an encoded path and NO User-Agent (a browser forbids setting one)', async () => {
    const { sdk } = browserLike();
    const { client, sent } = recordingClient(sdk, [{ id: 'a/b', status: 'active' }]);
    const out = await client.identity.get('a/b', { include: [] });
    expect(out.id).toBe('a/b');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/v1/identity/a%2Fb');
    expect(sent[0].headers['X-API-Key']).toBe('ck_live_browser_test');
    expect(Object.keys(sent[0].headers).map((h) => h.toLowerCase())).not.toContain('user-agent');
  });

  it('stamps an idempotency key built from Web Crypto on a POST', async () => {
    const { sdk } = browserLike();
    const { client, sent } = recordingClient(sdk, [{ ok: true }]);
    await client.http.post('/v1/anything', {});
    expect(sent[0].headers['Idempotency-Key']).toMatch(/^sdk_[0-9a-z]+_[0-9a-f]{16}$/);
  });

  it('still refuses a foreign origin before sending anything', async () => {
    const { sdk } = browserLike();
    const { client, sent } = recordingClient(sdk, [{}]);
    const err = await client.http.get('https://evil.example/steal').catch((e: any) => e);
    expect(err.code).toBe('FOREIGN_ORIGIN_URL');
    expect(sent).toEqual([]);
  });

  it('walks wait() through executed to completed_unproven, and applies the shared status table', async () => {
    const { sdk } = browserLike();
    const { client } = recordingClient(sdk, [{ status: 'submitted' }, { status: 'executed' }, { status: 'completed_unproven' }]);
    const seen: string[] = [];
    const tx = await client.execute.wait('i1', { timeoutMs: 5_000, intervalMs: 5, onState: (e: any) => seen.push(e.class) });
    expect(tx.status).toBe('completed_unproven');
    expect(seen).toEqual(['in_flight', 'executed', 'terminal_gas_only']);
    expect(sdk.intentOutcome(tx).outcome).toBe('completed_unproven');
  });

  it('verifies a real receipt end to end (digest, ed25519, inclusion, signed head) with no node:crypto', async () => {
    const { createHash, generateKeyPairSync, sign } = await import('node:crypto');
    const canonical = (v: unknown): string => (v === null || typeof v !== 'object') ? JSON.stringify(v)
      : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
        : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
    const body = { amount_usd: '1.25', kind: 'fee', n: [1, 2] };
    const digest = createHash('sha256').update(canonical(body)).digest('hex');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
    const salt = '0a0b0c';
    const leaf = createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(salt, 'hex'), Buffer.from(canonical(body))])).digest('hex');
    const sib = createHash('sha256').update('sibling').digest('hex');
    const root = createHash('sha256').update(Buffer.concat([Buffer.from([1]), Buffer.from(leaf, 'hex'), Buffer.from(sib, 'hex')])).digest('hex');
    const answers: Record<string, unknown> = {
      '/v1/billing/receipts/r1': { body, digest, signature: sign(null, Buffer.from(digest, 'hex'), privateKey).toString('hex'), key_id: 'k1' },
      '/v1/billing/receipts/verification-key': { keys: [{ key_id: 'k1', public_key: pub }] },
      '/v1/billing/receipts/r1/proof': { leaf_salt: salt, leaf_hash: leaf, leaf_index: 0, tree_size: 2, audit_path: [sib] },
      '/v1/transparency/heads/2': { root_hash: root },
    };
    const { sdk } = browserLike();
    const client = new sdk.CertenClient({ apiKey: 'k', baseUrl: 'https://gateway.example.test', maxRetries: 0 });
    client.http.defaults.adapter = async (config: any) => {
      const path = String(config.url).split('?')[0];
      if (!(path in answers)) return { data: { error: 'not stubbed ' + path }, status: 404, statusText: 'NF', headers: {}, config };
      return { data: answers[path], status: 200, statusText: 'OK', headers: {}, config };
    };
    client.http.defaults.validateStatus = (s: number) => s >= 200 && s < 300;
    const r = await client.billing.verifyReceipt('r1');
    const byName = Object.fromEntries(r.checks.map((c: any) => [c.name, c.status]));
    expect(byName).toMatchObject({ digest: 'ok', signature: 'ok', inclusion: 'ok', root: 'ok' });
  });
});
