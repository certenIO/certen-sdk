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
 * The order here is the order of the journey, not of importance. Anything not listed still
 * appears, under "Other" — a command must never become invisible because someone added it
 * without touching this file.
 */
const GROUPS: Group[] = [
  {
    title: 'Get started',
    blurb: 'from nothing to a working setup',
    commands: ['login', 'signup', 'init', 'chains', 'auth', 'keys', 'doctor', 'whoami'],
  },
  {
    title: 'Build',
    blurb: 'identities, and the work they authorize',
    commands: ['identity', 'call', 'tx', 'proof'],
  },
  {
    title: 'Approve',
    blurb: 'multi-party signing',
    commands: ['pending', 'governance'],
  },
  {
    title: 'Money',
    blurb: 'what it costs and how to pay',
    commands: ['pricing', 'balance', 'quote', 'fund', 'payers'],
  },
  {
    title: 'Audit',
    blurb: 'what you were charged, and proof of it',
    commands: ['ledger', 'receipts', 'verify'],
  },
  {
    title: 'Operate',
    blurb: 'across every identity and key',
    commands: ['portfolio', 'webhooks', 'oauth-clients', 'admin', 'scopes', 'errors'],
  },
];

const QUICKSTART = `
  From nothing to a proof:

    certen login                               # approve this machine in the portal
    certen init                                # key, identity, funding — all checked
    certen call --identity <id> --chain base-sepolia --to 0xContract \\
        --fn 'confirm(bytes32)' --arg 0x... --sign-with dev --wait
    certen proof get <intent-id>               # the evidence, to hand over

  Stuck? Run: certen doctor
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
