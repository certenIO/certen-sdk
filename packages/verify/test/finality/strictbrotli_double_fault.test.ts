/**
 * DOCUMENTED DIVERGENCE OQ-R12-BETA-1 (owner decision open; RB12-TS-FIX-POSTED, audit V-RB12-TS-AUDIT-POSTED D1): a Brotli stream that is BOTH over the
 * cap and corrupt later is judged by the validator's pkg/finality/strictbrotli (Go) on what andybalholm/brotli had flushed into io.ReadAll's growing
 * buffer before it failed, so Go's answer depends on the decoder's flush schedule; node:zlib discards the output of the call that fails and the TypeScript
 * twin (strictbrotli.ts flushedBeyond / boundaryFlushedBeyond) emulates the flush schedule without being able to be exact.
 *
 * This file holds the inputs on which the two disagree, with the Go answer as DATA recorded from the Go oracle (validator origin/pv2/rb11-e1-raise @cbb6373:
 * strictbrotli.Decompress, arbposted decodePayload and baseposted decompress; fixtures in test/fixtures/finality/strictbrotli_double_fault1, README there)
 * and the TypeScript answer asserted as the CURRENT behaviour. The tests titled DOCUMENTED DIVERGENCE fail on purpose the day the TypeScript reader is made
 * exact or both verifiers are respecified (owner options A and B of OQ-R12-BETA-1): whoever changes the reader then rewrites them deliberately.
 *
 * What is measured here, and no more: on these streams both answers are refusals, so no acceptance is affected; the Base channel reader answers
 * channel_malformed either way (ChannelError); the divergence is visible only as the state code of the Arbitrum batch decode
 * (finality_evidence_too_large{uncompressed_batch} in Go, l1_posted_content_not_found{payload_undecodable} in TS); and the caps of the embedded pins
 * (message 262,144, batch 16,777,216, channel 100,000,000) give the same answer in both on every stream of the set. It is reachable only through a pins
 * override that sets a cap in the gap of a stream (the embedded pins never do).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMBEDDED_PINS_TEXT } from '../../src/proof-v2/finality/pins-embedded.js';
import { embeddedPins, parsePinsOverride } from '../../src/proof-v2/finality/pins.js';
import { loadArbPins } from '../../src/proof-v2/finality/arbposted/pins.js';
import { MAX_L2_MESSAGE_SIZE, PayloadOK, PayloadTooLarge, PayloadUndecodable, decodePayload } from '../../src/proof-v2/finality/arbposted/nitro.js';
import { parseBasePins } from '../../src/proof-v2/finality/baseposted/pins.js';
import { ChannelError, decompress as channelDecompress } from '../../src/proof-v2/finality/baseposted/channel.js';
import { StrictBrotliError, decompress } from '../../src/proof-v2/finality/strictbrotli.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'finality', 'strictbrotli_double_fault1');
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const casesRaw = readFileSync(join(DIR, 'cases.json'));
const inputRaw = readFileSync(join(DIR, 'cases_in.json'));

/** sha256 of the files the Go oracle wrote or read (see the README of the fixture) */
const CASES_SHA256 = '9a2254a90d5c52391d4d40e2c916bdea7f3bc87b6ea57c998acb5b1155809c7d';
const CASES_IN_SHA256 = '16537c3c1179fd0c7b196395f0bb28868ec07ca634a42633745abceeefc50f27';
const STREAM_SHA256: Record<string, string> = {
  s_611: 'ace794397850dddd233b9c669eb03a6cb54ceaa8644504dedfbb208144043f65',
  s_38002: 'ae84cfa38305fb99eb510f0205caba23be46c58e9e3a847c7338717c2e78f3b5',
  s_39053: '20d3c16316133c7c1dfebb6fd1630805bc97358aab4ecda4cd873e51b2381ac7',
  s_79533: '92f611549fb5da2a27930a4b02f2a194f51112e13ae301934fc61ad0bbee2208',
  s_79534: '373843e3645b7e4edadfc35fb1182637d1192f3678020ce4d9d867b4683d3578',
  s_156786: 'c8fbf76a38a6b4c3dae7a86d69b952fe4fc6a37e77b2c5fae034d7b6e3169a9e',
  s_156789: 'bcf95731ed1f48cdee0811f88b87686848b5e88c193a326197a0b16c85c06bf5',
};

