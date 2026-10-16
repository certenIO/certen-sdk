import { CertenError, checkEvmRpcEndpoint } from '@certen.io/sdk';
import { UsageError } from './errors.js';

/**
 * Flag values that more than one command takes, validated in one place and before any network call or prompt: a typo in a flag must cost
 * a message, not a round trip (or an identity).
 */

/**
 * `--rpc`: a node of the caller's own on the execution chain, or `CERTEN_RPC_URL`.
 *
 * The URL is never echoed back: hosted providers put an API key in the path, and an error message is the place it would leak. The refusal says
 * which flag or variable was wrong, and why, and nothing else about it.
 */
export function parseNodeRpc(value: string | undefined): string | undefined {
  const fromEnv = value === undefined && process.env.CERTEN_RPC_URL ? process.env.CERTEN_RPC_URL : undefined;
  const raw = value ?? fromEnv;
  if (raw === undefined) return undefined;
  const where = value === undefined ? 'CERTEN_RPC_URL' : '--rpc';
  try {
    checkEvmRpcEndpoint(raw);
  } catch (err) {
    const why = err instanceof CertenError ? err.message.replace(/^certen: /, '') : 'it is not usable';
    throw new UsageError(`${where} is not usable: ${why} Give the JSON-RPC endpoint of a node you trust on the chain, e.g. https://sepolia.base.org`, 'INVALID_RPC');
  }
  return raw;
}

/**
 * `--expect <address:topic0[:topic1]>`: an event the execution receipt must contain.
 *
 * Checked here, before any request, so a typo costs a message and not a wait: a malformed address or topic would otherwise never match, and
 * "the expected event is NOT in the receipt" would be reported for a mistake in the flag rather than for the receipt.
 */
export function parseExpectEvent(value: string | undefined): { address?: string; topic0?: string; topic1?: string } | undefined {
  if (value === undefined) return undefined;
  const [address, topic0, topic1, ...rest] = value.split(':');
  const bad = (what: string): never => {
    throw new UsageError(
      `--expect "${value}": ${what}. Expected <contract address>:<event topic>[:<first indexed argument>], e.g. 0x41bc…5eb335e:0x81eb…7cbc.`,
      'INVALID_EXPECT',
    );
  };
  if (rest.length > 0) bad('too many parts');
  if (address && !/^0x[0-9a-fA-F]{40}$/.test(address)) bad('the contract address is not 0x followed by 40 hex characters');
  if (topic0 && !/^0x[0-9a-fA-F]{64}$/.test(topic0)) bad('the event topic is not 0x followed by 64 hex characters');
  if (topic1 && !/^0x[0-9a-fA-F]{64}$/.test(topic1)) bad('the first indexed argument is not 0x followed by 64 hex characters');
  if (!address && !topic0) bad('it names neither a contract nor an event');
  return { address: address || undefined, topic0: topic0 || undefined, topic1: topic1 || undefined };
}

export function parseGasReserve(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === 'none') return null;
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new UsageError(`--gas-reserve "${value}" must be a decimal number of whole native units (e.g. 0.0002), or "none".`, 'INVALID_AMOUNT');
  }
  return value;
}

export function parseRpc(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch {
    throw new UsageError(`--accumulate-rpc "${value}" is not a URL. Give the Accumulate API endpoint, e.g. https://kermit.accumulatenetwork.io/v3`, 'INVALID_ACCUMULATE_RPC');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new UsageError(`--accumulate-rpc "${value}" must be an http(s) URL with no username or password in it.`, 'INVALID_ACCUMULATE_RPC');
  }
  return value;
}

