/**
 * protocol.Transaction.GetHash for a decoded transaction: H( H(header) || H(body) ), the body's own hash for a WriteData-family
 * body (the merkle root of H(body without its entry) and the entry's hash), and the carried hash for a RemoteTransaction.
 * (accumulate protocol/transaction_hash.go, protocol/data_entry.go, protocol/factom_data_entry.go.)
 *
 * It is needed because a typedData signature signs the whole transaction rather than its hash, so the verifier must bind the
 * transaction it was handed to the hash the governance proof established as executed. It is computed from the decoded bytes
 * with the same field metadata that decodes them, not through accumulate-sdk-opendlt's TransactionBase.hash (which refuses an
 * empty data entry and has no RemoteTransaction rule, both of which Accumulate has).
 */
import { sha512 } from '@noble/hashes/sha2';
import { merkleHashList, sha256 } from '../proof-v2/bytes.js';
import { encodeNode, marshalFactomEntry, type Value, type WireNode } from './wire.js';

export class TransactionHashError extends Error {}

const isNode = (v: Value | undefined): v is WireNode => typeof v === 'object' && v !== null && 'cls' in v && 'fields' in v;
const bytesOf = (v: Value | undefined): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(0));

const WRITE_DATA_BODIES = new Set(['WriteData', 'WriteDataTo', 'SyntheticWriteData', 'SystemWriteData']);

/** FactomDataEntry.MarshalBinary then ComputeFactomEntryHash: sha256( sha512(d) || d ). */
function factomEntryHash(entry: WireNode): Uint8Array {
  const d = marshalFactomEntry(bytesOf(entry.fields.get('accountId')), bytesOf(entry.fields.get('data')), (entry.fields.get('extIds') as Uint8Array[] | undefined) ?? []);
  return sha256(sha512(d), d);
}

function dataEntryHash(entry: WireNode): Uint8Array {
  const data = (entry.fields.get('data') as Uint8Array[] | undefined) ?? [];
  switch (entry.cls) {
    case 'AccumulateDataEntry':
      return merkleHashList(data.map((d) => sha256(d)));
    case 'DoubleHashDataEntry':
      return sha256(merkleHashList(data.map((d) => sha256(d))));
    case 'FactomDataEntryWrapper':
      return factomEntryHash(entry);
  }
  throw new TransactionHashError(`no hash for a data entry of type ${entry.cls}`);
}

export function transactionHash(txn: WireNode): Uint8Array {
  const body = txn.fields.get('body');
  if (!isNode(body)) throw new TransactionHashError('the transaction has no body');
  if (body.cls === 'RemoteTransaction') {
    const h = bytesOf(body.fields.get('hash'));
    return h.length === 32 ? h : new Uint8Array(32);
  }
  const header = txn.fields.get('header');
  const headerHash = sha256(encodeNode(isNode(header) ? header : { cls: 'TransactionHeader', fields: new Map(), extra: new Uint8Array(0), empty: true }));
  let bodyHash: Uint8Array;
  if (WRITE_DATA_BODIES.has(body.cls)) {
    const entry = body.fields.get('entry');
    const withoutEntry = sha256(encodeNode(body, new Set(['entry'])));
    bodyHash = merkleHashList([withoutEntry, isNode(entry) ? dataEntryHash(entry) : new Uint8Array(32)]);
  } else {
    bodyHash = sha256(encodeNode(body));
  }
  return sha256(headerHash, bodyHash);
}