interface Case {
  id: string;
  stream: string;
  cap: number;
  go: { strictbrotli: string; payload: string; payload_exceeded_uncompressed: boolean; channel: string };
}
const cases = JSON.parse(casesRaw.toString('utf8')) as Case[];
const streamOf = (c: Case): Uint8Array => Uint8Array.from(readFileSync(join(DIR, 'streams', `${c.stream}.br`)));

/** the cases where the TypeScript reader answers differently from Go: Go says exceeded, TypeScript says the stream is corrupt */
const DIVERGENT = [
  's_39053_cap120000',
  's_38002_cap125000',
  's_79534_cap250000',
  's_79533_cap260000',
  's_156789_cap510000',
  's_156786_cap520000',
  's_39053_cap131071',
  's_79534_cap262143',
  ...[0, 1, 63, 64, 100, 255, 256, 300, 511].map((cap) => `s_611_cap${cap}`),
];

interface Ts {
  kind: string;
  payload: number;
  payloadExceeded: boolean;
  channel: 'err' | 'ok';
}
function tsAnswer(c: Case): Ts {
  const s = streamOf(c);
  let kind: string;
  try {
    const r = decompress(s, c.cap);
    kind = r.exceeded ? 'exceeded' : 'ok';
  } catch (e) {
    if (!(e instanceof StrictBrotliError)) throw e;
    kind = e.reason;
  }
  const p = decodePayload(Uint8Array.from([0, ...s]), c.cap, 1 << 20);
  let channel: 'err' | 'ok' = 'ok';
  try {
    channelDecompress(Uint8Array.from([1, ...s]), BigInt(c.cap));
  } catch (e) {
    if (!(e instanceof ChannelError)) throw e;
    channel = 'err';
  }
  return { kind, payload: p.status, payloadExceeded: p.exceededUncompressed, channel };
}

