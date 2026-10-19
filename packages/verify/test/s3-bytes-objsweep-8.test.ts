import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 8 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'e7c8511ea55af8a1726bcc520a329d3f1220f25f86e6ab94197a07cd1357bac6', 25, 'go-written/bytes-cases-objsweep-7.json.gz');
