import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 1 of 2 of the first-sibling corpus: entries[0].hash of every stateReceipt, spelled 0x / upper-case / both, judged by Go (xtsgen firstsibling, validator a5499e2; see helpers/s3-bytes.ts). */
defineBytesShard(0, 2, '7c7c85b93f15aabac8eebda53613bde93db934b3c5c7c13ff855cac030f32e26', 50, 'go-written/bytes-cases-firstsibling.json.gz');
