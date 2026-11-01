# Guide — Receiving webhooks

**Subscribe to events instead of polling, and know that each one came from CERTEN.** The gateway pushes
`transaction.completed`, `inbox.action_pending` and the rest to a URL you register. Every delivery is signed;
the SDK verifies the signature for you.

```
  gateway                                                    your receiver
  ───────                                                    ─────────────
  event happens ── POST body + X-Certen-Signature ─────────▶ verify (secret + raw bytes)
                                                             │  ├─ fails  → answer 400, do nothing
                                                             │  └─ holds  → handle it, answer 2xx
                   ◀──────────────────────── 2xx ────────────┘
  no 2xx → retried with backoff, then parked in the dead-letter queue (see "When a delivery goes missing")
```

## 1. Register an endpoint and keep the secret

```ts
import { CertenClient } from '@certen.io/sdk';
const certen = new CertenClient({ apiKey: process.env.CERTEN_API_KEY! });

const endpoint = await certen.webhooks.register({
  url: 'https://example.com/webhooks/certen',
  eventTypes: ['transaction.completed', 'transaction.failed'], // omit for everything
});
console.log(endpoint.secret); // shown ONCE — store it in your secret manager now
```

**The signing secret is returned once and never again.** Without it you cannot tell a real delivery from
anything else that finds your URL. Pass your own `secret` to `register` to keep it out of a response body
altogether. Registration sends a verification ping (event `webhook.verify`); answer it with a 2xx like any
other delivery.

## 2. Verify every delivery

The one rule: **verify the raw bytes that arrived, not a parsed-and-reserialized copy.** The gateway signs
`t + "." + body`, and the body it sends is the payload's canonical JSON (keys sorted, no whitespace). Any
framework that parses the body before your handler runs has already thrown away the thing that was signed.

### Fetch-style runtimes — Next.js route handlers, Hono, Cloudflare Workers, Bun, Deno

```ts
import { constructWebhookEventFromRequest, isWebhookEvent, CertenWebhookSignatureError } from '@certen.io/sdk';

export async function POST(request: Request): Promise<Response> {
  try {
    const hook = await constructWebhookEventFromRequest(request, process.env.CERTEN_WEBHOOK_SECRET!);

    if (isWebhookEvent(hook, 'transaction.completed')) {
      await settle(hook.payload.intent_id, hook.deliveryId); // hook.payload is typed
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof CertenWebhookSignatureError) return new Response(err.reason, { status: 400 });
    throw err; // anything else — including a missing secret — is YOUR bug: let it be a 500
  }
}
```

`constructWebhookEventFromRequest` reads the body with `arrayBuffer()`. Do not call `request.json()` or
`request.text()` first: the body can be read once.

### Node `http` and Express

```ts
import express from 'express';
import { constructWebhookEvent, CertenWebhookSignatureError } from '@certen.io/sdk';

const app = express();

// express.raw, NOT express.json, on this route: you need the bytes, not an object.
app.post('/webhooks/certen', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const hook = constructWebhookEvent({
      body: req.body,                 // a Buffer
      headers: req.headers,
      secret: process.env.CERTEN_WEBHOOK_SECRET!,
    });
    // ... handle hook.type / hook.payload ...
    res.status(204).end();
  } catch (err) {
    if (err instanceof CertenWebhookSignatureError) return res.status(400).json({ error: err.reason });
    throw err;
  }
});
```

If `express.json()` is mounted globally and you cannot change that, `verifyWebhookSignature({ payload: req.body, … })`
rebuilds the canonical form from the parsed object. It works for ordinary payloads, but it is only as faithful
as the parse (a number beyond 2^53 or a duplicate key is already altered), so prefer the raw route.

### Verify without parsing

```ts
import { verifyWebhookSignature } from '@certen.io/sdk';

const v = verifyWebhookSignature({ body: rawBytes, headers, secret });
if (!v.ok) console.warn(v.reason, v.hint); // returns data; never throws for a bad request
```

## What the signature covers

`t` and the body — nothing else. `X-Certen-Event`, `X-Certen-Delivery` and `X-Certen-Timestamp` are ordinary
headers. Someone who captures one valid delivery can replay it inside the tolerance window with a different
`X-Certen-Event` attached. So:

- `hook.payload` and `hook.timestamp` are authenticated. `hook.type` and `hook.deliveryId` are **not**: use
  `type` to route, and let the handler act on what is in `payload` (every transaction event carries its own `status`).
- The window is `±300` seconds by default (`toleranceSeconds`). A signature that is authentic but outside it is
  reported as `timestamp-outside-tolerance`, which means a replay or a clock problem — never a forgery.
- The body is `{ … }` — the payload alone. There is no `{ event, data }` envelope; the event name is the header.
  (Older descriptions of this format show an envelope and a bare-hex signature over `JSON.stringify(payload)`.
  That is not what the gateway sends.)

## Do it once: deliveries repeat

The gateway retries any delivery that does not get a 2xx, and `webhooks.redeliver(id)` sends one again on
purpose. `X-Certen-Delivery` (`hook.deliveryId`) is **one value per delivery, the same on every retry and on a
redelivery**, which makes it the right idempotency key. Store it with the effect and refuse a repeat. Treat it
as a dedupe key, not as proof of anything: it is unsigned.

