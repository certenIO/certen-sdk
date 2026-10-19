import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 4 of 4 of the receipt position-field corpus (RB9-F6, V-P): StartIndex, EndIndex and End of a receipt - read by no verifier - at every place a genesis-link document carries a receipt, given every kind of value; judged by Go (xtsgen receiptpos, validator ba4b70f; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '61d02d1be934c1c6dfb2afbe890d419f27269b4601f4875a47674a7c90f308ee', 25, 'go-written/bytes-cases-receiptpos-3.json.gz');
