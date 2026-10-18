import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 1 of 8 of the receipt-spelling corpus: start, anchor and every entries[k].hash of every stateReceipt, and secondaryHash, pendingHash, every chain pending[i] and anchor, spelled 0x / upper-case / both / 0X / space-padded, judged by Go (xtsgen receiptspell, validator a5499e2; see helpers/s3-bytes.ts). */
defineBytesShard(0, 8, 'bd56760b0d8f8d2441282ee94fffff2376faa18d1b0fdebbf6ebc53a91b969c1', 3, 'go-written/bytes-cases-receiptspell.json.gz');
