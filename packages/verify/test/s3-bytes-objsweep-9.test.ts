import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 9 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'fb9805e3d746c6032043520f5194ed61569d00f4f8a3769e587e3542e0f71476', 25, 'go-written/bytes-cases-objsweep-8.json.gz');
