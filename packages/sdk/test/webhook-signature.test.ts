import { describe, it, expect } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  CertenClient, CertenError, CertenWebhookSignatureError,
  verifyWebhookSignature, constructWebhookEvent, constructWebhookEventFromRequest, isWebhookEvent, signWebhookPayload,
  parseWebhookSignatureHeader, canonicalizeWebhookPayload, checkWebhookDelivery, WEBHOOK_EVENTS, isKnownWebhookEvent,
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS, WEBHOOK_SIGNATURE_HEADER,
} from '../src/index.js';
import { hmacSha256 } from '../src/webhook-signature.js';
import { bytesToHex, utf8 } from '../src/bytes.js';

/**
 * Webhook signing and verification.
 *
 * Three independent oracles keep this honest, because a verifier that agrees only with itself proves nothing:
 *   1. HMAC-SHA256 is held to RFC 4231 and to `node:crypto` (the portable implementation is not node's).
 *   2. Canonical JSON is fuzzed against a VERBATIM copy of the gateway's `canonicalJSON`.
 *   3. The pinned vectors below were produced by running the gateway's own `canonicalJSON` and `createHmac` over the inputs shown,
 *      exactly as `signWebhookPayload` does in `api-gateway/src/webhooks/webhook-signature.ts`. They are literals so that a change to
 *      this SDK's output — which would silently stop every receiver verifying — fails here, not in production.
 */

