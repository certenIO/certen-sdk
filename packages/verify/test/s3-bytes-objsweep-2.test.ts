import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 2 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '06e5d56bb209e81235fdcd53c8387fa4c396f136ca7c6d8e25bb0551cb15788c', 25, 'go-written/bytes-cases-objsweep-1.json.gz');
