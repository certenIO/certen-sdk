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

A native transfer from an identity (the ADI and the abstract account are derived from it), and the receipt it ends in:
```ts
import { buildReceipt } from '@certen.io/sdk/verify';

const sent = await certen.execute.send({
  identityId, chain: 'base-sepolia', toAddress, amount: '0.0001', asset: 'ETH',   // whole units; the chain's native token only
  publicKey, sign: (hashHex) => ed25519Sign(hashHex),
});
await certen.execute.wait(sent.intentId);
const receipt = await buildReceipt(certen, sent.intentId, { rpc: nodeYouTrust });  // verifies the proof here; reads the recipient from YOUR node
// receipt.verdict: 'verified' | 'partial' | 'failed' | 'pending' | 'unproven'. receipt.gaps names what is not established.
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
- **Chains: three live testnets, plus Telcoin Adiri on request.** `ethereum-sepolia` (11155111),
  `base-sepolia` (84532) and `arbitrum-sepolia` (421614) are on by default; their gas is ETH.
  `telcoin-adiri` (2017) is **Telcoin's Adiri testnet**, whose gas is **TEL** (18 decimals); it is
  off unless your configuration enables it (`CERTEN_ENABLED_CHAINS` for the CLI, `chains.enabled([...])`
  in the SDK) AND the gateway serves it. Other chains `GET /v1/chains` lists are not supported. The
  SDK's `CHAIN_CATALOGUE` holds each chain's id, gas token, decimals, block time and faucet;
  `client.chains.enabled()` is what to offer — the configured chains the gateway serves right now.
- **`contract_addresses` is an OBJECT, not a list**, and you almost never set it. It names the CERTEN
  deployment (`anchor`, `abstractAccount`, …), not your call target; the gateway supplies the right
  defaults. Passing an array is rejected with `/contract_addresses must be object`.
- **Errors are typed:** catch `CertenError` and branch on `.code`. **Retry ONLY the codes whose `retryable`
  is yes** — `RATE_LIMIT_EXCEEDED`, `INTERNAL_ERROR`, `BAD_GATEWAY`, `NETWORK_ERROR`. The SDK already retries
  those with backoff, so a second retry loop around it is wrong. Every other code is a condition that will
  not change on its own. Full table: the **Error catalog** in `llms-full.txt`.
- **A receipt's `verdict` is the weakest honest reading, and PARTIAL is not verified.** `verified` needs the proof to verify HERE (never a flag in a bundle) and the value to have arrived;
  the proof's execution layer stays `not_checked` until its receipts root is compared with a block header from a node you trust (`rpc`), and the recipient's balance is only ever read from that
  node (the gateway cannot read another address). `execute.send()` signs the chain's native token only and refuses a recipient whose EIP-55 checksum fails.
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

`client.readiness({ identityId, chain, keyHash?, amount? })` asks the narrower question asked just before sending: is *this* identity, on *this*
chain, able to act? It returns ordered checks (`gateway`, `credential`, `identity`, `chain`, `key page`, `accumulate credits`, `gateway balance`,
`gas`), each `ok` | `warn` | `fail` | `unknown` | `skipped`, with a stable `code` and a `fix`, plus `ready`, `state` and `first_blocker`. It never throws for
a failed check and is **never `ready` over an `unknown`**. The key page is read from an Accumulate node as well as from the gateway, and when the two
disagree that is a blocker (`KEY_PAGE_DISAGREES`). The gas check compares the abstract account's balance with the amount plus an *estimate* of the gas
(labelled as one; the gateway publishes no per-execution figure).
```ts
const r = await certen.readiness({ identityId: identity.id, chain: 'base-sepolia', keyHash, amount: '0.001' });
if (!r.ready) console.error(r.state, r.first_blocker);   // 'blocked' or 'unconfirmed'
```

## CLI (no code required)
The golden path is three commands. Everything else is a piece of it, or a different job.
```
npm install -g @certen.io/cli
certen setup                    # signing key, account, identity, checks, gas; resumable; exit 0 only when ready
certen send 0.0001 ETH --to 0x…   # a native transfer: checks, confirms, signs, waits, verifies the proof here, writes a receipt
certen receipt [<intent-id>]    # the receipt again: ids, whether the proof holds, whether the value arrived; re-verified here
certen status                   # is this identity, on this chain, with this key ready? exit 0 only when it is
certen watch <intent-id>        # wait for an intent to finish (Ctrl-C stops the wait, not the intent), then show its receipt
certen gas [--wait]             # the abstract account's gas: address, amount, faucet, wallet link; --wait returns when it arrives
certen call --to 0x… --fn 'confirm(bytes32)' --arg 0x… --wait     # a proof-gated contract call (identity, chain and key from context)
certen proof get <intent-id>
certen doctor                   # names the one thing blocking you
certen login                    # device authorization — no key is ever copied by hand (setup --existing-account does this)
certen init                     # signing key, identity, funding; idempotent (setup is the strict form: exit 0 only when ready)
```
`certen --help` leads with those five (`setup`, `send`, `call`, `status`, `receipt`) and puts plumbing (`tx`, `admin`, `webhooks`, `orgs`, …) under "Advanced"; nothing is hidden.
- **Say it once.** `certen use identity|key|chain <value>` chooses them, `certen context` shows what the next command will use and why,
  and `--profile <name>` switches between setups (each with its own gateway and API key). After that `--identity`, `--chain` and
  `--sign-with` (on `call` and `identity create`) can be left out. Whatever is taken from context is echoed on stderr, and a chain that is not a known
  testnet is never taken from a default by a command that moves value. `--identity` takes a UUID, an `acc://` ADI URL or a name.
