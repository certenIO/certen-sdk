#!/usr/bin/env node
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
