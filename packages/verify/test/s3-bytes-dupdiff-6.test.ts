import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 6 of 6 of the duplicate-key-with-another-value corpus (RB9-F6, review V-Q D1): every member of every object path class given a second occurrence of its key, before and after it, with each right-typed value that differs from its own; judged by Go (xtsgen dupdiff, validator c93f5ac; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'f205c2b536ca46abf5d374a950c2c98d96104a241142572cfb19943c17a1ac3f', 25, 'go-written/bytes-cases-dupdiff-5.json.gz');
