import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 10 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '4590f9ccfa3d81fade6e3c63d3224dcbf7a798be4d0698c98d40023f73671576', 25, 'go-written/bytes-cases-objsweep-9.json.gz');
