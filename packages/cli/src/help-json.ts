import type { Command } from 'commander';

/**
 * The whole command tree as one JSON object, for `certen --help --json`.
 *
 * Discovery otherwise means running `--help`, scraping columns of text, then running `--help` again
 * for every subcommand. That is a lot of turns to answer "what can this CLI do", and the answer is
 * already in the parser — this just serialises it.
 */

interface OptionNode {
  flags: string;
  name: string;
  description: string;
  required: boolean;
  takesValue: boolean;
  default?: unknown;
}

interface ArgumentNode {
  name: string;
  required: boolean;
  description: string;
}

interface CommandNode {
  name: string;
  description: string;
  path: string;
  arguments: ArgumentNode[];
  options: OptionNode[];
  commands: CommandNode[];
}

interface CommanderOptionLike {
  flags: string;
  description?: string;
  mandatory?: boolean;
  required?: boolean;
  optional?: boolean;
  defaultValue?: unknown;
  attributeName?: () => string;
  long?: string;
  short?: string;
}

interface CommanderArgumentLike {
  name: () => string;
  required?: boolean;
  description?: string;
}

function optionNode(o: CommanderOptionLike): OptionNode {
  return {
    flags: o.flags,
    name: o.attributeName ? o.attributeName() : (o.long ?? o.short ?? o.flags).replace(/^--?/, ''),
    description: o.description ?? '',
    required: Boolean(o.mandatory),
    // `required` on a commander Option means "this flag takes a mandatory value", not "this flag
    // must be present" — that is `mandatory`. Conflating them is an easy and very confusing bug.
    takesValue: Boolean(o.required || o.optional),
    ...(o.defaultValue !== undefined ? { default: o.defaultValue } : {}),
  };
}

function argumentsOf(cmd: Command): ArgumentNode[] {
  // `registeredArguments` is commander >= 12; `_args` is the older internal. Fall back rather than
  // throw, so a commander bump degrades the help tree instead of breaking the command.
  const raw =
    ((cmd as unknown as { registeredArguments?: CommanderArgumentLike[] }).registeredArguments
      ?? (cmd as unknown as { _args?: CommanderArgumentLike[] })._args
      ?? []);
  return raw.map((a) => ({
    name: a.name(),
    required: Boolean(a.required),
    description: a.description ?? '',
  }));
}

function walk(cmd: Command, prefix: string[]): CommandNode {
  const path = [...prefix, cmd.name()].filter(Boolean);
  return {
    name: cmd.name(),
    description: cmd.description(),
    path: path.join(' '),
    arguments: argumentsOf(cmd),
    options: (cmd.options as unknown as CommanderOptionLike[]).map(optionNode),
    commands: cmd.commands.map((c) => walk(c as Command, path)),
  };
}

export function commandTree(program: Command, version: string): string {
  return JSON.stringify({
    ok: true,
    data: {
      ...walk(program, []),
      version,
      exitCodes: {
        0: 'ok',
        1: 'operation failed',
        2: 'usage error',
        3: 'gateway unreachable',
      },
    },
  });
}
