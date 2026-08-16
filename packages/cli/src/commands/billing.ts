import { Command } from 'commander';
import { CertenClient, type DepositIntentStatus } from '@certen.io/sdk';
import { getApiKey, getApiUrl, getPortalUrl, getOutputFormat } from '../config.js';
import { printOutput, human, hint, isJsonMode } from '../output.js';
import { CliError, EXIT } from '../errors.js';
import { assertChain } from '../chains.js';

/**
 * Money commands.
 *
 * These exist because the gateway enforces payment on every execution path while
 * no client surface could add funds — so usage accrued against a credit line with
 * no way to settle it. A developer refused for lack of funds needs the fix in the
 * terminal they were already in, not a link to go and read.
 *
 * `fund` never touches a wallet or a private key. It asks the gateway where to
 * send stablecoin, prints that, and waits. Signing and sending stay entirely with
 * the customer's own wallet.
 */

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

/** "12.340000" -> "$12.34". Trims the string; never parses money into a float. */
function usd(amount: string): string {
  const [whole, frac = ''] = String(amount).split('.');
  const neg = whole.startsWith('-');
  return `${neg ? '-$' : '$'}${neg ? whole.slice(1) : whole}.${(frac + '00').slice(0, 2)}`;
}

/** Parse a whole-number option, refusing anything else before a network call is made. */
function intOption(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError(`"${raw}" is not a whole number for ${flag}.`, 'INVALID_NUMBER', EXIT.USAGE);
  }
  return n;
}

function minutesUntil(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
}

