# `@certen.io/cli`

The `certen` command line for the [CERTEN Gateway](https://gateway.kompendium.co/reference) —
proof-gated cross-chain execution on Accumulate.

**Docs: <https://docs.kompendium.co>** · **Get an API key: <https://gateway.kompendium.co/portal>**

```bash
npm install -g @certen.io/cli
```

## Five minutes, start to finish

```bash
# 1. A key. Generated here, encrypted here, and it never leaves this machine.
certen keys generate --name dev

# 2. An API key from the portal at https://gateway.kompendium.co/portal
certen auth login --api-key ck_live_...

# 3. An identity that your key controls.
certen identity create --name my-org --sign-with dev

# 4. Watch it provision (~20s). Wait for status=active AND can_sign=true.
certen identity get <id>
```

That is the whole onboarding path. Step 3 is the one worth understanding: `--sign-with` derives
the `public_key` and `public_key_hash` from your local key, so the ADI's key page is bound to a
key only you hold.

## Your key never leaves this machine

`certen keys generate` creates an Ed25519 key, encrypts it with a passphrase (scrypt + AES-256-GCM),
and writes it to `~/.certen/keys/<name>.json` with `0600` permissions. The CLI sends **signatures**
to the gateway. It never sends a private key, and there is no code path that could.

```bash
certen keys generate --name dev          # prompts for a passphrase (confirmed)
certen keys generate --name ci --no-passphrase   # unencrypted; file permissions only
certen keys list                         # metadata only — never decrypts
certen keys show dev
certen keys verify dev                   # proves the key decrypts and signs correctly
certen keys sign --name dev --hash <hex> # print a signature, send nothing
certen keys delete dev --yes
certen keys path
```

Set `CERTEN_KEY_PASSPHRASE` to skip the prompt in CI. When it is set and there is no TTY, the CLI
uses it; when neither is available it fails with an explanation rather than hanging on a prompt
nobody can see.

**`certen keys sign` sends nothing anywhere.** It is the air-gapped path: generate on one machine,
carry the hash to it, carry the signature back.

## Signing a transaction

The one-step form opens the intent, signs the returned hash, and submits the signature:

```bash
certen tx create --identity <uuid> --to-chain ethereum-sepolia \
  --to 0xRecipient --amount 1000000000000000 --sign-with dev
```

Or drive the steps yourself — useful when the signer is an HSM, another machine, or your own
policy engine:

```bash
certen tx create --identity <uuid> ...          # returns signing_data.hash_to_sign
certen keys sign --name dev --hash <hash>       # or your HSM
certen tx sign <intent-id> --signature <sig> --public-key <pub>
```

`--signature`/`--public-key` remain first-class. `--sign-with` is a convenience, not a replacement.

## Multi-party approvals

```bash
certen pending list
certen pending sign <id> --identity <adi> --vote approve
certen pending submit <request-id> --sign-with dev --hash <hash>
```

`--vote` takes `approve`, `reject`, or `abstain` — lowercase strings. Not `accept`, and not a
number.

## Everything else

```bash
certen identity get <id> | link-chain <id> --chain <chain>
certen portfolio                                 # balances across every identity and chain
certen tx status <id> | list
certen governance add-delegate | set-threshold
certen admin api-keys list | create | rotate | revoke
certen admin audit-log | usage
```

Run `certen <group> --help` for the flags on any of them.

## Configuration

| | |
|---|---|
| `CERTEN_API_KEY` | API key. Always wins, so CI never touches the keyring or config file. |
| `CERTEN_API_URL` | Gateway base URL. Defaults to `https://gateway.kompendium.co`. |
| `CERTEN_KEY_PASSPHRASE` | Passphrase for local signing keys. |

`certen auth login` stores the API key in your OS keyring by default, or in
`~/.certen/config.json` at `0600` with `--no-keyring`.

## Things that will bite you

**Identity creation is asynchronous.** `identity create` returns `202` and provisioning continues.
Poll until the status is terminal, and check `can_sign` — it derives from the on-chain key page, so
it can read `true` while the status is still `creating`.

**A proof cycle takes 60–110 seconds.** Real validator work, not a tunable delay. Do not wrap it in
a 30-second timeout.

**Sign the bytes, not the text.** If you are producing signatures outside this CLI: sign the raw
bytes of the hash, do not hash it again, and do not sign the ASCII of the hex string. All three
mistakes produce a well-formed 128-hex signature the gateway rejects. `certen keys sign` handles
this for you.

## Documentation

**<https://docs.kompendium.co>** — getting started, authentication, errors, idempotency, and
task-shaped guides: onboarding an identity, external signing, proof-gating a contract call, M-of-N
panels, and verifying a proof.

The [live API reference](https://gateway.kompendium.co/reference) is generated from the running
gateway and is authoritative — when a guide and the spec disagree, the spec is right.

## License

MIT
