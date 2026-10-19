import { defineBytesShard } from './helpers/s3-bytes.js';

/** Shard 1 of 8 of the receipt-spelling corpus: start, anchor and every entries[k].hash of every stateReceipt, and secondaryHash, pendingHash, every chain pending[i] and anchor, spelled 0x / upper-case / both / 0X / space-padded, judged by Go (xtsgen receiptspell, validator a5499e2; see helpers/s3-bytes.ts). */
defineBytesShard(0, 8, 'b5d5b8ff77c243b2b80f0b1e2b7b5d75fd99f713f1560f68962cee5a55cf919d', 3, 'go-written/bytes-cases-receiptspell.json.gz');
