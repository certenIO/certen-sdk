import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 3 of 4 of the wider Go-written byte-level corpus (xtsgen -per 40 bytes, validator a5499e2; see helpers/s3-bytes.ts). */
defineBytesShard(2, 4, '8b5756b07dbb5fd8b7c392692e1994567e6037dc94c80c3e7edf8ad621cebe81', 25, 'go-written/bytes-cases-wide2.json.gz');
