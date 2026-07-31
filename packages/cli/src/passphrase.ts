/**
 * Passphrase resolution for local signing keys.
 *
 * Order is deliberate: an explicit env var always wins so CI and scripted runs never depend on a
 * TTY, and the interactive prompt is the fallback rather than the default. A command that blocks
 * on a hidden prompt inside a pipeline looks like a hang, which is the worst failure mode here.
 */

const ENV_VAR = 'CERTEN_KEY_PASSPHRASE';

export function passphraseFromEnv(): string | null {
  const v = process.env[ENV_VAR];
  return v && v.length > 0 ? v : null;
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Read a line from the TTY without echoing it.
 *
 * Written against raw stdin rather than readline's historical `output: null` trick, which echoes
 * on some Windows terminals — and a passphrase echoed into scrollback is worse than no prompt.
 */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);

    const chars: string[] = [];
    const wasRaw = stdin.isRaw === true;

    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        switch (byte) {
          case 0x03: // Ctrl-C
            cleanup();
            reject(new Error('Cancelled.'));
            return;
          case 0x0d: // CR
          case 0x0a: // LF
            cleanup();
            resolve(chars.join(''));
            return;
          case 0x7f: // DEL
          case 0x08: // BS
            chars.pop();
            break;
          default:
            // Ignore other control characters; accept everything else as passphrase content.
            if (byte >= 0x20) chars.push(String.fromCharCode(byte));
        }
      }
    };

    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('binary');
    stdin.on('data', onData);
    stdin.on('error', (err) => {
      cleanup();
      reject(err);
    });
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
    throw new Error(
      `Key "${keyName}" is encrypted and there is no TTY to prompt on. Set ${ENV_VAR}, or run this interactively.`,
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
    throw new Error(
      `No TTY to prompt for a passphrase. Set ${ENV_VAR}, or pass --no-passphrase to store the key unencrypted.`,
    );
  }

  const first = await readHidden('Passphrase for the new key (empty to store unencrypted): ');
  if (first.length === 0) return null;
  const second = await readHidden('Confirm passphrase: ');
  if (first !== second) throw new Error('Passphrases did not match. Nothing was written.');
  return first;
}

export { ENV_VAR as PASSPHRASE_ENV_VAR };