// ── Oracle: the gateway's canonicalJSON, verbatim (api-gateway/src/utils/canonical-json.ts) ─────────────────────────────────────
function gatewayCanonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJSON: non-finite numbers are not encodable');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return '[' + value.map((v) => gatewayCanonicalJSON(v)).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue;
      parts.push(JSON.stringify(key) + ':' + gatewayCanonicalJSON(v));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonicalJSON: unsupported type ${typeof value}`);
}

/** Deterministic PRNG so a fuzz failure reproduces. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRING_POOL = ['', 'a', 'é', '日本語', '😀', 'quote"s', 'back\\slash', 'line\nbreak', 'tab\t', '  ', '\u0000', '<>&', 'z'.repeat(40), '\ud800'];
function randomJson(rand: () => number, depth: number): unknown {
  const pick = Math.floor(rand() * (depth > 3 ? 6 : 8));
  switch (pick) {
    case 0: return null;
    case 1: return rand() < 0.5;
    case 2: return Math.floor(rand() * 2_000_000) - 1_000_000;
    case 3: return (rand() - 0.5) * 10 ** Math.floor(rand() * 30 - 8);
    case 4: case 5: return STRING_POOL[Math.floor(rand() * STRING_POOL.length)] + (rand() < 0.3 ? String(Math.floor(rand() * 99)) : '');
    case 6: return Array.from({ length: Math.floor(rand() * 4) }, () => randomJson(rand, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = 0, n = Math.floor(rand() * 5); i < n; i++) o[STRING_POOL[Math.floor(rand() * STRING_POOL.length)] + String(Math.floor(rand() * 9))] = randomJson(rand, depth + 1);
      return o;
    }
  }
}

// ── Gateway-produced vectors ───────────────────────────────────────────────────────────────────────────────────────────────────
const VECTORS = [
  {
    name: 'the example in the gateway guide',
    secret: 'whsec_test_secret_0123456789', t: 1716624000,
    payload: { b: 'hello', a: 1 },
    canonical: '{"a":1,"b":"hello"}',
    header: 't=1716624000,v1=5b085ed362bf7b76234b8afa51a0f244985467e7ddc83947aa0f6b37fea5a5f8',
  },
  {
    name: 'nested, multi-byte, exponent, empty containers, -0 and an undefined property',
    secret: 'whsec_test_secret_0123456789', t: 1716624000,
    // Built from code points so no escape has to survive an editor or a shell: a = e-acute, U+2028, quote, backslash, LF; m = CJK + U+1F600.
    payload: { z: [1, 2, { b: null, a: String.fromCodePoint(0xe9, 0x2028, 0x22, 0x5c, 0x0a) }], m: String.fromCodePoint(0x65e5, 0x672c, 0x8a9e, 0x1f600), n: 1e21, o: {}, p: [], q: -0, u: undefined },
    canonical: '{"m":"日本語😀","n":1e+21,"o":{},"p":[],"q":0,"z":[1,2,{"a":"é \\"\\\\\\n","b":null}]}',
    header: 't=1716624000,v1=16b50cc757d823762bb151fac2b6a07da1391b63b98d48d5783b91406e452b00',
  },
  {
    name: 'the registration ping',
    secret: 'a-very-strong-secret', t: 1700000000,
    payload: { challenge: '00112233445566778899aabbccddeeff', endpoint_id: 'c0ffee00-0000-4000-8000-000000000001' },
    canonical: '{"challenge":"00112233445566778899aabbccddeeff","endpoint_id":"c0ffee00-0000-4000-8000-000000000001"}',
    header: 't=1700000000,v1=9d93d063a98550dc9650a6be9c14d70ad8bf048291565a3d0df0d3869a32566b',
  },
  {
    name: 'a transaction.completed payload',
    secret: 'another-secret-value-16', t: 1730000000,
    payload: {
      intent_id: 'i-1', identity_id: null, tx_hash: 'abc', proof_id: 'p-1', proof_bundle_url: null,
      completion_basis: 'proof_artifact', status: 'completed', additional_authorities: null, expires_at: null,
    },
    canonical: '{"additional_authorities":null,"completion_basis":"proof_artifact","expires_at":null,"identity_id":null,"intent_id":"i-1","proof_bundle_url":null,"proof_id":"p-1","status":"completed","tx_hash":"abc"}',
    header: 't=1730000000,v1=ea87530292aaedd0cc0425d50613db7ed9f68cf1c47739edd8360c73cc5cfab9',
  },
];

const SECRET = 'whsec_test_secret_0123456789';
const T0 = 1716624000;
/** A genuine gateway-style delivery at T0. */
function delivery(payload: unknown = { b: 'hello', a: 1 }, secret = SECRET, t = T0) {
  const s = signWebhookPayload(secret, payload, { timestamp: t, event: 'transaction.completed', deliveryId: 'del-1' });
  return { body: s.canonicalPayload, headers: s.headers, signature: s.header };
}

describe('hmacSha256 (the portable one)', () => {
  const rep = (b: number, n: number): Uint8Array => new Uint8Array(n).fill(b);
  const RFC4231: Array<[string, Uint8Array, Uint8Array, string]> = [
    ['case 1', rep(0x0b, 20), utf8('Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
    ['case 2', utf8('Jefe'), utf8('what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
    ['case 3', rep(0xaa, 20), rep(0xdd, 50), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'],
    ['case 4', Uint8Array.from({ length: 25 }, (_, i) => i + 1), rep(0xcd, 50), '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b'],
    ['case 6 (key longer than the block)', rep(0xaa, 131), utf8('Test Using Larger Than Block-Size Key - Hash Key First'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
    ['case 7 (key and data longer than the block)', rep(0xaa, 131),
      utf8('This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.'),
      '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2'],
  ];
  for (const [name, key, msg, want] of RFC4231) {
    it(`matches RFC 4231 ${name}`, () => { expect(bytesToHex(hmacSha256(key, msg))).toBe(want); });
  }

  it('agrees with node:crypto at every key and message length around the block and padding boundaries', () => {
    for (const k of [1, 8, 31, 32, 33, 55, 56, 63, 64, 65, 100, 131]) {
      const key = new Uint8Array(nodeRandomBytes(k));
      for (let m = 0; m <= 200; m += (m < 70 ? 1 : 13)) {
        const msg = new Uint8Array(nodeRandomBytes(m));
        expect(bytesToHex(hmacSha256(key, msg)), `key ${k} msg ${m}`).toBe(createHmac('sha256', key).update(msg).digest('hex'));
      }
    }
  });

  it('does not modify its inputs', () => {
    const key = utf8('k'.repeat(100)); const msg = utf8('m'.repeat(100));
    const [k0, m0] = [key.slice(), msg.slice()];
    hmacSha256(key, msg);
    expect(key).toEqual(k0); expect(msg).toEqual(m0);
  });
});

describe('canonicalizeWebhookPayload', () => {
  it('sorts keys at every level, keeps array order, omits whitespace', () => {
    expect(canonicalizeWebhookPayload({ b: 1, a: { d: [3, 2, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,2,1]},"b":1}');
  });

  it('treats an undefined property as absent and an undefined element or root as null, as the gateway does', () => {
    expect(canonicalizeWebhookPayload({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalizeWebhookPayload([undefined, 1])).toBe('[null,1]');
    expect(canonicalizeWebhookPayload(undefined)).toBe('null');
  });

  it('is byte-identical to the gateway on 3000 random JSON values', () => {
    const rand = mulberry32(0xc0ffee);
    for (let i = 0; i < 3000; i++) {
      const v = randomJson(rand, 0);
      expect(canonicalizeWebhookPayload(v), JSON.stringify(v)).toBe(gatewayCanonicalJSON(v));
    }
  });

  it('is byte-identical to the gateway on an object parsed from JSON text (what a receiver rebuilds from)', () => {
    const text = '{"z":1,"a":[{"y":2,"b":3}],"__proto__":{"x":1},"m":"\\u00e9\\ud83d\\ude00"}';
    expect(canonicalizeWebhookPayload(JSON.parse(text))).toBe(gatewayCanonicalJSON(JSON.parse(text)));
  });

  it('is STRICTER than the gateway on what is not JSON: it throws where the gateway would sign "{}"', () => {
    expect(gatewayCanonicalJSON(new Date(0))).toBe('{}'); // the trap
    expect(() => canonicalizeWebhookPayload(new Date(0))).toThrow(/Date is not JSON/);
    expect(() => canonicalizeWebhookPayload(new Map([[1, 2]]))).toThrow(/Map is not JSON/);
    expect(() => canonicalizeWebhookPayload({ a: new Set([1]) })).toThrow(/Set is not JSON/);
    expect(() => canonicalizeWebhookPayload(Number.NaN)).toThrow(/NaN/);
    expect(() => canonicalizeWebhookPayload({ a: Infinity })).toThrow(/Infinity/);
    expect(() => canonicalizeWebhookPayload(() => 1)).toThrow(/function is not JSON/);
    expect(() => canonicalizeWebhookPayload(Symbol('x'))).toThrow(/symbol is not JSON/);
  });

  it('refuses a circular structure and absurd nesting instead of overflowing the stack', () => {
    const a: Record<string, unknown> = {}; a.self = a;
    expect(() => canonicalizeWebhookPayload(a)).toThrow(/circular/);
    let deep: unknown = 1;
    for (let i = 0; i < 2000; i++) deep = [deep];
    expect(() => canonicalizeWebhookPayload(deep)).toThrow(/deep/);
    // The same node twice in a DAG is not a cycle.
    const shared = { x: 1 };
    expect(canonicalizeWebhookPayload({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe('signWebhookPayload — against what the gateway produced', () => {
  for (const v of VECTORS) {
    it(`reproduces the gateway's header and body for: ${v.name}`, () => {
      const s = signWebhookPayload(v.secret, v.payload, { timestamp: v.t });
      expect(s.canonicalPayload).toBe(v.canonical);
      expect(s.header).toBe(v.header);
      expect(s.signatureHex).toBe(v.header.split('v1=')[1]);
      expect(s.timestamp).toBe(v.t);
      expect(s.version).toBe('v1');
    });

    it(`verifies the gateway's own delivery for: ${v.name}`, () => {
      const r = verifyWebhookSignature({ body: v.canonical, signature: v.header, secret: v.secret, now: v.t });
      expect(r).toEqual({ ok: true, timestamp: v.t, ageSeconds: 0, version: 'v1', secretIndex: 0 });
    });
  }

  it('returns the headers a delivery carries, with event and delivery id only when asked', () => {
    const bare = signWebhookPayload(SECRET, { a: 1 }, { timestamp: T0 });
    expect(bare.headers).toEqual({ 'Content-Type': 'application/json', 'X-Certen-Signature': bare.header, 'X-Certen-Timestamp': String(T0) });
    const full = signWebhookPayload(SECRET, { a: 1 }, { timestamp: T0, event: 'transaction.failed', deliveryId: 'd-9' });
    expect(full.headers['X-Certen-Event']).toBe('transaction.failed');
    expect(full.headers['X-Certen-Delivery']).toBe('d-9');
  });

  it('defaults the timestamp to now', () => {
    const before = Math.floor(Date.now() / 1000);
    const s = signWebhookPayload(SECRET, {});
    expect(s.timestamp).toBeGreaterThanOrEqual(before);
    expect(s.timestamp).toBeLessThanOrEqual(before + 2);
  });

  it('refuses a secret the gateway would not sign with, an array of them, and a nonsense timestamp', () => {
    expect(() => signWebhookPayload('', {})).toThrow(/empty/);
    expect(() => signWebhookPayload('short', {})).toThrow(/5 characters/);
    expect(() => signWebhookPayload([SECRET] as unknown as string, {})).toThrow(/exactly one/);
    for (const timestamp of [-1, 1.5, Number.NaN, 1e16]) {
      expect(() => signWebhookPayload(SECRET, {}, { timestamp }), String(timestamp)).toThrow(/whole number of unix seconds/);
    }
  });
});

