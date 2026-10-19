import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 2 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'faba62aaee4d687489ccb5ca7bb99e10922872f62c0732d1ee18a49d9e016f51', 25, 'go-written/bytes-cases-objsweep-1.json.gz');