- **`send`, then `receipt`.** `certen send <amount> <asset> --to <address>` moves the chain's **native** token (whole units, never wei; any other asset is refused by name, because what a
  token transfer moves cannot be checked before signing). It checks readiness before it asks for a passphrase, refuses a recipient whose EIP-55 checksum fails, shows a confirmation card with what
  the signature authorises (rebuilt from the gateway's bytes and matched to the request), signs, waits for the proof cycle, verifies the proof locally, and writes
  `~/.certen/receipts/<intent>.json`. **Every command that signs shows that card; the question is asked only at a terminal.** `--yes` says yes in advance (required for `send` when no one is at a terminal) and
  never skips the check of what is signed. The receipt's `verdict` is `verified` · `partial` · `failed` · `pending` · `unproven`, with every unestablished thing named in `gaps`; **`send`, `receipt` and `watch`
  exit `0` only for `verified`**, `4` for partial or pending, `5` for no evidence, `130` for Ctrl-C. PARTIAL and NO EVIDENCE are never verified, and the proof's execution layer needs a node you trust
  (`--rpc <url>` or `CERTEN_RPC_URL`) to leave `not_checked`. Shape and codes: `docs/CLI-CONTRACT.md` section 10.
- `--timeout` takes units: `90s`, `6m`, `1h` (a bare number is minutes).
- **`--json` emits exactly one envelope object on stdout**, nothing else. Human output goes to stderr.
  Success is `{"ok":true,"data":{...}}`; failure is `{"ok":false,"error":{"code","message","retryable","next"}}`.
- **Every failure carries `error.next`: the ONE command to run next** (a single `certen ...` line; `<angle>` tokens are values you choose). Examples: no API key → `certen setup`; the identity
  cannot sign → `certen status`; no gas → `certen gas --chain <chain> --wait`; a wait ran out → `certen watch <intent-id>`; a wrong flag → `certen <command> --help`; a code the gateway publishes →
  `certen errors <CODE>`. In table mode it is the last stderr line, `  next: <command>`. It is built by the CLI and never from gateway text, and it is a hint to run, not a promise it fixes the cause:
  branch on `error.code`, and still ask before running one that creates, spends or signs.
- **Exit codes:** `0` ok · `1` operation failed · `2` usage error · `3` gateway unreachable. Branch on these
  without parsing text. (`4` and `5` are the verdicts of `proof verify`, `send`, `receipt` and `watch`: partial or pending, and no evidence; `130` is Ctrl-C while waiting.)
- A failure that still produced a result carries it under `error.details` — `certen --json doctor` returns
  every check that way, so signalling the failure never costs you the diagnosis.
- Failures carry the same codes and `retryable` flag as the SDK, so the retry decision is identical either way.
- `certen --help --json` returns the whole command tree (commands, flags, types) in one call.

## MCP (an AI agent, no code)
`@certen.io/mcp` (`certen-mcp`) is a Model Context Protocol server over the same gateway. It is read-only unless started with `CERTEN_MCP_ALLOW_WRITES=1`, **holds no signing key and cannot sign**, and
every tool that changes something needs `confirm: true`. Two read tools answer the two questions around every action:
- `certen_readiness { identityId, chain, keyHash?, amount? }` — can THIS identity, on THIS chain, act right now? The checks `client.readiness()` makes, in one call. Gate on `state`: `ready`, `blocked`
  (read `first_blocker`) or `unconfirmed`, which is **not** ready (an `unknown` is never read as `ok`). `keyHash` is the SHA-256 of the signing key's *public* key; with it the key page is read from Accumulate
  as well as from the gateway. Fixes are in words (`fix.text`), never a CLI command.
- `certen_receipt { intentId, header?, transfer?, call? }` — what happened to this intent: the ids to keep, the proof verified here layer by layer, and what of the effect is established. It is the document
  `certen receipt --json` returns. `verdict` is `verified` · `partial` · `failed` · `pending` · `unproven`; **PARTIAL and NO EVIDENCE are never verified**, and `gaps` says what is missing. The server **never calls a
  node you name**: close the proof's execution layer by passing the block `header` you fetched from your own node (`{ receiptsRoot, hash?, number? }`; one with no `receiptsRoot` compares nothing and is refused), and
  read the recipient's balance yourself (a described `transfer` is `unchecked`, so the receipt is not `verified`, until you have). It keeps no state and writes nothing.
The Accumulate endpoint for the key page read is the gateway's own advertisement, or the operator's `CERTEN_ACCUMULATE_RPC`; neither tool has an `rpc` argument. Read `certen://docs/llms.txt` first.

## Resources
- Full API digest: `llms-full.txt`
- Repository guide (build/test/lint, for working ON this SDK): `AGENTS.md`
- Task-shaped guides: `docs/guides/`
- Live API reference (authoritative): <https://gateway.kompendium.co/reference>