describe('verifyWebhookSignature', () => {
  const d = delivery();
  const base = { body: d.body, signature: d.signature, secret: SECRET, now: T0 };

  it('accepts a genuine delivery and reports its age', () => {
    expect(verifyWebhookSignature(base)).toEqual({ ok: true, timestamp: T0, ageSeconds: 0, version: 'v1', secretIndex: 0 });
    expect(verifyWebhookSignature({ ...base, now: T0 + 299 })).toMatchObject({ ok: true, ageSeconds: 299 });
    expect(verifyWebhookSignature({ ...base, now: T0 - 299 })).toMatchObject({ ok: true, ageSeconds: -299 });
  });

  it('reads the signature from headers in every shape a framework hands over', () => {
    const h = d.headers;
    expect(verifyWebhookSignature({ body: d.body, headers: h, secret: SECRET, now: T0 }).ok).toBe(true);
    expect(verifyWebhookSignature({ body: d.body, headers: new Headers(h), secret: SECRET, now: T0 }).ok).toBe(true); // Fetch Headers
    expect(verifyWebhookSignature({ body: d.body, headers: { 'x-certen-signature': d.signature }, secret: SECRET, now: T0 }).ok).toBe(true); // Node lower-cases
    expect(verifyWebhookSignature({ body: d.body, headers: { 'X-CERTEN-SIGNATURE': [d.signature] }, secret: SECRET, now: T0 }).ok).toBe(true);
  });

  it('accepts the body as a string, Uint8Array, Buffer, ArrayBuffer or a view into a larger buffer', () => {
    const bytes = utf8(d.body);
    const padded = new Uint8Array(bytes.length + 10); padded.set(bytes, 5);
    for (const body of [d.body, bytes, Buffer.from(d.body), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), padded.subarray(5, 5 + bytes.length)]) {
      expect(verifyWebhookSignature({ ...base, body: body as Uint8Array }).ok, Object.prototype.toString.call(body)).toBe(true);
    }
  });

  it('hashes bytes, so multi-byte text and bytes that are not UTF-8 verify as received', () => {
    const multibyte = signWebhookPayload(SECRET, { m: '日本語😀é' }, { timestamp: T0 });
    expect(verifyWebhookSignature({ body: multibyte.canonicalPayload, signature: multibyte.header, secret: SECRET, now: T0 }).ok).toBe(true);
    const raw = Uint8Array.from([0xff, 0xfe, 0x00, 0x80]);
    const t = '1716624000';
    const sig = createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from(`${t}.`), raw])).digest('hex');
    expect(verifyWebhookSignature({ body: raw, signature: `t=${t},v1=${sig}`, secret: SECRET, now: T0 }).ok).toBe(true);
  });

  it('accepts an already-parsed payload by rebuilding its canonical form, and not a different one', () => {
    const parsed = JSON.parse(d.body);
    expect(verifyWebhookSignature({ payload: parsed, signature: d.signature, secret: SECRET, now: T0 }).ok).toBe(true);
    expect(verifyWebhookSignature({ payload: { ...parsed, a: 2 }, signature: d.signature, secret: SECRET, now: T0 })).toMatchObject({ ok: false, reason: 'signature-mismatch' });
    // Something the gateway could never have sent: a mismatch with the reason, not an exception.
    expect(verifyWebhookSignature({ payload: { a: new Date() }, signature: d.signature, secret: SECRET, now: T0 })).toMatchObject({ ok: false, reason: 'signature-mismatch' });
  });

  describe('refuses', () => {
    it('a body that was altered by one byte', () => {
      expect(verifyWebhookSignature({ ...base, body: d.body.replace('"a":1', '"a":2') })).toMatchObject({ ok: false, reason: 'signature-mismatch' });
      expect(verifyWebhookSignature({ ...base, body: `${d.body} ` })).toMatchObject({ ok: false, reason: 'signature-mismatch' });
      expect(verifyWebhookSignature({ ...base, body: '' })).toMatchObject({ ok: false, reason: 'signature-mismatch' });
    });

    it('the wrong secret, and the right secret with a newline on it (with a hint saying so)', () => {
      expect(verifyWebhookSignature({ ...base, secret: 'a-different-secret' })).toMatchObject({ ok: false, reason: 'signature-mismatch' });
      const r = verifyWebhookSignature({ ...base, secret: `${SECRET}\n` });
      expect(r).toMatchObject({ ok: false, reason: 'signature-mismatch' });
      expect(r.ok ? '' : r.hint).toMatch(/whitespace/);
    });

    it('a timestamp that was moved: t is inside the HMAC, so changing it breaks the signature', () => {
      const moved = d.signature.replace(`t=${T0}`, `t=${T0 + 1}`);
      expect(verifyWebhookSignature({ ...base, signature: moved, now: T0 + 1 })).toMatchObject({ ok: false, reason: 'signature-mismatch' });
    });

    it('an authentic signature outside the tolerance window, either side, and says it is authentic', () => {
      const late = verifyWebhookSignature({ ...base, now: T0 + 301 });
      expect(late).toMatchObject({ ok: false, reason: 'timestamp-outside-tolerance', timestamp: T0, ageSeconds: 301 });
      expect(late.ok ? '' : late.hint).toMatch(/replay|clock/);
      expect(verifyWebhookSignature({ ...base, now: T0 - 301 })).toMatchObject({ ok: false, reason: 'timestamp-outside-tolerance', ageSeconds: -301 });
      expect(verifyWebhookSignature({ ...base, now: T0 + 3600, toleranceSeconds: 7200 }).ok).toBe(true);
      expect(verifyWebhookSignature({ ...base, now: T0 + 10, toleranceSeconds: 5 }).ok).toBe(false);
      expect(DEFAULT_WEBHOOK_TOLERANCE_SECONDS).toBe(300);
    });

    it('a FORGED signature before looking at the clock: stale + forged is a mismatch, never "authentic but old"', () => {
      const forged = `t=${T0},v1=${'0'.repeat(64)}`;
      expect(verifyWebhookSignature({ ...base, signature: forged, now: T0 + 99999 })).toMatchObject({ ok: false, reason: 'signature-mismatch' });
    });

    it('a missing header, however it is missing', () => {
      for (const extra of [{ signature: undefined }, { signature: null }, { signature: '' }, { signature: '   ' }, { signature: undefined, headers: {} }, { signature: undefined, headers: new Headers() }]) {
        expect(verifyWebhookSignature({ body: d.body, secret: SECRET, now: T0, ...extra }), JSON.stringify(extra)).toMatchObject({ ok: false, reason: 'missing-signature' });
      }
    });

    it('malformed headers, each for its own reason', () => {
      const sig = d.signature.split('v1=')[1];
      const cases: Record<string, string> = {
        'no t': `v1=${sig}`,
        'no v1': `t=${T0}`,
        'two t': `t=${T0},t=${T0},v1=${sig}`,
        'non-numeric t': `t=abc,v1=${sig}`,
        'negative t': `t=-5,v1=${sig}`,
        'decimal t': `t=1716624000.5,v1=${sig}`,
        'leading + on t': `t=+${T0},v1=${sig}`,
        'hex t': `t=0x10,v1=${sig}`,
        'absurdly long t': `t=${'9'.repeat(40)},v1=${sig}`,
        'v1 too short': `t=${T0},v1=${sig.slice(0, 62)}`,
        'v1 too long': `t=${T0},v1=${sig}00`,
        'v1 not hex': `t=${T0},v1=${'z'.repeat(64)}`,
        'a part with no =': `t=${T0},oops,v1=${sig}`,
        'garbage': 'hello world',
      };
      for (const [name, signature] of Object.entries(cases)) {
        expect(verifyWebhookSignature({ ...base, signature }), name).toMatchObject({ ok: false, reason: 'malformed-signature' });
      }
    });

    it('a header that carries only a version this SDK does not know — and says to upgrade', () => {
      const r = verifyWebhookSignature({ ...base, signature: `t=${T0},v2=${'a'.repeat(64)}` });
      expect(r).toMatchObject({ ok: false, reason: 'unsupported-version' });
      expect(r.ok ? '' : r.hint).toMatch(/Upgrade/);
    });
  });

  describe('accepts what a future or rotating gateway might send', () => {
    it('v1 alongside another version, in either order, and ignores unknown keys and spacing', () => {
      const sig = d.signature.split('v1=')[1];
      for (const signature of [`t=${T0},v1=${sig},v2=${'b'.repeat(64)}`, `v2=${'b'.repeat(64)}, t=${T0} , v1=${sig}`, `t=${T0},alg=hmac-sha256,v1=${sig}`, `t=${T0},v1=${sig.toUpperCase()}`]) {
        expect(verifyWebhookSignature({ ...base, signature }).ok, signature).toBe(true);
      }
    });

    it('any one of several v1 candidates', () => {
      const sig = d.signature.split('v1=')[1];
      expect(verifyWebhookSignature({ ...base, signature: `t=${T0},v1=${'0'.repeat(64)},v1=${sig}` }).ok).toBe(true);
      expect(verifyWebhookSignature({ ...base, signature: `t=${T0},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}` }).ok).toBe(false);
    });
  });

  describe('secret rotation', () => {
    it('accepts either of two secrets and reports which one matched', () => {
      const oldSecret = 'the-previous-secret-value'; const newSecret = 'the-rotated-secret-value';
      const signedOld = delivery({ a: 1 }, oldSecret); const signedNew = delivery({ a: 1 }, newSecret);
      expect(verifyWebhookSignature({ body: signedOld.body, signature: signedOld.signature, secret: [newSecret, oldSecret], now: T0 })).toMatchObject({ ok: true, secretIndex: 1 });
      expect(verifyWebhookSignature({ body: signedNew.body, signature: signedNew.signature, secret: [newSecret, oldSecret], now: T0 })).toMatchObject({ ok: true, secretIndex: 0 });
      expect(verifyWebhookSignature({ body: signedNew.body, signature: signedNew.signature, secret: [oldSecret], now: T0 }).ok).toBe(false);
    });
  });

  describe('the misconfigurations that would otherwise turn into forgeries', () => {
    it('THROWS on an empty/unset/short secret instead of verifying against it', () => {
      // The gateway guide's snippet reads `process.env.CERTEN_WEBHOOK_SECRET ?? ''`. HMAC with an empty key is computable, so
      // without this an unset variable makes a forged delivery verify.
      const forgedWithEmptyKey = `t=${T0},v1=${createHmac('sha256', '').update(`${T0}.${d.body}`).digest('hex')}`;
      for (const secret of ['', undefined, null, 42, 'short', ['x'.repeat(20), ''], []]) {
        expect(() => verifyWebhookSignature({ body: d.body, signature: forgedWithEmptyKey, secret: secret as string, now: T0 }), String(secret)).toThrow(CertenError);
        try { verifyWebhookSignature({ body: d.body, signature: forgedWithEmptyKey, secret: secret as string, now: T0 }); } catch (e) { expect((e as CertenError).code).toBe('WEBHOOK_SECRET_INVALID'); }
      }
    });

    it('says what the secret was in plain words (an unset variable reads as undefined, not "a undefined")', () => {
      const said = (secret: unknown): string => {
        try { verifyWebhookSignature({ ...base, secret: secret as string }); } catch (e) { return (e as Error).message; }
        return '';
      };
      expect(said(undefined)).toContain('is undefined, not a string');
      expect(said(null)).toContain('is null, not a string');
      expect(said(42)).toContain('is a number, not a string');
      expect(said({})).toContain('is an object, not a string');
      expect(said('')).toContain('is empty');
    });

    it('never puts the secret in an error message', () => {
      try { verifyWebhookSignature({ ...base, secret: 'hunter2' }); expect.unreachable(); } catch (e) {
        expect(String((e as Error).message)).not.toContain('hunter2');
      }
    });

    it('needs exactly one of body and payload', () => {
      expect(() => verifyWebhookSignature({ signature: d.signature, secret: SECRET })).toThrow(/exactly one/);
      expect(() => verifyWebhookSignature({ body: d.body, payload: {}, signature: d.signature, secret: SECRET })).toThrow(/exactly one/);
    });

    it('rejects a tolerance that would switch replay protection off, and a bad clock', () => {
      for (const toleranceSeconds of [Infinity, Number.NaN, -1, '300' as unknown as number]) {
        expect(() => verifyWebhookSignature({ ...base, toleranceSeconds }), String(toleranceSeconds)).toThrow(/toleranceSeconds/);
      }
      expect(() => verifyWebhookSignature({ ...base, now: Number.NaN })).toThrow(/`now`/);
      expect(verifyWebhookSignature({ ...base, now: new Date(T0 * 1000) }).ok).toBe(true);
      // Zero tolerance is allowed and means "this very second".
      expect(verifyWebhookSignature({ ...base, toleranceSeconds: 0 }).ok).toBe(true);
      expect(verifyWebhookSignature({ ...base, toleranceSeconds: 0, now: T0 + 1 }).ok).toBe(false);
    });

    it('refuses a body that is not bytes, rather than hashing "[object Object]"', () => {
      expect(() => verifyWebhookSignature({ ...base, body: { a: 1 } as unknown as string })).toThrow(/raw bytes/);
      expect(() => verifyWebhookSignature({ ...base, body: 12 as unknown as string })).toThrow(/raw bytes/);
    });
  });

  describe('the mistake it exists to catch: a body that was parsed and re-serialized', () => {
    it('says so, and which fix, when the signature is valid for the canonical form', () => {
      const reserialized = JSON.stringify(JSON.parse(d.body), null, 2);
      const r = verifyWebhookSignature({ ...base, body: reserialized });
      expect(r).toMatchObject({ ok: false, reason: 'signature-mismatch' }); // never accepted: the bytes are not what was signed
      expect(r.ok ? '' : r.hint).toMatch(/re-serialized/);
      expect(r.ok ? '' : r.hint).toMatch(/express\.raw|arrayBuffer/);
    });

    it('says the body is not canonical when it does not match even then (wrong secret AND re-serialized)', () => {
      const r = verifyWebhookSignature({ ...base, body: JSON.stringify(JSON.parse(d.body), null, 2), secret: 'a-different-secret' });
      expect(r.ok ? '' : r.hint).toMatch(/not in the gateway's canonical form/);
    });

    it('stays quiet for a body that is canonical but simply wrong, and for a body that is not JSON', () => {
      expect(verifyWebhookSignature({ ...base, body: '{"a":2,"b":"hello"}' })).toMatchObject({ ok: false, hint: undefined });
      expect(verifyWebhookSignature({ ...base, body: 'not json' })).toMatchObject({ ok: false, hint: undefined });
    });

    it('does not run the diagnosis on a huge body (an unauthenticated sender must not buy extra work)', () => {
      const big = JSON.stringify({ pad: 'x'.repeat(300_000) }, null, 1);
      expect(verifyWebhookSignature({ ...base, body: big })).toMatchObject({ ok: false, reason: 'signature-mismatch', hint: undefined });
    });
  });
});

