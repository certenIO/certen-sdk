import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 11 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'e728190c44cbc75bc9494a0157a1037da3ffa7f98a19c871a0d8880dfb0ed3e8', 25, 'go-written/bytes-cases-objsweep-10.json.gz');
