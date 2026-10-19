import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 1 of 6 of the duplicate-key-with-another-value corpus (RB9-F6, review V-Q D1): every member of every object path class given a second occurrence of its key, before and after it, with each right-typed value that differs from its own; judged by Go (xtsgen dupdiff, validator c93f5ac; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '89a7493f8ba5c169961d7b308ce97b6fa5036ce7868bee8977543cd81e428dfd', 25, 'go-written/bytes-cases-dupdiff-0.json.gz');
