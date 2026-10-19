import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 1 of 2 of the genesis-link spelling corpus (RB9-F6, V-P): every spelling of the evidence 2.1 genesis link member - its value, the name's case and form, a misplaced member, duplicate keys in both orders, the link given as links, the version - of 73 documents that carry one, judged by Go (xtsgen genesisspell, validator d1bbe40; see helpers/s3-bytes.ts). */
defineBytesShard(0, 2, '09d7a8088c97909c0d1856d7bfc9f812dedd2b9fd2bc555820dbc7fb46007417', 25, 'go-written/bytes-cases-genesisspell.json.gz');
