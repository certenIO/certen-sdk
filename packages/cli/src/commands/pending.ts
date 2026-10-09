import { Command } from 'commander';
import { CertenClient, CertenSigningDataError, resolveSignTarget, checkCosigning, inspectSigningData, type SignRequestParams } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { resolveSignature, resolveSigner } from '../signer.js';
import { UsageError } from '../errors.js';

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

/**
 * Render a transaction memo for a terminal.
 *
 * The memo is the only field that says what a pending transaction is FOR, and it matters most for
 * the ones the signer did not create — an authority transaction is pending on someone else's
 * account, so without it the inbox offers only `writeData` and an unfamiliar URL.
 *
 * It is also written by whoever built that transaction, who is NOT the person being asked to sign.
 * So it is sanitised before it reaches a terminal:
 *
 * - ANSI/control characters are stripped. A memo carrying escape codes could otherwise repaint the
 *   line, hide text, or forge output that looks like it came from the CLI.
 * - Newlines collapse to spaces, so one row cannot masquerade as several.
 * - Truncated, so a long memo cannot push the rest of the inbox off screen.
 *
 * A missing memo is reported as missing rather than blank — "no memo" is information: it means
 * nobody said why this needs signing.
 */
export function describeMemo(memo: string | null | undefined): string {
  if (!memo) return 'memo: (none given)';
  // eslint-disable-next-line no-control-regex
  const clean = memo.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return 'memo: (none given)';
  return `memo: ${clean.length > 120 ? `${clean.slice(0, 117)}...` : clean}`;
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
      // machineOnly: the generic table flattens `actions[]` into something unreadable, and the
      // memo — the one field that says what each item IS — would be lost in it.
      printOutput(result as unknown as Record<string, unknown>, { machineOnly: true });

      if (isJsonMode()) return;
      const actions = (result as unknown as { actions?: Array<Record<string, unknown>> }).actions ?? [];
      if (actions.length === 0) { human('(nothing pending)'); return; }

      for (const a of actions) {
        // Principal before type: for an authority transaction it is an account the signer does
        // NOT own, and that is the thing worth noticing.
        human(`${a.id}  ${a.type ?? '?'}  ${a.principal ?? ''}`);
        human(`    ${describeMemo(a.memo as string | null | undefined)}`);
        human(`    status=${a.status ?? '?'}  signed=${a.user_has_signed ? 'yes' : 'no'}`
          + (a.expires_at ? `  expires=${a.expires_at}` : ''));
      }
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
    .option('--sign-with <key>', 'Local key (the one for --public-key): rebuild the transaction, check it, show it, then sign and submit in one step. Transaction hashes only')
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
      if (opts.signWith && target.type !== 'pending_tx') {
        throw new UsageError(
          '--sign-with needs a transaction hash: an inbox id does not name the transaction, so there is nothing to check the signing data against. '
          + 'Give the transaction hash (certen pending list shows it), or sign elsewhere after inspecting.',
          'SIGN_WITH_NEEDS_TRANSACTION',
        );
      }
      const signer = opts.signWith ? await resolveSigner(opts.signWith) : null;
      if (signer && signer.publicKey.toLowerCase() !== String(opts.publicKey).toLowerCase()) {
        throw new UsageError(`--sign-with is the key ${signer.publicKey}, but --public-key names ${opts.publicKey}; the signing data is computed for the key named.`, 'SIGNER_KEY_MISMATCH');
      }
      const result = await client.sign.create(params);
      const sd = (result as unknown as { signing_data?: unknown }).signing_data;

      // The signing data is rebuilt and checked here whether or not this command signs: for a transaction named by hash, its own hash, the vote, the
      // signer and the page. With --sign-with a failure ends the command and nothing is signed. Without it nothing is signed here, but the hash this
      // prints is meant for a signer elsewhere, so a failure is reported loudly and the output says the data was NOT checked.
      let summary;
      let unchecked: { code: string; message: string } | undefined;
      try {
        if (target.type === 'pending_tx') {
          summary = await checkCosigning(sd, {
            transactionHash: target.targetId,
            signerPublicKey: opts.publicKey,
            signerKeyPage: opts.signerUrl,
            vote: (opts.vote ?? 'approve') as 'approve' | 'reject' | 'abstain',
          });
        } else if (sd && (sd as { transaction?: unknown }).transaction) {
          summary = await inspectSigningData(sd, { existing: true });
        }
      } catch (err) {
        if (signer || !(err instanceof CertenSigningDataError)) throw err;
        unchecked = { code: err.code, message: err.message };
        hint(`WARNING: the signing data was NOT checked (${err.code}). Do not sign the hash below elsewhere: ${err.message}`);
      }
      if (summary) hint(summary.text.join(String.fromCharCode(10)));

      if (signer) {
        const r = result as unknown as { sign_request_id: string; signing_data: { data_for_signature: string } };
        const submitted = await client.sign.submitSignature(r.sign_request_id, {
          signature: signer.sign(r.signing_data.data_for_signature),
          publicKey: signer.publicKey,
        });
        printOutput({ ...(result as unknown as Record<string, unknown>), ...(submitted as unknown as Record<string, unknown>), signing: summary } as Record<string, unknown>);
        return;
      }
      printOutput({ ...(result as unknown as Record<string, unknown>), ...(summary ? { signing: summary } : {}), ...(unchecked ? { signing_unchecked: unchecked } : {}) } as Record<string, unknown>);

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
        hint(`  certen pending sign ${rawTarget} ... --sign-with <key>   (rebuilds, checks and signs in one step)`);
        hint(`  or, to sign elsewhere after reading the summary above: certen pending submit ${requestId} --signature <hex> --public-key <hex>`);
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
    .option('--sign-with <key>', 'Refused: a bare hash is never signed (use pending sign --sign-with)')
    .option('--hash <hex>', 'Refused: a bare hash is never signed')
    .option('--signature <sig>', 'Signature (hex) — for an HSM or air-gapped signer, made after reading the summary `pending sign` printed')
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
