import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 2 of 4 of the receipt position-field corpus (RB9-F6, V-P): StartIndex, EndIndex and End of a receipt - read by no verifier - at every place a genesis-link document carries a receipt, given every kind of value; judged by Go (xtsgen receiptpos, validator ba4b70f; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '79475bae002935f6658c32d10a9be803ea0cafb37f086fd3bc636cf00bd9c17d', 25, 'go-written/bytes-cases-receiptpos-1.json.gz');
