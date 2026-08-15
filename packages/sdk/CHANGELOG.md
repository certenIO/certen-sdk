# Changelog — @certen.io/sdk

## 0.7.0 — one response shape, and nulls that stay null

**Breaking.** Requires a gateway from 2026-08 or later. An older gateway sends the previous shape and
this version will not read it; 0.6.0 and a current gateway are likewise incompatible. Upgrade both.
### Changed — `transaction.listAll()` also stops on `has_more`

Every paged list on the gateway now publishes `pagination.has_more`, including `/v1/transactions`,
which previously echoed `limit` and `offset` with no way to tell the last page from a full one.
`listAll()` uses it and falls back to short-page inference against an older gateway.

### Changed — `paginate()` stops on `has_more` instead of guessing

The gateway now returns `pagination: { limit, offset, has_more, returned }` on the ledger, receipts
and payments lists. Eleven list endpoints paged three different ways and six reported nothing at
all, so walking one meant inferring the end from a short page.

That inference is wrong in one specific case, and it fails silently: **a final page that lands
exactly on the page size is indistinguishable from a full one.** So the walk either stops a page
early — reporting a partial ledger as complete, which for a reconciliation is worse than an error —
or spends an extra request discovering an empty page.

`paginate()`, `ledgerAll()` and `receiptsAll()` use `has_more` when it is present and fall back to
short-page inference when it is not, since the SDK is regularly pointed at an older gateway. A
server that reports `has_more: true` while returning no rows now terminates the loop rather than
spinning forever — a hang in an unattended script being worse than a wrong answer.

### Changed — `doctor()` distinguishes an entitlement outage from a component outage

The gateway now reports `entitlement_unpublished` and `entitlement_expired` as not-ready. When no
valid entitlement epoch is published, validators refuse EVERY intent on the fleet — an outage that
stops execution of work that already exists, as opposed to a dry sponsor, which stops identity
creation silently behind a 202. The two need different responses, so `doctor()` names them
differently instead of printing a reason token.

### Added — `fetchSharedProof()`, for the person a share link is FOR

The SDK could create a share, list shares and revoke a share — every operation for the sender — and
had nothing at all for the recipient, who is the reason the feature exists.

`fetchSharedProof(link)` is a standalone export, not a client method, and that is the point: the
endpoint takes no API key because "requiring a Certen credential to verify a Certen proof would
defeat the purpose", and putting the only client-side way to redeem behind a constructor that
demands an `apiKey` would have reimposed exactly that requirement.

Pass the link as received. The origin comes from the link itself — a proof shared from one
deployment is never fetched from another, where the token means nothing and the resulting 404 would
read as "this proof never existed". A bare token works too, with `baseUrl`.

A 410 is surfaced distinctly from a 404: the link WAS real and is now revoked, expired, or out of
views, so the recipient is told to ask for a fresh one rather than that the proof does not exist.
`proof.shared(link)` is the equivalent for a caller who already holds a client.

### Added — `client.health.ready()`, and a `doctor()` check that tells a CERTEN outage from your setup

`doctor()` proved the gateway was there with `GET /v1/chains`. That is a static registry read: it
keeps returning 200 while the database, the api-bridge, the proof service or Accumulate are down. So
a CERTEN-side outage and a broken local setup produced the same report — "gateway reachable: ok" —
and sent the reader hunting through their own configuration for a fault that was never theirs.

The new `platform ready` check reads the public readiness probe and names what is down, with a fix
that says explicitly there is nothing on your side to change.

The case that earns the round trip is `sponsor_below_floor`: when the onboarding sponsor runs dry,
identity creation returns 202 and then **never completes** — every visible signal says it worked.
Nothing else in the report could see it. A low-but-serving sponsor is a `warn` and does not fail the
run, because failing on it would train people to ignore the check.

`health.ready()` does NOT throw on 503. A not-ready answer IS the answer and carries the reasons;
turning it into an exception would discard the only useful part. It needs no API key, so a caller
whose credential is being rejected can still find out whether the platform is the problem.

### Changed — `createAndWait()` uses the cadence the gateway publishes

