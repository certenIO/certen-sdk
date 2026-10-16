import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { buildProgram } from '../src/index.js';

/**
 * `certen --help` for someone who has just installed it (PLAN W7).
 *
 * The question that person has is "what do I type first", and the answer is five commands: setup, send, call, status, receipt. They lead the
 * help, the quickstart is the golden path (setup, send, receipt), and the plumbing goes under an "Advanced" heading. NOTHING is hidden or removed:
 * a command that is not on the page might as well not exist, and `--help --json` (a different serialisation) is not a substitute for a person.
 */

const program = buildProgram();
const help = program.helpInformation();
const lines = help.split('\n');

/** The command names listed under a group heading, in the order shown. */
function groupOf(title: string): string[] {
  const start = lines.findIndex((l) => l.startsWith(`${title} `) || l === title);
  if (start < 0) return [];
  const names: string[] = [];
  for (let i = start + 1; i < lines.length && lines[i]!.trim() !== ''; i++) names.push(lines[i]!.trim().split(/\s+/)[0]!);
  return names;
}

function headings(): string[] {
  // A heading is a non-indented line followed by indented command rows.
  const out: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i]! !== '' && !lines[i]!.startsWith(' ') && lines[i + 1]!.startsWith('  ') && / — /.test(lines[i]!)) out.push(lines[i]!.split(' — ')[0]!);
  }
  return out;
}

describe('root help: the five commands lead', () => {
  it('the first group is the five verbs, in the order of the journey', () => {
    expect(headings()[0]).toBe('Start here');
    expect(groupOf('Start here')).toEqual(['setup', 'send', 'call', 'status', 'receipt']);
  });

  it('the quickstart is setup, send, receipt: the golden path, and it appears before any list of commands', () => {
    const quick = help.slice(0, help.indexOf('Start here'));
    const setup = quick.indexOf('certen setup');
    const send = quick.indexOf('certen send ');
    const receipt = quick.indexOf('certen receipt');
    expect(setup).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(setup);
    expect(receipt).toBeGreaterThan(send);
    // The old first action was a contract call against a placeholder address. It is still mentioned, as the other thing you can do, after the path.
    expect(quick.indexOf('0xContract')).toBeGreaterThan(receipt);
    expect(quick).toMatch(/certen send 0\.0001 ETH --to 0x/);
  });

  it('says where to go when stuck, and that every error ends with the command to run', () => {
    expect(help).toMatch(/certen status/);
    expect(help).toMatch(/next:/);
  });
});

describe('root help: nothing is hidden or removed', () => {
  const registered = program.commands.map((c) => c.name());

  it('lists every registered command', () => {
    const missing = registered.filter((name) => !new RegExp(`^\\s{2}${name}\\s`, 'm').test(help));
    expect(missing).toEqual([]);
  });

  it('lists each command exactly once', () => {
    const rows = lines.filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().split(/\s+/)[0]!).filter((n) => registered.includes(n));
    const twice = rows.filter((n, i) => rows.indexOf(n) !== i);
    expect(twice).toEqual([]);
  });

  it('needs no "Other" catch-all: every command has a home', () => {
    expect(headings()).not.toContain('Other');
  });

  it('keeps the commands that existed before, including the ones the new journey replaces', () => {
    for (const name of ['init', 'login', 'signup', 'auth', 'doctor', 'whoami', 'tx', 'proof', 'identity', 'keys', 'pending', 'governance', 'balance', 'fund', 'receipts', 'admin', 'orgs', 'oauth-clients']) {
      expect(registered, name).toContain(name);
      expect(help, name).toMatch(new RegExp(`^\\s{2}${name}\\s`, 'm'));
    }
  });
});

describe('root help: plumbing is under Advanced', () => {
  it('has an Advanced group holding the plumbing', () => {
    const advanced = groupOf('Advanced');
    for (const name of ['tx', 'admin', 'oauth-clients', 'orgs']) expect(advanced, name).toContain(name);
  });

  it('keeps the five verbs, and the commands a first transaction needs, out of Advanced', () => {
    const advanced = groupOf('Advanced');
    for (const name of ['setup', 'send', 'call', 'status', 'receipt', 'watch', 'gas', 'doctor']) expect(advanced, name).not.toContain(name);
  });

  it('Advanced is the last group before the options', () => {
    const order = headings();
    expect(order[order.length - 1]).toBe('Advanced');
  });
});

describe('subcommand help', () => {
  const find = (...path: string[]): Command => {
    let cmd: Command = program;
    for (const p of path) cmd = cmd.commands.find((c) => c.name() === p) as Command;
    return cmd;
  };

  it('tx create lists the plumbing options under their own heading, and still lists them', () => {
    const text = find('tx', 'create').helpInformation();
    const heading = text.indexOf('Advanced options');
    expect(heading).toBeGreaterThan(-1);
    const advanced = text.slice(heading);
    for (const flag of ['--from-chain', '--contract-address', '--signer-key-page', '--signer-public-key']) {
      expect(advanced, flag).toContain(flag);
      expect(text.slice(0, heading), `${flag} must not be in the main options`).not.toContain(flag);
    }
    // The flags a transfer needs stay where a first-time reader looks.
    for (const flag of ['--to-chain', '--to', '--amount', '--sign-with', '--wait']) expect(text.slice(0, heading), flag).toContain(flag);
  });

  it('tx create still accepts every one of them, with the same default', () => {
    const create = find('tx', 'create');
    for (const flag of ['--from-chain', '--contract-address', '--signer-key-page', '--signer-public-key']) {
      expect(create.options.some((o) => o.long === flag), flag).toBe(true);
    }
    expect(create.options.find((o) => o.long === '--from-chain')!.defaultValue).toBe('accumulate');
  });

  it('other subcommand help is commander\'s own, untouched', () => {
    const text = find('keys').helpInformation();
    expect(text).toMatch(/Usage: certen keys \[options\] \[command\]/);
    expect(text).not.toContain('Start here');
  });
});
