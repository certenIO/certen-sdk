import { CertenClient, CertenError } from '@certen.io/sdk';
import {
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  RPC,
  RpcError,
  type Handler,
} from './protocol.js';
import { activeTools, writesAllowed, type ToolDef } from './tools.js';
import { availableResources, readResource } from './resources.js';

export const SERVER_NAME = '@certen.io/mcp';
export const SERVER_VERSION = '0.1.0';

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

  return {
    initialize: (params) => {
      // Echo the client's protocol version when we support it; otherwise answer with ours and let
      // the client decide whether it can proceed.
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : LATEST_PROTOCOL_VERSION;

      return {
        protocolVersion: version,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'CERTEN gateway access. Proof-gated cross-chain execution on Accumulate.\n\n'
          + 'THIS SERVER HOLDS NO SIGNING KEY AND CANNOT SIGN. To authorize anything: open an intent '
          + '(certen_transaction_open), sign the returned hash_to_sign wherever your key actually '
          + 'lives, then submit that signature (certen_transaction_submit_signature).\n\n'
          + (writesAllowed(env)
            ? 'Write tools ARE enabled. Each one requires confirm:true and several are irreversible.'
            : 'Write tools are DISABLED. This server is read-only; set CERTEN_MCP_ALLOW_WRITES=1 to '
              + 'enable them. Do not tell the user to set it without saying what it permits.')
          + '\n\nRead certen://docs/llms.txt before writing code against this API — a proof cycle '
          + 'legitimately takes 60-110 seconds, and most integration mistakes come from not knowing that.',
      };
    },

    // Notifications: acknowledged by returning nothing. dispatch() suppresses responses for these.
    'notifications/initialized': () => ({}),
    'notifications/cancelled': () => ({}),
    ping: () => ({}),

    'tools/list': () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
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

    'resources/read': (params) => {
      const uri = typeof params.uri === 'string' ? params.uri : '';
      try {
        const { text, mimeType } = readResource(uri);
        return { contents: [{ uri, mimeType, text }] };
      } catch (err) {
        throw new RpcError(RPC.INVALID_PARAMS, err instanceof Error ? err.message : String(err));
      }
    },
  };
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

function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof CertenError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        status: err.status,
        retryable: err.isRetryable,
        requestId: err.requestId,
      },
      // Say it outright: the SDK already retried the retryable ones with backoff.
      note: err.isRetryable
        ? 'The SDK already retried this with backoff before giving up. Retrying immediately will not help.'
        : 'Not retryable — this is a condition that will not change on its own.',
    };
  }
  return { error: { code: 'TOOL_ERROR', message: err instanceof Error ? err.message : String(err) } };
}