Two events can also legitimately follow each other for one intent: a `transaction.failed` with
`reason_code: 'expired'` can be followed by `transaction.completed` for the same `intent_id`. The later event
is authoritative.

Answer quickly and do the work after you have answered: the gateway gives up on a slow endpoint, and an
endpoint that keeps failing is switched off.

## Rotating the secret

`webhooks.rotateSecret(id)` invalidates the old secret **immediately**: the gateway signs the very next delivery
with the new one, and signs every retry of an earlier delivery afresh with it too. Until your receiver holds the
new value, those deliveries fail verification.

- **No window — choose the secret yourself.** Pick a new one (16 to 255 characters), deploy a receiver that
  accepts both, then rotate with your value, then drop the old one once deliveries verify against the new:

  ```ts
  // 1. deploy:  secret: [newSecret, oldSecret]   (hook.verification.secretIndex says which one matched)
  await certen.webhooks.rotateSecret(endpointId, { secret: newSecret }); // 2. rotate
  // 3. later: secret: newSecret
  ```

- **Let the gateway generate it.** `rotateSecret(id)` returns the new secret once. Deliver it to the receiver
  quickly: a delivery that failed in the gap is retried and recovers, but only if you are faster than the retry
  schedule. It is **not** retry-safe without your own value — a second call invalidates the first one's secret.
- **Two endpoints.** Register a second endpoint at the same URL with a secret of your own, wait for a delivery to
  verify on it, then `remove` the first. Both deliver while both exist, and each has its own `X-Certen-Delivery`,
  so dedupe on the payload's own id (`intent_id`, `pending_action_id`) rather than the header during the overlap.

## Try your receiver before the first real event

```ts
import { signWebhookPayload } from '@certen.io/sdk';

const signed = signWebhookPayload(secret, { intent_id: 'i-1', status: 'completed' }, {
  event: 'transaction.completed',
  deliveryId: crypto.randomUUID(),
});
await fetch('http://localhost:3000/webhooks/certen', {
  method: 'POST',
  headers: signed.headers,
  body: signed.canonicalPayload,   // exactly this string — the signature is over these bytes
});
```

From a shell, with the secret in a file or `CERTEN_WEBHOOK_SECRET` (never a flag — it would land in your shell history):

```bash
certen webhooks sign --payload '{"intent_id":"i-1","status":"completed"}' --event transaction.completed --secret-file ./whsec
certen webhooks check-signature --signature 't=1716624000,v1=…' --body-file ./captured-body.json --now 1716624000
```

## When a delivery goes missing, or is rejected

```ts
const { deliveries } = await certen.webhooks.deliveries({ limit: 20 });
// last_error and response_status say why; dlq_at is set once the retries ran out
await certen.webhooks.redeliver(deliveries[0].id);   // sends it again (not retry-safe — make your handler idempotent first)
```

**"Is my secret the right one?"** `webhooks.checkDelivery(id, secret)` fetches the delivery, which records
what the gateway signed on its last attempt, and reproduces the signature locally. The secret never leaves
your machine.

```ts
const check = await certen.webhooks.checkDelivery(deliveryId, process.env.CERTEN_WEBHOOK_SECRET!);
// { ok: true }  → that secret signed it: the fault is in how your receiver gets the body
// { ok: false, reason: 'signature-mismatch' } → wrong or rotated-away secret, or another endpoint's
```

`certen webhooks check-delivery <id>` does the same from a shell.

| `reason` | Means | Usually |
|---|---|---|
| `missing-signature` | No `X-Certen-Signature` header | A proxy stripped it, or the handler reads another header name |
| `malformed-signature` | Present, but not `t=<unix>,v1=<64 hex>` | Something rewrote the header |
| `unsupported-version` | Only a signature version this SDK does not know | The gateway is newer: upgrade `@certen.io/sdk` |
| `signature-mismatch` | No `v1` matches the body and secret | Wrong secret; **or the body was parsed and reserialized** — read the `hint`, which says when the signature is valid for the canonical form |
| `timestamp-outside-tolerance` | Authentic, but too old or too new | A replay, or a clock that is off: sync it |
| `invalid-payload` | The signature held, but the body is not JSON | Not something the gateway sends |

**A missing or too-short secret is an exception, not a failed check** (`WEBHOOK_SECRET_INVALID`). HMAC with an
empty key is perfectly computable, so a receiver that read an unset environment variable as `''` would otherwise
accept a forgery. It fails loudly, on every delivery, so that you notice.

## Events

`WEBHOOK_EVENTS` lists them and `WebhookEventPayloads` types each payload (`isWebhookEvent(hook, name)` narrows to it):
`transaction.completed` · `transaction.failed` · `transaction.executed` · `transaction.proof_unavailable` ·
`governance.completed` · `inbox.action_pending` · `inbox.action_signed` · `webhook.verify` · `billing.payment_received` ·
`billing.charged` · `billing.balance_low` · `billing.deposit_unattributed` · `billing.credit_warning` ·
`billing.account_suspended` · `billing.account_reinstated` · `billing.trial_expiring`.

These types are transcribed from the gateway's event registry, since events are pushed rather than served and
are not in the OpenAPI document. A gateway newer than your SDK may send an event or a field this SDK has no
type for: `isWebhookEvent` is then `false` and `hook.payload` is `unknown` — a prompt to upgrade, not an error.
Payloads only grow; a field is never renamed.
