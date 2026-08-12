import { Command } from 'commander';
import { writeFileSync, readFileSync } from 'node:fs';
import { CertenClient, CertenError, type ChainReceipt } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { CliError, UsageError, EXIT } from '../errors.js';

/**
 * `certen proof` — the evidence the whole product exists to produce.
 *
 * Eleven proof endpoints shipped with no CLI surface at all, so retrieving the deliverable meant
 * curl. That is the gap this closes.
 *
 * **The design is shaped by a fact about production: the proof-service and Accumulate fail
 * independently.** `proof/{id}`, `/bundle` and `/custody` come from the proof-service;
 * `proof/tx/{hash}/receipt` is read live from Accumulate. When the proof-service is down the
 * first three return 502 — with a plain-text body — while the receipt keeps working. On the live
 * gateway today, that is exactly the state: every proof-service read 502s and every receipt
 * succeeds.
 *
 * So a command that reported "no proof" on a 502 would be wrong in the most damaging way
 * available: telling someone their evidence does not exist when it does. Every read here falls
 * back to the receipt and says which source answered.
 */

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^(0x)?[0-9a-f]{64}$/i;

/**
 * Pull a 64-hex transaction hash out of whatever the gateway called one.
 *
 * `accum_tx_hash` arrives as a full ACME URL in practice —
 * `acc://<64hex>@campaign-714942.acme/data` — not as a bare hash. Passing that string to
 * `/v1/proof/tx/{hash}/receipt` 404s, and the reason is invisible unless you know the shape.
 */
function extractTxHash(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  return String(value).match(/([a-f0-9]{64})/i)?.[1];
}

/**
 * The verdict, applied identically in both output modes.
 *
 * Shared so that adding an output branch can never again skip it. A verification command that
 * exits 0 on an unverified proof is worse than no command at all.
 */
function failIfNotIncluded(inclusion: boolean): void {
  if (inclusion) return;
  throw new CliError(
    'Inclusion could not be established from this receipt.',
    'INCLUSION_NOT_ESTABLISHED',
    EXIT.FAILED,
  );
}

/** A 5xx means the source is unavailable, which is categorically not "the proof does not exist". */
function isUnavailable(err: unknown): boolean {
  return err instanceof CertenError && err.status >= 500;
}

interface Resolved {
  proofId?: string;
  txHash?: string;
  intentId?: string;
  status?: string;
}

/**
 * Work out what the user gave us and what it points at.
 *
 * Accepts a proof id, an intent id, or a transaction hash, because at the moment someone wants a
 * proof they have whichever of the three their last command printed — and making them work out
 * which kind it is, then pick a matching subcommand, is a step that buys nothing.
 */
async function resolveTarget(client: CertenClient, id: string): Promise<Resolved> {
  if (HEX64.test(id)) return { txHash: id.replace(/^0x/, '') };

  if (!UUID.test(id)) {
    throw new UsageError(
      `"${id}" is not a proof id, an intent id, or a transaction hash. `
      + 'Pass a UUID or a 64-character hex hash.',
      'INVALID_PROOF_TARGET',
    );
  }

  // A UUID could be either a proof id or an intent id. Try it as an intent first: that read is
  // served by the gateway's own database rather than the proof-service, so it answers even when
  // the proof-service is down — and it is the id a user is far more likely to be holding.
  try {
    const intent = await client.transaction.get(id) as unknown as {
      proof_id?: string; accum_tx_hash?: string; status?: string;
    };
    return {
      intentId: id,
      // Empty string, not undefined, is what a proof-less intent actually carries. Every
      // completed intent on the live gateway today has `proof_id: ""`.
      proofId: intent.proof_id || undefined,
      txHash: extractTxHash(intent.accum_tx_hash),
      status: intent.status,
    };
  } catch (err) {
    if (err instanceof CertenError && err.status === 404) return { proofId: id };
    throw err;
  }
}

