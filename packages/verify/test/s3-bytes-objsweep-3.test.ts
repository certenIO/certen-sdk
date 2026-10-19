import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 3 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '4b897b9a26a36d85e983ba4ffafd38433f57e8495acc63e54fb8f8a33f8a5293', 25, 'go-written/bytes-cases-objsweep-2.json.gz');
