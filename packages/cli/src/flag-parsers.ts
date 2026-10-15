import { UsageError } from './errors.js';

/**
 * Flag values that more than one command takes, validated in one place and before any network call or prompt: a typo in a flag must cost
 * a message, not a round trip (or an identity).
 */

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

