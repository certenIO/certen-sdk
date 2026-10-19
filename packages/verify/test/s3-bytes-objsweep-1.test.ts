import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 1 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '06ea63f22f230947cfa1e36d49234ea11038df6924b1f19f54a267a6da0438ae', 25, 'go-written/bytes-cases-objsweep-0.json.gz');