`POST /v1/identity` now returns a `polling` block: when to make the FIRST request, how often after
that, the typical total, and which statuses are terminal. It was a `status_url` and nothing else,
so every client invented a cadence — this one polled every 3 seconds starting immediately, against
an operation that is a chain of anchored Accumulate transactions and cannot complete in under a
minute. Roughly twenty requests spent before anything could possibly have changed.

An explicit `intervalMs` still overrides it completely, a gateway that sends no `polling` block
falls back to the previous numbers, and the published first-poll delay is clamped to the caller
timeout so a long advertised delay can never overshoot a short budget.

### Added — `client.transparency` and `billing.verifyReceipt()`

The transparency log had no client surface, which made the receipts unverifiable in practice. A
receipt's own instructions say to check its folded root against the signed head at that tree size —
and `/v1/transparency/heads/{treeSize}` was unreachable, so the instruction could not be followed
without hand-rolling HTTP. A verification procedure nobody can run is not a verification procedure.

`client.transparency` exposes `log()`, `heads()`, `head(treeSize)`, `consistency(first, second)`,
`priceBooks()` and `fx(id)`. None require an API key, deliberately: evidence obtainable only by
asking CERTEN could not settle a dispute with CERTEN.

`billing.verifyReceipt(id)` runs the whole procedure and returns a per-check report — digest
recomputed from the body, ed25519 signature checked against the PUBLISHED key set, salted leaf
recomputed, audit path folded and compared against a head fetched **separately**. Comparing the
proof with the `root_hash` that travelled inside it would prove nothing; the independent fetch is
the check.

It never throws for a failed check, and a check it could not run is `skipped` — which leaves both
`verified` and `complete` false. "I could not check" and "it checks out" are the two answers a
dispute must never confuse, so an unreachable log can never produce a pass.

Verified against a real signed receipt on a running gateway: digest, signature, inclusion and root
all reproduce; the anchor check correctly reports `skipped` when no anchored head covers the receipt
yet.

### Added — the evidence trail: `ledger`, `receipts`, `receipt`, `receiptProof`, `verificationKeys`

"What was I charged, and can I prove it?" The gateway has answered this from the start — an
append-only double-entry ledger, ed25519-signed receipts, RFC 6962 inclusion proofs against
Accumulate-anchored tree heads — and none of it had a client surface. For an audit or finance
function, evidence reachable only by hand-rolling HTTP may as well not exist.

- `ledger()` / `ledgerAll()` — every balance change, newest first. Corrections are new REVERSING
  entries, never edits.
- `receipts()` / `receiptsAll()` — each carries `signed` and `logged`; `logged` is what decides
  whether a proof can be fetched at all.
- `receipt(id)` — signature, computation inputs, and the gateway's own `verification` block.
- `receiptProof(id)` — the inclusion proof. **Store it with the receipt**: it stays valid forever
  against a head pinned on Accumulate, so the evidence outlives CERTEN's cooperation.
- `verificationKeys()` — the public keys, so a signature can be checked without trusting the
  response that carried it.

Read `covering_head`, not `head`, when asking whether a receipt is anchored. `head` is the head at
that tree size and may not itself be anchored, while a later anchored root still commits to the
leaf — so `head.anchor_status` reads "unanchored" for every receipt between anchors.

Verified against a real signed receipt from a running gateway using only what these methods return:
the digest recomputes from `body`, the ed25519 signature verifies against the published key, the
salted leaf hash matches, and the six-node audit path folds to `root_hash`. Nothing from the
gateway's own `verification` block was used — that block is CERTEN checking CERTEN, and its worth
is only that every check in it is reproducible, which is now what the SDK makes possible.

The list endpoints report no total and no `has_more`, so `ledgerAll()` and `receiptsAll()` infer
termination from a short page. That lives here once rather than in every caller that gets it subtly
wrong and reports a partial ledger as complete.

### Added — `billing.registerPayerAddress()` and `billing.payerAddresses()`

Register the wallet you pay from once, and every future deposit from it credits automatically — no
payment intent, no exact-amount matching, no expiry.

**The gateway's own 402 recommended this and no client could do it.** The PAYMENT_REQUIRED body
names `POST /v1/billing/deposit-addresses` under `how_to_pay.register_sender`, while this SDK
omitted it on the stated grounds that it required a signed-in portal owner rather than a machine
key. That was wrong — the endpoint authenticates with an API key carrying `billing:write`, which is
exactly what an autonomous caller settling its own refusal is holding. The advice in the refusal
pointed at a raw endpoint the reader had to call by hand.

