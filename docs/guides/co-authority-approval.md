# Guide — A second organisation's approval on an intent account

One organisation (call it **A**) sends intents. A second (**B**: an auditor, a registry, a counterparty) must approve each one before it executes. This is not a panel on one key page ([multisig-panel.md](multisig-panel.md)): B has its own identity, its own key book and its own keys, and the rule lives on A's intent account, so it holds for every intent A writes to it.

The mechanism is Accumulate's own: an account's **authorities** are the key books that must sign for it. Make B's book an authority of A's intent account and every transaction on that account waits for B's vote. Nothing in CERTEN's header fields stands in for this: do not use `additional_authorities` / `--authority` on an intent (the gateway refuses it with `422 HEADER_AUTHORITY_NOT_EXECUTABLE`, because the validators count only the principal's page and the account's authorities, so such an intent would be delivered and never execute).

This guide is what was run end to end on Kermit and Base Sepolia, with two identities in one organisation.

## 1. A makes B's book an authority of its intent account

```bash
certen governance add-authority \
  --identity acc://a-corp.acme \
  --account  acc://a-corp.acme/data \
  --authority acc://b-corp.acme/book \
  --sign-with a-key --yes
```

`/data` is the account intents are written to. The card the CLI shows lists **two** changes:

```
change   {"type":"addAuthority","authority":"acc://a-corp.acme/book"}
change   {"type":"addAuthority","authority":"acc://b-corp.acme/book"}
also keeps   acc://a-corp.acme/book   (already authorities of this account: pinned in the same transaction so the change does not drop them)
```

The first is not an extra authority, it is A's own book being kept. An account with no authorities of its own inherits its ADI's; the first one it is given makes its set explicit, and every inherited one would silently stop governing it unless it is named in the same transaction. The gateway adds A's own book for that reason, and the CLI accepts exactly that and nothing else: any other added, repeated, reordered or foreign operation is refused before anything is signed. If your ADI's root already has other books of its own, the gateway pins those too; the CLI refuses a pin it cannot see is safe unless you name it after confirming it yourself (`--pinned-authority <book>`).

## 2. B accepts being added

The transaction does **not** execute when A signs. Accumulate asks every book that is being added to accept, and the transaction stays `pending` until a key of B's book signs. (It is easy to mistake for a hang: A signs, the gateway reports `pending_signatures`, and the status does not make plain that B is being waited for. Query the transaction on an Accumulate node: it shows a signature request to B's book and none signed.)

B finds it and approves, checking what it approves:

```bash
certen pending list --identity acc://b-corp.acme
certen pending sign <transaction-hash> \
  --identity acc://b-corp.acme --signer-url acc://b-corp.acme/book/1 \
  --public-key <B's key, 64 hex> --vote approve --sign-with b-key --yes
```

`pending sign` rebuilds the transaction from the gateway's bytes, checks the hash it is asked to sign against it, and prints what it would approve before it signs. When it executes, `acc://a-corp.acme/data` lists both books under its authorities (`query` the account on any Accumulate node to see it).

> Needs a gateway whose bridge returns the pending transaction as Accumulate's JSON. Against one that does not, `certen pending sign` stops with `SIGNING_DATA_MISMATCH ... Invalid scheme: undefined` and signs nothing: it will not sign a transaction it cannot rebuild.

## 3. Every intent A sends now waits for B

A sends as usual (`certen call`, `certen tx create`). The intent's governance section declares both books (`authorization.authorities`), A's signature satisfies A's book, and the write to `/data` stays `pending` on Accumulate with a signature request to B's book. B approves **that** transaction the same way:

```bash
certen pending sign <intent's transaction hash> --identity acc://b-corp.acme --signer-url acc://b-corp.acme/book/1 \
  --public-key <B's key> --vote approve --sign-with b-key --yes
```

What B should check before it signs, and what the card shows it: the chain, the target contract, the call data, the value, the events the call must emit, and that the header carries no extra authorities. B compares them with **its own record** of what it expects to approve (for an attestation: that the call data carries the record hash B holds). Both rebuilt from the transaction, not read from the gateway's summary. If B votes `reject`, the transaction is refused and nothing executes.

Then the proof cycle runs as for any intent (minutes, not seconds: about 26 at the median). The intent executes only after both books have signed; it was 37 minutes from A's signature to `completed` including the time B took.

## 4. Seeing that B approved

```bash
certen proof verify <intent-id> --rpc <your node> --expect <emitter>:<topic0>
```

`overall: verified`, and under `G1` both books and both pages:

```
acc://b-corp.acme/book      authority-book
acc://b-corp.acme/book/1    authority-page, voter
acc://a-corp.acme/book      authority-book
acc://a-corp.acme/book/1    authority-page, voter, initiator-signer
authorization mode: authorities_required
```

The same is available to anyone who holds the proof, with no account: `@certen.io/proof-verify`'s `verifyPortableAny` returns those pages and roles from the document's own bytes. See [verify-a-proof.md](verify-a-proof.md).

## What to remember

- Adding an authority needs that authority's acceptance. Plan for B to be waited on, and say so to A.
- B approves each intent, not once. The rule is on the account.
- The authority set an intent declares must equal the one it executed under; the validators refuse an intent that executed under a different set.
- Removing B later is `certen governance remove-authority`. It is a transaction on the same account, and B is an authority of it, so expect it to wait for B's vote too (not run here).
