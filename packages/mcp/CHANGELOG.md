# Changelog — @certen.io/mcp

## 0.4.0 — one response shape

**Breaking.** Requires a gateway from 2026-08 or later, and `@certen.io/sdk` >= 0.7.0.

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
