import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 5 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '4068d3cb9e37673095db27502163e066ebcb265b5a8e71eac83cf3a562bf0535', 25, 'go-written/bytes-cases-objsweep-4.json.gz');
