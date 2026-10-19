import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 4 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '42b00e8195401b1e7c7119d135879c20d24343819b7e12b2f9e529f06d0ba77f', 25, 'go-written/bytes-cases-objsweep-3.json.gz');
