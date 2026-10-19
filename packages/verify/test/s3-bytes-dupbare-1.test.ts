import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 1 of 2 of the bare-element corpus (RB9-F6, review V-Q second pass D5): every list member of every object class given a second occurrence of its key that is one element of the list, bare, before and after the list; judged by Go (xtsgen dupbare, validator c93f5ac; see helpers/s3-bytes.ts). */
defineBytesShard(0, 1, '18ae048e390a0077d4d3f25a19abd098d59670df70c7f9cba92d399cc957f2ed', 25, 'go-written/bytes-cases-dupbare-0.json.gz');
