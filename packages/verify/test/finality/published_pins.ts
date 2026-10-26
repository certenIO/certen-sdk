/**
 * The pins file the published Go-recorded sets doc_report1 (cmd/proofverify at pv2/rb11-e1-raise@cbb6373) and pins_opssync_x were recorded under
 * (sha256 fdba733e...5440), kept byte for byte in test/fixtures/finality/pins_published_fdba733e. A published set is judged under the pins its Go
 * verdicts were recorded under; the embedded pins moved on (9f4fc10f..., post_denim) and those sets are not edited. Successor sets recorded by Go under
 * the new pins are owed (checkins/RB12-EPS-DENIM-TS.md).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPins, type Pins } from '../../src/proof-v2/finality/pins.js';

export const PUBLISHED_PINS_SHA256 = 'fdba733e7fc4206d96d73c87352834c51801ee8fe0af76d60654cb461fbd5440';
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'finality', 'pins_published_fdba733e', 'finality-pins.json');

export const publishedPinsBytes = (): Uint8Array => readFileSync(file);
/** The published pins loaded with the identity "embedded", as the recorded Go reports name them. */
export const publishedPins = (): Pins => loadPins(publishedPinsBytes(), Uint8Array.from(PUBLISHED_PINS_SHA256.match(/../g)!, (h) => parseInt(h, 16)));