/** Render a receipt for a human, leading with the field that decides whether it proves anything. */
function describeReceipt(receipt: ChainReceipt): void {
  human('');
  human(`  Accumulate receipt for ${receipt.tx_hash}`);
  human(`    status        ${receipt.status}`);
  human(`    anchored      ${receipt.anchored}`);
  if (receipt.tx_type) human(`    tx_type       ${receipt.tx_type}`);
  if (receipt.principal) human(`    principal     ${receipt.principal}`);
  if (receipt.block_time) human(`    block_time    ${receipt.block_time}`);
  if (receipt.receipt?.anchor) human(`    anchor        ${receipt.receipt.anchor}`);
  human('');
  if (!receipt.anchored) {
    // Delivered and anchored are different claims. Only the second is checkable against a root a
    // counterparty obtained independently, which is the only kind of check that means anything.
    human('  NOT ANCHORED YET — delivered, but there is no inclusion proof to check against a');
    human('  block root until it anchors. Try again shortly.');
    human('');
  }
}

export function registerProofCommands(program: Command): void {
  const proof = program.command('proof').description('Proofs — the evidence you hand a counterparty');

  proof
    .command('get <id>')
    .description('Get a proof by proof id, intent id, or transaction hash')
    .action(async (id: string) => {
      const client = await getClient();
      const target = await resolveTarget(client, id);

      let serviceDown = 0;

      if (target.proofId) {
        try {
          const artifact = await client.proof.get(target.proofId);
          printOutput({ source: 'proof-service', proof_id: target.proofId, proof: artifact });
          if (!isJsonMode()) {
            hint('');
            hint(`Full bundle: certen proof bundle ${target.proofId}`);
          }
          return;
        } catch (err) {
          if (!isUnavailable(err)) throw err;
          serviceDown = (err as CertenError).status;
          if (!isJsonMode() && target.txHash) {
            hint(`The proof-service is unavailable (${serviceDown}). `
              + 'Falling back to the Accumulate receipt, which is read from the network directly.');
          }
        }
      }

      if (!target.txHash) {
        // Three genuinely different situations, and only one of them is "there is nothing here".
        // Reporting a 502 as "nothing found" tells someone their evidence does not exist when it
        // does — the worst available answer, and the one the naive version gave.
        if (serviceDown) {
          throw new CliError(
            `The proof-service is unavailable (${serviceDown}), so proof ${target.proofId} could not `
            + 'be read. This does NOT mean the proof is missing — it means the service that serves '
            + 'it is down. If you have the intent id, its Accumulate receipt is readable directly: '
            + 'certen proof get <intent-id>',
            'PROOF_SERVICE_UNAVAILABLE',
            // Retryable: the proof is presumably fine and the service will come back.
            EXIT.FAILED,
            true,
          );
        }
        throw new CliError(
          target.intentId
            ? `Intent ${target.intentId} is "${target.status ?? 'unknown'}" and carries neither a proof `
              + 'nor an Accumulate transaction hash yet. Wait for it to reach a terminal state: '
              + `certen tx status ${target.intentId} --wait`
            : `Nothing found for ${id}.`,
          'NO_PROOF_AVAILABLE',
          EXIT.FAILED,
        );
      }

      // The receipt path. This is the normal case for governance and authorization transactions,
      // which have no proof_id by design — an empty proof lookup there is not a bug.
      const receipt = await client.proof.receipt(target.txHash);

      // The merkle path is the substance of the receipt and is the point of the JSON output — and
      // it is fourteen sibling hashes, which the table renderer flattens onto one unreadable line.
      // Machines get all of it; the human summary below carries the anchor, which is the part a
      // person actually checks.
      if (isJsonMode()) {
        printOutput({
          source: 'accumulate-receipt',
          tx_hash: receipt.tx_hash,
          status: receipt.status,
          anchored: receipt.anchored,
          tx_type: receipt.tx_type ?? null,
          principal: receipt.principal ?? null,
          block_time: receipt.block_time ?? null,
          receipt: receipt.receipt ?? null,
        });
        return;
      }

      describeReceipt(receipt);
      hint(`Full merkle path: certen --json proof get ${id}`);
      hint(`What this does and does not prove: certen proof verify ${id}`);
    });

  proof
    .command('bundle <proofId>')
    .description('Download the full proof bundle to a file')
    .option('--out <path>', 'Where to write it (default ./proof-<id>.<ext>)')
    .action(async (proofId: string, opts: { out?: string }) => {
      const client = await getClient();
      const { data, contentType } = await client.proof.bundle(proofId).catch((err: unknown) => {
        if (isUnavailable(err)) {
          throw new CliError(
            `The proof-service is unavailable (${(err as CertenError).status}), so the bundle cannot `
            + 'be downloaded right now. The proof is not lost — this is the service that packages '
            + `it. The Accumulate receipt is still readable: certen proof get ${proofId}`,
            'PROOF_SERVICE_UNAVAILABLE',
            EXIT.FAILED,
          );
        }
        throw err;
      });

      // The gateway streams octet-stream for binary downstreams and JSON otherwise, so the
      // extension follows what actually arrived rather than an assumption.
      const ext = contentType.includes('json') ? 'json' : 'bin';
      const path = opts.out ?? `./proof-${proofId}.${ext}`;
      writeFileSync(path, data);

      printOutput({ proof_id: proofId, path, bytes: data.length, content_type: contentType });
      if (!isJsonMode()) {
        hint('');
        hint(`Hand this to your counterparty. What they should check: certen proof verify @${path}`);
      }
    });

  proof
    .command('custody <proofId>')
    .description('Show the custody chain for a proof')
    .action(async (proofId: string) => {
      const client = await getClient();
      const custody = await client.proof.custody(proofId).catch((err: unknown) => {
        if (isUnavailable(err)) {
          throw new CliError(
            `The proof-service is unavailable (${(err as CertenError).status}). Custody is served by `
            + 'that service and has no independent fallback.',
            'PROOF_SERVICE_UNAVAILABLE',
            EXIT.FAILED,
          );
        }
        throw err;
      });
      printOutput(custody as Record<string, unknown>);
    });

  // ── sharing ───────────────────────────────────────────────────────────────────────────────────

  proof
    .command('share <proofId>')
    .description('Mint a link a counterparty can open without an API key')
    .option('--label <label>', 'What this share is for — shown in `proof shares`')
    .option('--expires-in <seconds>', 'Lifetime in seconds', parseInt)
    .action(async (proofId: string, opts: { label?: string; expiresIn?: number }) => {
      const client = await getClient();
      const share = await client.proof.share(proofId, {
        label: opts.label,
        expiresIn: opts.expiresIn,
      });

      printOutput(share as Record<string, unknown>);

      if (isJsonMode()) return;
      human('');
      if (share.url) human(`  ${share.url}`);
      else if (share.token) human(`  Token: ${share.token}`);
      human('');
      // The token is shown once. Saying so after the fact is useless, so say it here.
      human('  This token is shown ONCE. Later reads show only its prefix.');
      if (share.expires_at) human(`  Expires ${share.expires_at}.`);
      hint('');
      hint(`Revoke it: certen proof shares revoke ${share.id ?? '<share-id>'}`);
    });

  const shares = proof.command('shares').description('Share links this organization has created');

  shares
    .command('list', { isDefault: true })
    .description('List every share link, including revoked and expired ones')
    .action(async () => {
      const client = await getClient();
      const result = await client.proof.shares();
      const all = result.shares ?? [];

      if (all.length === 0) {
        printOutput([]);
        hint('No share links yet. Create one: certen proof share <proof-id>');
        return;
      }

      const now = Date.now();
      printOutput(all.map((share) => ({
        id: share.id ?? '-',
        proof_id: share.proof_id ?? '-',
        label: share.label ?? '-',
        // One column for the answer to "can someone use this right now", rather than three
        // timestamp columns the reader has to combine themselves.
        state: share.revoked_at
          ? 'revoked'
          : share.expires_at && new Date(share.expires_at).getTime() < now ? 'expired' : 'active',
        views: share.view_count ?? 0,
        expires_at: share.expires_at ?? '-',
      })));
    });

  shares
    .command('revoke <shareId>')
    .description('Revoke a share link (the proof itself is untouched)')
    .action(async (shareId: string) => {
      const client = await getClient();
      const result = await client.proof.revokeShare(shareId);
      printOutput(result as Record<string, unknown>);
      if (!isJsonMode()) {
        human(`Share ${shareId} revoked. The token no longer resolves; the proof is unaffected.`);
      }
    });

  // ── verify ────────────────────────────────────────────────────────────────────────────────────

  proof
    .command('verify <target>')
    .description('Check a proof, and state plainly what was and was not verified')
    .action(async (target: string) => {
      // A saved bundle is checked as a file; anything else is fetched.
      const fromFile = target.startsWith('@');
      const client = fromFile ? null : await getClient();

      let receipt: ChainReceipt | null = null;
      let bundle: Record<string, unknown> | null = null;

      if (fromFile) {
        const path = target.slice(1);
        try {
          bundle = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        } catch (err) {
          throw new UsageError(
            `Could not read ${path} as a JSON bundle: ${err instanceof Error ? err.message : String(err)}. `
            + 'A binary bundle cannot be checked locally.',
            'UNREADABLE_BUNDLE',
          );
        }
        const hash = extractTxHash(String(bundle.tx_hash ?? bundle.accum_tx_hash ?? ''));
        if (hash) receipt = (bundle.receipt ? bundle : null) as ChainReceipt | null;
      } else {
        const resolved = await resolveTarget(client!, target);
        if (!resolved.txHash) {
          throw new CliError(
            `Nothing to verify for ${target} — no Accumulate transaction hash.`,
            'NOTHING_TO_VERIFY',
            EXIT.FAILED,
          );
        }
        receipt = await client!.proof.receipt(resolved.txHash);
      }

      const inclusion = Boolean(receipt?.anchored && receipt?.receipt?.anchor);

      const summary = {
        checked: {
          inclusion: inclusion ? 'asserted by the gateway' : 'not established',
          authorization: 'NOT CHECKED — requires your own record of what was agreed',
          outcome: 'NOT CHECKED — requires reading the destination chain',
        },
        anchored: receipt?.anchored ?? null,
        anchor: receipt?.receipt?.anchor ?? null,
        tx_hash: receipt?.tx_hash ?? null,
        independent: false,
      };

      // JSON only for the payload: the `checked` object is three sentences the table renderer
      // puts on one line, directly above the rendered version of the same thing.
      //
      // The mode check gates the OUTPUT, never the verdict. An earlier arrangement returned here
      // in JSON mode and so skipped the failure check entirely — `--json proof verify` could not
      // fail, which is the one thing a verification command must be able to do.
      if (isJsonMode()) {
        printOutput(summary);
        failIfNotIncluded(inclusion);
        return;
      }

      human('');
      human('  A verifier should satisfy themselves of three separate things.');
      human('');
      human(`  1. Inclusion      ${inclusion ? 'the gateway returned an anchored merkle receipt' : 'NOT ESTABLISHED — not anchored, or no anchor in the receipt'}`);
      human('  2. Authorization  NOT CHECKED. Compare the operation against your own record of');
      human('                    what was agreed — recipient, amount, target, calldata.');
      human('                    A valid proof of the WRONG call is still a valid proof.');
      human('  3. Outcome        NOT CHECKED. Read the destination chain for the execution.');
      human('');
      // The load-bearing sentence. Everything above came from the gateway, and a verifier who
      // does not trust the gateway has learned nothing by asking it.
      human('  This command asked the GATEWAY. That is not independent verification.');
      human('  To verify without trusting Certen:');
      human('    - query an Accumulate node directly and check the receipt against roots you fetch;');
      human('    - read the execution and its events on the destination chain.');
      human('');

      failIfNotIncluded(inclusion);
    });
}
