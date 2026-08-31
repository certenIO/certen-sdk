#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { serve } from './protocol.js';
import { createHandlers, SERVER_NAME, SERVER_VERSION } from './server.js';
import { activeTools, writesAllowed } from './tools.js';

export { createHandlers } from './server.js';
export { ALL_TOOLS, READ_TOOLS, WRITE_TOOLS, activeTools, writesAllowed } from './tools.js';
export { RESOURCES } from './resources.js';

/**
 * stdio entrypoint.
 *
 * The startup banner goes to STDERR. stdout carries JSON-RPC frames and nothing else — a single
 * stray line there corrupts the stream and the client drops the connection.
 */
async function main(): Promise<void> {
  const tools = activeTools();
  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} — ${tools.length} tools, `
    + `writes ${writesAllowed() ? 'ENABLED' : 'disabled (read-only)'}\n`,
  );
  if (!process.env.CERTEN_API_KEY) {
    process.stderr.write(
      'warning: CERTEN_API_KEY is not set — documentation resources work, gateway calls will not.\n',
    );
  }

  await serve(process.stdin, process.stdout, createHandlers());
}

/* c8 ignore start — entrypoint wiring, exercised by the protocol suite as a subprocess */
/**
 * Was this file run as the program, rather than imported by a test?
 *
 * `import.meta.url` is the REAL path of this module; `process.argv[1]` is the path as typed. A
 * POSIX install exposes this server through a SYMLINK at `node_modules/.bin/certen-mcp`, so the
 * two strings differ and the guard was false for every non-Windows user — the process then
 * started nothing and exited 0, which to an MCP client looks like a server that closed the pipe
 * immediately. Resolving argv[1] first is what makes the comparison meaningful.
 */
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  let resolved = argv1;
  try {
    resolved = realpathSync(argv1);
  } catch {
    // Ignored: an unresolvable argv[1] is not this module, and the comparison says so anyway.
  }
  return import.meta.url === pathToFileURL(resolved).href;
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