describe('parseWebhookSignatureHeader', () => {
  it('returns t exactly as written, and every vN pair in order', () => {
    expect(parseWebhookSignatureHeader(`t=0001716624000,v1=${'a'.repeat(64)},v2=xyz`)).toEqual({
      ok: true, timestamp: 1716624000, timestampText: '0001716624000',
      signatures: [{ version: 'v1', value: 'a'.repeat(64) }, { version: 'v2', value: 'xyz' }],
    });
  });
  it('hashes t as written: a zero-padded t is signed over its padded text, not its number', () => {
    // A verifier that did `Number(t)` and re-printed it would hash "1716624000." and disagree with a signer that hashed "0001716624000."
    const padded = createHmac('sha256', SECRET).update('0001716624000.{}').digest('hex');
    expect(verifyWebhookSignature({ body: '{}', signature: `t=0001716624000,v1=${padded}`, secret: SECRET, now: T0 }).ok).toBe(true);
  });
});

describe('constructWebhookEvent', () => {
  const d = delivery({ intent_id: 'i-1', status: 'completed', tx_hash: 'abc' });

  it('verifies, parses, and carries the headers that sit outside the signature separately', () => {
    const hook = constructWebhookEvent<{ intent_id: string }>({ body: d.body, headers: d.headers, secret: SECRET, now: T0 });
    expect(hook.payload.intent_id).toBe('i-1');
    expect(hook.type).toBe('transaction.completed');
    expect(hook.deliveryId).toBe('del-1');
    expect(hook.timestamp).toBe(T0);
    expect(hook.verification).toMatchObject({ ok: true, secretIndex: 0 });
  });

  it('leaves type and deliveryId null when the headers are not passed (the registration ping has no delivery id)', () => {
    const hook = constructWebhookEvent({ body: d.body, signature: d.signature, secret: SECRET, now: T0 });
    expect(hook.type).toBeNull();
    expect(hook.deliveryId).toBeNull();
  });

  it('throws CertenWebhookSignatureError with the reason, status 400 and no secret, for every verification failure', () => {
    const failures: Array<[string, Parameters<typeof constructWebhookEvent>[0]]> = [
      ['signature-mismatch', { body: `${d.body} `, headers: d.headers, secret: SECRET, now: T0 }],
      ['timestamp-outside-tolerance', { body: d.body, headers: d.headers, secret: SECRET, now: T0 + 1000 }],
      ['missing-signature', { body: d.body, headers: {}, secret: SECRET, now: T0 }],
      ['malformed-signature', { body: d.body, signature: 'junk', secret: SECRET, now: T0 }],
    ];
    for (const [reason, opts] of failures) {
      try { constructWebhookEvent(opts); expect.unreachable(reason); } catch (e) {
        expect(e).toBeInstanceOf(CertenWebhookSignatureError);
        expect(e).toBeInstanceOf(CertenError);
        const err = e as CertenWebhookSignatureError;
        expect(err.reason).toBe(reason);
        expect(err.status).toBe(400);
        expect(err.code).toBe('WEBHOOK_SIGNATURE_INVALID');
        expect(err.isRetryable).toBe(false);
        expect(err.message).not.toContain(SECRET);
        expect(err.name).toBe('CertenWebhookSignatureError');
      }
    }
  });

  it('lets an unusable secret through as a CertenError, not as a signature failure', () => {
    try { constructWebhookEvent({ body: d.body, headers: d.headers, secret: '' }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(CertenError);
      expect(e).not.toBeInstanceOf(CertenWebhookSignatureError);
    }
  });

  it('says invalid-payload when the signature holds over bytes that are not JSON', () => {
    const t = String(T0); const body = 'not json at all';
    const sig = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
    try { constructWebhookEvent({ body, signature: `t=${t},v1=${sig}`, secret: SECRET, now: T0 }); expect.unreachable(); } catch (e) {
      expect((e as CertenWebhookSignatureError).reason).toBe('invalid-payload');
    }
  });

  it('narrows to a typed payload with isWebhookEvent, and is false for another or an unknown event', () => {
    const hook = constructWebhookEvent({ body: d.body, headers: d.headers, secret: SECRET, now: T0 });
    if (isWebhookEvent(hook, WEBHOOK_EVENTS.TransactionCompleted)) {
      const intent: string = hook.payload.intent_id; // type-level: this line must compile
      expect(intent).toBe('i-1');
    } else {
      expect.unreachable();
    }
    expect(isWebhookEvent(hook, 'transaction.failed')).toBe(false);
    const unknown = constructWebhookEvent({ body: d.body, headers: { ...d.headers, 'X-Certen-Event': 'brand.new_event' }, secret: SECRET, now: T0 });
    expect(unknown.type).toBe('brand.new_event');
    expect(isKnownWebhookEvent(unknown.type)).toBe(false);
    expect(isKnownWebhookEvent('webhook.verify')).toBe(true);
  });

  it('is the verifier a Fetch-style Request needs, reading the body as bytes', async () => {
    const req = new Request('https://example.test/hook', { method: 'POST', headers: d.headers, body: d.body });
    const hook = await constructWebhookEventFromRequest<{ intent_id: string }>(req, SECRET, { now: T0 });
    expect(hook.payload.intent_id).toBe('i-1');
    expect(hook.deliveryId).toBe('del-1');
    const tampered = new Request('https://example.test/hook', { method: 'POST', headers: d.headers, body: `${d.body} ` });
    await expect(constructWebhookEventFromRequest(tampered, SECRET, { now: T0 })).rejects.toBeInstanceOf(CertenWebhookSignatureError);
  });
});

describe('the event registry', () => {
  it('names every event the gateway registers, and no more', () => {
    // Transcribed from api-gateway/src/webhooks/event-types.ts. This list is the check that the transcription is complete.
    expect(Object.values(WEBHOOK_EVENTS).sort()).toEqual([
      'billing.account_reinstated', 'billing.account_suspended', 'billing.balance_low', 'billing.charged', 'billing.credit_warning',
      'billing.deposit_unattributed', 'billing.payment_received', 'billing.trial_expiring', 'governance.completed', 'inbox.action_pending',
      'inbox.action_signed', 'transaction.completed', 'transaction.executed', 'transaction.failed', 'transaction.proof_unavailable',
      'webhook.verify',
    ]);
  });
});

describe('checkWebhookDelivery and webhooks.checkDelivery', () => {
  /** What GET /v1/webhooks/deliveries/{id} returns after an attempt. */
  function recorded(secret = SECRET) {
    const s = signWebhookPayload(secret, { intent_id: 'i-1', status: 'completed' }, { timestamp: T0 });
    return {
      id: 'c0ffee00-0000-4000-8000-000000000002', org_id: 'o1', event_type: 'transaction.completed', status: 'delivered', attempts: 1, response_status: 200,
      signature_version: 'v1', signature_hex: s.signatureHex, signed_at_unix: T0, signed_canonical_payload: s.canonicalPayload,
      delivery_id_header: 'c0ffee00-0000-4000-8000-000000000003', last_error: null, dlq_at: null, created_at: '2026-10-26T00:00:00Z',
    };
  }

  it('reproduces the signature the gateway recorded', () => {
    expect(checkWebhookDelivery(recorded(), SECRET)).toEqual({ ok: true, timestamp: T0, version: 'v1' });
  });

  it('says the secret is not the one the gateway used, and does not call the delivery forged', () => {
    const r = checkWebhookDelivery(recorded(), 'a-different-secret');
    expect(r).toMatchObject({ ok: false, reason: 'signature-mismatch' });
    expect(r.ok ? '' : r.hint).toMatch(/rotated|another endpoint/);
  });

  it('takes several secrets, and applies no clock (it is history)', () => {
    expect(checkWebhookDelivery(recorded(), ['another-secret-value', SECRET]).ok).toBe(true);
  });

  it('detects a record whose payload or timestamp was changed after signing', () => {
    expect(checkWebhookDelivery({ ...recorded(), signed_canonical_payload: '{"intent_id":"i-2","status":"completed"}' }, SECRET)).toMatchObject({ ok: false, reason: 'signature-mismatch' });
    expect(checkWebhookDelivery({ ...recorded(), signed_at_unix: T0 + 1 }, SECRET)).toMatchObject({ ok: false, reason: 'signature-mismatch' });
  });

  it('accepts signed_at_unix as a numeric string (a bigint column serialized by the driver)', () => {
    expect(checkWebhookDelivery({ ...recorded(), signed_at_unix: String(T0) }, SECRET).ok).toBe(true);
  });

  it('reports an unattempted delivery as not signed, not as a mismatch', () => {
    const blank = { ...recorded(), signature_hex: null, signed_at_unix: null, signed_canonical_payload: null };
    expect(checkWebhookDelivery(blank, SECRET)).toMatchObject({ ok: false, reason: 'not-signed' });
    expect(checkWebhookDelivery({ id: 'x' }, SECRET)).toMatchObject({ ok: false, reason: 'not-signed' });
  });

  it('reports a future signature version and a record in the wrong shape distinctly', () => {
    expect(checkWebhookDelivery({ ...recorded(), signature_version: 'v2' }, SECRET)).toMatchObject({ ok: false, reason: 'unsupported-version' });
    expect(checkWebhookDelivery({ ...recorded(), signature_hex: 'nothex' }, SECRET)).toMatchObject({ ok: false, reason: 'malformed-record' });
    expect(checkWebhookDelivery({ ...recorded(), signed_at_unix: -3 }, SECRET)).toMatchObject({ ok: false, reason: 'malformed-record' });
  });

  it('throws on an unusable secret exactly as verification does', () => {
    expect(() => checkWebhookDelivery(recorded(), '')).toThrow(CertenError);
  });

  describe('through the client', () => {
    async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
      const seen: string[] = [];
      const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); handler(req, res); });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return { url, seen, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }) };
    }
    const reply = (res: http.ServerResponse, status: number, body: unknown) => {
      res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
    };

    it('fetches the delivery, checks it locally, and attaches the id', async () => {
      const rec = recorded();
      const srv = await serve((_req, res) => reply(res, 200, rec));
      try {
        const c = new CertenClient({ apiKey: 'ck_live_x', baseUrl: srv.url, maxRetries: 0 });
        expect(await c.webhooks.checkDelivery(rec.id, SECRET)).toEqual({ deliveryId: rec.id, ok: true, timestamp: T0, version: 'v1' });
        expect(await c.webhooks.checkDelivery(rec.id, 'a-different-secret')).toMatchObject({ deliveryId: rec.id, ok: false, reason: 'signature-mismatch' });
        expect(srv.seen).toEqual([`GET /v1/webhooks/deliveries/${rec.id}`, `GET /v1/webhooks/deliveries/${rec.id}`]);
      } finally { await srv.close(); }
    });

    it('never sends the secret to the gateway', async () => {
      const bodies: string[] = [];
      const rec = recorded();
      const srv = await serve((req, res) => { bodies.push(`${req.url} ${JSON.stringify(req.headers)}`); reply(res, 200, rec); });
      try {
        await new CertenClient({ apiKey: 'ck_live_x', baseUrl: srv.url, maxRetries: 0 }).webhooks.checkDelivery(rec.id, SECRET);
        expect(bodies.join('\n')).not.toContain(SECRET);
      } finally { await srv.close(); }
    });

    it('refuses an unusable secret before making any request', async () => {
      const srv = await serve((_req, res) => reply(res, 200, recorded()));
      try {
        await expect(new CertenClient({ apiKey: 'ck_live_x', baseUrl: srv.url, maxRetries: 0 }).webhooks.checkDelivery('id', '')).rejects.toThrow(/WEBHOOK_SECRET|secret/i);
        expect(srv.seen).toEqual([]);
      } finally { await srv.close(); }
    });

    it('lets a 404 for someone else\'s or a missing delivery reject as usual', async () => {
      const srv = await serve((_req, res) => reply(res, 404, { error: 'Webhook delivery not found', code: 'NOT_FOUND' }));
      try {
        await expect(new CertenClient({ apiKey: 'ck_live_x', baseUrl: srv.url, maxRetries: 0 }).webhooks.checkDelivery('c0ffee00-0000-4000-8000-000000000009', SECRET)).rejects.toMatchObject({ status: 404 });
      } finally { await srv.close(); }
    });
  });
});

