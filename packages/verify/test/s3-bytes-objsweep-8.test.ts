import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 8 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'b7efed8620572acee922f6a245600cd2a056048717de24ca5a40a4e9c92ae127', 25, 'go-written/bytes-cases-objsweep-7.json.gz');
