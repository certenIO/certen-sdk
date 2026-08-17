/**
 * Measure what onboarding costs, step by step.
 *
 * The audit could say `certen balance` makes one request and `doctor` makes five, and could say
 * nothing at all about the journey those commands sit inside — so there was no way to tell whether
 * any of the work reduced friction or merely moved it. A number nobody has measured is a number
 * nobody can improve.
 *
 * This records, per step: HTTP round trips, wall-clock, and the endpoints touched. It talks to a
 * gateway you point it at and runs the real CLI as a subprocess, because the thing being measured
 * is what a person actually experiences, not what the SDK does in isolation.
 *
 *   node scripts/measure-onboarding.mjs --url http://127.0.0.1:8090 --key ck_live_...
 *
 * Steps that need on-chain provisioning are skipped unless `--full` is passed, since they take
 * 60-90 seconds each and need a funded sponsor. The read-path numbers are the ones that regress
 * quietly; the write path is slow for reasons no client change will fix.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'packages', 'cli', 'dist', 'index.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const TARGET = arg('url', process.env.CERTEN_API_URL ?? 'http://127.0.0.1:8090');
const KEY = arg('key', process.env.CERTEN_API_KEY ?? '');
const FULL = process.argv.includes('--full');

if (!KEY) {
  console.error('need --key <api-key> (or CERTEN_API_KEY)');
  process.exit(2);
}

/**
 * A counting proxy in front of the gateway.
 *
 * Instrumenting the SDK would measure the SDK; instrumenting the gateway's own log misses anything
 * that never arrives. A proxy counts exactly what left the machine, which is what a user waits for.
 */
async function startProxy(upstream) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, upstream);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let upstreamRes;
    try {
      upstreamRes = await fetch(url, {
        method: req.method,
        headers: { ...req.headers, host: url.host },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
    } catch (err) {
      res.writeHead(502).end(JSON.stringify({ error: String(err) }));
      return;
    }
    const body = Buffer.from(await upstreamRes.arrayBuffer());
    seen.push({
      method: req.method,
      path: req.url.split('?')[0],
      status: upstreamRes.status,
      ms: Date.now() - started,
    });
    res.writeHead(upstreamRes.status, {
      'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
    });
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    take: () => seen.splice(0, seen.length),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const proxy = await startProxy(TARGET);
const env = { ...process.env, CERTEN_API_KEY: KEY, CERTEN_API_URL: proxy.url };

const STEPS = [
  ['What is this key?', ['whoami', '--json']],
  ['What does it cost?', ['pricing', '--json']],
  ['Can I afford it?', ['balance', '--json']],
  ['What can this key do?', ['scopes', '--json']],
  ['Is anything wrong?', ['doctor', '--json']],
  ['What chains are there?', ['chains', '--json']],
  ['What was I charged?', ['receipts', 'list', '--json']],
  ['Where did the money go?', ['ledger', '--json']],
];

/**
 * `--full` adds the steps that COST something, so they are opt-in.
 *
 * Identity provisioning is billable ($5 on the current price book) and takes ~45s of real anchoring,
 * so it is not something to run casually against a paid account.
 *
 * `--intent <id>` measures the proof read — the last step of the journey, and the one a counterparty
 * actually consumes. It takes an id rather than creating work, because producing a fresh proof needs
 * two things this script cannot conjure: an abstract account with gas on the destination chain, and
 * a contract with a known ABI to call. Measuring an EXISTING proof is honest about what it covers;
 * inventing a number for a cycle that never ran would not be.
 */
if (FULL) {
  STEPS.push(['Create an identity', ['identity', 'create', '--name', `probe-${Date.now()}`, '--wait', '--json']]);
}

const INTENT = arg('intent', '');
if (INTENT) {
  STEPS.push(['Fetch the proof', ['proof', 'get', INTENT, '--json']]);
}

console.log(`\nonboarding against ${TARGET}\n`);
console.log(`  ${'STEP'.padEnd(26)} ${'CALLS'.padStart(5)}  ${'MS'.padStart(6)}  ENDPOINTS`);

let totalCalls = 0;
let totalMs = 0;
for (const [label, args] of STEPS) {
  const t0 = Date.now();
  const { code } = await run(args, env);
  const ms = Date.now() - t0;
  const calls = proxy.take();
  totalCalls += calls.length;
  totalMs += ms;
  const endpoints = [...new Set(calls.map((c) => `${c.method} ${c.path}`))].join(', ') || '(none)';
  const flag = code === 0 ? ' ' : '!';
  console.log(`${flag} ${label.padEnd(26)} ${String(calls.length).padStart(5)}  ${String(ms).padStart(6)}  ${endpoints.slice(0, 96)}`);
}

console.log(`\n  ${'TOTAL'.padEnd(26)} ${String(totalCalls).padStart(5)}  ${String(totalMs).padStart(6)}`);
console.log('\n  ! = non-zero exit (expected where the local gateway lacks a downstream)\n');

await proxy.close();
