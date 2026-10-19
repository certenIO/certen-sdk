import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 10 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'f362785d7cc2560ffeed627ebe4331bb586db203b772222721481386307ac2f0', 25, 'go-written/bytes-cases-objsweep-9.json.gz');
