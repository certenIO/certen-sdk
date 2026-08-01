# Vendored gateway spec

`openapi.json` is a verbatim copy of the CERTEN Gateway's own OpenAPI document, fetched from
`https://gateway.kompendium.co/docs/json`.

It is the **single source of truth** for everything generated in this repo:

| Generated artifact | Consumer |
|---|---|
| `packages/sdk/test/fixtures/openapi-contract.json` | the contract test — does what the SDK sends match what the API accepts |
| `llms.txt` | agents building **on** CERTEN — quickstart and rules |
| `llms-full.txt` | agents building **on** CERTEN — full API digest |

## Refreshing

```bash
npm run spec:refresh    # the ONLY step that touches the network
npm run agentgen        # rebuild everything derived from it
```

Commit the spec diff and the regenerated artifacts **together**. Reviewing them side by side is the
point: an API change should be visible as a change to the docs and the test fixture, in the same
commit, rather than showing up months later as an agent confidently calling an endpoint that moved.

`npm run agentgen:check` runs in CI and fails if any artifact is out of date.

## Why vendored

A unit suite that reaches the network fails for reasons that have nothing to do with the code under
test. Vendoring also means the spec is versioned: `git log spec/openapi.json` is the gateway's API
history as this repo saw it.

The document is stored pretty-printed rather than as the single line the gateway serves, so that the
diff of an API change is reviewable.
