# Changelog — @certen.io/sdk

## 0.3.0 — response types now describe what the API actually returns

**Breaking, at the type level only. No runtime behavior changed.**

Every response interface was camelCase (`intentId`, `signingData.dataToSign`, `adiUrl`,
`creditBalance`). The API is snake_case, and the resources do `return data` with no transformation —
so every one of those declared fields was `undefined` at runtime while TypeScript insisted it was a
`string`. The failure was silent in the worst way: code compiled, ran, and produced `undefined`
somewhere far from the cause.

`execute.*` was never affected. It was written against real responses and reads snake_case directly,
which is why the one flow that had been exercised end-to-end worked while the typed resources did not.

If you were already compensating with `as any` or reading snake_case at runtime, your code was
correct and keeps working — you can now delete the casts. If you were trusting the types, your code
was silently broken and will now fail to compile, which is the point.

### Changed — all response types are snake_case

`IdentityResponse` · `TransactionResponse` · `GovernanceResponse` · `SignResponse` ·
`PortfolioResponse` · `PendingActionsResponse` · `OrgResponse` · `ApiKeyResponse` ·
`ApiKeyListItem` · `AuditLogEntry` · `UsageSummaryResponse` · `ChainAccount` · `ChainBalance` ·
`PortfolioIdentity` · `PendingAction`.

### Changed — `create` and `get` no longer share a type

`POST /v1/transaction` and `GET /v1/transaction/{id}` return different shapes, and one
`TransactionResponse` covering both hid it. Same for governance.

- `transaction.create` → **`CreateTransactionResponse`** (`intent_id`, `signing_data`, `submit_url`, `idempotent`)
- `transaction.get` → `TransactionResponse` (`accum_tx_hash`, `proof`, timestamps)
- `transaction.submitSignature` → **`SubmitSignatureResponse`**
- `transaction.list` → **`ListTransactionsResponse`**. It declared `{ transactions, pagination }`; the endpoint returns `{ transactions, limit, offset }` and has no pagination object.
- `governance.create` → **`CreateGovernanceResponse`**, `governance.submitSignature` → **`SubmitGovernanceSignatureResponse`**
- `sign.submitSignature` → **`SubmitSignSignatureResponse`**
- `identity.retire` → **`DeleteIdentityResponse`**

### Changed — `SigningData` split in two

The two endpoints that return signing data carry the bytes under **different names**, and a single
shared type is what let that go unnoticed:

- **`IntentSigningData`** (`POST /v1/transaction`) — the bytes are in **`hash_to_sign`**
- **`SignRequestSigningData`** (`POST /v1/sign`) — the bytes are in **`data_for_signature`**

Both mean the same thing: sign the RAW BYTES of that hex. Do not hash it again; do not sign its
ASCII. `execute.*` handles the distinction for you.

### Added

- `Identity` and `DeleteIdentityResponse` types; `can_sign` and `error_message` on `Identity`.
  `can_sign` derives from the on-chain key page, not the provisioning state machine, so it can read
  `true` while `status` is still `creating` — check both.
- `user_has_signed`, `required_signatures`, `is_ready`, `identity_url` on `PendingAction`, and
  `stats` on `PendingActionsResponse`.
- **`test/response-shape.test.ts`** — pins every declared response type against the gateway's own
  OpenAPI response schemas. The existing contract test only ever checked the REQUEST direction,
  which is precisely why this drifted. Verified to fail when a camelCase key is reintroduced.
- **`scripts/build-contract-fixture.mjs`** — regenerates the contract fixture from the live spec.
  The old fixture was hand-shaped and captured no responses at all; the test file said "then
  regenerate the fixture" without saying how.

## 0.2.0 — first published version

**0.1.0 was never published.** Three of its methods could not work against the live API. They were found
while preparing the package for release, by comparing what the SDK sends against the gateway's own OpenAPI
spec. Nothing in the existing test suite could have caught them: those tests exercise retry, idempotency,
and error mapping against a local mock that accepts any body, and a mock answering 200 to anything will
never tell you the request was wrong.

### Fixed — methods that could not work

- **`transaction.create` sent no `intent`.** It sent a flat `{ type, to, amount, token, chain, memo }` body.
  `POST /v1/transaction` requires `identity_id` and `intent`, and accepts none of those six fields — so every
  call returned 400. Now takes `{ identityId, intent, contractAddresses?, proofClass?, signerKeyPage?,
  signerPublicKey?, idempotencyKey? }`, matching the API, including multi-leg and `contractCall` intents.
- **`governance.create` omitted both required fields.** It sent `{ identity_id, operation_type, payload }`;
  the API requires `identity` (the ADI, not a uuid) and `operations` (an **array**, so several changes are
  authorized under one quorum). Every call returned 400.
- **`identity.list` called a route that does not exist.** `GET /v1/identities` returns 404 — the gateway has
  no plural collection route. **Removed** rather than shipped as a dead method. Track the ids you create.

### Fixed — silent no-ops

- **`identity.create` no longer sends `webhook_url`.** `POST /v1/identity` does not accept it, and Fastify
  strips unknown properties, so the option did nothing while appearing to work. Set it via `identity.update()`,
  which does accept it. `create` now also supports `signingMode`, `signingProvider`, and `idempotencyKey`.
- **`identity.get` no longer sends an `include` query parameter.** The route takes none; it was ignored.

### Added

- **`identity.retire(id)`** — `DELETE /v1/identity/{id}`, which frees the org's identity quota. Soft delete
  inside Certen only: the on-chain ADI, key book, and key page are untouched.
- **`DEFAULT_BASE_URL` is exported**, and the base URL now resolves `options.baseUrl` → `$CERTEN_API_URL` →
  `https://gateway.kompendium.co`. The previous default was `https://api.certen.io`, which resolves — to the
  Certen marketing site. A client built without an explicit `baseUrl` returned HTML for every call.
- **`test/contract.test.ts`** — validates the request every method produces against a vendored snapshot of
  the gateway's OpenAPI spec: path exists, method exists, required fields present, no field the endpoint
  would strip. This is the guard that would have caught all of the above. Refresh it with the command at the
  bottom of this file when the API changes.
- Publish metadata: `files`, `exports`, `engines`, repository, keywords, `prepack` build, README, LICENSE.

### Changed

- `license` corrected to **MIT**. `package.json` claimed Apache-2.0 while `LICENSE` is MIT.

## Also fixed, in the gateway

Six routes — `/v1/transactions`, `/v1/pending`, `/v1/portfolio`, `/v1/admin/usage`, `/v1/admin/audit-log`,
and `/v1/admin/webhooks/deliveries` — read query parameters but declared no `querystring` schema, so
`@fastify/swagger` emitted no `parameters` and the spec reported that they took none.

The routes worked. The damage was to everyone reading the spec instead of the source: a client generated
from it had no paging at all, and `/v1/pending` silently lost the `identity` and `category` filters a signer
needs to find its own work. All six now declare their parameters, guarded on both sides —
`test/integration/openapi-snapshot.test.ts` in the gateway, and `test/contract.test.ts` here.

Refresh this package's contract fixture after an API change, from the gateway root:

```bash
REGEN_SDK_CONTRACT=1 npx vitest run test/integration/openapi-snapshot.test.ts
```

The fixture is generated from `buildServer()` rather than from the deployed gateway on purpose: the SDK
must be tested against the code it ships beside, not against whatever happens to be live.