describe('webhooks.rotateSecret', () => {
  async function serve(reply: unknown) {
    const seen: Array<{ method: string; path: string; body: string; contentType: string | undefined }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ method: req.method ?? '', path: req.url ?? '', body, contentType: req.headers['content-type'] });
        res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }) };
  }
  const client = (url: string) => new CertenClient({ apiKey: 'ck_live_x', baseUrl: url, maxRetries: 0 });
  const ID = 'c0ffee00-0000-4000-8000-000000000001';

  it('with no argument sends no body, exactly as before, and the gateway generates the secret', async () => {
    const srv = await serve({ id: ID, secret: 'gateway-generated-secret-value' });
    try {
      const out = await client(srv.url).webhooks.rotateSecret(ID);
      expect(out.secret).toBe('gateway-generated-secret-value');
      expect(srv.seen[0]).toMatchObject({ method: 'POST', path: `/v1/webhooks/endpoints/${ID}/rotate-secret`, body: '' });
    } finally { await srv.close(); }
  });

  it('with a secret of your own sends it as { secret }, so a receiver can be switched with no failed deliveries', async () => {
    const mine = 'my-own-new-secret-0123456789';
    const srv = await serve({ id: ID, secret: mine });
    try {
      await client(srv.url).webhooks.rotateSecret(ID, { secret: mine });
      expect(JSON.parse(srv.seen[0].body)).toEqual({ secret: mine });
      expect(srv.seen[0].contentType).toMatch(/application\/json/);
    } finally { await srv.close(); }
  });

  it('refuses a secret the gateway would refuse, before any request, without echoing it', async () => {
    const srv = await serve({});
    try {
      for (const secret of ['', 'short', 'x'.repeat(15), 'y'.repeat(256)]) {
        await expect(client(srv.url).webhooks.rotateSecret(ID, { secret }), secret.slice(0, 10)).rejects.toMatchObject({ code: 'WEBHOOK_SECRET_INVALID' });
      }
      // 8 characters passes the signer's floor and fails the gateway's 16: the message must say why without repeating the value.
      const err = await client(srv.url).webhooks.rotateSecret(ID, { secret: 'hunter22' }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/16 to 255 characters/);
      expect((err as Error).message).not.toContain('hunter22');
      expect(srv.seen).toEqual([]);
    } finally { await srv.close(); }
  });
});

