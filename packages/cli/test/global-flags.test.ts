import { describe, it, expect } from 'vitest';
import { extractProfileFlag } from '../src/global-flags.js';

/**
 * `--profile <name>` is global, like `--json`: it may appear before or after the subcommand, because "which setup am I running
 * as" is not a property of one command. Commander does not model a global flag that can follow a subcommand, so it is taken out
 * of argv before parsing, exactly as `--json` is.
 *
 * What matters is what it refuses. Two different `--profile` values on one command line would mean the later one silently wins
 * on a command that signs; a missing value would swallow the next word and run as a profile named after it.
 */
describe('extractProfileFlag', () => {
  it('leaves an argv with no --profile alone', () => {
    expect(extractProfileFlag(['call', '--to', '0x1'])).toEqual({ argv: ['call', '--to', '0x1'], profile: undefined });
  });

  it('takes `--profile name` out from before the subcommand', () => {
    expect(extractProfileFlag(['--profile', 'testnet', 'context'])).toEqual({ argv: ['context'], profile: 'testnet' });
  });

  it('takes it out from after the subcommand and its flags', () => {
    expect(extractProfileFlag(['call', '--chain', 'base-sepolia', '--profile', 'testnet', '--wait']))
      .toEqual({ argv: ['call', '--chain', 'base-sepolia', '--wait'], profile: 'testnet' });
  });

  it('accepts `--profile=name`', () => {
    expect(extractProfileFlag(['context', '--profile=testnet'])).toEqual({ argv: ['context'], profile: 'testnet' });
  });

  it('refuses a missing value rather than swallowing the next word', () => {
    expect(() => extractProfileFlag(['context', '--profile'])).toThrowError(/--profile needs a profile name/);
    expect(() => extractProfileFlag(['--profile', '--json', 'context'])).toThrowError(/--profile needs a profile name/);
    expect(() => extractProfileFlag(['context', '--profile='])).toThrowError(/--profile needs a profile name/);
    try { extractProfileFlag(['context', '--profile']); } catch (e) {
      expect((e as { code: string; exitCode: number }).code).toBe('MISSING_PROFILE_NAME');
      expect((e as { exitCode: number }).exitCode).toBe(2);
    }
  });

  it('refuses two --profile flags on one command line', () => {
    expect(() => extractProfileFlag(['--profile', 'a', 'context', '--profile', 'b'])).toThrowError(/once/);
    try { extractProfileFlag(['--profile', 'a', '--profile=b']); } catch (e) {
      expect((e as { code: string }).code).toBe('DUPLICATE_PROFILE_FLAG');
    }
  });

  it('does not touch a value that merely contains the word', () => {
    expect(extractProfileFlag(['call', '--memo', 'my--profile', '--to', '0x1']).argv).toEqual(['call', '--memo', 'my--profile', '--to', '0x1']);
  });
});
