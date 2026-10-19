import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 3 of 3 of the null-before-the-value corpus (RB9-F6, step 3): every member of every object path class given a null before its value and a null between two copies of it; judged by Go (xtsgen nulldup, validator ba4b70f; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'b0b4ffc38b90a298be5375f610b17dbfe134ee99bf9aa92b96443f9158567f40', 25, 'go-written/bytes-cases-nulldup-2.json.gz');
