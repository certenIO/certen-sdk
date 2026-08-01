# Changelog — @certen.io/mcp

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
