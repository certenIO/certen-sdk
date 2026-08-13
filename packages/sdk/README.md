# @certen.io/sdk

TypeScript client for the [CERTEN Gateway](https://gateway.kompendium.co/reference) — proof-gated
cross-chain execution on Accumulate.

**Docs: <https://docs.kompendium.co>** · **Get an API key: <https://gateway.kompendium.co/portal>**

```bash
npm install @certen.io/sdk
```

```ts
import { CertenClient } from '@certen.io/sdk';

const certen = new CertenClient({ apiKey: process.env.CERTEN_API_KEY! });

// One call: opens the intent, signs what comes back, submits the signature.
const { intentId } = await certen.execute.transfer({
  identityId,
  adiUrl: 'acc://your-org.acme',
  fromChain: 'accumulate',
  toChain: 'base-sepolia',
  fromAddress: abstractAccount,      // the identity's account on the destination chain
  toAddress: '0xBe00…9251',
  amount: '0.001',                   // WHOLE units, as a string
  sign: (hashHex) => ed25519Sign(hashHex),   // YOU hold the key
});

await certen.execute.wait(intentId);                 // ~60-110s of real validator work
const proof = await certen.execute.proof(intentId);  // hand this to your counterparty
```

Prefer `execute.*` — it is the same flow every integration writes, with the details that are easy to
get wrong already handled. The raw resources are there when you need to drive the steps yourself:

```ts
const opened = await certen.transaction.create({ identityId, intent });
// `signing_data` is absent in provider mode, where the gateway holds the key and there is
// nothing for you to sign.
const hash = opened.signing_data?.hash_to_sign;
if (!hash) throw new Error('provider mode: no signature required from you');
await certen.transaction.submitSignature(opened.intent_id, {
  signature: ed25519Sign(hash),
  publicKey,
});
```

**Your key never leaves your process.** The gateway computes what must be signed and you decide whether to
sign it. That is the supported posture for anything carrying value — see
[the external-signing guide](https://docs.kompendium.co/external-signing.html).

---

## Configuration

```ts
new CertenClient({
  apiKey: 'ck_live_…',           // required
  baseUrl: 'https://…',           // optional — see precedence below
  maxRetries: 3,                  // default 3
  baseBackoffMs: 250,
  maxBackoffMs: 8_000,
  autoIdempotencyKey: true,       // default: every POST gets one
});
```

**Base URL precedence:** `options.baseUrl` → `$CERTEN_API_URL` → `https://gateway.kompendium.co`. The env var
is there so a deployment can be retargeted at staging or a self-hosted gateway without a code change.

## What it does for you

**Automatic idempotency on POSTs.** Every POST gets a generated `Idempotency-Key` so a retried network error
is safe to replay. This matters more than it sounds: without one, a timeout is indistinguishable from success,
and a blind retry can open a second intent or burn identity quota. Opt out per-client with
`autoIdempotencyKey: false`, or per-route with `noAutoIdempotencyRoutes`.

**Retries with backoff, and rate-limit awareness.** Transient failures retry with exponential backoff. On a
`429` the client remembers the reset window and pre-emptively waits rather than hammering.

**Typed errors.** Catch the class you care about instead of matching on status codes:

```ts
import { CertenAuthError, CertenRateLimitError, CertenBadRequestError, CertenServerError } from '@certen.io/sdk';

try {
  await certen.identity.create({ … });
} catch (e) {
  if (e instanceof CertenBadRequestError) { /* your request — fix and retry */ }
  if (e instanceof CertenRateLimitError)  { /* back off; e carries the reset */ }
  if (e instanceof CertenAuthError)       { /* key is wrong, revoked, or lacks the scope */ }
  if (e instanceof CertenServerError)     { /* gateway or downstream — safe to retry */ }
}
```

**Pagination helpers.** `paginate` and `paginateWithTotal` iterate a paged endpoint as an async generator.

## Resources

| | |
|---|---|
| `certen.identity` | `create` · `get` · `update` · `retire` |
| `certen.transaction` | `create` · `submitSignature` · `get` · `list` |
| `certen.sign` | `create` · `submitSignature` |
| `certen.governance` | `create` · `submitSignature` · `get` |
| `certen.pending` | `list` |
| `certen.portfolio` | `get` |
| `certen.admin` | `createOrg` · `createApiKey` · `listApiKeys` · `revokeApiKey` · `rotateApiKey` · `getAuditLog` · `getUsage` |

The gateway serves ~80 endpoints; this covers the integration surface. For anything else, the
[live spec](https://gateway.kompendium.co/docs/json) is authoritative and the client's `request` path will
carry it.

## Three things to know

**Identity creation is asynchronous.** `identity.create` resolves with a `202`-shaped result and provisioning
continues. Poll `identity.get` until the status is terminal, and check `can_sign` before building on it.

**A proof cycle takes ~60–110 seconds.** Real validator work, not a tunable delay. Do not wrap it in a 30s
timeout.

**`vote` is `approve` | `reject` | `abstain`** — a lowercase string, not a number, and not `accept`.

## Guides

- [Onboard an identity](https://docs.kompendium.co/onboard-an-identity.html)
- [Sign while holding your own key](https://docs.kompendium.co/external-signing.html)
- [Proof-gate a contract call](https://docs.kompendium.co/proof-gated-contract-call.html)
- [M-of-N panels](https://docs.kompendium.co/multisig-panel.html)
- [Verify a proof](https://docs.kompendium.co/verify-a-proof.html)

## License

MIT
