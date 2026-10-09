import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CertenClient, CertenError } from '@certen.io/sdk';
import {
  LATEST_LEGACY_PROTOCOL_VERSION,
  LEGACY_VERSIONS,
  PROTOCOL_VERSIONS,
  RPC,
  RpcError,
  type Handler,
} from './protocol.js';
import { features, finishModern, resolveEra, type Era, type EraState, type LegacyVersion } from './era.js';
import { activeTools, annotationsFor, writesAllowed, type ToolDef } from './tools.js';
import { availableResources, readResource } from './resources.js';

export const SERVER_NAME = '@certen.io/mcp';

/**
 * Read from package.json rather than written here.
 *
 * It was the literal `'0.1.0'` and stayed that way through 0.2.0, 0.3.0 and 0.4.0 — so the startup
 * banner and, more importantly, the `serverInfo.version` returned to every MCP client named a
 * release three versions old. A client deciding whether the server carries a tool it needs was
 * being told the wrong answer, and a bug report would name the wrong version.
 *
 * Resolved from this module's own location so it holds for `dist/server.js` (../package.json) and
 * for `src/server.ts` under a test runner (../package.json) alike.
 */
export const SERVER_VERSION: string = (() => {
  try {
    const pkg = fileURLToPath(new URL('../package.json', import.meta.url));
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    // A server that cannot read its own manifest must still start and serve tools.
    return '0.0.0';
  }
})();

export interface ServerOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected in tests so the suite never constructs a real HTTP client. */
  client?: CertenClient;
}

/**
 * Build the MCP method table.
 *
 * The client is created lazily: a read-only server should still start, list its tools and serve its
 * documentation resources when no API key is configured. Failing at startup would make the docs —
 * which is exactly what an agent needs in order to find out it needs a key — unreachable.
 */
export function createHandlers(opts: ServerOptions = {}): Record<string, Handler> {
  const env = opts.env ?? process.env;
  const tools = activeTools(env);
  const byName = new Map(tools.map((t) => [t.name, t]));

  let client: CertenClient | undefined = opts.client;
  const getClient = (): CertenClient => {
    if (client) return client;
    const apiKey = env.CERTEN_API_KEY;
    if (!apiKey) {
      throw new RpcError(
        RPC.INVALID_PARAMS,
        'CERTEN_API_KEY is not set. This server needs an API key to reach the gateway; '
        + 'documentation resources are available without one.',
      );
    }
    client = new CertenClient({ apiKey, baseUrl: env.CERTEN_API_URL });
    return client;
  };

  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  /** The one thing a legacy `initialize` leaves behind. Modern requests never touch it. */
  const eraState: EraState = { legacyVersion: undefined };

  /** What this server tells a model about itself: `initialize.instructions` (legacy) and `server/discover.instructions` (modern). */
  const instructions =
          'CERTEN gateway access. Proof-gated cross-chain execution on Accumulate.\n\n'
          + 'THIS SERVER HOLDS NO SIGNING KEY AND CANNOT SIGN. To authorize anything: open an intent '
          + '(certen_transaction_open), sign the returned hash_to_sign wherever your key actually '
          + 'lives, then submit that signature (certen_transaction_submit_signature).\n\n'
          + (writesAllowed(env)
            ? 'Write tools ARE enabled. Each one requires confirm:true and several are irreversible.'
            : 'Write tools are DISABLED. This server is read-only; set CERTEN_MCP_ALLOW_WRITES=1 to '
              + 'enable them. Do not tell the user to set it without saying what it permits.')
          + '\n\nRead certen://docs/llms.txt before writing code against this API — a proof cycle '
          + 'legitimately takes 60-110 seconds, and most integration mistakes come from not knowing that.';

  const capabilities = { tools: {}, resources: {} };

  /** Each method sees the era it was asked under. The wrapper below resolves it, refuses what the era does not allow, and shapes the result. */
  const methods: Record<string, (params: Record<string, unknown>, era: Era) => unknown> = {
    initialize: (params) => {
      // Echo the client's protocol version when it is a LEGACY one we support; otherwise answer with our newest legacy version and let
      // the client decide whether it can proceed. A handshake cannot select a modern version: modern clients send no `initialize`.
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version: LegacyVersion = (LEGACY_VERSIONS as readonly string[]).includes(asked)
        ? (asked as LegacyVersion)
        : LATEST_LEGACY_PROTOCOL_VERSION;
      eraState.legacyVersion = version;
      return { protocolVersion: version, capabilities, serverInfo, instructions };
    },

    // Modern clients may probe before anything else, to learn versions, capabilities and identity in one request. Mandatory in 2026-07-28.
    'server/discover': () => ({ supportedVersions: [...PROTOCOL_VERSIONS], capabilities, instructions }),

    // Notifications: acknowledged by returning nothing. dispatch() suppresses responses for these.
    'notifications/initialized': () => ({}),
    'notifications/cancelled': () => ({}),
    // Removed in 2026-07-28; the wrapper refuses it for a modern request.
    ping: () => ({}),

    'tools/list': (_params, era) => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        // Tool annotations exist from 2025-03-26; a 2024-11-05 client is not sent a field it does not know.
        ...(features(era).annotations ? { annotations: annotationsFor(t) } : {}),
      })),
    }),

    'tools/call': async (params) => {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = byName.get(name);

      if (!tool) {
        // Name the reason precisely: "disabled by configuration" and "does not exist" call for
        // completely different responses, and a model told only "unknown tool" will guess.
        const gated = !writesAllowed(env) && WRITE_NAMES.has(name);
        throw new RpcError(
          RPC.INVALID_PARAMS,
          gated
            ? `${name} is a write tool and this server is running read-only. `
              + 'It is disabled by configuration, not missing — set CERTEN_MCP_ALLOW_WRITES=1 to enable it.'
            : `unknown tool: ${name}`,
        );
      }

      // The confirmation stop. A mutating tool called without confirm:true describes itself and
      // does nothing — so the first call can never be the destructive one. Keyed on `mutates`, not
      // on the tier: the admin read tools are gated for visibility but have nothing to confirm.
      if (tool.mutates && args.confirm !== true) {
        return textResult(
          JSON.stringify(
            {
              status: 'confirmation_required',
              tool: tool.name,
              endpoint: tool.endpoint,
              would_do: tool.description,
              arguments_received: redact(args),
              next_step: `Call ${tool.name} again with confirm:true to proceed.`,
            },
            null,
            2,
          ),
        );
      }

      try {
        const result = await tool.run(getClient(), args);
        return textResult(JSON.stringify(result ?? null, null, 2));
      } catch (err) {
        if (err instanceof RpcError) throw err;
        // Tool errors come back as isError content rather than a JSON-RPC error, so the model can
        // read the code and decide, instead of the client treating it as a transport failure.
        return textResult(JSON.stringify(describeError(err), null, 2), true);
      }
    },

    'resources/list': () => ({
      resources: availableResources().map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    }),

    'resources/read': (params, era) => {
      const uri = typeof params.uri === 'string' ? params.uri : '';
      try {
        const { text, mimeType } = readResource(uri);
        return { contents: [{ uri, mimeType, text }] };
      } catch (err) {
        // A resource that does not exist is -32602 from 2026-07-28 on and was -32002 before it.
        throw new RpcError(era.modern ? RPC.INVALID_PARAMS : RPC.LEGACY_RESOURCE_NOT_FOUND, err instanceof Error ? err.message : String(err), { uri });
      }
    },
  };

  const MODERN_ONLY = new Set(['server/discover']);
  const LEGACY_ONLY = new Set(['initialize', 'ping']);
  const table: Record<string, Handler> = {};
  for (const [method, inner] of Object.entries(methods)) {
    table[method] = async (params) => {
      const era = resolveEra(method, params, eraState);
      if (era.modern && LEGACY_ONLY.has(method) && method !== 'initialize') {
        throw new RpcError(RPC.METHOD_NOT_FOUND, `${method} was removed in protocol ${era.version}`);
      }
      if (!era.modern && MODERN_ONLY.has(method)) {
        throw new RpcError(
          RPC.INVALID_PARAMS,
          `${method} needs _meta["io.modelcontextprotocol/protocolVersion"] and _meta["io.modelcontextprotocol/clientCapabilities"]`,
        );
      }
      const result = await inner(params, era);
      return era.modern ? finishModern(method, result, serverInfo) : result;
    };
  }
  return table;
}

