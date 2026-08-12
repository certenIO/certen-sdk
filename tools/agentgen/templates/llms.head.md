# CERTEN TypeScript SDK

> Proof-gated cross-chain execution on Accumulate. Package: `@certen.io/sdk` (v{{SDK_VERSION}}).

## Install
```
npm install @certen.io/sdk
```
Import: `import { CertenClient } from '@certen.io/sdk'`

## Canonical usage
Open a proof-gated intent, sign it, submit the signature — one call. Then wait, then take the proof.
```ts
const certen = new CertenClient({ apiKey: process.env.CERTEN_API_KEY! });

const { intentId } = await certen.execute.contractCall({
  identityId, adiUrl: 'acc://seller-bot.acme', fromAddress: abstractAccount,
  chain: 'ethereum-sepolia', chainId: 11155111,
  contractCall: { target, functionSignature: 'confirm(bytes32)', args: [orderId] },
  publicKey,
  sign: (hashHex) => ed25519Sign(hashHex),   // YOU hold the key
});

await certen.execute.wait(intentId);                  // ~60–110s: real validator work
const proof = await certen.execute.proof(intentId);   // hand this to your counterparty
```

## Rules
- **Your key never reaches this SDK.** You pass a `sign` function; it gets bytes and returns a signature.
  Sign the RAW BYTES of the hex string — do not hash it again, and do not sign the ASCII of the hex.
- **Every POST carries an Idempotency-Key.** The SDK adds one for you. A network error is otherwise
  indistinguishable from success, and a blind retry opens a SECOND intent — on a transfer, that is paying
  twice. Do not disable `autoIdempotencyKey` on anything carrying value.
- **A proof cycle takes 60–110 seconds.** Real validator work, not a tunable delay. `execute.wait()`
  budgets 360s by default. Do not wrap it in a 30-second timeout; it will always fire.
- **Identity creation is asynchronous.** `identity.create` returns `202` and provisioning continues. Poll
  `identity.get` until the status is terminal and `can_sign` is true before you try to sign with it.
- **`vote` is `approve` | `reject` | `abstain`** — lowercase string, not a number, not `accept`. It is folded
  into the signature preimage, so it is fixed when signing data is created: you cannot request signing data
  and pick the vote afterwards.
- **Amounts are base units as STRINGS.** A JSON number loses precision past 2^53.
- **A new identity's abstract account holds nothing.** `identity.create` provisions an abstract
  account per linked chain, but with a zero balance. An intent that moves value from it is accepted,
  signed and submitted normally — and then sits at `anchoring` forever, because the execution leg
  cannot run on chain. **Fund the abstract account before transferring value.** Nothing in the API
  response tells you this; the intent simply never reaches a terminal state.
- **Any chain the gateway lists works.** `GET /v1/chains` returns them (ethereum-sepolia,
  base-sepolia, arbitrum-sepolia, optimism-sepolia, polygon-amoy, and more). Chain names and
  `chainId` are passed straight through — there is nothing Ethereum-specific in this SDK.
- **`contract_addresses` is an OBJECT, not a list**, and you almost never set it. It names the CERTEN
  deployment (`anchor`, `abstractAccount`, …), not your call target; the gateway supplies the right
  defaults. Passing an array is rejected with `/contract_addresses must be object`.
- **Errors are typed:** catch `CertenError` and branch on `.code`. **Retry ONLY the codes whose `retryable`
  is yes** — `RATE_LIMIT_EXCEEDED`, `INTERNAL_ERROR`, `BAD_GATEWAY`, `NETWORK_ERROR`. The SDK already retries
  those with backoff, so a second retry loop around it is wrong. Every other code is a condition that will
  not change on its own. Full table: the **Error catalog** in `llms-full.txt`.
- **`execute.proof()` falls back to the Accumulate merkle receipt** when an intent has no cross-chain
  `proof_id`. That is the normal case for governance and authorization transactions — an empty lookup there
  is not a bug.

## Diagnosing a setup
`client.doctor()` returns an ordered list of checks and never throws for a failed one. Run it before
concluding that something is broken in your own code — most of what it catches is invisible until it
surfaces somewhere unrelated:
```ts
const report = await certen.doctor();
if (!report.ok) console.error(report.checks.filter(c => c.status === 'fail'));
```
It catches, in order: gateway unreachable · credential rejected (401) or merely unscoped (403) · no active
identity · **an abstract account with no gas**, which makes a value transfer park at `anchoring` forever ·
a balance entirely committed to pending intents · an expired trial.

## CLI (no code required)
```
npm install -g @certen.io/cli
certen login                    # device authorization — no key is ever copied by hand
certen init                     # signing key, identity, funding; idempotent
certen call --identity <id> --chain base-sepolia --to 0x… --fn 'confirm(bytes32)' --arg 0x…     --sign-with dev --wait
certen proof get <intent-id>
certen doctor                   # names the one thing blocking you
```
- **`--json` emits exactly one envelope object on stdout**, nothing else. Human output goes to stderr.
  Success is `{"ok":true,"data":{...}}`; failure is `{"ok":false,"error":{"code","message","retryable"}}`.
- **Exit codes:** `0` ok · `1` operation failed · `2` usage error · `3` gateway unreachable. Branch on these
  without parsing text.
- A failure that still produced a result carries it under `error.details` — `certen --json doctor` returns
  every check that way, so signalling the failure never costs you the diagnosis.
- Failures carry the same codes and `retryable` flag as the SDK, so the retry decision is identical either way.
- `certen --help --json` returns the whole command tree (commands, flags, types) in one call.

## Resources
- Full API digest: `llms-full.txt`
- Repository guide (build/test/lint, for working ON this SDK): `AGENTS.md`
- Task-shaped guides: `docs/guides/`
- Live API reference (authoritative): <https://gateway.kompendium.co/reference>
