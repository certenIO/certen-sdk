import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 12 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'da255386084b34de0f81687c3ed34f0d282a9b71ab9acd55edc975a36751cecf', 25, 'go-written/bytes-cases-objsweep-11.json.gz');