An address belongs to ONE organization per chain; a duplicate is rejected with a 409 rather than
merged, because ambiguous attribution would credit the wrong customer.

### Changed — affordability is one call, and `doctor()` drops a round trip

`BalanceResponse` now carries `remaining_usd`, `pending_intents` and `uncovered_usd`. **Gate on
`remaining_usd`.** `spendable_usd` ignores work already committed, and CERTEN charges a
multi-signature intent when quorum is reached — which can be weeks after it was opened — so an
account can show a healthy spendable balance that is entirely spoken for and still be refused.

Reading the safe number used to require a second request to `/v1/billing/obligations`. `doctor()`
made exactly that call for exactly that one field; it no longer does, taking it from **5 round trips
to 4**. `obligations()` stays, and is still the way to see WHICH intents claimed the balance.

The fields are optional in the type because an older gateway does not send them. Clients fall back
to `obligations()` when `remaining_usd` is absent rather than treating `spendable_usd` as safe.

### Added — `billing.pricing()`, so prices stop having to be guessed

`quote()` prices ONE sku on ONE chain and needs the sku name up front. Nothing published those
names, and they are not guessable: it is `identity.provision`, not `identity.create`. Finding out
what onboarding cost meant guessing a name, reading the refusal, and guessing again.

`billing.pricing()` returns the whole catalogue in one call — every sku, every chain, and the
`price_book_version` and `price_book_hash` that quotes and receipts also carry, so a price seen here
can be traced through to the charge.

Read `mode` before reporting a number. `flat` means `platform_fee_usd` is the whole charge; `quoted`
means gas is measured at execution and added, so the figure is a floor. `max_charge_usd` is `null`
when uncapped and stays null — it is not flattened to a string or a zero.

Requires a gateway with `GET /v1/pricing` (2026-08 or later).

### Changed — `doctor()` asks the gateway one question once, and overlaps the rest

Measured against the live gateway before and after: **6 round trips to 5**, and **~1570ms to ~1195ms**
of wall time.

The credential check proved the key by reading the balance and then discarded the answer, so the
balance check fetched it again — two of six round trips spent asking one question twice. And the
remaining reads (portfolio, obligations, recent intents) answer unrelated questions but were awaited
one after another, so the command cost their sum.

They now run concurrently and the probe's balance is reused. The checks are still reported in the
same order with the same verdicts — only the I/O overlaps.

This is the command someone runs when they are already stuck, which is the worst moment to spend
latency on nothing.

### Added — `listAll()` iterators that need no adapter

```ts
for await (const tx of certen.transaction.listAll()) { … }
for await (const action of certen.pending.listAll({ identity })) { … }
for await (const { item, index, total } of certen.admin.auditLogAll({ from })) { … }
```

`paginate` has been exported since 0.2.0 and composed with nothing this SDK ships: it takes a
callback returning `{ items }`, and no method returns that shape — `list()` returns
`{ transactions }`, `shares()` returns `{ shares }`. Using it meant hand-writing the adapter it
should have contained, in every caller:

```ts
paginate((limit, offset) =>
  certen.transaction.list({ limit, offset }).then((r) => ({ items: r.transactions })))
```

An exported helper that cannot be used as shipped is worse than none, because it reads as a solved
problem. `paginate` and `paginateWithTotal` remain exported for endpoints the SDK does not model and
for paginating your own API.

`auditLogAll` yields `{ item, index, total }` rather than bare entries — that endpoint returns a real
total, and an audit export is long enough to want a progress line and long enough that a silent
early stop matters.

### Breaking — identity and deposit responses are no longer wrapped

The gateway used to nest the resource under a single key on some endpoints and return it bare on
others, with no rule distinguishing them. Four operations were the odd ones out and have been
flattened.

```ts
// before
const { identity } = await client.identity.get(id);
identity.can_sign;

// after — the response IS the identity, with its sub-resources beside it
const identity = await client.identity.get(id);
identity.can_sign;
identity.governance;          // unchanged: a joined sub-resource stays named
```

