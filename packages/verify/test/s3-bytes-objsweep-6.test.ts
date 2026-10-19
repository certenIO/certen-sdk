import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 6 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '9e15e33713837bfac3a6061542323f0d8d4390a9610f6168b2c0db42bac94bd6', 25, 'go-written/bytes-cases-objsweep-5.json.gz');
