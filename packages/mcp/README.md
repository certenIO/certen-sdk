# `@certen.io/mcp`

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[CERTEN Gateway](https://gateway.kompendium.co/reference) — proof-gated cross-chain execution on
Accumulate.

**Read-only by default. It holds no signing key and cannot sign.**

## Install

```bash
npm install -g @certen.io/mcp
```

Requires **Node 22 or 24** (`engines.node >=22`).

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

## Protocol revisions

`certen-mcp` speaks **MCP 2026-07-28** and, from the same process, the four earlier revisions (**2025-11-25, 2025-06-18, 2025-03-26,
2024-11-05**). A client chooses by how it opens:

- **2026-07-28 (stateless).** No `initialize`. Every request carries `_meta["io.modelcontextprotocol/protocolVersion"]` and
  `_meta["io.modelcontextprotocol/clientCapabilities"]`; every result carries `resultType: "complete"`; lists and `resources/read`
  carry `ttlMs` and `cacheScope`; `server/discover` reports the supported versions, capabilities and instructions. A version the
  server does not serve is answered with `-32022` listing the ones it does.
- **Earlier revisions.** `initialize` negotiates one of them. `annotations` are sent from 2025-03-26 and `outputSchema` /
  `structuredContent` from 2025-06-18; a 2024-11-05 client gets neither.

Interop is tested with the official clients, one per revision (`packages/mcp/test/interop.test.ts`): `@modelcontextprotocol/client`
2.3.1 for 2026-07-28 (pinned, `auto`, and its legacy default) and `@modelcontextprotocol/sdk` 1.32.1, 1.13.0, 1.12.1 and 1.0.2 for
the others. They are exact-pinned **devDependencies**, never installed with the package: the server's only runtime dependency is the CERTEN SDK.

## What a tool tells a client

Every tool carries MCP **annotations** derived from the metadata the server already enforces with: `readOnlyHint` is false exactly
for the 12 tools that change something; revoke, retire, rotate, update and the signature submissions are `destructiveHint: true`;
every tool is `openWorldHint: true`. Annotations are hints, not enforcement: the `confirm:true` stop and `CERTEN_MCP_ALLOW_WRITES`
are what enforce.

Every tool also declares an **`outputSchema`** and returns **`structuredContent`** that conforms to it, alongside the JSON text. Most
schemas are generated from the gateway's own response schemas (`npm run agentgen`; CI fails if they are stale); the ten tools that
build their own result have schemas written beside the server code, and a test runs all 50 tools and validates what each returns. A
`confirmation_required` stop and any failure are returned with `isError: true` and no `structuredContent`.

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
certen-mcp                              # 35 read tools
CERTEN_MCP_ALLOW_WRITES=1 certen-mcp    # 50 tools
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
| `CERTEN_ENABLED_CHAINS` | Comma-separated chains this server accepts in tool calls. Unset means the three live testnets (`ethereum-sepolia`, `base-sepolia`, `arbitrum-sepolia`). Telcoin Adiri (`telcoin-adiri`, chain 2017) is **off by default**: add it here, and it is used only while the gateway also lists it as served. |
| `CERTEN_ALLOW_ANY_CHAIN` | Exactly `1` skips chain-name checking, for a chain the gateway serves that this catalogue does not list. |
| `CERTEN_ACCUMULATE_RPC` | An Accumulate JSON-RPC endpoint (e.g. `https://kermit.accumulatenetwork.io/v3`) for the independent key page read in `certen_readiness`. Unset, the endpoint the gateway's own chain registry advertises is used. It is **server configuration, never a tool argument**: no tool takes a node to call. |
| `CERTEN_RPC_URL_<CHAIN>` | A node **you** trust on one chain, e.g. `CERTEN_RPC_URL_BASE_SEPOLIA=https://…` (the slug upper-cased, anything else an underscore). With one, `certen_receipt` for that chain reads the recipient's balance before and after the execution block and compares the proof's block header itself, so a transfer can be **confirmed** and the receipt **verified**. Its chain id is checked first; only its host is ever shown, never the URL (hosted nodes put a key in it). `certen_chains_enabled` reports `receiptNode` per chain. Unset, a transfer's effect stays `unchecked`. |
| `CERTEN_SHARE_ORIGINS` | Comma-separated origins (e.g. `https://gateway.other.example`) whose proof **share links** `certen_proof_verify` may open, besides this server's own gateway. A link on any other origin is refused before a request (`SHARE_ORIGIN_NOT_ALLOWED`); a bare `cps_` token is the configured gateway's. Needed only to verify a proof shared from a *different* deployment. |

A chain name is checked against the SDK's catalogue before anything is sent (`certen_quote`, `certen_billing_register_payer`,
`certen_identity_create`, `certen_readiness`, `certen_receipt`, and every chain named in an intent opened with `certen_transaction_open`). A typo or an unlisted chain
comes back as `UNSUPPORTED_CHAIN` naming the alternatives; `certen_chains_enabled` lists what is usable now. The gateway's own
answer for an opt-in chain is told apart: not listed at all is `unknown_chain`, listed but switched off is `chain_not_enabled`.

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
| `certen_readiness` | **Can this identity, on this chain, act right now?** One call: ordered checks, a `fix` in words for each, never `ready` over an `unknown`. |
| `certen_receipt` | **What happened to this intent?** One call: the ids to keep, the proof verified here layer by layer, and what of the effect is established. |

