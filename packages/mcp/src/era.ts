import { LATEST_LEGACY_PROTOCOL_VERSION, LEGACY_VERSIONS, MODERN_VERSIONS, PROTOCOL_VERSIONS, RPC, RpcError } from './protocol.js';

/**
 * Which protocol era a request belongs to, decided per request.
 *
 * This server is DUAL-ERA (MCP 2026-07-28, "Versioning and Compatibility"): it serves
 *   - the MODERN era (2026-07-28 and later), where there is no handshake and every request carries its protocol version and the client's
 *     capabilities in `_meta`, and results carry `resultType`; and
 *   - the LEGACY era (2025-11-25 and earlier), which opens with `initialize` and negotiates one of the older versions.
 * A request carrying the modern `_meta` is served statelessly under this revision; `initialize` selects legacy semantics. Nothing about a
 * modern request depends on an earlier one.
 */

export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;

export type LegacyVersion = (typeof LEGACY_VERSIONS)[number];

export type Era =
  | { modern: true; version: string }
  | { modern: false; version: LegacyVersion };

/** The only per-process state: the legacy version an `initialize` negotiated. Modern requests never read or write it. */
export interface EraState { legacyVersion: LegacyVersion | undefined }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Decide the era of one request, or refuse it.
 *
 * - `initialize` is always legacy (it is how a legacy client opens).
 * - `_meta['io.modelcontextprotocol/protocolVersion']` present: modern. A version this server does not serve is answered with
 *   `UnsupportedProtocolVersionError` (-32022) listing the versions it does, so the client can pick one and retry. A request missing
 *   the protocol version's companions (`clientCapabilities` is required) is malformed: -32602.
 * - Neither: a legacy request (the connection's negotiated version, or the newest legacy one if the client never sent `initialize`).
 */
export function resolveEra(method: string, params: Record<string, unknown>, state: EraState): Era {
  if (method === 'initialize') return { modern: false, version: state.legacyVersion ?? LATEST_LEGACY_PROTOCOL_VERSION };
  const meta = params._meta;
  const asked = isObject(meta) ? meta[META.protocolVersion] : undefined;
  if (asked === undefined) return { modern: false, version: state.legacyVersion ?? LATEST_LEGACY_PROTOCOL_VERSION };

  if (typeof asked !== 'string' || asked === '') {
    throw new RpcError(RPC.INVALID_PARAMS, `_meta["${META.protocolVersion}"] must be a protocol version string`);
  }
  if (!(MODERN_VERSIONS as readonly string[]).includes(asked)) {
    throw new RpcError(RPC.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: [...PROTOCOL_VERSIONS],
      requested: asked,
    });
  }
  if (!isObject((meta as Record<string, unknown>)[META.clientCapabilities])) {
    throw new RpcError(RPC.INVALID_PARAMS, `_meta["${META.clientCapabilities}"] is required on every request under protocol ${asked}`);
  }
  return { modern: true, version: asked };
}

/** What the negotiated version allows in `tools/list` and `tools/call` results. Newest-first rules; nothing is sent a client cannot read. */
export function features(era: Era): { annotations: boolean; structuredOutput: boolean } {
  if (era.modern) return { annotations: true, structuredOutput: true };
  return {
    annotations: era.version >= '2025-03-26',
    structuredOutput: era.version >= '2025-06-18',
  };
}

/** Freshness hints required on cacheable modern results. The tool and resource lists change only when the server is restarted. */
export const CACHE_HINT = { ttlMs: 300_000, cacheScope: 'public' } as const;
const CACHEABLE = new Set(['server/discover', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'resources/read']);

/**
 * Shape a handler's result for a modern response: `resultType`, the server's identity in `_meta`, and caching hints on the methods
 * the spec makes cacheable. A result that already names its `resultType` is left alone.
 */
export function finishModern(method: string, result: unknown, serverInfo: { name: string; version: string }): unknown {
  const base = isObject(result) ? result : {};
  const meta = isObject(base._meta) ? base._meta : {};
  return {
    ...base,
    resultType: typeof base.resultType === 'string' ? base.resultType : 'complete',
    ...(CACHEABLE.has(method) ? CACHE_HINT : {}),
    _meta: { ...meta, [META.serverInfo]: serverInfo },
  };
}
