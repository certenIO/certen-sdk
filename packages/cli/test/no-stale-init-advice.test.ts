import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * No message tells a person to run `certen init` as the way to start.
 *
 * `init` is still a command, with its own meaning (it exits 0 once its steps are done, ready or not), and it keeps every flag. But `setup` does everything `init`
 * does and then checks that the account can actually act, and says what is still in the way; since Phase 3 it is the command the docs and `--help` lead with.
 * Many error messages and hints still sent people to `init` ("Create one with: certen init", "run: certen init"), advice from before `setup` existed. Each is
 * valid and each is a step behind, and `next:` (Phase 5) cannot fix a sentence in the middle of a message.
 *
 * This reads every string the CLI source can print, with the TypeScript compiler (so comments, which may say anything, are not looked at), and fails on any that
 * sends a person to `certen init`. The one file allowed to mention it is `init`'s own command, which talks about itself.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
/** The command that is allowed to name itself. */
const OWN = new Set(['commands/init.ts']);
const ADVICE = /\bcerten init\b/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}

interface Hit { file: string; line: number; text: string }

function stringsWithInitAdvice(): Hit[] {
  const hits: Hit[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, '/');
    if (OWN.has(rel)) continue;
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const check = (node: ts.Node, text: string): void => {
      if (ADVICE.test(text)) hits.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: text.trim().slice(0, 140) });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) check(node, node.text);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

describe('no user-facing message sends a person to `certen init`', () => {
  it('finds none outside init\'s own command', () => {
    const hits = stringsWithInitAdvice();
    expect(hits.map((h) => `${h.file}:${h.line}  ${h.text}`)).toEqual([]);
  });

  it('would find one (the scan itself works)', () => {
    // A guard that cannot fail proves nothing: feed the same detector a string it must catch, and one it must not.
    const sf = ts.createSourceFile('x.ts', 'const a = `Create one with: certen init`; const b = "run certen setup"; // certen init in a comment', ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && ADVICE.test(n.text)) found.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(found).toEqual(['Create one with: certen init']);
  });
});

describe('the advice that replaced it', () => {
  it('names `certen setup`, including the key form signup hands on to', () => {
    const read = (f: string): string => readFileSync(join(SRC, f), 'utf8');
    expect(read('commands/signup.ts')).toContain('certen setup --key ${opts.withKey}');
    expect(read('commands/status.ts')).toContain('Create one with: certen setup');
    expect(read('identity-ref.ts')).toContain('create one with: certen setup');
    expect(read('context.ts')).toContain('create one with: certen setup');
    expect(read('commands/context.ts')).toContain('(certen setup makes one)');
    expect(read('commands/doctor.ts')).toContain('fix: `certen setup   (or: certen identity create');
  });
});