Affects `identity.create()`, `identity.get()`, `identity.update()`, `billing.payment()` and
`admin.createOrg()`. `IdentityResponse` now `extends Identity`, so an `IdentityResponse` is usable
anywhere an `Identity` was. `OrgResponse` carries `id` / `name` / `plan` / `created_at` directly.

`createAndWait()` and `execute.*` are unaffected — they return the same values as before.

The change is breaking, and was taken deliberately while there are no external integrators. The
alternatives were to break real callers later or to carry both shapes indefinitely. See the
gateway's `docs/api-conventions.md`.

### Fixed — a field with no value is `null`, not `""`

`proof_id`, `proof_bundle_url`, `accum_tx_hash` and `error_message` were typed `string` and arrived
as `""` when the gateway had no value. The gateway declared them `type: 'string'`, and its serializer
coerces a null to an empty string rather than rejecting it — so `proof_id` was `""` on all 205
intents in the production table, meaning every transaction response ever served.

`""` is falsy, so `if (tx.proof_id)` happened to work. `tx.proof_id != null` did not: it is **true**
for `""`, and that caller went on to request a proof by empty id. Worse for `error_message`, where a
completed transaction reported an error message that was merely empty rather than absent.

These are now `string | null` and the gateway sends a real null.

### Fixed — `can_sign: null` is no longer reported as `false`

`can_sign` is three-valued: `true`, `false`, and `null` meaning *the on-chain key page could not be
read*. The gateway declared it `type: 'boolean'`, and the serializer turned that null into `false` —
collapsing "we could not check" into "this identity cannot sign".

It rounded down rather than up, so nobody was told they could sign when they could not. What was
lost is the distinction: "definitively cannot sign, repair with `identity.update({ publicKey })`"
and "we could not check, retry" have different fixes, and callers were shown the first when the
truth was the second.

### Changed — `waitForPayment` no longer depends on watching the payments feed

The gateway now closes a deposit intent when its payment credits, however the payer was identified.
The feed watch is kept — the SDK is versioned independently and may be pointed at an older gateway,
and a deposit for the wrong amount still credits your balance without ever matching the intent.

## 0.6.0 — diagnosis, proofs, device authorization, and a guard that refuses to strand your money

### Added — `client.doctor()`

An ordered list of checks that **never throws for a failed check** — a diagnosis that cannot report
a broken setup is useless. Read `report.ok` and the per-check status. It catches, in order: gateway
unreachable, a credential rejected (401) or merely unscoped (403), no active identity, an abstract
account with no gas, a balance entirely committed to pending intents, an expired trial, and intents
that anchored but never executed.

The check list is the same length however far the run got, so a skipped check is visibly skipped
rather than absent. `CREDENTIALLED_CHECKS` is exported for callers that need to mark the same set.

### Added — `client.proof`, `client.chains`, `client.device`

`proof` covers the artifact, the bundle, custody, share links, and the Accumulate merkle receipt.
**A 5xx from the proof-service does not mean the proof is missing** — that service and Accumulate
fail independently, and the receipt keeps working when the proof-service does not.

`chains` is the public contract registry and needs no API key, which makes it usable before a
credential exists. `device` is the RFC 8628 device authorization grant, so a terminal can obtain its
own key without a human copying a secret.

### Added — `identity.createAndWait()`

`create()` returns 202 and provisioning continues, so its response says nothing about whether the
identity works. This waits for `status` terminal AND `can_sign === true`, and distinguishes all
three values of `can_sign`: `false` is a failure, `null` is UNKNOWN and never rounds up to ready,
and a timeout is neither success nor failure.

### Behavioural change — `execute.transfer` and `execute.contractCall` refuse an unfunded account

An intent that moves value from an empty abstract account is accepted, signed and submitted — every
call returns success — and then parks at `anchoring` forever, because the execution leg cannot run
on chain. Nothing in any API response says so.

Both methods now check first and throw `CertenUnfundedAccountError` before submitting. **The check
refuses only on a positively observed zero balance**: if the balance cannot be read, the intent
proceeds, because a guard that blocked on missing data would break real work every time the
portfolio view lagged. Opt out with `skipFundingCheck: true`.

