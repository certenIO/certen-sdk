import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 4 of 12 of the object-class sweep (B7): every object and scalar path class of every base document of every suite - a trailing field, null, deleted, a wrong JSON type, a duplicate key, the uint64 edges - judged by Go (xtsgen objsweep, validator 2d98ff9; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, 'ad246def40804a6fabced6253c67d7f9f78a66f27d78893bbb749dd8e3919542', 25, 'go-written/bytes-cases-objsweep-3.json.gz');
