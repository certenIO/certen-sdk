import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 4 of 4 of the wider Go-written byte-level corpus (xtsgen -per 40 bytes, validator a5499e2; see helpers/s3-bytes.ts). */
defineBytesShard(3, 4, 'ac5eda975e312d5f8658921eb09f6fc2f6a443427996094302524cc7c6c2cbe4', 25, 'go-written/bytes-cases-wide2.json.gz');