It also normalizes the two spellings the gateway uses for a chain id — `GET /v1/portfolio` returns a
slug on some chain accounts and a numeric EVM id on others, in the same response.

## 0.5.0 — balance, funding, and a 402 that carries its own fix

### Added — `client.billing`

Balance, commitments, and adding funds. Two methods worth reading the docstrings for:

`obligations()` returns `remaining_usd` — spendable minus what pending intents will consume — and
that, not `balance()`, is the number to gate work on. A multi-signature intent can wait weeks for
quorum, so an account can hold a balance that is entirely committed and still be refused on its
next call.

`waitForPayment()` polls until a deposit is credited or its window closes, and RETURNS the terminal
status rather than throwing on expiry. An expired payment is an ordinary outcome the caller should
report, not an exception.

Registering a payer address is deliberately absent: it asserts that deposits from a wallet belong to
your organization, so it stays a signed-in owner/admin action in the portal rather than something a
machine key can do.

### Added — `CertenPaymentRequiredError`, and the response body on every error

**Behavioural change: HTTP 402 no longer arrives as `CertenBadRequestError`.** Code that caught
`CertenBadRequestError` to handle payment failures must catch `CertenPaymentRequiredError` instead.
The two were worth separating: nothing is wrong with a refused request — it is priced, valid, and
would succeed once funded — and a host product needs that distinction to choose between a top-up
prompt and a validation message.

The gateway mints a payment target with the refusal, and the SDK was discarding it: `details`
carried only `retryAfter`, so a body containing an address, an exact amount, a reference and a
deep link was reduced to a message string. `CertenError.body` now carries the parsed response for
every error, and the 402 subclass reads it through typed accessors — `shortfallUsd`, `quoteId`,
`resolution`, `portalUrl`, `cliCommand`, `pendingIntents`, `isCommitmentExceeded`, and a `summary`
fit to show a person.

`summary` exists so callers do not each re-derive the sentence and get the commitment case wrong:
under `COMMITMENT_EXCEEDED`, waiting for pending intents to settle frees the same capacity, so
advising only "add funds" is incomplete.

Never retryable, and it must not be retried: only money changes the outcome.


### Fixed — `execute.contractCall()` now works at all

**Breaking, type-level: `contractAddresses` is an object, not `string[]`.**

`execute.contractCall()` sent `contract_addresses: [contractCall.target]`. That field is an OBJECT
naming the CERTEN deployment (`anchor`, `anchorV2`, `abstractAccount`, `entryPoint`, `factory`) — not
your call target, and not a list. The endpoint rejected every such call with
`400 /contract_addresses must be object`, so the method had never worked on any chain.

It is no longer sent at all: the gateway applies the correct defaults. Pass `contractAddresses` only
to target a non-standard deployment.

Verified against production on base-sepolia: opened, signed and submitted, where the same call
returned 400 before.

### Fixed — `CreateIdentityParams.signingProvider` is an object

Declared `string` while the endpoint's schema is `{ type: 'object' }`, so a provider name was
rejected with a 400 naming a field the caller believed they had set correctly.

### Changed — the contract fixture now pins property TYPES

Both bugs above are the same class, and the contract test could not see either: it recorded property
*names* only, so it confirmed `contract_addresses` was an allowed key while the SDK sent it in a
shape the API rejects. The fixture now records each request property's JSON type and
`contract.test.ts` asserts it, with `number`/`integer` handled the way JSON Schema does.

### Fixed — `execute.transfer()` now works at all

**Breaking: `TransferParams.adiUrl` is required.** Not breaking in practice — every call that
omitted it failed, so there is no working code to break.

`execute.transfer()` returned a bodyless `502` on every invocation. The cause was not the gateway
being down: the upstream native-transfer path requires four fields that **do not appear in the
transfer shape the API documents** — `adiUrl`, `id`, `initiatedBy` and `timestamp` — and omitting any
one of them crashes it rather than returning a validation error. `adiUrl` is dereferenced with no
null check (`TypeError`), and `new Date(intent.timestamp).toISOString()` throws `RangeError` on
`undefined`. The equivalent multi-leg path defaults the last three for the caller; this one does not.

