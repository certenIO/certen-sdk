import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 3 of 4 of the receipt position-field corpus (RB9-F6, V-P): StartIndex, EndIndex and End of a receipt - read by no verifier - at every place a genesis-link document carries a receipt, given every kind of value; judged by Go (xtsgen receiptpos, validator ba4b70f; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '7a6aaeac2be474d3db002767c2866d266e9705cb2b655b71aba7824663e3be6b', 25, 'go-written/bytes-cases-receiptpos-2.json.gz');
