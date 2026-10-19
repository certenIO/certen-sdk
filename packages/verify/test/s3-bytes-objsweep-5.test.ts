import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 5 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'c18a83db3dab1f05e21b6422b9a5d124802bbd27ee0efa95e0150af60b56dfe1', 25, 'go-written/bytes-cases-objsweep-4.json.gz');
