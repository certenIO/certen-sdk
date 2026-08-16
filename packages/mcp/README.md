# `@certen.io/mcp`

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[CERTEN Gateway](https://gateway.kompendium.co/reference) — proof-gated cross-chain execution on
Accumulate.

**Read-only by default. It holds no signing key and cannot sign.**

## Install

```bash
npm install -g @certen.io/mcp
```

Claude Desktop / any MCP client (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "certen": {
      "command": "certen-mcp",
      "env": { "CERTEN_API_KEY": "ck_live_..." }
    }
  }
}
```

## It also serves the documentation

Nine MCP *resources*, so an agent can read the rules rather than guess them: the quickstart, the full
API digest, the error catalogue, the CLI JSON contract, and five task guides (onboarding an identity,
signing while holding your own key, proof-gating a contract call, M-of-N panels, verifying a proof).

An agent finds them with `resources/list`. A human configuring the server would not have known they
were there, which is why they are listed here — they are the fastest answer to "what can this do".

## Two things this server will not do

**It will not sign.** There is no code path that accepts a private key, a mnemonic or a passphrase —
a test asserts that no tool parameter is even named like one. The flow is: open an intent, get back
`hash_to_sign`, sign it wherever your key actually lives, submit the signature. The server sees the
hash and the signature, never the key. That is the SDK's central guarantee, and an autonomous
process holding a key would undo it.

**It will not write unless you say so.** Write tools are not registered at all unless
`CERTEN_MCP_ALLOW_WRITES=1`. The gate is in the server, not in a prompt: a tool that is never
registered cannot be called by a confused model, a prompt injection, or a bug. A tool registered
with "please don't call this" in its description can be called by all three.

```bash
certen-mcp                              # 30 read tools
CERTEN_MCP_ALLOW_WRITES=1 certen-mcp    # 45 tools
```

Every tool that changes something additionally requires `confirm: true`. Called without it, the tool
returns a description of what it *would* do and changes nothing — so the first call can never be the
destructive one.

## Configuration

| | |
|---|---|
| `CERTEN_API_KEY` | Required for gateway calls. Documentation resources work without it. |
| `CERTEN_API_URL` | Gateway base URL. Defaults to `https://gateway.kompendium.co`. |
| `CERTEN_MCP_ALLOW_WRITES` | Exactly `1` enables write tools. `true`, `yes` and `0` do not. |

## Tools

**Read tier** (always available)

| Tool | |
|---|---|
| `certen_identity_get` | One identity. Check `can_sign` before relying on it. |
| `certen_portfolio_get` | Balances across every identity and chain. |
| `certen_transaction_get` | Status of one intent. |
| `certen_transaction_list` | Recent intents. |
| `certen_pending_list` | The pending actions inbox. |
| `certen_governance_get` | Status of a governance operation. |
| `certen_proof_get` | The proof for a completed intent. |
| `certen_execute_wait` | Poll to a terminal state — **takes 60–110 seconds**. |

**Write tier** (`CERTEN_MCP_ALLOW_WRITES=1`)

Identity `create` / `update` / `retire`; `transaction_open` and `transaction_submit_signature`;
`sign_create` and `sign_submit_signature`; `governance_submit_signature`; and the admin tools
(`list_api_keys`, `audit_log`, `usage`, `rotate_api_key`, `revoke_api_key`).

The admin read tools sit in the write tier because they enumerate credentials and belong behind the
same door as rotating them — but they do not ask for confirmation, because there is nothing to
confirm about a list, and demanding it for reads trains a model to pass `confirm:true` reflexively.

## Resources

The server serves this repo's documentation over the protocol, so a client gets CERTEN's semantics
without a web fetch: `certen://docs/llms.txt`, `certen://docs/llms-full.txt`,
`certen://docs/errors`, `certen://docs/cli-contract`, and the five guides under `certen://guides/`.

Read `certen://docs/llms.txt` first. Most integration mistakes come from not knowing that a proof
cycle legitimately takes 60–110 seconds.

## No third-party dependencies

The only runtime dependency is `@certen.io/sdk`. MCP's stdio transport is newline-delimited
JSON-RPC 2.0 — a small, stable surface implemented directly in `src/protocol.ts`. For a server that
can authorize value-bearing operations, every transitive dependency it does not have is
supply-chain risk it does not carry.

## License

MIT
