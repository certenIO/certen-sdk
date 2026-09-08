/**
 * Passphrase resolution for local signing keys.
 *
 * Order is deliberate: an explicit env var always wins so CI and scripted runs never depend on a
 * TTY, and the interactive prompt is the fallback rather than the default. A command that blocks
 * on a hidden prompt inside a pipeline looks like a hang, which is the worst failure mode here.
 */

import { StringDecoder } from 'node:string_decoder';
import { UsageError } from './errors.js';

const ENV_VAR = 'CERTEN_KEY_PASSPHRASE';

export function passphraseFromEnv(): string | null {
  const v = process.env[ENV_VAR];
  return v && v.length > 0 ? v : null;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Read a secret from stdin when it is a pipe rather than a terminal.
 *
 * This is what makes `--api-key -` work: `echo $KEY | certen auth login --api-key -` keeps the
 * secret out of shell history and out of the process table, which passing it as an argument
 * cannot do. Only the first line is taken, so a trailing newline from `echo` is not part of the
 * key.
 */
export function readSecretFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf.split(/\r?\n/)[0].trim()));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

/**
 * Read a line from the TTY without echoing it.
 *
 * Written against raw stdin rather than readline's historical `output: null` trick, which echoes
 * on some Windows terminals — and a passphrase echoed into scrollback is worse than no prompt.
 *
 * THE STREAM MUST STAY IN BUFFER MODE. This called `stdin.setEncoding('binary')` before handing
 * the stream to `onData`, which makes every `data` event a STRING. `for (const byte of chunk)`
 * then yielded one-character strings, so `case 0x0a` never matched, `byte >= 0x20` compared a
 * string to a number (always false), and nothing was ever collected or resolved: Enter did
 * nothing, typing did nothing, and Ctrl-C did nothing, so the only way out was killing the
 * terminal. Shipped in 0.7.1 through 0.9.0 and found by a partner on first contact with the
 * product — `keys generate` is the first command anyone runs. Bytes in, characters out, and a
 * test below drives this function with a fake TTY so a regression cannot ship silently again.
 */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);

    // Full characters, not bytes and not UTF-16 code units, so backspace deletes one thing the
    // person typed — an accented letter or an emoji included.
    let chars: string[] = [];
    // Holds a multi-byte character that arrives split across two chunks, which a paste can do.
    const decoder = new StringDecoder('utf8');
    const wasRaw = stdin.isRaw === true;

    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.removeListener('error', onError);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write('\n');
    };

    const take = (bytes: Buffer): void => {
      if (bytes.length === 0) return;
      const text = decoder.write(bytes);
      if (text.length > 0) chars.push(...Array.from(text));
    };

    const onData = (input: Buffer | string): void => {
      // Defensive: nothing here sets an encoding, but another code path in the same process might
      // have (`readSecretFromStdin` sets utf8), and the stream would then hand us a string.
      const chunk = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;

      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i];
        // Every UTF-8 continuation byte is >= 0x80, so a byte below 0x20 (or DEL) is always a
        // control character in its own right and can never be part of a larger character.
        if (byte >= 0x20 && byte !== 0x7f) continue;

        take(chunk.subarray(start, i));
        start = i + 1;

        switch (byte) {
          case 0x03: // Ctrl-C
            cleanup();
            reject(new Error('Cancelled.'));
            return;
          case 0x04: // Ctrl-D on an empty line: EOF, the terminal's other way of saying cancel
            if (chars.length === 0) {
              cleanup();
              reject(new Error('Cancelled.'));
              return;
            }
            break;
          case 0x0d: // CR
          case 0x0a: // LF
            cleanup();
            resolve(chars.join(''));
            return;
          case 0x7f: // DEL
          case 0x08: // BS
            chars.pop();
            break;
          case 0x15: // Ctrl-U clears the line
            chars = [];
            break;
          default:
            break; // every other control character is ignored
        }
      }
      take(chunk.subarray(start));
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.on('error', onError);
  });
}

/**
 * Resolve the passphrase for reading an existing key.
 *
 * `encrypted === false` short-circuits so an unencrypted key never prompts — otherwise every
 * `--no-passphrase` key would still stop and ask for one it does not use.
 */
export async function resolvePassphrase(encrypted: boolean, keyName: string): Promise<string | null> {
  if (!encrypted) return null;

  const fromEnv = passphraseFromEnv();
  if (fromEnv !== null) return fromEnv;

  if (!isInteractive()) {
    throw new UsageError(
      `Key "${keyName}" is encrypted and there is no TTY to prompt on. Set ${ENV_VAR}, or run this interactively.`,
      'PASSPHRASE_REQUIRED',
    );
  }

  return readHidden(`Passphrase for key "${keyName}": `);
}

/**
 * Resolve the passphrase for a NEW key, confirming it.
 *
 * A typo here is unrecoverable — there is no reset for a key that only exists locally — so the
 * confirmation is not optional when prompting. Supplying it via the env var skips confirmation,
 * because a script that set it once cannot mistype it twice differently.
 */
export async function resolveNewPassphrase(noPassphrase: boolean): Promise<string | null> {
  if (noPassphrase) return null;

  const fromEnv = passphraseFromEnv();
  if (fromEnv !== null) return fromEnv;

  if (!isInteractive()) {
    throw new UsageError(
      `No TTY to prompt for a passphrase. Set ${ENV_VAR}, or pass --no-passphrase to store the key unencrypted.`,
      'PASSPHRASE_REQUIRED',
    );
  }

  const first = await readHidden('Passphrase for the new key (empty to store unencrypted): ');
  if (first.length === 0) return null;
  const second = await readHidden('Confirm passphrase: ');
  if (first !== second) throw new Error('Passphrases did not match. Nothing was written.');
  return first;
}

/**
 * Prompt for a secret on the TTY without echoing it.
 *
 * Exported so `auth login` can ask for an API key the same way key commands ask for a passphrase.
 * A key pasted at a hidden prompt never reaches shell history; one passed as `--api-key <value>`
 * always does.
 */
export async function promptSecret(prompt: string): Promise<string> {
  if (!isInteractive()) {
    throw new Error('No TTY to prompt on.');
  }
  return readHidden(prompt);
}

export { ENV_VAR as PASSPHRASE_ENV_VAR };
