import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 4 of 6 of the duplicate-key-with-another-value corpus (RB9-F6, review V-Q D1): every member of every object path class given a second occurrence of its key, before and after it, with each right-typed value that differs from its own; judged by Go (xtsgen dupdiff, validator c93f5ac; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '58769baadde3ee9148b191abe589ee1e030f82ce8d3139f139620cd386fffaeb', 25, 'go-written/bytes-cases-dupdiff-3.json.gz');
