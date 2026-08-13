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
| `npm test --workspace packages/sdk` | SDK — 83 tests | no |
| `npm test --workspace packages/cli` | CLI — 40 tests (14 are CLI-contract conformance) | no |
| `npm test --workspace packages/mcp` | MCP — 37 tests | no |
| `npm test` | all three via `--workspaces` | no |
| `npm run typecheck` | `tsc --noEmit` in all three | no |

Nothing in the suite reaches the network or needs an API key. If a test wants either, that is a bug in
the test.

**Run the three per-workspace commands when you need certainty.** `npm run <script> --workspaces`
stops at the first workspace that reports a failure, so one spurious non-zero exit silently skips the
rest — and on some Windows setups `npm test` returns 1 even when vitest itself exits 0 and every test
passed, which makes the root command look like a failure and run only the SDK suite. CI invokes each
suite by name for exactly this reason. If `npm test` at the root reports a failure with no failing
test in the output, this is what you are looking at.

**On Windows, build with `node scripts/build-all.mjs`, not `npm run build`.** Measured on Windows
npm: the root build dies partway through the SECOND package, exits 1, truncates its own log mid-line,
and leaves `packages/cli/dist` and `packages/mcp/dist` absent — with no error explaining any of it.
Every subsequent `vitest run` then executes against a missing `dist` and reports dozens of failures
that have nothing to do with the code. Running the same script directly builds all three and exits 0.

If a test run suddenly fails in bulk with import or type errors, check that all three `dist`
directories exist before believing any of it.

(The per-package scripts used to be `node -e "rmSync('dist')" && tsc`. The `&&` never ran under
Windows npm, so `npm run build` deleted `dist/` and compiled nothing — a build command that made the
package unimportable. Both the root and per-package scripts now route through node. Never chain
commands with `&&` inside an npm script in this repo.)

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
