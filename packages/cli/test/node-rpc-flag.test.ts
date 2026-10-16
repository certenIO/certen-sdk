import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseNodeRpc } from '../src/flag-parsers.js';

/**
 * `--rpc` / `CERTEN_RPC_URL`: a node of the caller's own.
 *
 * Hosted node providers put an API key in the URL's path, so the one thing this must never do is repeat a URL it was given: an error message
 * is exactly where a key would leak (a terminal scrollback, a CI log, a pasted bug report).
 */

const KEYED = 'https://base-sepolia.g.alchemy.com/v2/SUPERSECRETKEY123';
let saved: string | undefined;
beforeEach(() => { saved = process.env.CERTEN_RPC_URL; delete process.env.CERTEN_RPC_URL; });
afterEach(() => { if (saved === undefined) delete process.env.CERTEN_RPC_URL; else process.env.CERTEN_RPC_URL = saved; });

describe('parseNodeRpc', () => {
  it('is undefined when no node was given: the check is optional, and its absence is reported by the receipt, not here', () => {
    expect(parseNodeRpc(undefined)).toBeUndefined();
  });

  it('accepts an http(s) endpoint, including one with a key in its path, and returns it unchanged', () => {
    expect(parseNodeRpc(KEYED)).toBe(KEYED);
    expect(parseNodeRpc('http://127.0.0.1:8545')).toBe('http://127.0.0.1:8545');
  });

  it('takes CERTEN_RPC_URL when the flag is absent, and the flag wins when both are given', () => {
    process.env.CERTEN_RPC_URL = 'https://env.example/rpc';
    expect(parseNodeRpc(undefined)).toBe('https://env.example/rpc');
    expect(parseNodeRpc('https://flag.example/rpc')).toBe('https://flag.example/rpc');
  });

  it.each([
    ['not a URL', 'not a url'],
    ['a scheme that is not http(s)', 'ws://node.example/rpc'],
    ['a username and password in the URL', 'https://user:hunter2@node.example/rpc'],
  ])('refuses %s as a usage error INVALID_RPC', (_why, bad) => {
    expect(() => parseNodeRpc(bad)).toThrowError(expect.objectContaining({ code: 'INVALID_RPC', exitCode: 2 }));
  });

  it('never repeats the URL it refused: not the password, not the host, nothing it was given', () => {
    for (const bad of ['https://user:hunter2@node.example/rpc?k=SUPERSECRETKEY123', 'ftp://node.example/v2/SUPERSECRETKEY123']) {
      try {
        parseNodeRpc(bad);
        expect.unreachable();
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain('hunter2');
        expect(message).not.toContain('SUPERSECRETKEY123');
        expect(message).not.toContain('node.example');
      }
    }
  });

  it('names the variable when the bad value came from the environment, and the flag when it was typed', () => {
    process.env.CERTEN_RPC_URL = 'ftp://x';
    expect(() => parseNodeRpc(undefined)).toThrowError(/^CERTEN_RPC_URL is not usable/);
    expect(() => parseNodeRpc('ftp://x')).toThrowError(/^--rpc is not usable/);
  });
});
