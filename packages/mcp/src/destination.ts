import type { TransactionDestination, TransactionResponse } from '@certen.io/sdk';

/**
 * The destination transaction, with whose word it is.
 *
 * The gateway returns `destination` on a transaction: the one transaction the intent made on its destination chain, `source: 'validators'`. That is the
 * VALIDATORS' record, not a fact the gateway checked and not the proof; the proof artifact is what lets anyone check it against the chain. A hash an agent
 * reads out of a tool result and repeats to a person ("your transfer is 0xabc...") is read as established, so the caveat travels with the field, in the
 * same result, in text and in structured output, rather than living only in a description the agent read an hour earlier.
 *
 * The caveat is added only where there is a destination to caveat. A null or absent one is "not yet recorded" (or, for an intent on several chains,
 * "none is named as the destination"), and a note on nothing would read as a warning about something that is not there.
 */

/** What the note says. Tests look for the phrase, so a rewording is a visible change. */
export const DESTINATION_NOTE =
  'Destination transaction as recorded by the validators; not verified by the gateway. It is the validators\' statement of the hash, not proof that anything '
  + 'happened on the destination chain: the execution proof (certen_proof_verify, or `proof` in certen_receipt) is what lets anyone check it against the chain.';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The note for this transaction, or nothing when it names no destination. */
export function destinationNoteFor(transaction: unknown): { destination_note?: string } {
  return isRecord(transaction) && isRecord(transaction.destination) ? { destination_note: DESTINATION_NOTE } : {};
}

/** The transaction as the gateway returned it, plus the note when it carries a destination. Everything else is untouched. */
export function withDestinationNote<T extends object>(transaction: T): T {
  const note = destinationNoteFor(transaction);
  return note.destination_note === undefined ? transaction : { ...transaction, ...note };
}

/** The same for a page of them (`certen_transaction_list`). A result that is not a page is returned as it came. */
export function withDestinationNotes<T extends object>(page: T): T {
  const transactions = (page as { transactions?: unknown }).transactions;
  if (!Array.isArray(transactions)) return page;
  return { ...page, transactions: transactions.map((t) => (isRecord(t) ? withDestinationNote(t) : t)) };
}

/**
 * What `certen_receipt` adds to the receipt: the gateway's destination record (null when it has none) and, with one, the note.
 * The receipt's own `ids.destination_tx` says where ITS hash came from (`destination_tx_source`: the verified proof, or the validators); this is the
 * gateway's single record of the destination, including what the validators say became of it (`settlement`, e.g. `reverted`), which the receipt does not carry.
 */
export function receiptDestination(transaction: TransactionResponse): { destination: TransactionDestination | null; destination_note?: string } {
  const destination = isRecord(transaction.destination) ? (transaction.destination as TransactionDestination) : null;
  return { destination, ...destinationNoteFor(transaction) };
}