The SDK now supplies all four: you pass `adiUrl`, and `id`, `initiatedBy` and `timestamp` are
generated. Verified end-to-end against production — intent opened, signed externally, submitted,
`anchoring` → `completed` in 94s, and the resulting Accumulate transaction confirmed `delivered`
on kermit.

This is a workaround for certenIO/accumulate-api-bridge#1. Once that path defaults the three
generated fields, they become harmless no-ops rather than load-bearing.

`execute.contractCall()` was never affected — it sends the multi-leg shape, which is handled
correctly upstream.

### Changed — `Identity.can_sign` is now `boolean | null`

The gateway changed what this field means, and the type follows.

It used to be derived from a database column — effectively "was a public key supplied" — so it read
`true` from the moment the identity row existed. On 2026-08-01 an Accumulate outage killed
provisioning between "create the ADI under the sponsor key" and "swap the customer's key in",
leaving an ADI on chain held by the **CERTEN sponsor key** rather than the customer. The gateway
reported `status: "error"` and `can_sign: true` for it. On the one failure where the distinction
matters most, the field asserted the reassuring answer.

It is now derived from the on-chain key page: is this identity's key hash actually on it?

- `true` — the key is on the page. The identity can sign.
- `false` — the page was read and the key is not on it.
- **`null` — the page could not be read. Unknown, NOT usable.**

**Treat `null` as "do not proceed".** It is deliberately not `true`: an Accumulate outage is exactly
when a caller most needs to be told the truth is unavailable rather than handed an optimistic
default. If you were doing `if (identity.can_sign)`, that still behaves correctly — `null` is falsy.
If you were doing `if (identity.can_sign === false)`, add the null case.

## 0.4.0 — a reachable timeout, and error codes that match the documentation

Both of these were found by running the SDK against the live gateway. Neither is visible against a
mock that always answers JSON promptly, which is why neither was caught before.

### Added — `timeoutMs` client option

```ts
const certen = new CertenClient({ apiKey, timeoutMs: 90_000 });
```

The per-request timeout was hardcoded at 30s with no way to change it, and the ceiling was reachable
in ordinary use: `execute.proof()` falls back to fetching the Accumulate merkle receipt, which can
take longer than 30s. The call failed as `NETWORK_ERROR` and the caller could do nothing about it —
the SDK reported that a proof could not be retrieved when it existed and was simply slow.

This bounds a single HTTP request. It is not `execute.wait()`, which polls to its own budget
(default 360s).

### Changed — `execute.proof()` gets its own budget, and accepts an override

Proof fetches now allow 120s rather than the client default, and take an override:

```ts
await certen.execute.proof(intentId, { timeoutMs: 30_000 });
```

Retrieving evidence for an already-completed transaction is the call that should wait rather than
fail: nothing is pending on it, and the alternative is telling a caller their proof does not exist
when it does.

### Fixed — errors no longer report codes outside the documented catalog

An error response with no machine-readable `code` now maps to a documented code by HTTP status
(`502/503/504 → BAD_GATEWAY`, `500 → INTERNAL_ERROR`, `404 → NOT_FOUND`, and so on). A `code` the
gateway actually sends always wins; a status with no mapping still reports `UNKNOWN_ERROR`.

Previously any non-JSON error body left `data.code` undefined and produced `UNKNOWN_ERROR`. That is
not hypothetical — an edge-level 502 has a `text/plain` body, so **every edge 502 surfaced as
`UNKNOWN_ERROR`**, and code branching on `BAD_GATEWAY`, exactly as `docs/errors.md` instructs,
silently never matched.

`isRetryable` is derived from the HTTP status and was always correct, so retry behaviour does not
change. Only the reported `code` does. If you were special-casing `UNKNOWN_ERROR` to catch 5xx, you
can now branch on the documented codes instead.

## 0.3.1 — documentation links that work off GitHub

No code changes.

The README linked its guides with repository-relative paths (`../../docs/guides/...`). Those resolve
on GitHub and are **dead on the npm package page**, which renders the README standalone and where
`docs/` is not part of the tarball. Every guide link a reader followed from npm 404'd. They now point
at <https://docs.kompendium.co>, which publishes the same guides.

Also adds the documentation and API-key links to the top of the README, and corrects a link to the
policy signer that pointed at a GitHub org that does not exist.

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
