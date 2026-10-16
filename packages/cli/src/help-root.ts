import { Command, Help } from 'commander';

/**
 * Root help, grouped by where you are in the journey.
 *
 * An alphabetical list of eighteen commands answers "what exists" and not "what do I do now",
 * and the second question is the one someone typing `certen --help` for the first time actually
 * has. `admin` sorting above `auth` is a small thing; `admin` sorting above `auth` while the
 * reader has no credential yet is a wrong first impression.
 *
 * Only the ROOT help is restructured. Subcommand help stays exactly as commander renders it —
 * by the time someone types `certen identity --help` they know what they are looking for, and
 * a bespoke format there would be novelty rather than clarity.
 *
 * `certen --help --json` is unaffected: it serialises the parser (see help-json.ts), not this.
 */

interface Group {
  title: string;
  blurb: string;
  commands: string[];
}

/**
 * The first group is the five commands a person types: the journey, in order (get ready, move value, move value through a contract, ask what is in
 * the way, read what happened). Everything else follows in the order a person needs it, and the plumbing is last, under "Advanced".
 *
 * Anything not listed still appears, under "Other" — a command must never become invisible because someone added it without touching this file
 * (`help-root.test.ts` asserts every registered command has a home, so "Other" stays empty).
 */
const GROUPS: Group[] = [
  {
    title: 'Start here',
    blurb: 'the whole journey, in five commands',
    commands: ['setup', 'send', 'call', 'status', 'receipt'],
  },
  {
    title: 'Follow it through',
    blurb: 'see an intent finish, and check it yourself',
    commands: ['watch', 'proof', 'gas', 'doctor'],
  },
  {
    title: 'Your account',
    blurb: 'who you are, and what the other commands default to',
    commands: ['whoami', 'context', 'use', 'identity', 'keys', 'chains', 'portfolio', 'login', 'signup', 'auth', 'init'],
  },
  {
    title: 'Approve',
    blurb: 'multi-party signing',
    commands: ['pending', 'governance'],
  },
  {
    title: 'Money',
    blurb: 'what it costs, how to pay, and what you were charged',
    commands: ['balance', 'fund', 'pricing', 'quote', 'payers', 'ledger', 'receipts', 'verify'],
  },
  {
    title: 'Advanced',
    blurb: 'plumbing and administration; everything above is built from these',
    commands: ['tx', 'admin', 'scopes', 'webhooks', 'oauth-clients', 'orgs', 'errors'],
  },
];

const QUICKSTART = `
  From nothing to a verified transfer:

    certen setup                                # sign in, key, identity, checks, gas: resumable, ready or it says why
    certen send 0.0001 ETH --to 0xRecipient     # preview, confirm, sign, wait, verify, receipt
    certen receipt                              # the record again: what happened, and what was checked

  Calling a contract instead: certen call --to 0xContract --fn 'confirm(bytes32)' --arg 0x... --wait
  Something in the way? \`certen status\` names the first thing and the command that fixes it.
  Every error ends with \`next:\` and the one command to run.
`;

export function formatRootHelp(cmd: Command, helper: Help): string {
  // Subcommands inherit this configuration, so anything that is not the root is handed straight
  // back to commander's own renderer. Calling `helper.formatHelp` here would recurse into this
  // function, because that is the property being overridden.
  if (cmd.parent !== null) {
    return Help.prototype.formatHelp.call(helper, cmd, helper);
  }

  const visible = cmd.commands.filter((c) => !(c as Command & { _hidden?: boolean })._hidden);
  const byName = new Map(visible.map((c) => [c.name(), c]));
  const grouped = new Set(GROUPS.flatMap((g) => g.commands));
  const width = Math.max(...visible.map((c) => c.name().length), 10) + 2;

  const lines: string[] = [];
  lines.push(`${cmd.name()} — ${cmd.description()}`);
  lines.push('');
  lines.push(`Usage: ${cmd.name()} [options] <command> [args]`);
  lines.push(QUICKSTART.replace(/^\n/, ''));

  for (const group of GROUPS) {
    const present = group.commands.filter((name) => byName.has(name));
    if (present.length === 0) continue;
    lines.push(`${group.title} — ${group.blurb}`);
    for (const name of present) {
      lines.push(`  ${name.padEnd(width)}${byName.get(name)!.description()}`);
    }
    lines.push('');
  }

  const ungrouped = visible.filter((c) => !grouped.has(c.name()));
  if (ungrouped.length > 0) {
    lines.push('Other');
    for (const c of ungrouped) {
      lines.push(`  ${c.name().padEnd(width)}${c.description()}`);
    }
    lines.push('');
  }

  lines.push('Options');
  for (const option of helper.visibleOptions(cmd)) {
    lines.push(`  ${helper.optionTerm(option).padEnd(width + 12)}${helper.optionDescription(option)}`);
  }
  lines.push('');
  lines.push(`Run \`${cmd.name()} <command> --help\` for the flags on any of them.`);
  lines.push(`Scripting? \`${cmd.name()} --help --json\` returns the whole tree in one call.`);
  lines.push('');

  return lines.join('\n');
}
