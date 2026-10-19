import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 9 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'f43d918cd464296fa16cda71988085a97756e22522502a045792ed0489005e99', 25, 'go-written/bytes-cases-objsweep-8.json.gz');
