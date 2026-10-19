import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 1 of 3 of the null-before-the-value corpus (RB9-F6, step 3): every member of every object path class given a null before its value and a null between two copies of it; judged by Go (xtsgen nulldup, validator ba4b70f; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '9bb9f8c71c7d222da6063db259a5d03cd6a1bb68752cdf632066afaf10d20fd9', 25, 'go-written/bytes-cases-nulldup-0.json.gz');
