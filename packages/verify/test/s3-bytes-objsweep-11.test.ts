import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 11 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'e26dd21fb1007e74c9184dbd7e3e116372d49934b565274e0c40507a6aa89177', 25, 'go-written/bytes-cases-objsweep-10.json.gz');
