/**
 * MCP over stdio: newline-delimited JSON-RPC 2.0.
 *
 * Implemented directly rather than via a client library. The surface a server needs is small and
 * stable — initialize, tools/list, tools/call, resources/list, resources/read, ping — and this
 * package can authorize value-bearing operations, so every transitive dependency it does not have
 * is supply-chain risk it does not carry.
 *
 * The framing rule that matters: **stdout carries protocol frames and nothing else.** Anything
 * written to stdout that is not a JSON-RPC message corrupts the stream and the client disconnects.
 * Diagnostics go to stderr. This is the same discipline as the CLI's `--json` envelope, for the
 * same reason.
 */

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

/** JSON-RPC 2.0 reserved codes, plus the ones MCP servers actually return. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

/** Thrown by a handler to produce a specific JSON-RPC error rather than a generic internal one. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export function isNotification(msg: JsonRpcRequest): boolean {
  // A JSON-RPC notification has no id and must never receive a response.
  return msg.id === undefined;
}

export async function dispatch(
  msg: JsonRpcRequest,
  handlers: Record<string, Handler>,
): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (isNotification(msg)) return null;
    return { jsonrpc: '2.0', id, error: { code: RPC.INVALID_REQUEST, message: 'invalid request' } };
  }

  const handler = handlers[msg.method];
  if (!handler) {
    // Unknown notifications are ignored: the spec requires a server to tolerate them, and
    // `notifications/cancelled` in particular arrives unsolicited.
    if (isNotification(msg)) return null;
    return {
      jsonrpc: '2.0',
      id,
      error: { code: RPC.METHOD_NOT_FOUND, message: `unknown method: ${msg.method}` },
    };
  }

  try {
    const result = await handler(msg.params ?? {});
    if (isNotification(msg)) return null;
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    if (isNotification(msg)) return null;
    if (err instanceof RpcError) {
      return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message, data: err.data } };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: RPC.INTERNAL_ERROR,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Read newline-delimited JSON from a stream and dispatch each message.
 *
 * Returns a promise that resolves when the input closes, so the process can exit cleanly rather
 * than hanging on an open stdin.
 */
export function serve(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  handlers: Record<string, Handler>,
): Promise<void> {
  return new Promise((resolve) => {
    let buffer = '';
    // Messages are dispatched in order: a client may send `initialize` and `tools/list`
    // back-to-back, and answering them out of order is a protocol violation.
    let chain: Promise<void> = Promise.resolve();

    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;

        chain = chain.then(async () => {
          let msg: JsonRpcRequest;
          try {
            msg = JSON.parse(line) as JsonRpcRequest;
          } catch {
            write(output, {
              jsonrpc: '2.0',
              id: null,
              error: { code: RPC.PARSE_ERROR, message: 'parse error' },
            });
            return;
          }
          const response = await dispatch(msg, handlers);
          if (response) write(output, response);
        });
      }
    });

    input.on('end', () => {
      chain.then(resolve, resolve);
    });
    input.on('close', () => {
      chain.then(resolve, resolve);
    });
  });
}

function write(output: NodeJS.WritableStream, message: JsonRpcResponse): void {
  output.write(`${JSON.stringify(message)}\n`);
}
