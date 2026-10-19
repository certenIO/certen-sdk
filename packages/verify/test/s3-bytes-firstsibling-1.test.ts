import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 1 of 2 of the first-sibling corpus: entries[0].hash of every stateReceipt, spelled 0x / upper-case / both, judged by Go (xtsgen firstsibling, validator a5499e2; see helpers/s3-bytes.ts). */
defineBytesShard(0, 2, '9be09e1c9af760d21628b6276cc8bb1d29e39f7252a274c6cb2fab1f8d84764a', 50, 'go-written/bytes-cases-firstsibling.json.gz');