export function registerBillingCommands(program: Command): void {
  program
    .command('balance')
    .description('Show your balance and what pending work has already claimed')
    .action(async () => {
      const client = await getClient();
      // One call. The balance carries `remaining_usd` — spendable minus what pending intents will
      // consume — because either number alone misleads: the balance looks healthy while every cent
      // of it is committed to intents awaiting quorum. This used to be two concurrent requests, and
      // it still falls back to the second one against a gateway that does not send the field yet,
      // rather than reporting the flattering number as if it were safe.
      const balance = await client.billing.balance();
      const commitments = balance.remaining_usd !== undefined
        ? {
          remaining_usd: balance.remaining_usd,
          pending_intents: balance.pending_intents ?? 0,
          uncovered_usd: balance.uncovered_usd ?? '0.000000',
        }
        : await client.billing.obligations();

      printOutput({
        currency: balance.currency,
        available_usd: balance.available_usd,
        held_usd: balance.held_usd,
        credit_limit_usd: balance.credit_limit_usd,
        spendable_usd: balance.spendable_usd,
        remaining_usd: commitments.remaining_usd,
        pending_intents: commitments.pending_intents,
        uncovered_usd: commitments.uncovered_usd,
        status: balance.status,
        suspended_reason: balance.suspended_reason ?? null,
        credit: balance.credit ?? null,
      });

      if (isJsonMode()) return;

      human('');
      human(`  Available          ${usd(balance.available_usd)}`);
      human(`  Held for in-flight ${usd(balance.held_usd)}`);
      if (balance.credit_limit_usd !== '0.000000') {
        human(`  Credit line        ${usd(balance.credit_limit_usd)}`);
      }
      human(`  Spendable          ${usd(balance.spendable_usd)}`);
      human(`  Left to commit     ${usd(commitments.remaining_usd)}`);
      human('');

      if (commitments.pending_intents > 0) {
        human(
          `  ${commitments.pending_intents} pending intent(s) have claimed `
          + `${usd(commitments.uncovered_usd)} of that.`,
        );
      }
      if (Number(commitments.remaining_usd) <= 0) {
        human('  You cannot start new work until you add funds.');
        hint('certen fund <amount> --chain <chain>');
      }
      // The two numbers an autonomous caller needs and could not previously see:
      // when a trial ends, and the drawdown at which work stops being accepted.
      // Publishing the threshold is what makes it possible to top up BEFORE
      // being cut off instead of discovering it through a refusal.
      const credit = balance.credit;
      if (credit && credit.kind !== 'none') {
        human('');
        if (credit.expired) {
          human(`  Your ${credit.kind} credit has EXPIRED (was ${usd(credit.granted_limit_usd)}).`);
        } else if (credit.expires_at) {
          const days = Math.max(0, Math.round((new Date(credit.expires_at).getTime() - Date.now()) / 86_400_000));
          human(`  ${credit.label ?? credit.kind} — ${usd(credit.granted_limit_usd)}, ends in ${days} day(s).`);
        } else {
          human(`  ${credit.label ?? credit.kind} — ${usd(credit.granted_limit_usd)} credit line.`);
        }
        human(`  Warning at ${usd(credit.warns_at_usd)} drawn · service stops at ${usd(credit.suspends_at_usd)}.`);
      }

      if (balance.status !== 'active') {
        human(`  Account status: ${balance.status}.`);
        if (balance.suspended_reason) human(`  Reason: ${balance.suspended_reason}.`);
        hint('certen fund <amount> --chain base-sepolia');
      }
    });

  program
    .command('pricing')
    .description('Everything CERTEN charges for, and what it costs')
    .option('--chain <chain>', 'Only operations priced on this chain (plus the "*" fallback)')
    .action(async (opts: { chain?: string }) => {
      // The price list had no client surface at all. `certen quote` prices ONE operation and needs
      // its sku spelled correctly up front — and the names are not guessable: it is
      // `identity.provision`, not `identity.create`. Anyone asking "what does onboarding cost"
      // had to guess a name, read the refusal, and guess again.
      const chain = opts.chain ? assertChain(opts.chain) : undefined;
      const client = await getClient();
      const book = await client.billing.pricing();

      // Filtering to a chain RESOLVES the fallback rather than listing both candidates, because
      // the price book resolves it: a sku with an entry for this chain is charged at that entry,
      // and "*" applies only where there is none. Listing both showed proof.execute at $0.50 (*)
      // and $0.35 (base-sepolia) side by side — two prices for one operation on one chain, with
      // nothing on screen to say which one you would actually be billed.
      const items = chain
        ? book.items.filter((i) => (
          i.chain === chain
          || (i.chain === '*' && !book.items.some((j) => j.sku === i.sku && j.chain === chain))
        ))
        : book.items;

      // Machine output carries the version and hash alongside the items, because a price is only
      // traceable to a charge with them. Human output does NOT go through printOutput: this payload
      // has a nested array, and the generic key/value table renders it as one line of raw JSON.
      if (isJsonMode() || getOutputFormat() === 'json') {
        printOutput({
          price_book_version: book.price_book_version,
          price_book_hash: book.price_book_hash,
          currency: book.currency,
          items,
        });
        return;
      }

      if (items.length === 0) {
        human('');
        human(`  Nothing is priced on ${chain}.`);
        hint('certen pricing   # every chain');
        return;
      }

      const w = Math.max(...items.map((i) => i.sku.length), 3);
      const c = Math.max(...items.map((i) => i.chain.length), 5);
      human('');
      human(`  ${'SKU'.padEnd(w)}  ${'CHAIN'.padEnd(c)}  PRICE`);
      for (const i of items) {
        // The distinction that decides whether the printed number is the answer or a floor:
        // `flat` is all-in, `quoted` measures gas at execution and adds it.
        const price = i.mode === 'flat'
          ? usd(i.platform_fee_usd)
          : `${usd(i.platform_fee_usd)} + gas`;
        human(`  ${i.sku.padEnd(w)}  ${i.chain.padEnd(c)}  ${price}`);
      }
      human('');
      if (items.some((i) => i.mode === 'quoted')) {
        human('  "+ gas" is priced at execution from live chain conditions.');
      }
      if (items.some((i) => i.chain === '*')) {
        human('  "*" applies to any chain without an entry of its own.');
      }
      human(`  Price book ${book.price_book_version}.`);
      hint('certen quote --chain <chain> --sku <sku>   # a binding price for real work');
    });

  program
    .command('quote')
    .description('What a piece of work will cost, before you commit to it')
    .requiredOption('--chain <chain>', 'Chain the work executes on, e.g. base-sepolia')
    .option('--sku <sku>', 'Operation to price, e.g. identity.provision. See: certen pricing')
    .option('--proof-class <class>', 'on_cadence (batched, cheaper) or on_demand (immediate)', 'on_cadence')
    .option('--legs <n>', 'Number of legs in the intent', '1')
    .action(async (opts: { chain: string; sku?: string; proofClass: string; legs: string }) => {
      if (opts.proofClass !== 'on_cadence' && opts.proofClass !== 'on_demand') {
        throw new CliError(
          `"${opts.proofClass}" is not a proof class. Use on_cadence or on_demand.`,
          'INVALID_PROOF_CLASS', EXIT.USAGE,
        );
      }
      const legs = Number(opts.legs);
      if (!Number.isInteger(legs) || legs < 1) {
        throw new CliError(`"${opts.legs}" is not a leg count. Use a whole number of 1 or more.`,
          'INVALID_LEG_COUNT', EXIT.USAGE);
      }

      const chain = assertChain(opts.chain);

      const client = await getClient();
      const q = await client.billing.quote({
        chain,
        sku: opts.sku,
        proofClass: opts.proofClass,
        legCount: legs,
      });

      printOutput({
        quote_id: q.quote_id,
        chain: q.chain,
        proof_class: q.proof_class,
        leg_count: q.leg_count,
        platform_fee_usd: q.platform_fee_usd,
        gas_usd: q.gas_usd,
        total_usd: q.total_usd,
        max_total_usd: q.max_total_usd,
        expires_at: q.expires_at,
        gas_estimate_basis: q.computation?.gas_estimate_basis ?? null,
      });

      if (isJsonMode()) return;

      human('');
      human(`  ${q.chain}  ${q.proof_class ?? 'unclassified'}  ${q.leg_count} leg(s)`);
      human('');
      human(`  Platform fee   ${usd(q.platform_fee_usd)}`);
      human(`  Gas            ${usd(q.gas_usd)}`);
      human(`  Total          ${usd(q.total_usd)}`);
      human(`  Capped at      ${usd(q.max_total_usd)}   (gas above this is on us)`);
      human('');

      // A thin basis is a real caveat, not a footnote: it means the median
      // behind this gas figure rests on very few observations and can move
      // materially. Saying so is the difference between a price and a guess
      // presented as a price.
      if (q.computation?.gas_estimate_basis === 'class_thin') {
        human('  Note: this gas estimate comes from a small sample for this proof class,');
        human('  so it may move as more of this class executes.');
        human('');
      } else if (q.computation?.gas_estimate_basis === 'unclassified_fallback') {
        human('  Note: no cost history for this proof class yet — priced from mixed history.');
        human('');
      }

      hint(`Lock this price: pass quote_id=${q.quote_id} on the transaction (expires ${q.expires_at}).`);
    });

  // ---- Evidence -----------------------------------------------------------------------------
  //
  // "What was I charged, and can I prove it?" The gateway has answered this from the start --
  // signed receipts, transparency-log inclusion proofs, an append-only double-entry ledger -- and
  // no command reached any of it. An audit or finance function had to hand-roll HTTP, which for
  // most of them means the evidence may as well not exist.

  program
    .command('ledger')
    .description('Every balance change, newest first - where the money went')
    .option('--limit <n>', 'How many to fetch (page size with --all)', '50')
    .option('--offset <n>', 'Skip this many')
    .option('--all', 'Fetch every page, not just the first')
    .action(async (opts: { limit: string; offset?: string; all?: boolean }) => {
      const limit = intOption(opts.limit, '--limit');
      const offset = opts.offset === undefined ? undefined : intOption(opts.offset, '--offset');
      if (opts.all && offset !== undefined) {
        throw new CliError(
          '--all starts from the beginning, so --offset has no meaning with it. Use one or the other.',
          'CONFLICTING_PAGING_FLAGS', EXIT.USAGE,
        );
      }

      const client = await getClient();
      const entries = [];
      if (opts.all) {
        // --limit is the PAGE size here, not a cap: the point of --all is to stop thinking about
        // page boundaries.
        for await (const e of client.billing.ledgerAll(limit)) entries.push(e);
      } else {
        entries.push(...(await client.billing.ledger({ limit, offset })).entries);
      }

      if (isJsonMode() || getOutputFormat() === 'json') {
        printOutput({ entries });
        return;
      }
      human('');
      if (entries.length === 0) {
        human('  No ledger entries - nothing has moved on this account yet.');
        return;
      }
      const kw = Math.max(...entries.map((e) => e.kind.length), 4);
      const aw = Math.max(...entries.map((e) => e.account.length), 7);
      human(`  ${'WHEN'.padEnd(20)}  ${'KIND'.padEnd(kw)}  ${'ACCOUNT'.padEnd(aw)}  ${'AMOUNT'.padStart(10)}`);
      for (const e of entries) {
        human(`  ${e.created_at.slice(0, 19).replace('T', ' ').padEnd(20)}  `
          + `${e.kind.padEnd(kw)}  ${e.account.padEnd(aw)}  ${usd(e.amount_usd).padStart(10)}`
          + `${e.memo ? `  ${e.memo}` : ''}`);
      }
      human('');
      human(`  ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}. `
        + 'Corrections appear as new reversing entries, never as edits.');
    });

  const receipts = program
    .command('receipts')
    .description('Signed receipts for every charge, payment, refund and adjustment');

  receipts
    .command('list', { isDefault: true })
    .description('List receipts, newest first')
    .option('--limit <n>', 'How many to fetch (page size with --all)', '50')
    .option('--offset <n>', 'Skip this many')
    .option('--all', 'Fetch every page, not just the first')
    .action(async (opts: { limit: string; offset?: string; all?: boolean }) => {
      const limit = intOption(opts.limit, '--limit');
      const offset = opts.offset === undefined ? undefined : intOption(opts.offset, '--offset');
      if (opts.all && offset !== undefined) {
        throw new CliError(
          '--all starts from the beginning, so --offset has no meaning with it. Use one or the other.',
          'CONFLICTING_PAGING_FLAGS', EXIT.USAGE,
        );
      }

      const client = await getClient();
      const receipts = [];
      if (opts.all) {
        for await (const r of client.billing.receiptsAll(limit)) receipts.push(r);
      } else {
        receipts.push(...(await client.billing.receipts({ limit, offset })).receipts);
      }

      if (isJsonMode() || getOutputFormat() === 'json') {
        printOutput({ receipts });
        return;
      }
      human('');
      if (receipts.length === 0) {
        human('  No receipts yet - nothing has been charged or paid on this account.');
        return;
      }
      human(`  ${'NUMBER'.padStart(8)}  ${'WHEN'.padEnd(20)}  ${'TYPE'.padEnd(12)}  ${'AMOUNT'.padStart(10)}  EVIDENCE`);
      for (const r of receipts) {
        // `signed` and `logged` decide what can be proven, and `logged` in particular decides
        // whether an inclusion proof can be fetched at all.
        const evidence = [r.signed ? 'signed' : null, r.logged ? 'logged' : null]
          .filter(Boolean).join(' + ') || 'pending';
        human(`  ${r.receipt_number.padStart(8)}  ${r.issued_at.slice(0, 19).replace('T', ' ').padEnd(20)}  `
          + `${r.type.padEnd(12)}  ${usd(r.amount_usd).padStart(10)}  ${evidence}`);
      }
      human('');
      hint('certen receipts get <id> --proof   # the full receipt and its inclusion proof');
    });

  program
    .command('verify <receipt-id>')
    .description('Check a receipt yourself, against independently published data')
    .action(async (id: string) => {
      // The receipt already ships a `verification` block, and it is CERTEN checking CERTEN. This
      // command is the difference between being told the evidence is good and confirming it: the
      // digest is recomputed from the body, the signature is checked against the PUBLISHED key set,
      // and the audit path is folded and compared against a tree head fetched separately - not
      // against the root that travelled inside the proof, which would compare the proof to itself.
      const client = await getClient();
      const report = await client.billing.verifyReceipt(id);

      // Emitted as a success envelope only when it actually verified. Anything else throws below
      // and carries the same checks under `error.details`, matching `certen doctor`: the machine
      // interface never has to choose between knowing something is wrong and knowing what.
      //
      // JSON only in this block. The table renderer serialises `checks` to one unreadable line, and
      // the rendered report below is the human answer.
      if (report.verified && (isJsonMode() || getOutputFormat() === 'json')) {
        printOutput({ ...report });
        return;
      }

      human('');
      for (const c of report.checks) {
        const mark = c.status === 'ok' ? 'PASS' : c.status === 'failed' ? 'FAIL' : 'SKIP';
        human(`  ${mark}  ${c.name.padEnd(10)}  ${c.detail}`);
      }
      human('');
      if (report.verified) {
        human('  Verified. Every check reproduced from published data.');
      } else if (report.checks.some((c) => c.status === 'failed')) {
        human('  VERIFICATION FAILED. At least one check did not reproduce.');
      } else {
        // Not a pass. A verifier that could not run every check must never imply one.
        human('  Incomplete - some checks could not be run. This is not a verification.');
      }

      // `process.exitCode` does NOT survive here: run() returns EXIT.OK on any command that did
      // not throw, and the entrypoint assigns that over it. Verified this the hard way — the
      // command printed "this is not a verification" and exited 0, which a CI gate would have read
      // as a pass. Throwing is the mechanism the CLI actually honours.
      const failed = report.checks.filter((c) => c.status === 'failed');
      if (failed.length > 0) {
        throw new CliError(
          `Verification FAILED: ${failed.map((f) => f.name).join(', ')} did not reproduce.`,
          'RECEIPT_VERIFICATION_FAILED', EXIT.FAILED, false, { ...report },
        );
      }
      if (!report.verified) {
        // Incomplete is not a pass. Exiting 0 here would let a script report an unverified receipt
        // as verified, which is the one mistake this command exists to prevent.
        const skipped = report.checks.filter((c) => c.status === 'skipped');
        throw new CliError(
          `Verification INCOMPLETE: ${skipped.map((c) => c.name).join(', ')} could not be checked.`,
          'RECEIPT_VERIFICATION_INCOMPLETE', EXIT.FAILED, false, { ...report },
        );
      }
    });

  receipts
    .command('get <id>')
    .description('One receipt, with its signature and computation')
    .option('--proof', 'Also fetch the transparency-log inclusion proof')
    .option('--tree-size <n>', 'Prove against this tree size instead of the newest anchored head')
    .action(async (id: string, opts: { proof?: boolean; treeSize?: string }) => {
      const treeSize = opts.treeSize === undefined
        ? undefined
        : intOption(opts.treeSize, '--tree-size');
      if (treeSize !== undefined && !opts.proof) {
        throw new CliError(
          '--tree-size only applies to the inclusion proof. Add --proof.',
          'TREE_SIZE_WITHOUT_PROOF', EXIT.USAGE,
        );
      }

      const client = await getClient();
      const receipt = await client.billing.receipt(id);
      // Sequential, not concurrent: without the receipt there is nothing to prove, and a 404 on the
      // id should not also produce a second confusing failure from the proof call.
      const proof = opts.proof ? await client.billing.receiptProof(id, { treeSize }) : undefined;

      // Machine output only. `body`, `computation`, `verification` and `proof` are deep objects,
      // and the generic key/value table renders each as one enormous line of raw JSON — burying
      // the four facts a person actually reads under a screenful of hashes.
      if (isJsonMode() || getOutputFormat() === 'json') {
        printOutput({ ...receipt, ...(proof ? { proof } : {}) });
        return;
      }

      human('');
      human(`  Receipt ${receipt.receipt_number} - ${receipt.type} ${usd(receipt.amount_usd)}`);
      human(`  Issued ${receipt.issued_at}`);
      human(`  Digest ${receipt.digest}`);
      human(receipt.signature
        ? `  Signed ${receipt.algorithm ?? 'ed25519'} by key ${receipt.key_id}`
        : '  NOT SIGNED yet.');
      if (receipt.price_book_hash) {
        human(`  Priced from price book ${receipt.price_book_hash}`);
      }
      if (proof) {
        human('');
        human(`  In the log at leaf ${proof.leaf_index} of ${proof.tree_size}.`);
        // covering_head, not head: `head` is the head at this tree size and may not itself be
        // anchored, while a later anchored root still commits to this leaf. Reporting head's
        // status would call a perfectly good receipt unanchored for every gap between anchors.
        const anchor = proof.covering_head;
        if (anchor?.anchor_status === 'anchored') {
          human(`  Anchored on Accumulate in ${anchor.anchor_tx_hash}`);
          human(anchor.timestamp_attested
            ? `  Existed no later than ${anchor.anchor_block_time} (block timestamp).`
            : `  Existed no later than ${anchor.anchor_block_time} - a loose upper bound, not the block time.`);
        } else {
          human('  Not yet anchored on Accumulate - the proof holds against our signed head only.');
        }
        human('');
        human('  Keep this proof with the receipt. It stays valid forever against that head.');
      } else if (receipt.leaf_seq !== null) {
        hint(`certen receipts get ${id} --proof   # prove it is in the anchored log`);
      }
    });

  // Registering the wallet you pay from. The gateway's own 402 names this as the recommended fix
  // ("register_sender ... makes every future deposit attribute automatically") and no client could
  // do it, so the advice in the refusal pointed at a raw endpoint the reader had to call by hand.
  const payers = program
    .command('payers')
    .description('Wallets whose deposits credit automatically');

  payers
    .command('list', { isDefault: true })
    .description('Show the wallets registered for automatic attribution')
    .action(async () => {
      const client = await getClient();
      const { addresses } = await client.billing.payerAddresses();
      // Machine output only. The generic key/value table renders a nested array as one line of raw
      // JSON — `addresses  []` — which is noise above the readable list below.
      if (isJsonMode() || getOutputFormat() === 'json') {
        printOutput({ addresses });
        return;
      }
      human('');
      if (addresses.length === 0) {
        human('  No wallets registered — deposits need a one-time payment to be attributed.');
        hint('certen payers add <address> --chain base-sepolia');
        return;
      }
      for (const a of addresses) {
        human(`  ${a.address}  ${a.chain}${a.label ? `  (${a.label})` : ''}`
          + `${a.is_active ? '' : '  [inactive]'}`);
      }
      human('');
      human('  Deposits from these credit this organization on sight — no payment intent needed.');
    });

  payers
    .command('add <address>')
    .description('Register a wallet you pay from, so future deposits credit automatically')
    .requiredOption('--chain <chain>', 'Chain the wallet sends on, e.g. base-sepolia')
    .option('--label <label>', 'A name for your own reference')
    .action(async (address: string, opts: { chain: string; label?: string }) => {
      // Checked before the network call: a malformed address would otherwise be rejected by the
      // gateway's pattern with no indication of which of the two arguments was wrong.
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new CliError(
          `"${address}" is not an EVM address. Expected 0x followed by 40 hex characters.`,
          'INVALID_ADDRESS', EXIT.USAGE,
        );
      }
      const chain = assertChain(opts.chain);
      const client = await getClient();
      const record = await client.billing.registerPayerAddress({
        chain, address, label: opts.label,
      });
      printOutput({ ...record });
      if (isJsonMode() || getOutputFormat() === 'json') return;
      human('');
      human(`  Registered ${record.address} on ${record.chain}.`);
      human('  Stablecoin sent from this wallet now credits automatically — any amount, any time.');
      hint('certen balance');
    });

  program
    .command('fund')
    .argument('<amount>', 'Amount in USD to send, e.g. 25 or 25.50')
    .description('Get payment details for adding funds, and wait until they are credited')
    .option('--chain <chain>', 'Chain to send stablecoin on, e.g. base-sepolia')
    // `--wait` is accepted although waiting is already the default, because every other
    // long-running command (`identity create`, `tx create`, `call`) takes it. Someone who learned
    // the flag there types it here and, without this, meets "unknown option" on a command that was
    // about to do exactly what they asked.
    .option('--wait', 'Wait for the deposit to be credited (the default)')
    .option('--no-wait', 'Print the payment details and exit instead of waiting')
    .option('--timeout <minutes>', 'How long to wait for the deposit', '60')
    // Scripted callers legitimately want a different cadence — a CI job funding a
    // test account should not sit on a 5-second loop, and a long unattended wait
    // should poll gently. Exposed rather than hard-coded.
    .option('--poll-interval <seconds>', 'How often to check for the deposit', '5')
    .action(async (
      amount: string,
      opts: { chain?: string; wait: boolean; timeout: string; pollInterval: string },
    ) => {
      if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) {
        throw new CliError(
          `"${amount}" is not a valid amount. Use a number of dollars, e.g. 25 or 25.50`,
          'INVALID_AMOUNT',
          EXIT.USAGE,
        );
      }
      if (!opts.chain) {
        throw new CliError(
          'Which chain will you send on? Pass --chain (e.g. --chain base-sepolia)',
          'CHAIN_REQUIRED',
          EXIT.USAGE,
        );
      }
      // Validated here, with the other pre-flight checks, for the reason the comment below gives:
      // a wrong chain must not be discovered after a real payment intent has been opened against
      // it. `base` and `base-sepolia` are different networks and money sent to the wrong one is
      // not recoverable by anything this CLI can do.
      const chain = assertChain(opts.chain);

      // Every option is validated BEFORE the network call. Checking after would
      // mean a typo in --timeout had already opened a real payment intent that the
      // customer then has to wait out or abandon.
      const timeoutMin = Number(opts.timeout);
      if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
        throw new CliError(
          '--timeout must be a positive number of minutes',
          'INVALID_TIMEOUT',
          EXIT.USAGE,
        );
      }
      const pollSec = Number(opts.pollInterval);
      if (!Number.isFinite(pollSec) || pollSec <= 0) {
        throw new CliError(
          '--poll-interval must be a positive number of seconds',
          'INVALID_POLL_INTERVAL',
          EXIT.USAGE,
        );
      }

      const client = await getClient();
      const target = await client.billing.openPayment({ chain, amountUsd: amount });
      const intent = target.deposit_intent;
      if (!intent) {
        // Defensive: an amount was supplied, so the gateway should have opened one.
        throw new CliError(
          'The gateway did not open a payment for that amount. Nothing was sent; try again.',
          'PAYMENT_NOT_OPENED',
          EXIT.FAILED,
        );
      }

      printOutput({
        reference: intent.reference,
        amount_usd: intent.amount_usd,
        expires_at: intent.expires_at,
        chain: target.chain,
        chain_id: target.chain_id,
        token_symbol: target.token_symbol,
        token_address: target.token_address,
        deposit_address: target.deposit_address,
        min_confirmations: target.min_confirmations,
      });

      if (!isJsonMode()) {
        human('');
        human(`  Send exactly ${intent.amount_usd} ${target.token_symbol} on ${target.chain} to:`);
        human('');
        human(`      ${target.deposit_address}`);
        human('');
        human(`  Reference ${intent.reference} · expires in ${minutesUntil(intent.expires_at)} min`);
        human('  The exact amount is how we know the payment is yours, so send it to the cent.');
        human(`  Credited after ${target.min_confirmations} confirmation(s).`);
        human('');
      }

      // `opts.wait !== false`, not `!opts.wait`. Declaring BOTH `--wait` and `--no-wait` makes
      // commander default the value to undefined rather than true, so the plain `!` test silently
      // stopped this command waiting at all — it printed the payment details and exited 0 on a
      // deposit nobody was watching. Caught by the expiry case in test/billing.test.ts.
      if (opts.wait === false) {
        hint('certen fund --no-wait was used; check later with certen balance');
        return;
      }

      if (!isJsonMode()) {
        human('  Waiting for your deposit. Ctrl-C is safe — the payment stays open.');
      }

      let lastSeen = '';
      const final: DepositIntentStatus = await client.billing.waitForPayment(intent.reference, {
        intervalMs: pollSec * 1_000,
        timeoutMs: timeoutMin * 60_000,
        onPoll: (s) => {
          // Only speak when something changed, so a long wait is not a wall of text.
          if (!isJsonMode() && s.status !== lastSeen) {
            lastSeen = s.status;
            if (s.status !== 'open') human(`  Payment ${s.status}.`);
          }
        },
      });

      if (final.status === 'matched') {
        if (!isJsonMode()) {
          const balance = await client.billing.balance().catch(() => null);
          human(`  Credited ${usd(final.amount_usd)}.`);
          if (balance) human(`  Available now ${usd(balance.available_usd)}.`);
          human('');
          hint('Paying from this wallet again? Register it once in the portal and every '
            + `future deposit credits automatically: ${getPortalUrl()}`);
        }
        return;
      }

      // Not credited. This is an ordinary outcome, not a crash — but the exit code
      // has to say so, or a script will treat an expired payment as funded.
      const why = final.status === 'open'
        ? `still waiting after ${timeoutMin} min`
        : `payment ${final.status}`;
      throw new CliError(
        `Deposit not credited (${why}). Nothing was charged. `
        + 'Check with: certen balance',
        'DEPOSIT_NOT_CREDITED',
        EXIT.FAILED,
      );
    });
}
