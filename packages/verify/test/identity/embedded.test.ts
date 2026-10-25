// The embedded copies in src/proof-v2/identity/embedded.ts are the published bytes: they equal the fixtures and carry their sha256.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_JSON, MANIFEST_SHA256, STATES_JSON, STATES_SHA256, VOCAB_JSON, VOCAB_SHA256 } from '../../src/proof-v2/identity/embedded.js';
import { embeddedPin, manifestHash } from '../../src/proof-v2/identity/index.js';
import { FIXTURES, STATES_SHA256 as FIXTURE_STATES, VOCAB_SHA256 as FIXTURE_VOCAB } from './fixtures.js';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('embedded identity data', () => {
  it('equals the byte-identical fixtures and its own sha256 constants', () => {
    const states = readFileSync(join(FIXTURES, 'states.json'));
    const vocab = readFileSync(join(FIXTURES, 'vocab.json'));
    const manifest = readFileSync(join(FIXTURES, 'manifest', 'identity-manifest.json'));
    expect(Buffer.from(STATES_JSON, 'utf8').equals(states)).toBe(true);
    expect(Buffer.from(VOCAB_JSON, 'utf8').equals(vocab)).toBe(true);
    expect(Buffer.from(MANIFEST_JSON, 'utf8').equals(manifest)).toBe(true);
    expect(STATES_SHA256).toBe(sha(states));
    expect(STATES_SHA256).toBe(FIXTURE_STATES);
    expect(VOCAB_SHA256).toBe(sha(vocab));
    expect(VOCAB_SHA256).toBe(FIXTURE_VOCAB);
    expect(MANIFEST_SHA256).toBe(sha(manifest));
    expect(embeddedPin()).toBe(readFileSync(join(FIXTURES, 'manifest', 'identity-manifest.json.sha256'), 'utf8').trim().split(/\s+/)[0]);
    expect(manifestHash(manifest)).toBe(embeddedPin());
  });
});
