import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 2 of 6 of the duplicate-key-with-another-value corpus (RB9-F6, review V-Q D1): every member of every object path class given a second occurrence of its key, before and after it, with each right-typed value that differs from its own; judged by Go (xtsgen dupdiff, validator c93f5ac; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '600083a31127b9edf6e985142b2a2ed79b23018cffa9090a963046110b1390df', 25, 'go-written/bytes-cases-dupdiff-1.json.gz');
