# certen-sdk — repository guide for agents

TypeScript client libraries for the [CERTEN Gateway](https://gateway.kompendium.co/reference) —
proof-gated cross-chain execution on Accumulate. An npm workspaces monorepo publishing
`@certen.io/sdk` (v0.3.1), `@certen.io/cli` (v0.4.0) and `@certen.io/mcp` (v0.1.0).

> Building **on** CERTEN rather than **on this SDK**? You want `llms.txt` (quickstart + rules) and
> `llms-full.txt` (full API digest). This file is about working on the SDK itself.

## Setup

Toolchain: **Node >= 18** (`engines`). CI runs the suite on 18, 20 and 22.

```bash
npm install     # workspaces: the CLI resolves @certen.io/sdk from packages/sdk
```

## Build

```bash
npm run build   # tsc in both packages
```

**Build the SDK before typechecking the CLI.** The CLI imports `@certen.io/sdk` types from that
package's `dist/`, which is gitignored — so on a fresh clone the CLI does not typecheck until the SDK
has been built once. If you see the CLI failing to resolve SDK types, you skipped this.

## Test

| Command | Covers | Needs network |
|---|---|:--:|
| `node scripts/test-all.mjs` | all three, one vitest process — 409 tests | no |
| `node scripts/typecheck-all.mjs` | `tsc --noEmit` in all three | no |
| `node scripts/build-all.mjs` | compiles all three, sdk first | no |
| `npm test` / `npm run typecheck` / `npm run build` | delegate to the three above | no |
| `npm test --workspace packages/<pkg>` | one package, as CI invokes it | no |

The npm forms and the `node scripts/*` forms do the same work; the npm ones are what CI invokes. If
npm ever starts returning immediately with exit 1 while the work continues in the background, read
the Windows note below before believing any test result.

Nothing in the suite reaches the network or needs an API key. If a test wants either, that is a bug in
the test.

**Run the three per-workspace commands when you need certainty.** `npm run <script> --workspaces`
stops at the first workspace that reports a failure, so one spurious non-zero exit silently skips the
rest — and on some Windows setups `npm test` returns 1 even when vitest itself exits 0 and every test
passed, which makes the root command look like a failure and run only the SDK suite. CI invokes each
suite by name for exactly this reason. If `npm test` at the root reports a failure with no failing
test in the output, this is what you are looking at.

**If `npm run <anything>` starts returning exit 1 immediately while the work carries on in the
background, suspect a corrupt global npm install.** That happened here, and it cost a lot of time
before it was identified, so the signature is worth recording.

Symptoms: `npm run build` returns after ~3s with exit 1 while `tsc` is still compiling; a check made
straight afterwards finds a half-written `dist/` and every later `vitest run` reports dozens of
import and type errors that have nothing to do with the code. npm's own log stops at the script
banner and never prints its `verbose exit` epilogue.

Cause: two npm copies exist on a typical Windows machine — the one bundled with Node, and a global
one under `%APPDATA%
pm
ode_modules
pm`. npm's shim prefers the global copy whenever one is
present, so a corrupt global install captures every `npm run` while `npm --version` still answers
normally. Both copies reported 10.9.2 with identical dependency trees and identical `npmrc` files;
only their behaviour differed:

| | waits for its child | exit code |
|---|---|---|
| bundled | yes | correct |
| corrupt global | no — gives up after ~2–3s | always 1 |

Diagnosing it without changing anything: run the same script through each copy directly,
`node "<path to that copy>/bin/npm-cli.js" run <script>`, and compare. Or set
`npm_config_prefix` to a directory containing no npm, which forces the shim onto the bundled copy —
if the problem disappears, the global install is the culprit.

Fix: `npm install -g npm@<version matching your Node>` to replace it. `npm@latest` may refuse on an
older Node, and that refusal is clean — it installs nothing. Repaired on 2026-08-13 by reinstalling
npm@10.9.2; `npm run build`, `npm run typecheck` and `npm test` have all returned correct exit codes
since.

The `node scripts/*` forms remain the most direct way to run these, and are what to reach for if npm
ever looks suspect again:

```
node scripts/build-all.mjs
node scripts/test-all.mjs
node scripts/typecheck-all.mjs
```

Two things were blamed along the way and should not be: `&&` inside an npm script, and
`npm run <x> --workspaces`. Both were tested after the repair and both work correctly. They appeared
broken only because the corrupt npm returned early from every script, which makes a chained command
look like it never ran and makes `--workspaces` stop after the first package. The repo now uses
`scripts/build-all.mjs`, `test-all.mjs` and `typecheck-all.mjs` for smaller, genuine reasons — stated
in each file — not because the npm forms are unsafe.

`packages/cli/test/keystore.test.ts` takes ~6 seconds on its own — it runs real scrypt key
derivation. `conformance.test.ts` takes ~11s because it spawns the built CLI as a subprocess per
case. Neither is hung.

The CLI conformance suite needs `packages/cli/dist` — **build before testing the CLI**, or it fails
with a message telling you so.

## Lint & format

**There is no linter and no formatter in this repo.** No ESLint, no Prettier, no Biome. `npm run
typecheck` is the only static gate. Do not invent `npm run lint`; it does not exist. Match the
surrounding style by reading the file you are editing — it is consistent, just not enforced by a tool.

## Generated artifacts

`spec/openapi.json` is a vendored copy of the gateway's OpenAPI document and is the single source of
truth for three generated files:

- `packages/sdk/test/fixtures/openapi-contract.json` — what the contract test checks requests against
- `llms.txt`, `llms-full.txt` — agent-facing API docs

```bash
npm run spec:refresh   # the ONLY step that touches the network — refetch spec/openapi.json
npm run agentgen       # rebuild everything derived from the spec
npm run agentgen:check # CI gate: fails if any artifact is out of date
```

**Do not hand-edit any generated file.** Each carries a header saying so. Editing prose in `llms.txt`
means editing `tools/agentgen/templates/llms.head.md` and regenerating. Commit a spec refresh and the
regenerated artifacts in the same commit, so an API change is visible as a doc change.

`agentgen` also fails if the SDK calls an endpoint that does not exist in the vendored spec — which
catches both a wrong path in the SDK and a stale spec.

## Layout

```
packages/sdk/      @certen.io/sdk — the client. resources/ mirrors the API; execute.ts is the composite flow
packages/cli/      @certen.io/cli — the `certen` command
packages/mcp/      @certen.io/mcp — MCP server. protocol.ts is a direct JSON-RPC implementation (no deps)
spec/openapi.json  vendored gateway spec; source of truth for everything generated
tools/agentgen/    the generator + drift gate
docs/guides/       task-shaped guides
```

## MCP server

`packages/mcp` exposes the gateway to AI agents. Two rules hold and are enforced by
`packages/mcp/test/tiers.test.ts` — treat them as invariants, not preferences:

- **It never signs and never accepts key material.** A test asserts no tool parameter is even named
  like a private key. If you add a tool, it takes a hash or a signature, never a key.
- **Write tools are not registered unless `CERTEN_MCP_ALLOW_WRITES=1`**, and every *mutating* tool
  additionally requires `confirm: true`. `tier` controls visibility; `mutates` controls confirmation.
  They are separate fields because the admin read tools are gated but have nothing to confirm.

A new tool must declare the gateway endpoint it reaches; a test checks that endpoint exists in the
vendored spec and that no read-tier tool points at a write-only one.

## CLI

Run it from the checkout after building:

```bash
node packages/cli/dist/index.js --json identity get <id>
```

`--json` is a **machine contract**: exactly one envelope object on stdout, everything human on stderr,
and exit codes `0` ok / `1` operation failed / `2` usage error / `3` gateway unreachable. Changing that
output shape is a contract change — `packages/cli/test/conformance.test.ts` enforces it, and
`docs/CLI-CONTRACT.md` is the spec. Table output (no `--json`) is for humans and is not a contract.

## Gotchas

- **`dist/` is gitignored, so a stale build lies to you.** After changing SDK source, rebuild before
  testing the CLI against it. A CLI test that fails inexplicably usually means `dist/` is old.
- **`DEFAULT_BASE_URL` must be a host that actually serves the API.** It was once
  `https://api.certen.io`, which resolves to the marketing site, so every call returned HTML and the
  failure read as a broken SDK. Point it only at a host whose `/v1/health` answers.
- **A proof cycle is 60–110 seconds of real validator work.** `execute.wait()` budgets 360s. This is
  not a delay that can be tuned away — do not "fix" a slow test by shortening the wait, and do not wrap
  the call in a 30-second timeout.
- **`identity.create` returns `202` and keeps provisioning.** Poll until the status is terminal and
  `can_sign` is true before relying on the identity.
- **`vote` is `approve` | `reject` | `abstain`** — lowercase string, not a number, not `accept`.
- **Amounts are base units as strings.** A JSON number loses precision past 2^53.
- **A fresh identity's abstract account has a zero balance.** A value transfer from it is accepted,
  signed and submitted, then parks at `anchoring` forever because the execution leg cannot run on
  chain. Fund it first. This is the most likely reason a hand-rolled end-to-end test "hangs" — the
  API layer is behaving correctly and nothing reports the real cause.
- **`contract_addresses` is an object keyed by role**, not a list of addresses, and it identifies the
  CERTEN deployment rather than your call target. Omit it; the gateway defaults it correctly.
- **The contract fixture pins property TYPES as well as names.** A name-only contract answers "may I
  send this key" but never "in what shape" — which is how `contract_addresses` shipped as an array
  against an object schema and broke every `execute.contractCall`. If you add a request field, the
  fixture records its type and `contract.test.ts` enforces it.
- **The config permission check is POSIX-only.** Windows has no POSIX mode bits, so `chmod` is a no-op
  and `statSync().mode` reports a synthesized value. Guard any new permission logic by platform.
- **The gateway is much larger than the SDK.** It exposes 106 operations; the SDK wraps 24 of them.
  Before adding a method, check the closing section of `llms-full.txt` for the real endpoint — and do
  not assume an SDK method exists just because the endpoint does.

## Permitted commands

Safe to run unattended: `npm install`, `npm run build`, `npm test`, `npm run typecheck`,
`npm run agentgen`, `npm run agentgen:check`, and any read-only git command.

**Require a human first:**

- **Anything that moves value or authorizes execution** — `execute.contractCall`, `execute.transfer`,
  `execute.cosign`, `sign.*`, `governance.submitSignature`, `transaction.submitSignature`. These
  authorize real on-chain execution against real funds. A test double is fine; a live gateway is not.
- **Anything touching credentials** — `admin.createApiKey`, `admin.rotateApiKey`, `admin.revokeApiKey`,
  writing to `~/.certen/config.json`, or touching the OS keyring.
- **Publishing** — `npm publish`, `npm version`, pushing a `sdk-v*` / `cli-v*` tag. npm versions are
  immutable: a bad publish can only be superseded, never fixed.
- **`npm run spec:refresh`** — it reaches the network and rewrites the source of truth for every
  generated artifact.
- Rewriting git history, force-pushing, or changing CI secrets.

Never create a `.npmrc` in this repo. It is where npm auth tokens land; publishing uses CI with
`NPM_TOKEN` as a repository secret.

## Before you commit

```bash
npm run build && npm run typecheck && npm test && npm run agentgen:check
```
