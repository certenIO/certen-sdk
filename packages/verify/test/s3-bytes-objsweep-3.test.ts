import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 3 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '791eb4c1452239cd4aa31ce7576c09d2d0758e04ddd28be46e8ecc912a014374', 25, 'go-written/bytes-cases-objsweep-2.json.gz');