const WRITE_NAMES = new Set(
  activeTools({ CERTEN_MCP_ALLOW_WRITES: '1' } as NodeJS.ProcessEnv)
    .filter((t: ToolDef) => t.tier === 'write')
    .map((t) => t.name),
);

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** Keep signatures out of transcripts — they are not secret, but they are noise nobody should read. */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = k === 'signature' && typeof v === 'string' ? `<${v.length}-char signature>` : v;
  }
  return out;
}

/** Codes whose `details` are the point of the error: what the last poll saw, or why there is no proof. */
const DETAIL_CODES = new Set(['WAIT_TIMEOUT', 'PROOF_NOT_ASSIGNED', 'INTENT_FAILED']);

function extraErrorFields(err: unknown): Record<string, unknown> {
  const e = err as { guidance?: unknown; reasonCode?: unknown; code?: unknown; details?: unknown };
  return {
    ...(typeof e.guidance === 'string' ? { guidance: e.guidance } : {}),
    ...(e.reasonCode !== undefined ? { reason_code: e.reasonCode } : {}),
    // Read by shape, like the fields above: this package may run against an SDK that predates these errors.
    ...(typeof e.code === 'string' && DETAIL_CODES.has(e.code) && e.details && typeof e.details === 'object' ? { details: e.details } : {}),
  };
}

function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof CertenError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        status: err.status,
        retryable: err.isRetryable,
        requestId: err.requestId,
        // Additive: the refusal carries its remedy, and a failed intent its reason. Read by shape,
        // not by class, because this package may run against an SDK release that predates both.
        ...extraErrorFields(err),
      },
      // Say it outright: the SDK already retried the retryable ones with backoff.
      note: err.isRetryable
        ? 'The SDK already retried this with backoff before giving up. Retrying immediately will not help.'
        : 'Not retryable — this is a condition that will not change on its own.',
    };
  }
  return { error: { code: 'TOOL_ERROR', message: err instanceof Error ? err.message : String(err) } };
}
