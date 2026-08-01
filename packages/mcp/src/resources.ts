import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Documentation exposed as MCP resources.
 *
 * This is how a client gets CERTEN's semantics — the retry rules, the 60-110s proof cycle, the
 * lowercase `vote` — without a web fetch and without guessing. The same files the repo already
 * generates for `llms.txt` consumers, served over the protocol.
 */

export interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  /** Repo-relative path, resolved from the built package location. */
  file: string;
}

// dist/ -> packages/mcp -> packages -> repo root
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');

export const RESOURCES: ResourceDef[] = [
  {
    uri: 'certen://docs/llms.txt',
    name: 'CERTEN quickstart and rules',
    description:
      'Start here. Canonical usage plus the rules that decide whether your code works: idempotency, '
      + 'the 60-110s proof cycle, retryable error codes, and the lowercase vote values.',
    mimeType: 'text/markdown',
    file: 'llms.txt',
  },
  {
    uri: 'certen://docs/llms-full.txt',
    name: 'CERTEN full API digest',
    description:
      'Every SDK method with its endpoint, request fields and response shape, plus the error catalog '
      + 'and the list of gateway endpoints that have no SDK method.',
    mimeType: 'text/markdown',
    file: 'llms-full.txt',
  },
  {
    uri: 'certen://docs/errors',
    name: 'Error catalog',
    description: 'Every error code, its HTTP status, whether it is retryable, and what to do about it.',
    mimeType: 'text/markdown',
    file: 'docs/errors.md',
  },
  {
    uri: 'certen://docs/cli-contract',
    name: 'CLI JSON contract',
    description: 'The `certen --json` envelope shape and exit codes, for driving the CLI instead of the API.',
    mimeType: 'text/markdown',
    file: 'docs/CLI-CONTRACT.md',
  },
  {
    uri: 'certen://guides/onboard-an-identity',
    name: 'Guide: onboard an identity',
    description: 'Creating the ADI that signs and holds. Everything else needs one.',
    mimeType: 'text/markdown',
    file: 'docs/guides/onboard-an-identity.md',
  },
  {
    uri: 'certen://guides/external-signing',
    name: 'Guide: sign while holding your own key',
    description: 'The pattern almost every integration uses, and the one this server assumes.',
    mimeType: 'text/markdown',
    file: 'docs/guides/external-signing.md',
  },
  {
    uri: 'certen://guides/proof-gated-contract-call',
    name: 'Guide: proof-gate a contract call',
    description: 'Arbitrary contract functions — escrow, settlement, anything past a transfer.',
    mimeType: 'text/markdown',
    file: 'docs/guides/proof-gated-contract-call.md',
  },
  {
    uri: 'certen://guides/multisig-panel',
    name: 'Guide: M-of-N panels',
    description: 'Arbitration, dual control, break-glass.',
    mimeType: 'text/markdown',
    file: 'docs/guides/multisig-panel.md',
  },
  {
    uri: 'certen://guides/verify-a-proof',
    name: 'Guide: verify a proof',
    description: 'Handing evidence to someone who should not have to trust you.',
    mimeType: 'text/markdown',
    file: 'docs/guides/verify-a-proof.md',
  },
];

/**
 * Resolve a resource's text.
 *
 * Docs are looked up in the repo checkout first, then inside the packaged copy — a published
 * package has no repo above it.
 */
export function readResource(uri: string): { text: string; mimeType: string } {
  const def = RESOURCES.find((r) => r.uri === uri);
  if (!def) throw new Error(`unknown resource: ${uri}`);

  // The repo checkout when running from source; `bundled/` when installed from a tarball, where
  // scripts/bundle-docs.mjs has copied these in at prepack time.
  for (const base of [REPO_ROOT, join(PKG_ROOT, 'bundled')]) {
    const path = join(base, def.file);
    if (existsSync(path)) return { text: readFileSync(path, 'utf8'), mimeType: def.mimeType };
  }
  throw new Error(`resource ${uri} is unavailable in this installation (${def.file} not found)`);
}

/** Only advertise what can actually be read, so a client never gets a 'listed but missing' resource. */
export function availableResources(): ResourceDef[] {
  return RESOURCES.filter((r) => {
    try {
      readResource(r.uri);
      return true;
    } catch {
      return false;
    }
  });
}
