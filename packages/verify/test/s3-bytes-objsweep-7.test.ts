import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 7 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '982d1a3ff623e7f020f8c52dd0ee65211bfeb53403ba2a9f37f15bff1f7a201e', 25, 'go-written/bytes-cases-objsweep-6.json.gz');
