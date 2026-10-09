import { describe, it, expect } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { sameText } = (await import(pathToFileURL(join(REPO_ROOT, 'tools', 'agentgen', 'lib', 'text.mjs')).href)) as {
  sameText: (a: string | null, b: string | null) => boolean;
};

describe('agentgen compares generated artifacts as text', () => {
  it('treats CRLF and LF checkouts of the same content as equal', () => {
    expect(sameText('a\r\nb\r\n', 'a\nb\n')).toBe(true);
  });
  it('still reports a real difference, and a missing file, as different', () => {
    expect(sameText('a\nb\n', 'a\nc\n')).toBe(false);
    expect(sameText(null, 'a\n')).toBe(false);
  });
});
