import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 1 of 4 of the receipt position-field corpus (RB9-F6, V-P): StartIndex, EndIndex and End of a receipt - read by no verifier - at every place a genesis-link document carries a receipt, given every kind of value; judged by Go (xtsgen receiptpos, validator ba4b70f; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '991409c4386c1dd075b5c2385bdddaf3106be426646126a231e0fe8ab6466d67', 25, 'go-written/bytes-cases-receiptpos-0.json.gz');
