import type { FeeEstimate, SigningSummary } from '@certen.io/sdk';
import { isKnownTestnet } from './chains.js';
import { hint, isJsonMode } from './output.js';
import { CliError, UsageError, EXIT } from './errors.js';
import { commandPrompter, type Prompter } from './prompt.js';
import { describeSource, type Resolved } from './context.js';

/**
 * The confirmation card: the one place a person reads what a signature will authorise, and says yes.
 *
 * Every command that signs (`send`, `call`, `tx create --sign-with`, `governance`, `pending sign`) used to print the rebuilt summary and sign
 * straight away. The summary was always right and nobody could stop it: by the time it was readable the signature was made. This is the same
 * summary with a question after it.
 *
 * **The card adds to the summary; it does not replace it.** `summary.text` ("You are about to sign: …") is what was rebuilt from the
 * gateway's bytes and matched to the request, and it is what a person actually checks the signature against, so it is shown verbatim. Above it
 * the card puts the same thing in the person's own terms (whole units, the recipient in full, what it costs) and says which values the person
 * did not type.
 *
 * **`--yes` and `--json` skip the question, never the check.** The check (`checkIntentSigning`) runs inside the SDK before any signature and has
 * no switch. What `--yes` skips is a person pressing Enter.
 *
 * **Only a person is asked.** Where nobody can answer (no terminal), a command that has always signed unattended keeps doing so, and a new
 * command (`send`) refuses to start rather than sign on nobody's say-so: see {@link assertCanConfirm}.
 *
 * **Mainnet reads differently.** The chain is in capitals, the card says the funds are real, and the answer on a bare Enter is no. A chain
 * nobody can classify gets the same treatment: unknown is not ok.
 */

export interface CardContextValue {
  field: 'identity' | 'key' | 'chain';
  value: string;
  /** Where it came from, in the words the echo uses (`from CERTEN_CHAIN`, `the only key on this machine`). */
  source: string;
}

export interface SigningCard {
  /** What is about to happen, in the person's terms: `Send 0.0001 ETH on base-sepolia`. */
  headline: string;
  rows: Array<[label: string, value: string]>;
  /** The chain the card is about, for the mainnet rule. Absent for a command that is not about one (governance). */
  chain?: string;
  fee?: FeeEstimate | null;
  /** Values the person did NOT type. */
  fromContext: CardContextValue[];
  summary: SigningSummary;
  /** The local key that will sign. */
  keyName: string;
}

export const isMainnetLike = (chain: string | undefined): boolean => chain !== undefined && !isKnownTestnet(chain);

/**
 * The values a command took from context, for the card: only those the person did not type, each with where it came from.
 * `shown` is what the person will recognise (the ADI for an identity whose context value is a UUID).
 */
export function contextValues(entries: Array<{ field: CardContextValue['field']; resolved: Resolved | undefined; shown: string }>): CardContextValue[] {
  return entries.flatMap(({ field, resolved, shown }) => {
    const source = describeSource(resolved);
    return source ? [{ field, value: shown, source }] : [];
  });
}

/** One line for the fee, saying what it is. A figure that is not known is "not available", never a number. */
export function feeLine(fee: FeeEstimate | null | undefined): string {
  if (!fee) return 'not estimated';
  if (fee.state !== 'estimated') return fee.note;
  const platform = fee.platform_fee_usd ? `about $${fee.platform_fee_usd} CERTEN fee` : 'CERTEN fee not in the price book';
  const gas = fee.gas_reserve && fee.gas_symbol ? ` · gas up to about ${fee.gas_reserve} ${fee.gas_symbol}` : '';
  return `${platform}${gas} (an estimate, not a quote${fee.mode === 'quoted' ? '; gas is priced when it executes' : ''})`;
}

/** The card as lines. Pure, so what a person is shown can be tested exactly. */
export function renderSigningCard(card: SigningCard): string[] {
  const mainnet = isMainnetLike(card.chain);
  const lines: string[] = [''];
  lines.push(`  ${mainnet && card.chain ? card.headline.split(card.chain).join(card.chain.toUpperCase()) : card.headline}`);
  const width = Math.max(4, ...card.rows.map(([label]) => label.length), card.fee !== undefined ? 3 : 0, mainnet ? 7 : 0, card.fromContext.length > 0 ? 7 : 0);
  if (mainnet) lines.push(`    ${'network'.padEnd(width)}  NOT A KNOWN TESTNET: this moves real funds`);
  for (const [label, value] of card.rows) lines.push(`    ${label.padEnd(width)}  ${value}`);
  if (card.fee !== undefined) lines.push(`    ${'fee'.padEnd(width)}  ${feeLine(card.fee)}`);
  if (card.fromContext.length > 0) {
    lines.push(`    ${'context'.padEnd(width)}  not typed by you: ${card.fromContext.map((c) => `${c.field} ${c.value} (${c.source})`).join('; ')}`);
  }
  lines.push('');
  for (const line of card.summary.text) lines.push(`  ${line}`);
  lines.push('');
  lines.push('  The signature authorises exactly this: it was rebuilt from the gateway\'s bytes and matched to your request.');
  return lines;
}

/**
 * Refuse BEFORE the passphrase when a command that must be confirmed has nobody to confirm it.
 *
 * `strict` (a new command): no terminal, no `--yes`, not `--json` is an error. `when-interactive` (a command that has always signed
 * unattended): never an error, because refusing would break the scripts that work today. `--json` counts as an answer: the caller who asked
 * for a machine envelope is a program.
 */
export function assertCanConfirm(opts: { yes: boolean; prompter: Prompter; mode: 'strict' | 'when-interactive'; command: string }): void {
  if (opts.mode !== 'strict' || opts.yes || isJsonMode() || opts.prompter.interactive) return;
  throw new UsageError(
    `${opts.command} signs and moves value, and there is no one at a terminal to confirm it. Run it where you can answer, or pass --yes to say yes in advance. `
    + '--yes skips the question, never the check of what is signed.',
    'CONFIRMATION_REQUIRED',
  );
}

/**
 * Show the card and, where a person is there, ask.
 *
 * @returns true to sign. False only when a person answered no.
 */
export async function confirmSigning(card: SigningCard, opts: { yes: boolean; prompter: Prompter }): Promise<boolean> {
  hint(renderSigningCard(card).join('\n'));
  if (opts.yes || isJsonMode() || !opts.prompter.interactive) return true;
  // The default is "yes" on a testnet, where the card has just been read, and "no" on anything else, where an absent-minded Enter must not move funds.
  return opts.prompter.confirm(`  Sign with "${card.keyName}"?`, !isMainnetLike(card.chain));
}

/** The failure for a person who answered no: nothing was signed, and what was opened will expire. */
export function signingDeclined(intentId?: string): CliError {
  return new CliError(
    `Not signed. ${intentId ? `The intent ${intentId} was opened and will expire unsigned; ` : ''}nothing was charged and nothing moved.`,
    'SIGNING_DECLINED', EXIT.FAILED, false, intentId ? { intent_id: intentId } : undefined,
  );
}

/**
 * For the commands that have always signed straight away (`call`, `tx create --sign-with`, `governance`, `pending sign`): show the card and,
 * where a person is at a terminal, ask. Piped, or with `--yes` or `--json`, it shows the card and signs, as those commands always have.
 */
export async function confirmBeforeSigning(card: SigningCard, opts: { yes?: boolean; intentId?: string }): Promise<void> {
  if (!(await confirmSigning(card, { yes: Boolean(opts.yes), prompter: commandPrompter() }))) throw signingDeclined(opts.intentId);
}
