import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 1 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'c21f174d0863604c5ee1839349839fd87570c6cb5eb1780cecfd6b844460c4dc', 25, 'go-written/bytes-cases-objsweep-0.json.gz');
