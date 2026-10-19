import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 3 of 6 of the duplicate-key-with-another-value corpus (RB9-F6, review V-Q D1): every member of every object path class given a second occurrence of its key, before and after it, with each right-typed value that differs from its own; judged by Go (xtsgen dupdiff, validator c93f5ac; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '9ee92284583f7cf10f3ec3ac870625ee52cd9e0e6f9e388a41bb65b9d0b52756', 25, 'go-written/bytes-cases-dupdiff-2.json.gz');
