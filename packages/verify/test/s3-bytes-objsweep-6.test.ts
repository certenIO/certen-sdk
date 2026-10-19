import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 6 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '857e872ab8564ae96ef168586f3029c38764ef22b3e5d973b6b4f075d734c6e4', 25, 'go-written/bytes-cases-objsweep-5.json.gz');
