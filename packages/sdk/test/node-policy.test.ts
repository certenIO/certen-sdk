import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { checkNodePolicy } = (await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'check-node-policy.mjs')).href)) as {
  checkNodePolicy: (root?: string, today?: Date) => string[];
};

/** A copy of the files the policy reads, so a test can break one rule at a time. */
function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'node-policy-'));
  cpSync(join(REPO_ROOT, '.github'), join(root, '.github'), { recursive: true });
  cpSync(join(REPO_ROOT, '.devcontainer'), join(root, '.devcontainer'), { recursive: true });
  cpSync(join(REPO_ROOT, '.nvmrc'), join(root, '.nvmrc'));
  cpSync(join(REPO_ROOT, 'package.json'), join(root, 'package.json'));
  for (const pkg of ['sdk', 'cli', 'mcp', 'verify']) {
    mkdirSync(join(root, 'packages', pkg), { recursive: true });
    cpSync(join(REPO_ROOT, 'packages', pkg, 'package.json'), join(root, 'packages', pkg, 'package.json'));
  }
  return root;
}
const edit = (file: string, from: string | RegExp, to: string): void => {
  const text = readFileSync(file, 'utf8');
  expect(text).toMatch(from);
  writeFileSync(file, text.replace(from, to));
};

describe('one Node policy for the whole repository', () => {
  it('holds in this checkout: .nvmrc, engines, workflows and devcontainer agree', () => {
    expect(checkNodePolicy(REPO_ROOT)).toEqual([]);
  });

  it('refuses a CI matrix that tests an end-of-life line', () => {
    const root = scratchRepo();
    try {
      edit(join(root, '.github/workflows/ci.yml'), 'node: ["22", "24"]', 'node: ["20", "22", "24"]');
      expect(checkNodePolicy(root).join('\n')).toMatch(/matrix \[20, 22, 24\] must be exactly the supported LTS lines/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a CI matrix that skips a supported LTS line', () => {
    const root = scratchRepo();
    try {
      edit(join(root, '.github/workflows/ci.yml'), 'node: ["22", "24"]', 'node: ["24"]');
      expect(checkNodePolicy(root).join('\n')).toMatch(/matrix \[24\] must be exactly/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a job that hard-codes a Node version instead of reading .nvmrc', () => {
    const root = scratchRepo();
    try {
      edit(join(root, '.github/workflows/release.yml'), 'node-version-file: .nvmrc', 'node-version: "20"');
      expect(checkNodePolicy(root).join('\n')).toMatch(/release\.yml: node-version must come from a matrix or \.nvmrc/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses engines that disagree across packages, or a floor that is end of life', () => {
    const root = scratchRepo();
    try {
      edit(join(root, 'packages/mcp/package.json'), '"node": ">=22"', '"node": ">=20"');
      const out = checkNodePolicy(root).join('\n');
      expect(out).toMatch(/floors disagree/);
    } finally { rmSync(root, { recursive: true, force: true }); }
    const root2 = scratchRepo();
    try {
      for (const f of ['package.json', 'packages/sdk/package.json', 'packages/cli/package.json', 'packages/mcp/package.json', 'packages/verify/package.json']) {
        edit(join(root2, f), '"node": ">=22"', '"node": ">=18"');
      }
      expect(checkNodePolicy(root2).join('\n')).toMatch(/engines floor 18 is not a supported LTS line/);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  });

  it('refuses a .nvmrc that is not an exact version on a supported line', () => {
    const root = scratchRepo();
    try {
      writeFileSync(join(root, '.nvmrc'), '24\n');
      expect(checkNodePolicy(root).join('\n')).toMatch(/must pin an exact version/);
      writeFileSync(join(root, '.nvmrc'), '20.19.0\n');
      expect(checkNodePolicy(root).join('\n')).toMatch(/Node 20 is not a supported LTS line/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a devcontainer that runs a different Node than .nvmrc', () => {
    const root = scratchRepo();
    try {
      edit(join(root, '.devcontainer/devcontainer.json'), 'typescript-node:24-bookworm', 'typescript-node:1-22-bookworm');
      expect(checkNodePolicy(root).join('\n')).toMatch(/devcontainer image runs Node 22 but \.nvmrc is 24/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('turns a line end-of-life when its date passes, so the matrix must be updated then', () => {
    expect(checkNodePolicy(REPO_ROOT, new Date('2027-05-01')).join('\n')).toMatch(/Node 22|engines floor 22/);
  });
});