### Ready? and what happened?

These two replace what an agent otherwise stitches together from five and four calls, and say what they could **not** establish.

**`certen_readiness { identityId, chain, keyHash?, amount?, tokenSymbol? }`** returns the SDK's `client.readiness()`: `gateway`, `credential`, `identity`, `chain`,
`key page`, `accumulate credits`, `gateway balance` and `gas`, in dependency order, each `ok` · `warn` · `fail` · `unknown` · `skipped` with a stable `code` and a
`fix.text`. Gate on `state`: `ready`, `blocked` (read `first_blocker`) or `unconfirmed` (nothing failed, something could not be answered; **not** ready). Give `keyHash`
(the SHA-256 of the signing key's *public* key, never the key) and the key page is read from an Accumulate node as well as from the gateway; two reads that disagree
are a blocker. The gas check is an estimate and says so. A wei-looking `amount` is refused before any request.

**`certen_receipt { intentId, header?, transfer?, call? }`** returns the receipt `certen receipt --json` returns (`docs/CLI-CONTRACT.md` section 10). `verdict` is
`verified` · `partial` · `failed` · `pending` · `unproven`, and `gaps` names what is not established; PARTIAL and NO EVIDENCE are never verified, and a proof service that
answers 5xx is `unavailable`, not "no evidence". The proof's execution layer stays `not_checked` until you pass `header` (`{ receiptsRoot, hash?, number? }`), the block header
you fetched from **your own node**; a header with no `receiptsRoot` compares nothing and is refused. Say what the intent was and the receipt can say what of its effect is
established: `transfer { chain, to, amount }` for a native transfer (where the operator set `CERTEN_RPC_URL_<CHAIN>` the server reads the recipient itself and the effect can be `confirmed`; otherwise it cannot, so the effect is `unchecked` and the receipt is not `verified` until you have read the recipient yourself),
`call { chain, expect: { address, topic0 } }` for a contract call (the event is looked for in the proof's own execution receipt). It does not wait (`certen_execute_wait` first),
and it writes nothing: the CLI keeps receipts in `~/.certen`, this server keeps no state.

Neither takes a node to call. The server never connects to a JSON-RPC node a caller names, which is why there is a `header` argument and not an `rpc` one, and why an `rpc` (or `url`, `node`, …)
passed anyway is refused by name (`NODE_ARGUMENT_REFUSED`) rather than silently ignored. No tool lets a caller choose a host at all: a proof *share link* is the only URL-shaped thing
a caller hands over, and `certen_proof_open_shared` takes only its token and asks this server's own gateway, while `certen_proof_verify` opens a link only on that gateway or an origin the
operator listed in `CERTEN_SHARE_ORIGINS`, and refuses to be redirected off it.

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
