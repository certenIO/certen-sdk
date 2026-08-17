#!/usr/bin/env node
/**
 * Does an INSTALLED `@certen.io/mcp` actually serve its documentation resources?
 *
 *   node scripts/mcp-serves-resources.mjs <path-to-installed-package-root>
 *
 * The property under test is real: without the `prepack` bundling step the published package serves
 * ZERO resources, because `llms.txt` and `docs/` live outside the package root and npm's `files`
 * cannot reach outside it. An agent installing it would get a server that starts, reports its tools,
 * and can answer nothing.
 *
 * This exists as a script because the inline version was a pipe:
 *
 *     printf '<initialize>\n<resources/list>\n' | node dist/index.js > out.jsonl
 *
 * which closes stdin the instant both lines are written. The server then races its own shutdown
 * against the async work for the second request — and on a GitHub runner it lost, returning only the
 * `initialize` response. That failed a RELEASE, after every other check had passed, with
 * `Cannot read properties of undefined (reading 'result')` and no indication that the package was
 * fine and the harness was not. The same pipe passes locally every time, which is the worst shape a
 * flake can take: it looks like a real defect in the artefact being published.
 *
 * So: send a request, WAIT for its response, then send the next. Nothing races.
 */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(process.argv[2] ?? '.');
const entry = join(root, 'node_modules', '@certen.io', 'mcp', 'dist', 'index.js');

if (!existsSync(entry)) {
  console.error(`mcp-check: no installed MCP server at ${entry}`);
  process.exit(2);
}

const server = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'inherit'],
  // No API key on purpose: documentation resources must work without one. An agent evaluating
  // CERTEN reads them BEFORE it has a credential, which is the whole point of shipping them.
  env: { ...process.env, CERTEN_API_KEY: '' },
});

/** Resolve when a JSON-RPC message with this id arrives. */
const pending = new Map();
let buffered = '';

server.stdout.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // Not every line is a response; banners and notices are not fatal.
    }
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    }
  }
});

function request(id, method, params = {}) {
  return new Promise((done, fail) => {
    // Bounded: a server that never answers must fail the check rather than hang the release.
    const timer = setTimeout(() => {
      pending.delete(id);
      fail(new Error(`no response to ${method} (id ${id}) within 20s`));
    }, 20_000);
    pending.set(id, (msg) => { clearTimeout(timer); done(msg); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

let code = 0;
try {
  const init = await request(1, 'initialize', {});
  if (!init.result?.serverInfo?.name) throw new Error('initialize returned no serverInfo');
  console.log(`mcp-check: ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);

  const listed = await request(2, 'resources/list', {});
  const resources = listed.result?.resources ?? [];
  if (resources.length === 0) {
    throw new Error(
      'the installed package serves 0 resources — bundled/ is missing, so prepack did not run',
    );
  }
  console.log(`mcp-check: serves ${resources.length} resources`);

  // Read one, rather than trusting the listing. A resource that is listed and unreadable is the
  // failure a listing-only check cannot see.
  const first = resources[0];
  const read = await request(3, 'resources/read', { uri: first.uri });
  const contents = read.result?.contents ?? [];
  if (contents.length === 0 || !contents[0].text) {
    throw new Error(`resource ${first.uri} is listed but has no readable content`);
  }
  console.log(`mcp-check: read ${first.uri} (${contents[0].text.length} chars)`);
} catch (err) {
  console.error(`mcp-check: FAILED — ${err instanceof Error ? err.message : String(err)}`);
  code = 1;
} finally {
  server.stdin.end();
  server.kill();
}

process.exit(code);
