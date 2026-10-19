import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 2 of 3 of the null-before-the-value corpus (RB9-F6, step 3): every member of every object path class given a null before its value and a null between two copies of it; judged by Go (xtsgen nulldup, validator ba4b70f; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '888e8b3ce6e08869b8b683c5930714837098db0282dacbb6e9c8bb1d6334be85', 25, 'go-written/bytes-cases-nulldup-1.json.gz');
