import { Command } from 'commander';
import { CertenClient, resolveSignTarget, type SignRequestParams } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint, isJsonMode } from '../output.js';
import { resolveSignature } from '../signer.js';
import { UsageError } from '../errors.js';

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

export function registerPendingCommands(program: Command): void {
  const pending = program.command('pending').description('Pending actions inbox');

  pending
    .command('list')
    .description('List pending actions')
    .option('--identity <id>', 'Filter by identity')
    .option('--status <status>', 'Filter by status')
    .option('--category <cat>', 'Filter by category')
    .option('--limit <n>', 'Max results', parseInt)
    .option('--offset <n>', 'Offset', parseInt)
    .action(async (opts) => {
      const client = await getClient();
      const result = await client.pending.list({
        identity: opts.identity,
        status: opts.status,
        category: opts.category,
        limit: opts.limit,
        offset: opts.offset,
      });
      printOutput(result as unknown as Record<string, unknown>);
    });

  pending
    .command('sign <target>')
    .description(
      'Create a sign request for a pending action (inbox id) or a pending transaction (hash or TxID)',
    )
    .option('--identity <id>', 'Identity to sign as (required with a transaction hash)')
    .option('--signer-url <url>', 'Signer URL (required with a transaction hash)')
    .option('--public-key <hex>', 'Public key that will sign, 64-char hex (required with a transaction hash)')
    // Was documented as "accept/reject". The API takes a lowercase `approve` | `reject` |
    // `abstain`; `accept` is rejected. The help text was sending people to a value that fails.
    .option('--vote <vote>', 'Vote: approve | reject | abstain')
    .action(async (rawTarget: string, opts) => {
      // Inferred from the argument, not from a flag: an inbox id is a UUID and a transaction is a
      // 64-hex hash, so the two are disjoint and a --type flag would only be a new way to get it
      // wrong. Resolution happens BEFORE the client is built, so a bad target never opens a
      // connection or reads a key.
      let target;
      try {
        target = resolveSignTarget(rawTarget);
      } catch (err) {
        throw new UsageError((err as Error).message, 'INVALID_SIGN_TARGET');
      }

      let params: SignRequestParams;
      if (target.type === 'pending_tx') {
        // A raw transaction has no inbox row behind it, so nothing derives these. Fail here with
        // the CLI's own usage error rather than letting the gateway answer 400 — the caller can
        // tell "you left a flag out" from "the gateway refused" only if we say so.
        const missing = ([
          ['identity', opts.identity],
          ['signer-url', opts.signerUrl],
          ['public-key', opts.publicKey],
        ] as const).filter(([, v]) => !v).map(([flag]) => flag);
        if (missing.length > 0) {
          throw new UsageError(
            `signing by transaction hash requires --${missing.join(', --')}. `
            + 'An inbox id (UUID) derives these automatically; a raw transaction does not.',
            'MISSING_SIGNER_DETAILS',
          );
        }
        params = {
          type: 'pending_tx',
          targetId: target.targetId,
          identity: opts.identity,
          signerUrl: opts.signerUrl,
          publicKey: opts.publicKey,
          vote: opts.vote,
        };
      } else {
        params = {
          type: 'pending_action',
          targetId: target.targetId,
          identity: opts.identity,
          signerUrl: opts.signerUrl,
          publicKey: opts.publicKey,
          vote: opts.vote,
        };
      }

      const client = await getClient();
      const result = await client.sign.create(params);
      printOutput(result as unknown as Record<string, unknown>);

      if (isJsonMode()) return;
      // This command creates a sign REQUEST; it does not cast the vote. The two-step shape is not
      // obvious from the name, and stopping here leaves the approval uncast.
      const r = result as unknown as {
        sign_request_id?: string;
        signing_data?: { hash_to_sign?: string; data_for_signature?: string };
      };
      const requestId = r.sign_request_id;
      const hash = r.signing_data?.data_for_signature ?? r.signing_data?.hash_to_sign;
      if (requestId && hash) {
        hint('');
        hint('This opened a sign request — the vote is not cast until the signature is submitted:');
        hint(`  certen pending submit ${requestId} --sign-with <key> --hash ${hash}`);
        if (target.type === 'pending_tx') {
          // The signing data was computed FOR the key named by --public-key, and the vote is folded
          // into the preimage. A signature from any other key verifies against nothing, which fails
          // silently — the transaction simply stays pending.
          hint(`  (sign with the key for --public-key ${opts.publicKey}; no other key fits this request)`);
        }
      }
    });

  pending
    .command('submit <id>')
    .description('Submit a signature for a pending sign request')
    .option('--sign-with <key>', 'Local key to sign with (needs --hash)')
    .option('--hash <hex>', 'Hash to sign, from the sign request\'s signing data')
    .option('--signature <sig>', 'Signature (hex) — for an HSM or air-gapped signer')
    .option('--public-key <key>', 'Public key (hex), required with --signature')
    .action(async (id: string, opts) => {
      const { signature, publicKey } = await resolveSignature({
        signWith: opts.signWith,
        signature: opts.signature,
        publicKey: opts.publicKey,
        hash: opts.hash,
      });
      const client = await getClient();
      const result = await client.sign.submitSignature(id, { signature, publicKey });
      printOutput(result as unknown as Record<string, unknown>);
    });
}
