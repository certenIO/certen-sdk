import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 5 of 6 of the duplicate-key-with-another-value corpus (RB9-F6, review V-Q D1): every member of every object path class given a second occurrence of its key, before and after it, with each right-typed value that differs from its own; judged by Go (xtsgen dupdiff, validator c93f5ac; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '69713732bd307b0b74d28bc7f2339c25309a6508db90f792dabd040e6b9fb41b', 25, 'go-written/bytes-cases-dupdiff-4.json.gz');
