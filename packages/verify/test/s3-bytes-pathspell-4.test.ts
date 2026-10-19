import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 4 of 8 of the path-class spelling corpus (51131 cases): the first occurrence of every path class of every hex or partition / URL string member of every base document, spelled 0x / 0X / upper-case / space-padded (hex) and upper-case / space / U+FEFF / U+0085 / U+00A0 / tab-newline (names), judged by Go (xtsgen pathspell, validator a5499e2; see helpers/s3-bytes.ts). */
defineBytesShard(3, 8, '636d721f1afe88579b081201d1bfd3820681c183a2668e21da1ca2921f7a805f', 3, 'go-written/bytes-cases-pathspell.json.gz');
