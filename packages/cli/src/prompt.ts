import { isInteractive } from './passphrase.js';

/**
 * Asking the person a question, from one place.
 *
 * `init` has always had its own `askLine`. `setup` asks more (which kind of account, which key, whether to retire a failed identity) and has to
 * be testable without a terminal, so the questions go through this interface: the real one reads a TTY, and a test hands in a scripted one.
 *
 * **A question is only asked of a person.** Every method answers from its default, or refuses, when there is no TTY: a command that blocks on
 * a prompt inside a pipeline looks like a hang, which is the worst failure mode here (the same rule the passphrase prompt follows).
 *
 * Prompts go to stderr. In `--json` mode stdout is exactly one envelope, and a question printed there would corrupt it; on a terminal the two
 * streams look the same to the person.
 */
export interface Prompter {
  /** May this prompter ask at all? False means every method must be answered from its default or refused. */
  readonly interactive: boolean;
  /** A line of text, with what is used when the person just presses Enter. */
  ask(question: string, fallback: string): Promise<string>;
  /** Yes or no. Enter takes the default. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /**
   * One of several named answers, with NO default: the person has to say. Used where a wrong guess has a cost (creating an organisation).
   * Returns the chosen `key`, or undefined when the answer was not one of them after `tries` attempts.
   */
  choose(question: string, options: ReadonlyArray<{ key: string; aliases?: readonly string[]; label: string }>, tries?: number): Promise<string | undefined>;
}

interface LineSource {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * The prompter that reads a terminal.
 *
 * `stdin` and `out` are parameters so a test can drive it with streams instead of a TTY. Lines are buffered: a paste of several lines (or two
 * answers typed ahead) must not lose the second one, which a "take the next chunk" reader does.
 */
export function terminalPrompter(
  stdin: LineSource = process.stdin,
  out: { write(text: string): unknown } = process.stderr,
  interactive: () => boolean = isInteractive,
): Prompter {
  let buffered = '';
  const waiting: Array<(line: string) => void> = [];

  const onData = (chunk: Buffer | string): void => {
    buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (;;) {
      const at = buffered.search(/\r?\n/);
      if (at < 0) return;
      const line = buffered.slice(0, at);
      buffered = buffered.slice(buffered[at] === '\r' ? at + 2 : at + 1);
      const next = waiting.shift();
      if (!next) {
        // An answer typed before the question was asked: keep it for the question that comes.
        buffered = `${line}\n${buffered}`;
        return;
      }
      next(line.trim());
      if (waiting.length === 0) {
        stdin.removeListener('data', onData);
        stdin.pause();
      }
    }
  };

  const readLine = (): Promise<string> => new Promise((resolve) => {
    // A full line may already be waiting from earlier typing.
    const at = buffered.search(/\r?\n/);
    if (at >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(buffered[at] === '\r' ? at + 2 : at + 1);
      resolve(line.trim());
      return;
    }
    waiting.push(resolve);
    if (waiting.length === 1) {
      stdin.on('data', onData);
      stdin.resume();
    }
  });

  const ask = async (question: string, fallback: string): Promise<string> => {
    if (!interactive()) return fallback;
    out.write(`${question} [${fallback}]: `);
    const answer = await readLine();
    return answer.length > 0 ? answer : fallback;
  };

  return {
    get interactive() { return interactive(); },
    ask,
    async confirm(question, defaultYes) {
      if (!interactive()) return defaultYes;
      out.write(`${question} [${defaultYes ? 'Y/n' : 'y/N'}]: `);
      const answer = (await readLine()).toLowerCase();
      if (answer === '') return defaultYes;
      return answer === 'y' || answer === 'yes';
    },
    async choose(question, options, tries = 3) {
      if (!interactive()) return undefined;
      for (let attempt = 0; attempt < tries; attempt += 1) {
        out.write(`${question}\n${options.map((o) => `    ${o.key.padEnd(10)} ${o.label}`).join('\n')}\n  Which? `);
        const answer = (await readLine()).toLowerCase();
        const hit = options.find((o) => o.key === answer || o.aliases?.includes(answer));
        if (hit) return hit.key;
        out.write(`  "${answer}" is not one of: ${options.map((o) => o.key).join(', ')}.\n`);
      }
      return undefined;
    },
  };
}

/** A default identity name that is valid (3-63 chars) and unlikely to collide on a retry. */
export function suggestedName(): string {
  return `bot-${Math.floor(Date.now() / 1000) % 1_000_000}`;
}
