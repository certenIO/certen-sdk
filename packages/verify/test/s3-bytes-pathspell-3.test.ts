import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 3 of 8 of the path-class spelling corpus (51131 cases): the first occurrence of every path class of every hex or partition / URL string member of every base document, spelled 0x / 0X / upper-case / space-padded (hex) and upper-case / space / U+FEFF / U+0085 / U+00A0 / tab-newline (names), judged by Go (xtsgen pathspell, validator a5499e2; see helpers/s3-bytes.ts). */
defineBytesShard(2, 8, 'ce13b070f4ec7d2ceaeb15641bdfe75c060caa59704394dc3380e363889bd867', 3, 'go-written/bytes-cases-pathspell.json.gz');
