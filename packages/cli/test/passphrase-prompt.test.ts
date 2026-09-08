import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { promptSecret, resolveNewPassphrase, PASSPHRASE_ENV_VAR } from '../src/passphrase.js';

/**
 * The hidden prompt, driven byte for byte against a fake TTY.
 *
 * There was no test here, and the cost of that was the worst possible bug in the worst possible
 * place: `keys generate` — the FIRST command in the README — hung forever on 0.7.1 through 0.9.0.
 * Enter did nothing, typing did nothing, and Ctrl-C did nothing, so the terminal had to be killed.
 * The cause was one line, `stdin.setEncoding('binary')`, which turns every `data` event into a
 * string; the reader compared those characters to byte numbers and matched nothing, ever.
 *
 * So these tests feed Buffers, the way a real terminal in raw mode does, and assert on what the
 * caller gets back. A reader that ignores its input fails every case below.
 */

interface FakeStdin extends EventEmitter {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(raw: boolean): FakeStdin;
  resume(): FakeStdin;
  pause(): FakeStdin;
}

const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
const originalWrite = process.stdout.write.bind(process.stdout);

/** A stdin that behaves like a terminal in raw mode, and a stdout that swallows the prompt. */
function fakeTty(): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin;
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (raw: boolean) => { stdin.isRaw = raw; return stdin; };
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  process.stdout.write = (() => true) as typeof process.stdout.write;
  return stdin;
}

/** Deliver keystrokes on the next tick, so the reader is listening before they arrive. */
function type(stdin: FakeStdin, ...chunks: (string | Buffer)[]): void {
  queueMicrotask(() => {
    for (const c of chunks) stdin.emit('data', typeof c === 'string' ? Buffer.from(c, 'utf8') : c);
  });
}

const CR = Buffer.from([0x0d]);
const LF = Buffer.from([0x0a]);
const CTRL_C = Buffer.from([0x03]);
const CTRL_D = Buffer.from([0x04]);
const CTRL_U = Buffer.from([0x15]);
const BACKSPACE = Buffer.from([0x7f]);

afterEach(() => {
  Object.defineProperty(process, 'stdin', originalStdin);
  process.stdout.write = originalWrite;
  delete process.env[PASSPHRASE_ENV_VAR];
});

describe('the hidden passphrase prompt reads what is typed', () => {
  it('resolves the typed text when Enter is pressed — the case that hung on 0.7.1 to 0.9.0', async () => {
    const stdin = fakeTty();
    const p = promptSecret('Passphrase: ');
    type(stdin, 'correct horse', CR);
    await expect(p).resolves.toBe('correct horse');
  });

  it('resolves empty on Enter alone, which is how a key is stored unencrypted', async () => {
    const stdin = fakeTty();
    const p = promptSecret('Passphrase: ');
    type(stdin, LF);
    await expect(p).resolves.toBe('');
  });

  it('accepts one keystroke per chunk, the way a terminal in raw mode actually delivers them', async () => {
    const stdin = fakeTty();
    const p = promptSecret('Passphrase: ');
    type(stdin, 'h', 'u', 'n', 't', 'e', 'r', '2', CR);
    await expect(p).resolves.toBe('hunter2');
  });

  it('cancels on Ctrl-C instead of ignoring it', async () => {
    const stdin = fakeTty();
    const p = promptSecret('Passphrase: ');
    type(stdin, 'half typed', CTRL_C);
    await expect(p).rejects.toThrow(/Cancelled/);
  });

  it('cancels on Ctrl-D at an empty prompt, and treats it as a plain control character otherwise', async () => {
    const first = fakeTty();
    const cancelled = promptSecret('Passphrase: ');
    type(first, CTRL_D);
    await expect(cancelled).rejects.toThrow(/Cancelled/);

    const second = fakeTty();
    const kept = promptSecret('Passphrase: ');
    type(second, 'abc', CTRL_D, CR);
    await expect(kept).resolves.toBe('abc');
  });

  it('deletes a character on backspace, and clears the line on Ctrl-U', async () => {
    const stdin = fakeTty();
    const p = promptSecret('Passphrase: ');
    type(stdin, 'passwd', BACKSPACE, BACKSPACE, 'ord', CR);
    await expect(p).resolves.toBe('passord');

    const other = fakeTty();
    const q = promptSecret('Passphrase: ');
    type(other, 'throw this away', CTRL_U, 'keep this', CR);
    await expect(q).resolves.toBe('keep this');
  });

  it('keeps non-ASCII characters intact, including one split across two chunks', async () => {
    const stdin = fakeTty();
    const p = promptSecret('Passphrase: ');
    const emoji = Buffer.from('🔑', 'utf8');
    type(stdin, 'clé-', emoji.subarray(0, 2), emoji.subarray(2), '-naïve', CR);
    await expect(p).resolves.toBe('clé-🔑-naïve');
  });

  it('deletes a whole multi-byte character on backspace, not one byte of it', async () => {
    const stdin = fakeTty();
    const p = promptSecret('Passphrase: ');
    type(stdin, 'a🔑', BACKSPACE, 'b', CR);
    await expect(p).resolves.toBe('ab');
  });

  it('treats a Windows CRLF as one Enter', async () => {
    const stdin = fakeTty();
    const p = promptSecret('Passphrase: ');
    type(stdin, Buffer.concat([Buffer.from('windows', 'utf8'), CR, LF]));
    await expect(p).resolves.toBe('windows');
  });

  it('restores raw mode and stops listening once it has an answer', async () => {
    const stdin = fakeTty();
    const p = promptSecret('Passphrase: ');
    type(stdin, 'done', CR);
    await p;
    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.listenerCount('error')).toBe(0);
  });
});

describe('resolveNewPassphrase, the path `keys generate` takes', () => {
  it('returns null when the person just presses Enter, so the key is stored unencrypted', async () => {
    const stdin = fakeTty();
    const p = resolveNewPassphrase(false);
    type(stdin, CR);
    await expect(p).resolves.toBeNull();
  });

  it('asks for confirmation and returns the passphrase when both match', async () => {
    const stdin = fakeTty();
    const p = resolveNewPassphrase(false);
    type(stdin, 's3cret', CR);
    queueMicrotask(() => queueMicrotask(() => {
      stdin.emit('data', Buffer.from('s3cret', 'utf8'));
      stdin.emit('data', CR);
    }));
    await expect(p).resolves.toBe('s3cret');
  });

  it('refuses a mismatched confirmation rather than writing a key nobody can open', async () => {
    const stdin = fakeTty();
    const p = resolveNewPassphrase(false);
    type(stdin, 'first', CR);
    queueMicrotask(() => queueMicrotask(() => {
      stdin.emit('data', Buffer.from('second', 'utf8'));
      stdin.emit('data', CR);
    }));
    await expect(p).rejects.toThrow(/did not match/i);
  });

  it('never prompts with --no-passphrase, or when the env var is set', async () => {
    Object.defineProperty(process, 'stdin', { value: new EventEmitter(), configurable: true });
    await expect(resolveNewPassphrase(true)).resolves.toBeNull();
    process.env[PASSPHRASE_ENV_VAR] = 'from the environment';
    await expect(resolveNewPassphrase(false)).resolves.toBe('from the environment');
  });
});
