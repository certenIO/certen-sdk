import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 2 of 2 of the bare-element corpus (RB9-F6, review V-Q second pass D5): every list member of every object class given a second occurrence of its key that is one element of the list, bare, before and after the list; judged by Go (xtsgen dupbare, validator c93f5ac; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '813d758abf7efb0f1e979e95cbf86e70b4d9d1aff49366cad4de9cbcc1205c17', 25, 'go-written/bytes-cases-dupbare-1.json.gz');
