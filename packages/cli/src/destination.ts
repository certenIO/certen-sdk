import { chainInfo, type TransactionDestination } from '@certen.io/sdk';
import { getOutputFormat } from './config.js';
import { human, isJsonMode, printOutput } from './output.js';
import { printable } from './gateway-text.js';

/**
 * The transaction an intent made on its destination chain, as the gateway reports it.
 *
 * **It is the validators' record, and nothing checked it.** The gateway copies the hash from what the validators wrote down and does not read the
 * chain to confirm it, so every place the CLI shows it says so in the same words ({@link UNVERIFIED}). It is not evidence that the transfer
 * happened: `certen receipt` is what verifies a proof, and it does so separately. Showing the two side by side is deliberate, and so is never
 * letting the first look like the second.
 *
 * Absent or null is normal and renders as nothing in a table: the gateway sends null until the validators have recorded one, and for an intent on
 * several chains (it names one transaction, so it does not guess). In `--json` it stays `null`, so a script never has to probe for the key.
 */

export const UNVERIFIED = 'as recorded by the validators; not verified';

/** The destination of a transaction response, or null when it has none (absent, null, or an object that records nothing). */
export function destinationOf(tx: unknown): TransactionDestination | null {
  const d = (tx as { destination?: unknown } | null | undefined)?.destination;
  if (d === null || d === undefined || typeof d !== 'object' || Array.isArray(d)) return null;
  const record = d as TransactionDestination;
  const says = record.tx_hash || record.chain_id !== undefined || record.settlement;
  return says ? record : null;
}

/** `base-sepolia`, or `chain 84532` for one this client has no name for. */
function chainLabel(d: TransactionDestination): string {
  if (d.chain_id === undefined || d.chain_id === null) return 'destination chain';
  return chainInfo(d.chain_id)?.slug ?? `chain ${printable(d.chain_id, 40)}`;
}

/**
 * The destination as two lines: what the validators recorded, and what that is worth. Empty when nothing was recorded.
 *
 * The label is a line of its own under the values, never omitted when any value is shown: a hash without it would read as a fact.
 */
export function destinationLines(d: TransactionDestination | null): string[] {
  if (!d) return [];
  const tx = d.tx_hash ? `tx ${printable(d.tx_hash, 120)}` : 'no transaction hash recorded';
  const settlement = d.settlement ? `settlement ${printable(d.settlement, 40)}` : 'settlement not stated';
  return [`destination ${chainLabel(d)}   ${tx}   ${settlement}`, `(${UNVERIFIED}; the proof is checked by \`certen receipt\`, not by this)`];
}

/**
 * The same lines as the rows of a receipt, which is where `tx status` puts them too: a `Recorded` label (the receipt's labels are nine wide,
 * and the word is what this is: a record, not a confirmation) and the caveat indented under it.
 */
export function destinationRows(d: TransactionDestination | null): string[] {
  return destinationLines(d).map((line, i) => `  ${(i === 0 ? 'Recorded' : '').padEnd(9)} ${line}`);
}

/** The transaction response without `destination`, which a table would print as one unlabelled JSON line. */
export function withoutDestination(tx: Record<string, unknown>): Record<string, unknown> {
  const { destination: _omitted, ...rest } = tx;
  return rest;
}

/**
 * Print a transaction the way `tx status`, `tx create --wait` and `call` do: the gateway's object for a machine (with `destination` in it,
 * as the gateway sent it), and for a person the table without it, followed by the destination with its label.
 */
export function printTransaction(tx: Record<string, unknown>): void {
  const machine = isJsonMode() || getOutputFormat() === 'json';
  printOutput(machine ? tx : withoutDestination(tx));
  if (machine) return;
  const lines = destinationRows(destinationOf(tx));
  if (lines.length === 0) return;
  human('');
  for (const line of lines) human(line);
}