describe('strictbrotli double fault: the recorded Go answers and the CURRENT TypeScript answers (OQ-R12-BETA-1)', () => {
  it('the files are the ones the Go oracle wrote and read, and every stream is the one named (sha256)', () => {
    expect(sha(casesRaw)).toBe(CASES_SHA256);
    expect(sha(inputRaw)).toBe(CASES_IN_SHA256);
    for (const [name, h] of Object.entries(STREAM_SHA256)) expect(sha(readFileSync(join(DIR, 'streams', `${name}.br`))), name).toBe(h);
    expect(cases.length).toBe(33);
    expect(new Set(cases.map((c) => c.id)).size).toBe(33);
    expect(new Set(cases.map((c) => c.stream))).toEqual(new Set(Object.keys(STREAM_SHA256)));
    // the input file is the projection of the answers file: same ids, streams and caps in the same order
    expect((JSON.parse(inputRaw.toString('utf8')) as { id: string; stream: string; cap: number }[]).map((c) => `${c.id}|${c.stream}|${c.cap}`)).toEqual(
      cases.map((c) => `${c.id}|${c.stream}|${c.cap}`),
    );
  });

  it('Go answered consistently: exceeded <-> payload too_large <-> a refused channel, decode <-> undecodable, and it accepted none of the streams', () => {
    for (const c of cases) {
      expect(['exceeded', 'decode'], c.id).toContain(c.go.strictbrotli);
      expect(c.go.payload, c.id).toBe(c.go.strictbrotli === 'exceeded' ? 'too_large' : 'undecodable');
      expect(c.go.payload_exceeded_uncompressed, c.id).toBe(c.go.strictbrotli === 'exceeded');
      expect(c.go.channel, c.id).toBe('err');
    }
    expect(cases.filter((c) => c.go.strictbrotli === 'exceeded').length).toBe(DIVERGENT.length + 3); // the three agreeing exceeded cases: caps 100000, 200000, and the pinned 262144 on the longest stream
  });

  it.each(DIVERGENT)('DOCUMENTED DIVERGENCE OQ-R12-BETA-1: %s: Go says exceeded (batch too large), TypeScript says the stream is corrupt (payload undecodable)', (id) => {
    const c = cases.find((x) => x.id === id)!;
    expect(c, id).toBeDefined();
    expect(c.go).toEqual({ strictbrotli: 'exceeded', payload: 'too_large', payload_exceeded_uncompressed: true, channel: 'err' });
    expect(tsAnswer(c)).toEqual({ kind: 'decode', payload: PayloadUndecodable, payloadExceeded: false, channel: 'err' });
  });

  it('the divergent set is exactly the listed 17 cases: every other case, 16 of them, is answered as Go answered it (controls, incl. the caps of the embedded pins)', () => {
    const divergent = new Set(DIVERGENT);
    expect(divergent.size).toBe(17);
    const agreeing = cases.filter((c) => !divergent.has(c.id));
    expect(agreeing.length).toBe(16);
    for (const c of agreeing) {
      const t = tsAnswer(c);
      expect(t.kind, c.id).toBe(c.go.strictbrotli);
      expect(t.payload, c.id).toBe(c.go.payload === 'too_large' ? PayloadTooLarge : PayloadUndecodable);
      expect(t.payloadExceeded, c.id).toBe(c.go.payload_exceeded_uncompressed);
      expect(t.channel, c.id).toBe(c.go.channel);
    }
    // the DIVERGENT ids really differ from Go (a stale id would turn a divergence into a control unnoticed)
    for (const id of DIVERGENT) expect(tsAnswer(cases.find((x) => x.id === id)!).kind, id).not.toBe(cases.find((x) => x.id === id)!.go.strictbrotli);
  });

  it('no acceptance is affected: for every case both verifiers refuse (Go: exceeded or decode; TS: payload status not OK, strictbrotli never ok, Base channel refused)', () => {
    for (const c of cases) {
      const t = tsAnswer(c);
      expect(t.kind, c.id).not.toBe('ok');
      expect(t.payload, c.id).not.toBe(PayloadOK);
      expect(t.channel, c.id).toBe('err');
      expect(c.go.channel, c.id).toBe('err');
      expect(c.go.payload, c.id).not.toBe('ok');
    }
  });

  it('the caps of the embedded pins (message 262144, arb batch 16777216, base channel 100000000) give the same answer in both verifiers on every stream of the set', () => {
    expect(MAX_L2_MESSAGE_SIZE).toBe(262144);
    expect(loadArbPins(embeddedPins()).maxUncompressedBatch).toBe(16777216);
    expect(parseBasePins(embeddedPins()).maxRlpBytesPerChannel).toBe(100000000n);
    const pinned = new Set([262144, 16777216, 100000000]);
    const atPinned = cases.filter((c) => pinned.has(c.cap));
    expect(atPinned.length).toBe(7); // s_39053 and s_156789 at all three caps, plus s_79534 at 262144
    const divergent = new Set(DIVERGENT);
    for (const c of atPinned) {
      expect(divergent.has(c.id), c.id).toBe(false);
      expect(tsAnswer(c).kind, c.id).toBe(c.go.strictbrotli);
    }
  });

  it('it is reachable only through a pins override: a max_uncompressed_batch of 120000 loads, and the Arbitrum batch decode under it names the TypeScript answer of the divergent case', () => {
    const marker = '"max_uncompressed_batch": 16777216';
    expect(EMBEDDED_PINS_TEXT.split(marker).length).toBe(2);
    const overridden = parsePinsOverride(new TextEncoder().encode(EMBEDDED_PINS_TEXT.replace(marker, '"max_uncompressed_batch": 120000')));
    const cap = loadArbPins(overridden).maxUncompressedBatch;
    expect(cap).toBe(120000);
    const c = cases.find((x) => x.id === 's_39053_cap120000')!;
    const p = decodePayload(Uint8Array.from([0, ...streamOf(c)]), cap, 1 << 20);
    expect(p.status).toBe(PayloadUndecodable);
    expect(c.go.payload).toBe('too_large');
  });
});
