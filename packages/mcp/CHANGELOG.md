# Changelog — @certen.io/mcp

## 0.7.1 — depends on @certen.io/proof-verify 0.2.0 (2026-10-26)

No code change; the dependency range moves from ^0.1.0 to ^0.2.0.

## 0.7.0 — the gateway asks over MCP: any-address balance, identity facts, an intent estimate, sponsor-paid credits and gas, and the destination transaction (CLI UX, Phase G; 2026-10-17)

Additive: five tools (three read, two write) and one added field on the tools that return a transaction. No tool is removed or renamed, no parameter becomes required, and the server still holds no key and still registers no write tool without `CERTEN_MCP_ALLOW_WRITES=1`.
Needs the `@certen.io/sdk` release that carries `chains.balance`, `identity.readiness`, `identity.topUpCredits`, `identity.drip`, `transaction.quote` and `TransactionResponse.destination`, so the SDK goes out first and this package's `@certen.io/sdk` range is raised with it (a maintainer versions both).
Against a gateway that does not serve the operations, each tool answers `ENDPOINT_NOT_ON_GATEWAY`.

### Added
- **`certen_chain_balance { chain, address }`** (read). The native balance (ETH, or TEL on Telcoin Adiri) of ANY EVM address on a chain this server enables, through the gateway's own node. `balance` is a decimal string; `"0"` is a real read. A balance that could not be read is `BALANCE_UNREADABLE` (retryable) and never a zero. A mistyped address is `INVALID_ADDRESS` before any request, and the address is checked before the chain.
- **`certen_identity_readiness { identity_id, chain? }`** (read). The gateway's one-read FACTS about an identity: the identity, whether its key is on its key page, the page's credits, with `chain` that chain's account and balance, and the organization's spendable balance. It says nothing like "ready"; each section has its own `state` and an `unreadable` one is unknown, not a yes. It differs from `certen_readiness`, which judges from several reads and compares the key page with Accumulate (and the description of each says so).
- **`certen_intent_quote { intent, proof_class? }`** (read). An ESTIMATE of an intent's price and whether it would be admitted now; nothing is created, charged, held or signed, and `estimate` is always true. `checked` and `not_checked` are returned whole. It is not `certen_quote`, which is a price-book quote for one sku and returns a binding `quote_id` (both descriptions now say which to pick). The gateway gates this operation by `transaction:write`, so a read-only key gets a 403 although the tool creates nothing; `tiers.test.ts` names it as the one preflight allowed to need a write scope.
- **`certen_credits_topup { identity_id, credits, idempotency_key?, confirm }`** (write; spends the PLATFORM's funds). Credits for the identity's key page, paid by the sponsor account, never the organization. `credits` is a COUNT of credits (1 = $0.01), never ACME, and anything but a whole number of at least 1 is refused before any request. The result is the gateway's answer plus `idempotency_key` and `next_step`: `submitted` is not confirmed, and `unconfirmed` (or any status this server does not know) says the credits MAY have been applied and to read them back with `certen_identity_readiness`, not to ask again.
- **`certen_gas_drip { identity_id, chain, idempotency_key?, confirm }`** (write; spends the PLATFORM's funds, testnets only). A small fixed amount of native token to the identity's own deployed account. There is no destination and no amount to choose; an argument naming either (`to`, `address`, `amount`, ...) is refused by name. `sent` carries the hash and link, `skipped` says nothing was sent, `unconfirmed` says it may have been sent and to read the balance with `certen_chain_balance`.
- **The Idempotency-Key is returned, and carried on a failure.** The SDK makes a key when it is given none and keeps it, which is fine for code that retries on its own and unsafe for an agent: after a timeout it would hold no key and its next call would be a second draw. These two tools make the key themselves, pass it to the SDK, and return it as `idempotency_key` (and as `error.idempotency_key` on a failure, with `guidance` to repeat THAT request when the outcome is unknown). A key is 1 to 128 characters from letters, digits and `. _ : -`.
- **A switched-off feature is said plainly.** `CREDIT_TOPUP_DISABLED` and `DRIP_DISABLED` come back as an error with `guidance` that the operator has not switched it on, that it is a setting and not a fault, and that retrying cannot change it (the SDK does not retry them either). The limits (`CREDIT_TOPUP_LIMIT`, `DRIP_LIMIT`) say not to vary the key or the amount to get around them.
- **`destination` on the transactions the tools return, with its caveat.** `certen_transaction_get`, `certen_execute_wait`, `certen_transaction_open` and `certen_transaction_list` return the gateway's `destination` (`chain_id`, `tx_hash`, `settlement`, `source: "validators"`) untouched, and now add `destination_note` beside it, in the text and in the structured output, whenever a destination is present: it is the destination transaction AS THE VALIDATORS RECORDED IT, not verified by the gateway and not proof. A null or absent destination carries no note. `certen_receipt` gains `destination` (null when the gateway has none) and the same note; **this is the one place the receipt differs from the document `certen receipt --json` returns**, and `ids.destination_tx_source` still says whether the receipt's own hash came from the proof or only from the validators.
- Annotations: the two write tools are `readOnlyHint: false`, `destructiveHint: false` (they add) and `idempotentHint: false` (with no key given, each call is its own request). The server's instructions to a client now say these two spend the platform's funds.

### Changed
- The descriptions of `certen_quote` and `certen_readiness` each point at the look-alike that was added (`certen_intent_quote`, `certen_identity_readiness`) and say which one to pick. The header comment on the tier split now says what the two spending tools are, and why they are not a funding tool (they draw on the sponsor, never on the organization).
- The runners for the new tools are in `src/gateway-tools.ts`, and the argument helpers in `src/agent-tools.ts` (`refuse`, `onlyKnown`, `given`, `uuid`, `chainName`) are exported for them. Nothing that called them changes.

### Counts
- 55 tools (was 50); 38 are read-tier (was 35); 14 change something (was 12). Ten tools still build their own result and have a hand-written `outputSchema`; the new tools take the gateway's response schema from the spec (the two spending tools extend it with `idempotency_key` and `next_step`).

## 0.6.0 — ready? and what happened? for an agent, and a confirmed transfer (CLI UX plan, 2026-10-16)

Additive: two read-tier tools (ready? and what happened?), a fix to an existing one, two operator settings (`CERTEN_RPC_URL_<CHAIN>`, `CERTEN_SHARE_ORIGINS`) and one added field (`receiptNode` on
`certen_chains_enabled`). No tool is removed or renamed, no parameter becomes required, no write tool moves, and the server still holds no key. Needs `@certen.io/sdk` 0.11.0, so the SDK goes out first.

### Included — a confirmed transfer over MCP, and no tool lets a caller choose a host (CLI UX, Phase 6 follow-ups)

Two operator settings, one tightening of an existing tool, one added field. No tool is removed or renamed and no parameter becomes required. Needs the `@certen.io/sdk` release that carries `effectRpc` and the redirect guard, so the SDK goes out first.

### Added
- **`CERTEN_RPC_URL_<CHAIN>`** (server configuration; the chain slug upper-cased, anything that is not a letter or digit an underscore: `CERTEN_RPC_URL_BASE_SEPOLIA`). A node the OPERATOR trusts, per chain. With one, `certen_receipt` for that chain reads the recipient's balance before the execution block and at it (the node's chain id is checked first) and, when the
  caller passed no `header`, compares the proof's block header with it too: **a transfer receipt can now be `confirmed`, and `verified`**, from a node the server read. The chain is the one the caller described (`transfer.chain` / `call.chain`), else the one the validators' record says the intent ran on; with neither, no node is used. A caller's own `header` still decides the
  proof layer, and the node then reads only the recipient. A node on another chain, without history, down, or a setting that is not a usable URL leaves a named gap (`EFFECT_UNREADABLE`, `NODE_NOT_CONSULTED`), never a pass; only its host is ever shown, never its URL (which can carry a key). A caller still cannot name a node: `rpc` and friends are refused. An agent's own claim of a balance is still not a reading, and cannot upgrade a verdict.
- **`receiptNode: boolean`** on each chain in `certen_chains_enabled`: whether the operator configured such a node, so an agent knows whether fetching a header and a balance itself is still worth doing. An added field on a closed schema (updated).
- **`CERTEN_SHARE_ORIGINS`** (server configuration; comma-separated origins): other deployments whose proof share links `certen_proof_verify` may open. See Changed.

### Changed
- **`certen_proof_verify` given a share link opens it only on this server's own gateway or an origin the operator listed in `CERTEN_SHARE_ORIGINS`.** It used to fetch from whatever origin the link named, so a caller chose a host the server connected to; and a bare `cps_` token went to the default gateway rather than the one the server is configured for. A link elsewhere is
  `SHARE_ORIGIN_NOT_ALLOWED` (nothing requested; the message names the variable), a list that does not parse is `SHARE_ORIGINS_INVALID` (refused by name, not skipped), a bare token is this gateway's, and a fetch redirected off its origin is refused. **Behaviour change:** a counterparty verifying a proof shared from a different deployment now needs the operator to list that origin. After this no tool lets a caller
  choose what the server connects to.
- `certen_chains_enabled` reads its chain settings from the server's `env` (the same object as `process.env` in production).

### Corrected
- Earlier notes (Phase 6 ledger, `AGENTS.md`, this README) said `certen_proof_open_shared` also fetched from the link's origin. It never did: it takes only the token from a link and asks the server's own gateway. Only `certen_proof_verify` named a host.

### Included — ready? and what happened? for an agent (CLI UX, Phase 6)

Two read-tier tools, one fix to an existing one, and nothing else that works today changes: no tool is removed or renamed, no parameter becomes required, no write tool moves. The server still holds no key,
still signs nothing, and still registers no write tool without `CERTEN_MCP_ALLOW_WRITES=1`. A maintainer versions and publishes this (it needs the `@certen.io/sdk` release that carries
`client.readiness()`, `buildReceipt` and the `header` option, so the SDK goes out first).

### Added
- **`certen_readiness { identityId, chain, keyHash?, amount?, tokenSymbol? }`** (read). "Can this identity, on this chain, act right now?" in one call instead of five: the gateway, the credential, the identity, the chain, the key page,
  the Accumulate credits, the organization's balance and the abstract account's gas, in dependency order, each `ok` | `warn` | `fail` | `unknown` | `skipped` with a stable `code` and a `fix` in words. It is `client.readiness()`, the same
  judgement `certen status` renders. Gate on `state`: `ready`, `blocked` (read `first_blocker`) or `unconfirmed` (nothing failed, something could not be answered: **not** ready; an `unknown` is never read as `ok`).
  - Give `keyHash` (the SHA-256 of the signing key's *public* key) and the key page is read from an Accumulate node as well as from the gateway; two reads that disagree are a blocker (`KEY_PAGE_DISAGREES`). Without it the check is a `warn`: the gateway's word alone.
  - The Accumulate endpoint is the one the gateway's chain registry advertises, or **`CERTEN_ACCUMULATE_RPC`** (new, server configuration beside `CERTEN_ENABLED_CHAINS`). It is never an argument.
  - Checked before a request is made: the identity is a UUID, the chain is one this server enables, the amount is whole units (a wei-looking one is refused), the key hash is 64 hex.
  - **An argument it does not have is refused by name, not ignored** (`UNKNOWN_ARGUMENT`, listing the ones it takes; `NODE_ARGUMENT_REFUSED` for `rpc`, `accumulateRpc`, `url`, `endpoint`, `node` and the like, saying why and what to do instead). An agent that passes `rpc` and gets a normal result would believe the node was used. The same rule holds for both tools, and for the fields inside `transfer`, `call` and `call.expect`.
- **`certen_receipt { intentId, header?, transfer?, call? }`** (read). "What happened to this intent?" in one call instead of four: the ids to keep (the intent, the Accumulate transaction, the destination transaction and a link to it), the proof
  verified here layer by layer, and what of the effect is established. It is `buildReceipt()`, the document `certen receipt --json` returns (`docs/CLI-CONTRACT.md` section 10). `verdict` is `verified` · `partial` · `failed` · `pending` · `unproven`; `gaps`
  names what is not established and is empty exactly when the verdict is `verified`; PARTIAL and NO EVIDENCE are never verified; a proof service answering 5xx is `unavailable`, not "no evidence".
  - The execution layer stays `not_checked` until you pass **`header`**, the block header you fetched from your own node. This server never calls a node you name, so there is no `rpc` argument.
  - It cannot read a recipient's balance. A `transfer { chain, to, amount }` has an `unchecked` effect and a receipt that is not `verified` until you have read the recipient yourself; `call { chain, expect }` looks for the event in the proof's own execution receipt.
  - It writes nothing. The CLI keeps receipts in `~/.certen/receipts`; this server keeps no state.
- `ToolDef.run` receives the server's `env` as a third argument, so a tool can read operator configuration without touching `process.env`. Existing tools ignore it.

### Fixed
- **`certen_proof_verify` no longer reads an empty header as a comparison that passed.** `header` went to the verifier as given, so `{}` or only the block number (which the bundle itself states) found nothing to disagree with and the execution layer
  came back `verified` with `headerCheck.ok: true`, having compared nothing. A header now needs a `receiptsRoot` (and a malformed `hash` or `number` is refused rather than ignored): otherwise `INVALID_HEADER`, before the proof is fetched.
  This is a behaviour change to an existing tool, in the direction "unknown is not ok". A caller that sent a complete header (`receiptsRoot`, `hash`, `number`, as the tool's own description asked) is unaffected.

### Counts
- 50 tools (was 48); 35 are read-tier (was 33). Ten tools build their own result and have a hand-written `outputSchema`.

## 0.5.0 — RB7b: verify what you trust, sign what you see (2026-10-09)

**Breaking** changes are marked; the minor carries them (0.x).

### Breaking
- **Node 22 or 24** (`engines.node >=22`).
- **`certen_proof_verify` takes `target` and verifies locally** (see below); the result is per-layer, and `independent` is true only when every layer the proof carries was checked.
- **A confirmation stop is `isError: true`** (it was a success result), so a client that treated any non-error as done no longer mistakes a stop for completion.
- **`certen_execute_wait`** returns the named `outcome` (`pending`, `executed`, `completed`, `completed_unproven`, `failed`, `unknown`) and accepts `until: 'executed'`; tool errors carry `timeout` and failure details.
- A chain the catalogue does not know, or Adiri without `CERTEN_ENABLED_CHAINS`, is refused before anything is sent.

### Added
- MCP revisions **2026-07-28** (stateless: per-request version in `_meta`, `server/discover`, `resultType`, cache hints, `-32022`) alongside 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, proved against the official client of each.
- Annotations (read-only, destructive, idempotent, open-world) and an `outputSchema` with `structuredContent` on all 48 tools; the hints are withheld from a client that predates them. They are hints: `confirm: true` and `CERTEN_MCP_ALLOW_WRITES` still enforce.
- `certen_chains_enabled` (read), the signing summary, and an `exports` map.
- Builds on the workspace SDK, so header fields go through the SDK's validation; the `HEADER_FIELDS_UNSUPPORTED` workaround is gone.

### Included — the signing summary (RB7b Phase F)

### Added
- `certen_transaction_open` and `certen_sign_create` return `signing`, the rebuilt summary of what a signature on the returned hash would authorise (matched to the request, or to the transaction named), or `signing_check`
  (`ok:false`, `code`, `message`) when the gateway's transaction could not be checked, in which case the hash must not be signed. The intent or request is returned either way. The server still signs nothing and holds no key.
### Included — `certen_proof_verify` verifies (RB7b Phase E)

### Changed (breaking)
- `certen_proof_verify` takes `target` (an intent id, a proof id, a transaction hash or a share link) instead of `txHash`, verifies locally, and returns the per-layer
  result described in docs/CLI-CONTRACT.md (`overall`, `independent`, `layers`, `covers`, `notCovered`, `failure`, `execution`, `bundleStatements`, `evidence`, `gateway`). `independent` is true
  only when every layer the proof carries was checked here. The server stays read-only and never fetches a URL the caller names: the execution chain's block header is
  passed in as `header`, not fetched.
### Included — header fields on `certen_transaction_open`

### Added
- Optional `additionalAuthorities` and `expiresAt` on `certen_transaction_open`. Refused with
  `HEADER_FIELDS_UNSUPPORTED` (nothing sent) when the installed `@certen.io/sdk` predates them, rather than
  silently dropped. Tool errors now include `guidance` and `reason_code` when the SDK error carries them.

## 0.4.2 — the server starts when you install it

### Fixed — the same silent entrypoint as the CLI

`certen-mcp` compared `import.meta.url` against an unresolved `process.argv[1]` to decide whether
it had been run as a program. A POSIX install exposes it through a symlink in `node_modules/.bin`,
`import.meta.url` is the resolved real path, and so the comparison was false: the process started
nothing and exited 0. To an MCP client that is a server closing the pipe on connect, with no error
to read.

Unaffected on Windows, where npm writes a `.cmd` shim carrying the real path. `realpathSync` now
resolves `argv[1]` first so the two sides are comparable. See `@certen.io/cli` 0.7.2 — same bug,
same line, found there first.

## 0.4.1 — sign a pending action by its inbox id

### Added — the sign tool takes the id an agent actually has

`certen_sign` accepted only a transaction hash, so an agent that had just listed the pending inbox
held exactly the id the tool would not take. It now accepts the inbox UUID, a 64-hex hash, a
0x-prefixed hash, or a TxID, and infers which is which — the forms are disjoint, so no `type`
parameter is needed and none can be got wrong.

Resolution is `resolveSignTarget` from `@certen.io/sdk`, shared with the CLI rather than
reimplemented. A drifted copy would sign the wrong preimage and produce a valid signature attached
to nothing.

Unchanged: this server still holds no key and cannot sign. It exchanges an id for a
`hash_to_sign`; the signature is produced wherever the key actually lives.

## 0.4.0 — one response shape

**Breaking.** Requires a gateway from 2026-08 or later, and `@certen.io/sdk` >= 0.7.0.

### Added — `certen_errors`, `certen_quote_get`

Both read-tier. `certen_errors` is the one that changes agent behaviour: `retryable` says whether
repeating a request can ever work, and an `audience: platform` code says there is nothing in the
request to change — so an agent stops sending someone to debug their own setup during our outage.

`certen_quote_get` checks whether a quote obtained earlier in a conversation can still be used. A
quote is single-use and expires, and a spent one is refused at submission, partway into the work.

Deliberately NOT exposed: retrieving a provider-mode mnemonic, and creating or rotating an OAuth
client secret. Both hand long-lived key material to a model, and neither is something an agent
should be doing on someone's behalf. They are in the SDK and the CLI, where a person is holding it.

### Added — `certen_webhook_endpoints`, `certen_webhook_deliveries`, `certen_webhook_redeliver`

An agent asked "why did the event not arrive" had nothing to look at. `certen_webhook_deliveries` is
the tool to reach for first — a failed delivery and an event that never fired are indistinguishable
without it.

Redelivering is write-tier and requires `confirm:true`: it is one of the few genuinely
non-idempotent operations on the API, because delivering again is the entire point.

### Added — `certen_proof_open_shared`

Reads a proof from a share link, with no API key. Its description tells the agent that a 410 means
the link was real and has lapsed — so the response is to ask for a new link, not to tell the user
their proof does not exist.

### Added — `certen_platform_ready`

An agent had no way to tell a CERTEN outage from a user misconfiguration, and most errors look
identical either way — so the likely response was to send someone debugging their own setup during
an outage. The tool description flags `sponsor_below_floor` as a hard stop on creating identities,
because that failure returns 202 and then never completes.

### Added — `certen_billing_verify_receipt`, `certen_transparency_log`, `certen_transparency_price_books`

An agent asked to prove a charge could previously only quote CERTEN's own `verification` block back
at the user. `certen_billing_verify_receipt` performs the checks against independently published
data and returns a per-check report.

Its description tells the agent the thing it would otherwise get wrong: report `verified` only when
`complete` is also true, because a `skipped` check is not a pass — announcing a receipt "verified"
on the strength of checks that never ran would be the worst available error here.

### Added — `certen_billing_ledger`, `_receipts`, `_receipt`, `_verification_keys`

An agent asked "what were we charged for, and can you prove it" had no tool that could answer.

`certen_billing_receipt` takes `includeProof` rather than shipping a separate proof tool, because an
agent asking for proof wants both and a not-yet-logged receipt should not lose it the receipt — that
case returns the receipt with `proof: null` and a plain explanation.

The tool descriptions carry the two things an agent gets wrong unprompted: `verification` is CERTEN
checking its own work and must not be reported as independent confirmation, and anchoring must be
read from `covering_head` rather than `head`.

### Added — `certen_billing_register_payer` and `certen_billing_payer_addresses`

An agent that hit PAYMENT_REQUIRED was told, in the refusal itself, to register the sending wallet —
and had no tool for it. Registering is now a write-tier tool requiring `confirm:true`, because it
asserts that money arriving from an address belongs to this organization: registering someone
else's wallet would credit their deposits here, and an address belongs to only one organization per
chain. Reading the registered list is read-tier.

### Changed — `certen_billing_balance` answers affordability on its own

Its description told the agent to also call `certen_billing_obligations` before concluding that work
was affordable. The balance now carries `remaining_usd`, so one call settles it, and the description
says plainly to gate on that rather than on `spendable_usd`. `certen_billing_obligations` is still
the tool for seeing which intents claimed the balance.

### Fixed — the server reports its real version

`serverInfo.version` was the literal `0.1.0`, written once and never updated, so every MCP client
completing a handshake against 0.2.0, 0.3.0 and 0.4.0 was told it was talking to 0.1.0 — the wrong
answer for a client deciding whether a tool it needs exists, and the wrong version on any bug
report. It is now read from package.json, and a test pins the two together.

### Added — `certen_pricing` and `certen_quote`

An agent could read the balance but could not find out what anything cost. There was no quote tool
at all, and no way to discover a sku name — they are not guessable (`identity.provision`, not
`identity.create`), so "can I afford this" was unanswerable without leaving the tool surface.

`certen_pricing` returns the whole catalogue in one call, for exploring. `certen_quote` returns a
binding price for specific work, whose `quote_id` fixes the charge when the transaction is opened.
Both are read-tier and neither mutates anything.

The `mode` field is called out in the tool description because it changes what the number means:
`quoted` prices are a floor with gas added at execution, and must not be reported to a user as a
total.

### Fixed — `certen_identity_create` no longer advertises a call that cannot succeed

The tool required `name` and `publicKeyHash` and marked `publicKey` optional, while the gateway
REJECTS an external identity that has no `public_key` — the hash alone cannot sign. An agent
following the tool's own schema made a call that could only ever return 400.

Both key fields are now required. The gateway's OpenAPI is also at fault and has been corrected: it
declared `required: ['name']` with no descriptions, so anything generated from it inherits the same
gap.

### Changed — creating an identity WAITS by default

`create` returns 202 and provisioning continues, so the old instruction was "poll
certen_identity_get until status is terminal and can_sign is true". That is several more tool calls,
and it asks an agent to re-implement a contract it can get wrong invisibly: `can_sign` is
three-valued, and reading `null` as either false or ready yields an identity that fails at the last
step of every later flow.

One call now returns an identity that can actually sign. Pass `wait: false` for the old behaviour.

### Breaking — identity tool results are no longer wrapped

Identity results carried the identity under an `identity` key. It is now at the top level, matching
the API and every other tool. An agent reading `result.identity.can_sign` must read
`result.can_sign`.

### Fixed — absent fields are `null` rather than `""` or `false`

`proof_id` and friends are `null` when there is no value, and `can_sign` is `null` — not `false` —
when the on-chain key page could not be read. An agent deciding whether an identity is usable was
previously told a definite "no" in a case that was actually "unknown".

## 0.3.0 — an agent can diagnose its own broken setup

### Added — five read-tier tools

`certen_doctor`, `certen_chains_list`, `certen_whoami`, `certen_proof_receipt` and
`certen_proof_verify`.

`certen_proof_verify` exists to stop an agent concluding "verified" from a successful proof fetch.
It reports three separate judgements — inclusion, authorization, outcome — establishes only the
first, and only as something the gateway asserted, and returns `independent: false` to say so.

`certen_proof_receipt` reads the Accumulate merkle receipt directly, which is the read that works
when `certen_proof_get` does not: the proof-service and Accumulate fail independently.

### Added — `alsoReaches` on a tool definition

A composite tool reaches several endpoints, and `endpoint` alone would have understated what it
touches. Every entry is checked against the vendored spec and the read-tier scope rule exactly as
`endpoint` is, so declaring more can only constrain a tool further. A new invariant also asserts no
read-tier tool reaches `/v1/admin/*`.

Writes remain gated behind `CERTEN_MCP_ALLOW_WRITES=1`; no tool accepts key material; `signup` is
deliberately not a tool, because account creation is a human act.

## 0.2.0 — an agent can see what work costs, and explain a refusal

### Added — `certen_billing_balance` and `certen_billing_obligations`

Read tools, so an agent can say what work will cost and why a call was refused. The obligations
description points at `remaining_usd` rather than the balance, for the same reason the SDK does:
pending multi-signature intents can commit a balance for weeks.

There is deliberately **no funding tool**, in either tier. Reading is explanation; opening a payment
or registering a payer address is spending on the operator's behalf, and an agent able to do that
would be an agent that can move money. Those stay on the portal and the CLI, where a person is
present. The omission is recorded in the invariants at the top of `tools.ts` so it is not "completed"
later by mistake.

### Changed — a payment refusal is reported with its remedy

A 402 used to reduce to a bare message, leaving an agent able only to say "it failed" and likely to
retry — which cannot succeed until money moves. The error now carries the shortfall, the payment
target, and an explicit instruction not to retry but to report the amount and link to its operator.

## 0.1.0 — initial release

A [Model Context Protocol](https://modelcontextprotocol.io) server for the CERTEN Gateway, so an AI
agent can query identities, transactions, portfolios and proofs — and, when explicitly permitted,
authorize execution.

Two properties define this package, and both are enforced by tests rather than documented and hoped
for:

- **It holds no signing key and cannot sign.** No tool accepts a private key, mnemonic or
  passphrase; a test asserts no tool parameter is even *named* like one. The flow is: open an intent,
  receive `hash_to_sign`, sign it wherever the key actually lives, submit the signature. The server
  sees the hash and the signature, never the key.
- **It is read-only unless told otherwise.** Write tools are not registered at all unless
  `CERTEN_MCP_ALLOW_WRITES=1` (exactly `1` — `true`, `yes` and `0` do not enable them). The gate is
  in the server, not in a prompt: an unregistered tool cannot be called by a confused model, a prompt
  injection, or a bug.

### Added

- **8 read tools**: `identity_get`, `portfolio_get`, `transaction_get`, `transaction_list`,
  `pending_list`, `governance_get`, `proof_get`, `execute_wait`.
- **13 further tools behind the write gate**: identity create/update/retire, transaction open and
  submit-signature, sign create and submit-signature, governance submit-signature, and the admin
  tools. Every tool that *changes* something additionally requires `confirm: true`; called without
  it, the tool describes what it would do and changes nothing, so the first call can never be the
  destructive one. Tools that only read do not ask for confirmation — demanding it for a list trains
  a model to pass `confirm:true` reflexively, which is the habit that makes the gate worthless where
  it matters.
- **Documentation as MCP resources**: `llms.txt`, `llms-full.txt`, the error catalog, the CLI
  contract, and the five task guides, so a client gets CERTEN's semantics without a web fetch.
- `certen_execute_wait` states in its description that it takes 60–110 seconds, so a client does not
  read a normal proof cycle as a hang and retry it.

### Notes

The only runtime dependency is `@certen.io/sdk`. MCP's stdio transport is newline-delimited
JSON-RPC 2.0 — a small, stable surface implemented directly in `src/protocol.ts`. For a server that
can authorize value-bearing operations, every transitive dependency it does not have is supply-chain
risk it does not carry.

The documentation it serves lives outside this package directory, so `prepack` copies it into
`bundled/`. Without that step the package would install cleanly, start cleanly, list its tools, and
serve zero resources — a failure invisible in the monorepo, where the repo root is right there and
every lookup succeeds. CI packs the tarball, installs it, speaks MCP to it, and fails if it serves
none.
