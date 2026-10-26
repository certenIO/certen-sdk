#!/usr/bin/env node
// Regenerates src/proof-v2/finality/pins-embedded.ts from src/proof-v2/finality/finality-pins.json (the validator's pkg/finality/pins file, copied
// byte for byte). The embedded text is a string literal of the file's exact bytes; test/finality/pins.test.ts fails if the two ever differ.
// Usage: node tools/gen-pins-embedded.mjs   (writes the .ts; run it after replacing finality-pins.json, never edit the .ts by hand)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'proof-v2', 'finality');
const text = readFileSync(join(dir, 'finality-pins.json'), 'utf8');
const target = join(dir, 'pins-embedded.ts');
const old = readFileSync(target, 'utf8');
const head = old.slice(0, old.indexOf('export const EMBEDDED_PINS_TEXT'));
writeFileSync(target, `${head}export const EMBEDDED_PINS_TEXT = ${JSON.stringify(text)};\n`);
