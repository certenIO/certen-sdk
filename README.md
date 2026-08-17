# CERTEN client libraries

Client libraries for the [CERTEN Gateway](https://gateway.kompendium.co/reference) — proof-gated
cross-chain execution on Accumulate.

**Documentation: <https://docs.kompendium.co>** — guides, authentication, errors, and the live API reference.

| Package | |
|---|---|
| [`@certen.io/sdk`](packages/sdk) | TypeScript client. Typed errors, automatic retries, auto-idempotency, and the proof-gated execution flow as one call. |
| [`@certen.io/cli`](packages/cli) | The `certen` command line. Add `--json` for a machine contract. |
| [`@certen.io/mcp`](packages/mcp) | MCP server for AI agents. Read-only by default; holds no signing key. |

```bash
npm install @certen.io/sdk
```

```ts
import { CertenClient } from '@certen.io/sdk';

const certen = new CertenClient({ apiKey: process.env.CERTEN_API_KEY! });

// Open a proof-gated contract call, sign it, submit the signature — one call.
const { intentId } = await certen.execute.contractCall({
  identityId, adiUrl: 'acc://seller-bot.acme', fromAddress: abstractAccount,
  chain: 'base-sepolia', chainId: 84532,
  contractCall: { target: escrobot, functionSignature: 'confirm(bytes32)', args: [orderId] },
  publicKey,
  sign: (hashHex) => ed25519Sign(hashHex),   // YOU hold the key
});

await certen.execute.wait(intentId);          // ~60–110s: real validator work
const proof = await certen.execute.proof(intentId);   // hand this to your counterparty
```

**Your key never reaches this code.** You pass a `sign` function; the SDK hands it bytes and takes back a
signature. It cannot act without you. That is the supported posture for anything carrying value.

---

## Documentation

The **[live API reference](https://gateway.kompendium.co/reference)** is generated from the running
gateway and is authoritative. When a document here and the spec disagree, the spec is right.

Task-shaped guides, in the order most people need them:

| | |
|---|---|
| [Onboard an identity](docs/guides/onboard-an-identity.md) | Creating the ADI that signs and holds. Everything else needs one. |
| [Sign while holding your own key](docs/guides/external-signing.md) | The pattern almost every integration uses. |
| [Proof-gate a contract call](docs/guides/proof-gated-contract-call.md) | Arbitrary contract functions — escrow, settlement, anything past a transfer. |
| [M-of-N panels](docs/guides/multisig-panel.md) | Arbitration, dual control, break-glass. |
| [Verify a proof](docs/guides/verify-a-proof.md) | Handing evidence to someone who should not have to trust you. |

Reference: [authentication](docs/authentication.md) · [errors](docs/errors.md) ·
[idempotency](docs/idempotency.md)

## Four things to know before you build

**Identity creation is asynchronous.** `identity.create` returns a `202` and provisioning continues. Poll
until the status is terminal and check `can_sign` before relying on it.

**Send an idempotency key on every POST.** The SDK does this for you. A network error is otherwise
indistinguishable from success, and a blind retry can open a second intent or burn identity quota.

**A proof cycle takes 60–110 seconds.** Real validator work, not a tunable delay. Do not wrap it in a
30-second timeout.

**`vote` is `approve` | `reject` | `abstain`** — a lowercase string, not a number, and not `accept`.

## Development

```bash
npm install          # workspaces: the CLI resolves @certen.io/sdk from packages/sdk
npm run build
npm test             # SDK 119, CLI 55, MCP 37 — no network, no key
npm run typecheck
```

### On Windows, trust the summary over npm's exit code

`npm test` here can exit 1 while printing `119 passed` and a clean summary, with no error output from
npm at all. It gets worse under load — measured on npm 10.9.2 / Node 22.14:

| invocation | exit 0 | tests |
|---|:--:|---|
| `node node_modules/vitest/vitest.mjs run` | 6/6 | 119/119 passing |
| `npm test` | 1/6 | 119/119 passing |
| `npm test`, with four CPU hogs running | 0/6 | 119/119 passing |

It is a load-sensitive race in npm's script runner, not a fault in the tests or the tools: the same
npm is clean in a scratch package and in a scratch workspaces monorepo, and `--loglevel=silly` stops
it reproducing. **CI runs on `ubuntu-latest` and is unaffected.**

Where a trustworthy exit code matters locally — a hook, a script, a release step — invoke the tool
directly instead of through npm:

```bash
node node_modules/vitest/vitest.mjs run    # from the repo root
node scripts/prepublish-check.mjs          # from a package dir: build + tests, real exit code
```

`prepublishOnly` uses that script for this reason. Its previous form, `npm run build && npm test`,
blocked a good release with a 105-byte log that ended mid-build — a false negative impossible to
diagnose from the output.

The SDK's requests are validated against a snapshot of the gateway's OpenAPI spec
(`packages/sdk/test/contract.test.ts`). That guard exists because three methods once shipped in a state
where they could not work — they sent bodies the API rejects — and a mock that answers 200 to anything will
never tell you the request was wrong.

The spec is vendored at [`spec/openapi.json`](spec/README.md) and is the single source of truth for the
contract fixture *and* the agent-facing docs. Refresh it and rebuild everything derived from it:

```bash
npm run spec:refresh   # the only step that touches the network
npm run agentgen       # rebuild the fixture, llms.txt and llms-full.txt
```

`npm run agentgen:check` runs in CI and fails if any generated artifact is out of date.

### Measuring, rather than asserting

Two claims about this project were repeatedly made and never checked: that every gateway operation
worth calling is reachable from a client, and that onboarding is fast. Both are now measured.

```bash
node scripts/coverage.mjs                  # which operations no client can reach
node scripts/measure-onboarding.mjs --url https://gateway.kompendium.co --key ck_live_...
node scripts/e2e-onboarding.mjs --url https://staging.example   # the whole journey, from nothing
```

**The end-to-end check** signs up with a freshly generated keypair, creates an identity, confirms the
trial credit covers new work, and — given `--contract` — executes a proof-gated call and verifies the
proof. It holds no credential: the key is generated per run and discarded, which is the entire reason
the keypair signup path exists. Every step asserts a PROPERTY rather than an exit code, because a run
that passed on five zero exits would pass against a gateway that created an identity which cannot
sign and a proof that does not verify — the two failures the journey exists to catch.
`packages/cli/test/e2e-script.test.ts` tests the checker itself against a stub that returns
plausible-but-wrong answers, since a green end-to-end run that cannot go red is worse than none.

**To exercise the proof cycle in CI**, four repository secrets are needed — without them the run
still passes and reports the proof step as *skipped*, never as passed:

| Secret | |
|---|---|
| `E2E_PROOF_IDENTITY` | A funded identity's uuid |
| `E2E_PROOF_FROM` | Its abstract account address on the target chain |
| `E2E_SIGNING_KEY` | The key file JSON that authorizes it |
| `E2E_SIGNING_KEY_NAME` | The name to store it under |

`E2E_SIGNING_KEY` is a real private key in CI, so make it a **dedicated** one: used for nothing else,
controlling a single testnet identity whose account holds a trivial balance. It authorizes transfers
from that account and nothing more. Keep that account topped up, or the proof step starts failing for
lack of gas rather than for a real regression.

It runs weekly via `.github/workflows/e2e-onboarding.yml`, and on demand through
`workflow_dispatch`. **It cannot pass until the gateway is deployed** — `/v1/signup/challenge` is one
of 22 operations this build calls that production does not yet serve.

**Every number an audit quotes** comes from one command, because the last one drifted:

```bash
node scripts/audit-numbers.mjs            # operations, coverage, error codes
node scripts/audit-numbers.mjs --tests    # also runs both suites and reads their totals
```

The consolidated friction audit stated 119 operations, 1225 gateway tests and 576 client tests; the
real figures were 125, 1253 and 589. Nothing was wrong when it was written — prose cannot notice that
the code moved, and a reader cannot tell a current number from a stale one. Paste this output and
name the command beside it: a number without a command that reproduces it is a claim, not a
measurement. It also warns when the vendored spec and the gateway's own spec disagree, which means
one of them was never refreshed.

**Coverage** was measured for a long time by a tool that matched paths as substrings, so a path in
a code *comment* counted as implemented — `POST /v1/oauth/token` was reported covered while the SDK
had no OAuth surface at all. Its replacement then missed every path behind a local helper function.
Both errors ran toward good news, which is the direction a coverage number always fails in.
`packages/sdk/test/coverage.test.ts` now pins the result against an explicit list of the operations
that are unreachable **on purpose**, each with a written reason, so a newly unreachable operation
fails the build instead of going unnoticed.

**Onboarding** runs the real CLI through a counting proxy and reports round trips and wall-clock per
step.

| Measured | Target | Result |
|---|---|---|
| Read path, 2026-08-17 | `gateway.kompendium.co` | **13 requests, 5.0s** — every step exit 0 |
| Read path + proof, 2026-08-17 | `gateway.kompendium.co` | **15 requests, 6.6s** — `--intent <id>` adds the proof read |
| Signup → signing identity, 2026-08-17 | `gateway.kompendium.co` | **46.9s**, unattended, from no credential at all |
| Proof cycle, 2026-08-17 | `gateway.kompendium.co` | **anchored**, receipt present — open, sign, submit, anchor, prove |

The read-path figure dropped from 14 requests to 13 the moment the gateway was deployed, because
`remaining_usd` now rides on the balance and the separate obligations read is gone. The previous
production run reported 14 requests / 5.5s **with two steps failing** — `GET /v1/pricing` and
`GET /v1/scopes` were not deployed. Earlier local figures (12 requests / 4.9s) were taken against a
gateway with every downstream absent and are a floor for reads, not a journey time.

The signup figure comes from `e2e-onboarding.mjs`: keypair signup, identity created and confirmed
able to sign, trial credit verified — with no human and no pre-existing credential.

**The proof cycle cannot run on the organization the script just created**, and that is a fact about
chains rather than a gap in the tooling: a brand-new abstract account holds no gas, so its execution
leg parks at `anchoring` forever. Somebody has to put testnet ETH in the account.

So the journey splits honestly. Signup and identity creation run **from nothing** — the part that was
impossible before keypair signup. The proof cycle runs against an identity that is kept funded:

```bash
node scripts/e2e-onboarding.mjs --url …   --proof-identity <uuid> --sign-with <local-key> --proof-from <abstract-account>
```

It uses a value transfer rather than a contract call: same proof-gated path — open, sign, submit,
anchor, prove — with no contract ABI to go stale. The proof is asserted **anchored and carrying a
receipt**, because a proof that exists and is not anchored is a claim about a claim.

Re-run both on each release and diff. A regression in round trips is invisible in code review and
obvious here.

## Working with AI coding agents

| | |
|---|---|
| [AGENTS.md](AGENTS.md) | Working **on** this repo: setup, build, test, layout, gotchas, and which commands need a human first. |
| [llms.txt](llms.txt) | Building **on** CERTEN: quickstart and the rules that decide whether your code works. |
| [llms-full.txt](llms-full.txt) | Building **on** CERTEN: the full API digest, generated from the spec. |
| [docs/CLI-CONTRACT.md](docs/CLI-CONTRACT.md) | The `certen --json` machine contract: envelope shape and exit codes. |

`llms.txt` and `llms-full.txt` are generated — edit the prose in
`tools/agentgen/templates/llms.head.md` and regenerate, rather than editing them directly.

## Releasing

Tag-driven, and nothing publishes until the packed tarball has been installed into a scratch project and
run. npm versions are immutable — a bad publish can only be superseded, never fixed.

**Deploy the gateway first.** The vendored spec is generated from the gateway's *source*, so the
entire offline suite can pass against a document describing an API that is not deployed yet. That is
the right trade — it lets the SDK be built before the gateway ships — but it means green tests are
not evidence that anything works against production. Where a release moves paths, publishing first
ships a client that 404s on every call to the moved routes.

```bash
npm run check:gateway                      # do the deployed operations cover this build?
CERTEN_API_URL=https://staging npm run check:gateway
```

`prepublish-check.mjs` runs this and refuses to publish when the deployment is provably behind. An
unreachable gateway warns instead of blocking — "no answer" is not the same as "out of date". Set
`CERTEN_SKIP_GATEWAY_CHECK=1` to override, deliberately.

Publish the three packages **together**. They are separately versioned and mutually dependent; an
SDK calling `/v1/webhooks/*` paired with an older CLI is a combination nobody tested.

```bash
cd packages/sdk && npm version minor
git tag sdk-v0.2.0 && git push --follow-tags
```

See [.github/workflows/release.yml](.github/workflows/release.yml). Publishing needs `NPM_TOKEN` as a
repository secret; never put a token in a local `.npmrc`.

## License

MIT