describe('a receiver, end to end', () => {
  it('accepts a delivery signed by signWebhookPayload over a real HTTP request, and rejects it once tampered with', async () => {
    const outcomes: string[] = [];
    const receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const hook = constructWebhookEvent({ body: Buffer.concat(chunks), headers: req.headers, secret: SECRET });
          outcomes.push(`ok ${hook.type} ${hook.deliveryId}`);
          res.statusCode = 200;
        } catch (e) {
          outcomes.push(`rejected ${(e as CertenWebhookSignatureError).reason}`);
          res.statusCode = 400;
        }
        res.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', () => resolve()));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    try {
      const signed = signWebhookPayload(SECRET, { intent_id: 'i-1', status: 'completed' }, { event: 'transaction.completed', deliveryId: 'd-1' });
      const good = await fetch(url, { method: 'POST', headers: signed.headers, body: signed.canonicalPayload });
      const bad = await fetch(url, { method: 'POST', headers: signed.headers, body: signed.canonicalPayload.replace('i-1', 'i-2') });
      expect(good.status).toBe(200);
      expect(bad.status).toBe(400);
      expect(outcomes).toEqual(['ok transaction.completed d-1', 'rejected signature-mismatch']);
    } finally { await new Promise<void>((resolve) => { receiver.close(() => resolve()); }); }
  });
});

describe('what the package exports', () => {
  it('names the header constants the gateway sends', () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('X-Certen-Signature');
  });
});
